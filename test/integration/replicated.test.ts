import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Control, replicaConfig, replicaURL, type ReplicaConfig } from "../../s3-control.ts";
import { Litestream } from "../../litestream.ts";
import { repositoryDatabasePath } from "../../state.ts";
import { fixture, noDatabaseMigration, tool } from "../fixtures.ts";
import { deliver, reviewRequested, webhookSecret } from "../webhook-fixtures.ts";

const exec = promisify(execFile);
const relative = "repos/github.com/acme~demo.sqlite";
const url = "https://github.com/acme/demo/pull/7";
const body = reviewRequested("me", url);
if (!process.env.PRONTO_S3_ENDPOINT || !process.env.PRONTO_LITESTREAM_BIN) throw new Error("Use npm run test:replicated; real RustFS and Litestream are mandatory");

async function until<T>(check: () => Promise<T | false>, timeout = 25_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error("Timed out waiting for observable integration state");
}
async function store(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-replica-test-"));
  const config = replicaConfig({ ...process.env, PRONTO_REPLICA_URL: `s3://pronto-${randomUUID()}/state`, PRONTO_STATE_DIR: directory });
  const storage = new S3Control(config);
  const client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.pathStyle, maxAttempts: 1 });
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  t.after(async () => { storage.close(); client.destroy(); await rm(directory, { recursive: true, force: true }); });
  return { config, storage, client, directory };
}
function database(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE operations(id TEXT PRIMARY KEY, payload BLOB)");
  return db;
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok"); return db.prepare("SELECT id FROM operations ORDER BY id").all().map((row) => row.id); }
  finally { db.close(); }
}
async function restore(config: ReplicaConfig, source: string, relative: string, txid: string, root: string) {
  await mkdir(root, { recursive: true });
  const ls = new Litestream(config, root, `${config.prefix}/terms/${randomUUID()}`, new AbortController().signal, () => {});
  await ls.restore(source, [{ relative, txid }]);
  return repositoryDatabasePath(root, relative);
}

// External HTTP fault proxy, not a storage fake. Every successful operation is forwarded to real RustFS.
async function proxy(t: TestContext) {
  const events: { method: string; path: string; status: number }[] = [];
  let intercept: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      if (await intercept?.(req, res)) return;
      const target = new URL(process.env.PRONTO_S3_ENDPOINT!);
      const upstream = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
        response.on("end", () => events.push({ method: req.method!, path: req.url!, status: response.statusCode! }));
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    } catch { res.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { endpoint: `http://127.0.0.1:${address.port}`, events, set intercept(value: typeof intercept) { intercept = value; } };
}

function github() {
  const posts: object[] = [];
  const attempts: object[] = [];
  const requests: string[] = [];
  let reviewStatus = 200;
  let beforePost: (() => Promise<void>) | undefined;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url!.split("?")[0]!;
    requests.push(`${req.method} ${path}`);
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (path === "/github/user") return json({ login: "me" });
    if (path === "/github/graphql") return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    if (req.method === "POST" && path.endsWith("/reviews")) {
      await beforePost?.();
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const review = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(review);
      res.statusCode = reviewStatus;
      if (reviewStatus >= 300) return json({ message: "GitHub temporarily unavailable" });
      posts.push(review);
      return json({ html_url: `${url}#pullrequestreview-${posts.length}` });
    }
    if (/\/pulls\/\d+$/.test(path)) return json({ title: "Replicated PR", body: "", merged: false, draft: false, labels: [], changed_files: 0,
      head: { sha: "a".repeat(40), repo: { full_name: "acme/demo" } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } });
    return json([]);
  };
  return { handler, posts, attempts, requests,
    set reviewStatus(value: number) { reviewStatus = value; },
    set beforePost(value: typeof beforePost) { beforePost = value; } };
}
async function app(t: TestContext, config: ReplicaConfig, endpoint = config.endpoint,
  respond: Parameters<typeof fixture>[1] = (_body, response) => tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] }),
  launch: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const runs: { child: import("node:child_process").ChildProcess; done: Promise<unknown>; output(): string }[] = [];
  // Register BEFORE fixture cleanup: graceful parent shutdown must reap its owned Litestream child.
  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill("SIGTERM");
        await run.done;
      }
      if (process.env.PRONTO_INTEGRATION_ARTIFACTS) await writeFile(join(process.env.PRONTO_INTEGRATION_ARTIFACTS,
        `${t.name.replace(/[^a-z0-9]/gi, "-")}-${run.child.pid}.log`), run.output());
    }
  });
  const gh = github();
  const f = await fixture(t, respond, { entrypoint: resolve("audit.ts"), github: gh.handler });
  const start = async (apply = false) => {
    const run = f.start(["serve", "--replicated-state", "--port", "0", ...(apply ? ["--apply"] : [])], { nodeArgs: launch.nodeArgs, env: {
      PRONTO_WEBHOOK_SECRET: webhookSecret, PRONTO_REPLICA_URL: `s3://${config.bucket}/${config.prefix}`, PRONTO_S3_ENDPOINT: endpoint,
      ...launch.env,
    } });
    let output = "";
    run.child.stdout.on("data", (data) => { output += data; });
    run.child.stderr.on("data", (data) => { output += data; });
    runs.push({ child: run.child, done: run.done, output: () => output });
    const base = await until(async () => {
      const match = /Listening on (http:\/\/127\.0\.0\.1:\d+)\/webhook/.exec(output);
      if (run.child.exitCode !== null) throw new Error(`Serve exited before listening: ${output}`);
      return match?.[1] ?? false;
    });
    return { ...run, base, get output() { return output; }, async stop() { run.child.kill("SIGTERM"); const result = await run.done; assert.equal(result.code, 0, result.stderr); } };
  };
  return { f, gh, start };
}
async function replaceOwner(storage: S3Control, expires = Date.now() + 60_000) {
  const head = (await storage.read())!;
  return storage.write({ ...head.record, revision: randomUUID(), owner: randomUUID(), phase: "bootstrapping", expires }, head);
}
async function releaseForeign(storage: S3Control) {
  const head = (await storage.read())!;
  await storage.write({ ...head.record, revision: randomUUID(), owner: null, phase: "idle", expires: 0 }, head);
}
const ready = (base: string) => until(async () => (await fetch(`${base}/readyz`)).status === 200);

// Authoring gate: real storage preconditions are the coordinator's prerequisite, not a simulated CAS contract.
test("RustFS rejects existing initialization and stale If-Match, including two competing writes", async (t) => {
  const { config, client } = await store(t);
  const input = { Bucket: config.bucket, Key: "preconditions" };
  const first = await client.send(new PutObjectCommand({ ...input, Body: "initial", IfNoneMatch: "*" }));
  await assert.rejects(client.send(new PutObjectCommand({ ...input, Body: "wrong", IfNoneMatch: "*" })), (error: any) => error.$metadata?.httpStatusCode === 412);
  const contenders = await Promise.allSettled(["A", "B"].map((Body) => client.send(new PutObjectCommand({ ...input, Body, IfMatch: first.ETag }))));
  assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(contenders.filter((r) => r.status === "rejected" && r.reason.$metadata.httpStatusCode === 412).length, 1);
  await assert.rejects(client.send(new PutObjectCommand({ ...input, Body: "stale", IfMatch: first.ETag })), (error: any) => error.$metadata?.httpStatusCode === 412);
  const final = await client.send(new GetObjectCommand(input));
  assert.ok(["A", "B"].includes(await final.Body!.transformToString()));
});

// Authoring gate: the existing crash/ambiguous-response tests use real, aligned clocks.
// These replays protect the distinct lease-margin and post-await deadline contracts.
// They run real serve, S3 CAS and Litestream; only JS clock/timer delivery is controlled.
async function controlledClock(directory: string, name: string, wall: number) {
  const path = join(directory, `${name}-clock.json`);
  const set = async (mono: number, wallNow: number, intervals = 0) => {
    // Atomic replacement prevents a child from observing a partially written JSON file.
    await writeFile(`${path}.next`, JSON.stringify({ mono, wall: wallNow, intervals }));
    await rename(`${path}.next`, path);
  };
  await set(0, wall);
  return { set, launch: { nodeArgs: ["--import", resolve("test/integration/controlled-clock.mjs")], env: { PRONTO_TEST_CLOCK: path } } };
}

for (const [skew, jump] of [[5_000, false], [10_000, false], [10_000, true]] as const)
  test(`Quint replay: ${skew}ms ${jump ? "forward clock jump" : "skew"} and the 5000ms local margin`, { timeout: 60_000 }, async (t) => {
  const { config, storage, directory } = await store(t);
  const base = Date.now();
  const aClock = await controlledClock(directory, "a", base);
  const bClock = await controlledClock(directory, "b", base);
  const a = await app(t, config, config.endpoint, undefined, aClock.launch);
  const first = await a.start(); await ready(first.base);
  const old = (await storage.read())!;
  assert.equal(old.record.expires, base + 30_000);
  await aClock.set(20_000, base + 20_000);
  await bClock.set(20_000, base + 20_000 + (jump ? 0 : skew));
  const p = await proxy(t);
  const b = await app(t, config, p.endpoint, undefined, bClock.launch);
  const second = await b.start();
  await until(async () => p.events.some((e) => e.method === "GET" && e.path.includes("control.json")));
  if (jump) {
    assert.equal((await fetch(`${second.base}/readyz`)).status, 503);
    await bClock.set(20_000, base + 30_000);
  }
  if (skew === 5_000) {
    assert.equal((await fetch(`${first.base}/readyz`)).status, 200);
    assert.equal((await fetch(`${second.base}/readyz`)).status, 503);
    assert.equal((await storage.read())!.record.owner, old.record.owner);
    assert.deepEqual(await readdir(join(b.f.stateDir, "terms")), []);
    // At the exact margin boundary, A fences itself before B becomes eligible.
    await aClock.set(25_000, base + 25_000);
    await bClock.set(25_000, base + 30_000);
    assert.equal((await fetch(`${first.base}/readyz`)).status, 503);
    await first.stop();
    await ready(second.base);
  } else {
    await ready(second.base);
    const successor = (await storage.read())!;
    assert.notEqual(successor.record.owner, old.record.owner);
    assert.equal((await fetch(`${first.base}/readyz`)).status, 200, "old term remains locally ready at monotonic 20s < 25s");
    assert.equal((await fetch(`${second.base}/readyz`)).status, 200, "successor is also locally ready");
    // This records a known limitation, not a guarantee of simultaneous protected effects.
    // The old term's fresh ownership barrier must still reject a new admission.
    assert.equal((await deliver(first.base, body, { id: "stale-ready-owner" })).status, 503);
    assert.deepEqual(a.gh.requests, ["GET /github/user"], "no unconfirmed worker can fetch GitHub evidence");
    assert.equal((await fetch(`${first.base}/readyz`)).status, 503);
    assert.equal((await storage.read())!.record.owner, successor.record.owner, "old cleanup cannot release B");
    await first.stop();
  }
  await second.stop();
});

test("Quint replay: an owner's backward wall-clock jump shortens the shared lease but not local authority", { timeout: 60_000 }, async (t) => {
  const { config, storage, directory } = await store(t);
  const base = Date.now();
  const bClock = await controlledClock(directory, "backward", base);
  const b = await app(t, config, config.endpoint, undefined, bClock.launch);
  const first = await b.start(); await ready(first.base);
  const old = (await storage.read())!;
  // At monotonic 5s, wall time jumps backwards by 10s. Deliver one renewal timer.
  await bClock.set(5_000, base - 5_000, 5_000);
  await until(async () => (await storage.read())!.record.expires === base + 25_000);
  await bClock.set(25_000, base + 15_000, 5_000);
  const aClock = await controlledClock(directory, "normal", base);
  await aClock.set(25_000, base + 25_000);
  const a = await app(t, config, config.endpoint, undefined, aClock.launch);
  const second = await a.start(); await ready(second.base);
  assert.notEqual((await storage.read())!.record.owner, old.record.owner);
  assert.equal((await fetch(`${first.base}/readyz`)).status, 200, "renewed local deadline is 30s, although shared expiry is 25s");
  assert.equal((await fetch(`${second.base}/readyz`)).status, 200);
  await first.stop(); await second.stop();
});

test("Quint replay: a successful renewal delivered at the old deadline cannot revive authority", { timeout: 60_000 }, async (t) => {
  const { config, storage, directory } = await store(t);
  const base = Date.now();
  const clock = await controlledClock(directory, "renewal", base);
  const p = await proxy(t);
  const a = await app(t, config, p.endpoint, undefined, clock.launch);
  const run = await a.start(); await ready(run.base);
  const previous = (await storage.read())!;
  const committed = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  t.after(() => unblock.resolve());
  let held = false;
  p.intercept = async (req, res) => {
    if (held || req.method !== "PUT" || !req.url!.includes("control.json")) return false;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const record = JSON.parse(bytes.toString());
    assert.equal(record.phase, "ready");
    assert.equal(record.owner, previous.record.owner);
    held = true;
    const target = new URL(process.env.PRONTO_S3_ENDPOINT!);
    const reply = await new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const upstream = request({ hostname: target.hostname, port: target.port, path: req.url, method: "PUT", headers: req.headers }, (response) => {
        const data: Buffer[] = []; response.on("data", (chunk: Buffer) => data.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(data) }));
      });
      upstream.on("error", reject); upstream.end(bytes);
    });
    assert.equal(reply.status, 200, "real RustFS committed the conditional renewal");
    committed.resolve();
    await unblock.promise;
    res.writeHead(reply.status, reply.headers).end(reply.body);
    return true;
  };
  await clock.set(20_000, base + 20_000, 5_000);
  await Promise.race([committed.promise, delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`No renewal reached RustFS: ${run.output}`); })]);
  assert.equal((await storage.read())!.record.expires, base + 50_000);
  await clock.set(25_000, base + 25_000, 5_000);
  unblock.resolve();
  await until(async () => run.output.includes("Owner term ended"));
  assert.equal((await fetch(`${run.base}/readyz`)).status, 503, "a successful PUT is not permission to extend an expired local deadline");
  await run.stop();
});

// Strongest oracle: independent SQLite contents and integrity, restored from fixed remote endpoints.
test("stock Litestream fixed restore during writes/compaction and independent new-prefix baseline", { timeout: 90_000 }, async (t) => {
  const { config, storage, client, directory } = await store(t);
  const source = `${config.prefix}/terms/${randomUUID()}`;
  const candidate = `${config.prefix}/terms/${randomUUID()}`;
  const root = join(directory, "A");
  await mkdir(dirname(repositoryDatabasePath(root, relative)), { recursive: true });
  const db = database(repositoryDatabasePath(root, relative));
  t.after(() => db.close());
  db.prepare("INSERT INTO operations VALUES(?, randomblob(4096))").run("confirmed");
  // Exercise stock compaction quickly through its public configuration, not a production test hook.
  const ipc = await mkdtemp(join(tmpdir(), "pronto-source-"));
  const socket = join(ipc, "ipc.sock");
  const yaml = join(ipc, "source.yml");
  await writeFile(yaml, `socket:\n  enabled: true\n  path: ${JSON.stringify(socket)}\nretention:\n  enabled: false\nauto-recover: false\nlevels:\n  - interval: 2s\n  - interval: 4s\n  - interval: 8s\nsnapshot:\n  interval: 4s\n  retention: 3s\nl0-retention: 2s\nl0-retention-check-interval: 1s\ndbs: []\n`);
  const child = spawn(config.binary, ["replicate", "-config", yaml], { stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit"); child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await done; clearTimeout(force);
    }
    await rm(ipc, { recursive: true, force: true });
  });
  await until(async () => { try { await exec(config.binary, ["info", "-socket", socket]); return true; } catch { return false; } });
  await exec(config.binary, ["register", "-socket", socket, "-replica", replicaURL(config, `${source}/${relative}`), repositoryDatabasePath(root, relative)]);
  await exec(config.binary, ["sync", "-socket", socket, "-wait", repositoryDatabasePath(root, relative)]);
  const point = (await storage.inventory(source))[0]!;
  const writer = setInterval(() => db.prepare("INSERT INTO operations VALUES(?, randomblob(4096))").run(randomUUID()), 30);
  t.after(() => clearInterval(writer));
  await delay(4_500); // Cross multiple real compaction and local cleanup intervals while writing.
  await until(async () => {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const objects = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${source}/${relative}/0001/` }));
    return (objects.Contents?.length ?? 0) > 0;
  });
  const restored = await restore(config, source, relative, point.txid, join(directory, "fixed"));
  assert.deepEqual(rows(restored), ["confirmed"]);
  const bRoot = join(directory, "B");
  await restore(config, source, relative, point.txid, bRoot);
  const b = new Litestream(config, bRoot, candidate, new AbortController().signal, (error) => { throw error; });
  await b.start(); t.after(() => b.close());
  await b.enroll(relative); await b.flush();
  const bPoint = (await storage.inventory(candidate))[0]!;
  const independentProxy = await proxy(t);
  independentProxy.intercept = async (req, res) => {
    if (req.url!.includes(source)) { res.writeHead(403).end(); return true; }
    return false;
  };
  const independent = await restore({ ...config, endpoint: independentProxy.endpoint }, candidate, relative, bPoint.txid, join(directory, "independent"));
  assert.deepEqual(rows(independent), ["confirmed"]);
  await assert.rejects(restore(config, source, relative, "7fffffffffffffff", join(directory, "missing")));
  clearInterval(writer);
});

test("competing serve contenders, new repository admission and deduplication survive takeover", { timeout: 100_000 }, async (t) => {
  const { config, storage, directory } = await store(t);
  const p = await proxy(t);
  const a = await app(t, config, p.endpoint);
  const b = await app(t, config, p.endpoint);
  const [one, two] = await Promise.all([a.start(), b.start()]);
  await until(async () => {
    const states = await Promise.all([one, two].map(async (run) => (await fetch(`${run.base}/readyz`)).status));
    assert.ok(states.filter((s) => s === 200).length <= 1);
    return states.includes(200);
  });
  const primary = (await fetch(`${one.base}/readyz`)).status === 200 ? one : two;
  const standby = primary === one ? two : one;
  const standbyApp = primary === one ? b : a;
  assert.equal((await fetch(`${standby.base}/healthz`)).status, 200);
  assert.equal((await deliver(standby.base, body)).status, 503);
  assert.deepEqual((await readdir(join(standbyApp.f.stateDir, "terms"))), []);
  const mark = p.events.length;
  const accepted = await deliver(primary.base, body, { id: "durable-delivery" });
  assert.equal(accepted.status, 202);
  const operations = p.events.slice(mark);
  const upload = operations.findIndex((e) => e.method === "PUT" && e.path.includes(".ltx"));
  assert.ok(upload >= 0);
  assert.ok(operations.slice(upload + 1).some((e) => e.method === "GET" && e.path.includes("control.json")), "fresh ownership GET follows actual upload before 202");
  await primary.stop();
  await ready(standby.base);
  const duplicate = await deliver(standby.base, body, { id: "durable-delivery" });
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });
  const current = (await storage.read())!;
  const points = await storage.inventory(current.record.recovery!);
  assert.equal(points.length, 1);
  const independent = await restore(config, current.record.recovery!, relative, points[0]!.txid, join(directory, "verify"));
  const check = new DatabaseSync(independent, { readOnly: true });
  assert.equal(check.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok"); check.close();
  await standby.stop();
  const released = (await storage.read())!;
  assert.equal(released.record.owner, null);
  assert.equal(released.record.phase, "idle");
  assert.equal(released.record.recovery, current.record.recovery);
});

test("a crashed owner is replaced only after lease expiry, without reusing its still-live child prefix", { timeout: 80_000 }, async (t) => {
  const { config, storage } = await store(t);
  let orphan: number | undefined;
  t.after(() => { if (orphan) { try { process.kill(orphan, "SIGTERM"); } catch {} } });
  const a = await app(t, config);
  const first = await a.start(); await ready(first.base);
  assert.equal((await deliver(first.base, body, { id: "survive-parent-crash" })).status, 202);
  const source = (await storage.read())!;
  const { stdout } = await exec("pgrep", ["-P", String(first.child.pid)]);
  orphan = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(orphan) && orphan > 0);
  first.child.kill("SIGKILL");
  const crashed = await first.done;
  assert.equal(crashed.signal, "SIGKILL");
  const b = await app(t, config);
  const successor = await b.start();
  assert.equal((await fetch(`${successor.base}/readyz`)).status, 503);
  assert.equal((await deliver(successor.base, body)).status, 503);
  assert.deepEqual(await readdir(join(b.f.stateDir, "terms")), []);
  assert.equal((await storage.read())!.record.owner, source.record.owner);
  await until(async () => (await fetch(`${successor.base}/readyz`)).status === 200, 45_000);
  const current = (await storage.read())!;
  assert.notEqual(current.record.owner, source.record.owner);
  assert.notEqual(current.record.recovery, source.record.recovery);
  const duplicate = await deliver(successor.base, body, { id: "survive-parent-crash" });
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });
  process.kill(orphan, "SIGTERM"); orphan = undefined;
  await successor.stop();
});

// The protocol gate executes these same abstract schedules in TLC and the original
// Python graph. Here the schedule chooses the actual signed transport boundary.
// SQLite commits, daemon IPC and cleanup add unmodelled steps; this is trace
// correspondence at two observation points, not implementation refinement.
const admissionSchedules: { name: string; actions: string[]; acknowledges: boolean }[] =
  JSON.parse(await readFile(new URL("../../protocol/schedules.json", import.meta.url), "utf8"));
for (const schedule of admissionSchedules) test(schedule.name, { timeout: 70_000 }, async (t) => {
  const { config, storage } = await store(t);
  const p = await proxy(t);
  const a = await app(t, config, p.endpoint);
  const run = await a.start(); await ready(run.base);
  const boundary = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  const holdObservation = schedule.actions.includes("Observe(0)");
  let held = false;
  t.after(() => unblock.resolve());
  p.intercept = async (req, res) => {
    if (!holdObservation) {
      if (req.method === "PUT" && req.url!.includes(".ltx")) { boundary.resolve(); await unblock.promise; }
      return false;
    }
    if (held || req.method !== "GET" || !req.url!.includes("control.json") || !p.events.some((e) => e.method === "PUT" && e.path.includes(".ltx"))) return false;
    held = true;
    // Read RustFS NOW, delay only its already-successful response to the old owner.
    const upstream = new URL(process.env.PRONTO_S3_ENDPOINT!);
    const response = await new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
      const call = request({ hostname: upstream.hostname, port: upstream.port, path: req.url, headers: req.headers }, (reply) => {
        const chunks: Buffer[] = []; reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("end", () => resolve({ status: reply.statusCode!, headers: reply.headers, body: Buffer.concat(chunks) }));
      });
      call.on("error", reject); call.end();
    });
    assert.equal(response.status, 200);
    boundary.resolve();
    await unblock.promise;
    res.writeHead(response.status, response.headers).end(response.body);
    return true;
  };
  const admission = deliver(run.base, body, { id: "model-scheduled-delivery" });
  await boundary.promise;
  const next = await replaceOwner(storage);
  unblock.resolve();
  assert.equal((await admission).status, schedule.acknowledges ? 202 : 503);
  if (!schedule.acknowledges) {
    assert.equal((await fetch(`${run.base}/readyz`)).status, 503);
    assert.equal((await fetch(`${run.base}/healthz`)).status, 200);
    assert.deepEqual(a.gh.requests, ["GET /github/user"], "unconfirmed admission cannot begin GitHub evidence fetches");
    assert.equal((await storage.read())!.record.owner, next.record.owner, "old cleanup cannot release a successor");
  }
  await run.stop();
  if (schedule.acknowledges) {
    await releaseForeign(storage);
    const b = await app(t, config);
    const successor = await b.start(); await ready(successor.base);
    const duplicate = await deliver(successor.base, body, { id: "model-scheduled-delivery" });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { status: "duplicate" });
    await successor.stop();
  }
});

// Reads actual committed application state, never supplies receipts or callback ordering.
async function publications(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    const document = db.prepare("SELECT id FROM documents WHERE json_extract(record, '$.kind')='app.audit-publications'").get();
    if (!document) return undefined;
    const revisions = db.prepare("SELECT kind, content FROM document_revisions WHERE document_id=? ORDER BY seq").all(document.id!);
    const { apply } = await import("@earendil-works/chord/delta");
    let value: any;
    for (const revision of revisions) value = revision.kind === "base" ? JSON.parse(String(revision.content)) : apply(value, JSON.parse(String(revision.content)));
    return Object.values(value.pending) as { attempted: boolean; failed: boolean; intent: { choices: { apply: boolean } } }[];
  } finally { db.close(); }
}

// The GitHub POST itself is the observation point: independent remote restore must already contain attempted=true.
test("publication attempt marker is independently restorable before GitHub POST", { timeout: 70_000 }, async (t) => {
  const { config, storage, directory } = await store(t);
  const a = await app(t, config);
  const checked = Promise.withResolvers<void>();
  a.gh.beforePost = async () => {
    const head = (await storage.read())!;
    const point = (await storage.inventory(head.record.recovery!))[0]!;
    const path = await restore(config, head.record.recovery!, relative, point.txid, join(directory, "before-post"));
    try {
      const pending = await publications(path);
      assert.ok(pending, "independently restored database must contain the publication");
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.attempted, true);
      assert.equal(pending[0]!.intent.choices.apply, true);
      checked.resolve();
    } catch (error) { checked.reject(error); throw error; }
  };
  const run = await a.start(true); await ready(run.base);
  assert.equal((await deliver(run.base, body)).status, 202);
  await Promise.race([checked.promise, delay(15_000, undefined, { ref: false }).then(() => { throw new Error(`Publication did not reach POST: ${run.output}`); })]);
  await until(async () => a.gh.posts.length === 1);
  await run.stop();
});

test("an unconfirmed publication attempt cannot send the GitHub review POST", { timeout: 60_000 }, async (t) => {
  const { config, storage } = await store(t);
  const p = await proxy(t);
  const a = await app(t, config, p.endpoint, (_body, response) => {
    // Worker intake is already confirmed. Fail real uploads only after the model starts.
    p.intercept = async (req, res) => {
      if (req.method === "PUT" && req.url!.includes(".ltx")) { res.writeHead(503).end(); return true; }
      return false;
    };
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });
  });
  const run = await a.start(true); await ready(run.base);
  const owner = (await storage.read())!.record.owner!;
  assert.equal((await deliver(run.base, body)).status, 202);
  await until(async () => (await fetch(`${run.base}/readyz`)).status === 503);
  const pending = await publications(repositoryDatabasePath(join(a.f.stateDir, "terms", owner), relative));
  assert.ok(pending?.some((item) => item.attempted), "the attempted marker really committed locally before the failed barrier");
  assert.equal(a.gh.posts.length, 0);
  await run.stop();
});

// Authoring gate: startup-retry CLI tests do not exercise a live primary whose
// GitHub outage heals without restart. A terminal publication stays pending;
// another actual webhook re-admits it. No production retry seam or fake receipt.
test("GitHub recovery alone leaves failed publication pending; a new webhook retries it in the same term", { timeout: 70_000 }, async (t) => {
  const { config, storage } = await store(t);
  let modelCalls = 0;
  const a = await app(t, config, config.endpoint, (_body, response) => {
    modelCalls++;
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });
  });
  a.gh.reviewStatus = 503;
  const run = await a.start(true); await ready(run.base);
  const owner = (await storage.read())!.record.owner!;
  const path = repositoryDatabasePath(join(a.f.stateDir, "terms", owner), relative);
  assert.equal((await deliver(run.base, body, { id: "failed-publication" })).status, 202);
  await until(async () => (await publications(path))?.some((item) => item.failed && item.attempted) ?? false);
  assert.equal(a.gh.attempts.length, 1);
  assert.equal(a.gh.posts.length, 0);

  // Observe a real successful lease renewal after GitHub heals, not just a sleep.
  a.gh.reviewStatus = 200;
  const before = (await storage.read())!;
  await until(async () => (await storage.read())!.record.revision !== before.record.revision);
  const after = (await storage.read())!;
  assert.equal(after.record.owner, owner);
  assert.equal((await fetch(`${run.base}/readyz`)).status, 200);
  assert.equal(a.gh.attempts.length, 1, "a healthy primary does not automatically rerun a terminal publisher");
  assert.ok((await publications(path))?.some((item) => item.failed));

  assert.equal((await deliver(run.base, body, { id: "retry-publication" })).status, 202);
  await until(async () => a.gh.posts.length === 1);
  await until(async () => (await publications(path))?.length === 0);
  assert.equal(a.gh.attempts.length, 2);
  assert.equal(modelCalls, 1, "re-admission publishes the saved assessment rather than requiring a new model result");
  assert.equal((await storage.read())!.record.owner, owner);
  await run.stop();
});

// Process incarnation failure must create a different prefix, never restart a child against the same history.
test("Litestream death ends the term and creates a fresh independently recoverable prefix", { timeout: 70_000 }, async (t) => {
  const { config, storage } = await store(t);
  const a = await app(t, config);
  const run = await a.start(); await ready(run.base);
  assert.equal((await deliver(run.base, body, { id: "survive-child" })).status, 202);
  const before = (await storage.read())!;
  const { stdout } = await exec("pgrep", ["-P", String(run.child.pid)]);
  const pids = stdout.trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 1, "the owner runs one Litestream child");
  process.kill(pids[0]!, "SIGKILL");
  await until(async () => { const current = await storage.read(); return current?.record.phase === "ready" && current.record.owner !== before.record.owner; });
  const after = (await storage.read())!;
  assert.notEqual(after.record.recovery, before.record.recovery);
  assert.match(run.output, /Owner term ended; admission disabled and work interrupted: Error: Litestream child exited; ending owner term/);
  const duplicate = await deliver(run.base, body, { id: "survive-child" });
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { status: "duplicate" });
  await run.stop();
});

test("an already-running repository cannot dispatch a newly unconfirmed admission", { timeout: 60_000 }, async (t) => {
  const { config } = await store(t);
  const p = await proxy(t);
  const a = await app(t, config, p.endpoint);
  const run = await a.start(); await ready(run.base);
  assert.equal((await deliver(run.base, body)).status, 202);
  await until(async () => /Preview only/.test(run.output));
  p.intercept = async (req, res) => {
    if (req.method === "PUT" && req.url!.includes(".ltx")) { res.writeHead(503).end(); return true; }
    return false;
  };
  const next = await deliver(run.base, reviewRequested("me", "https://github.com/acme/demo/pull/8"), { id: "unconfirmed-worker" });
  assert.equal(next.status, 503);
  assert.ok(!a.gh.requests.some((path) => path.includes("/pulls/8")), "worker-side barrier must precede GitHub evidence dispatch even when the harness is already running");
  await run.stop();
});

test("interrupted partial bootstrap preserves the complete source and a successor discovers every repository", { timeout: 90_000 }, async (t) => {
  const { config, storage } = await store(t);
  const a = await app(t, config);
  const first = await a.start(); await ready(first.base);
  assert.equal((await deliver(first.base, body, { id: "repo-one" })).status, 202);
  const secondBody = reviewRequested("me", "https://github.com/other/repo/pull/9");
  assert.equal((await deliver(first.base, secondBody, { id: "repo-two" })).status, 202);
  await first.stop();
  const source = (await storage.read())!.record.recovery;
  assert.equal((await storage.inventory(source!)).length, 2);
  const p = await proxy(t);
  p.intercept = async (req, res) => {
    if (req.method === "PUT" && req.url!.includes("other~repo.sqlite") && req.url!.includes(".ltx")) { res.writeHead(503).end(); return true; }
    return false;
  };
  const b = await app(t, config, p.endpoint);
  const partial = await b.start();
  await until(async () => p.events.some((e) => e.method === "PUT" && e.path.includes("acme~demo.sqlite") && e.path.includes(".ltx")));
  const boot = (await storage.read())!;
  assert.equal(boot.record.phase, "bootstrapping");
  assert.equal(boot.record.recovery, source);
  assert.equal((await fetch(`${partial.base}/readyz`)).status, 503);
  assert.equal((await deliver(partial.base, body)).status, 503);
  assert.deepEqual(b.gh.requests, ["GET /github/user"], "bootstrap cannot execute recovered tasks");
  await partial.stop();
  assert.equal((await storage.read())!.record.recovery, source);
  const c = await app(t, config);
  const successor = await c.start(); await ready(successor.base);
  for (const [payload, id] of [[body, "repo-one"], [secondBody, "repo-two"]]) {
    const response = await deliver(successor.base, payload!, { id });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "duplicate" });
  }
  const complete = (await storage.read())!.record.recovery!;
  assert.notEqual(complete, source);
  assert.equal((await storage.inventory(complete)).length, 2);
  await successor.stop();
});

test("source restore denial cannot promote or substitute an empty database", { timeout: 60_000 }, async (t) => {
  const { config, storage } = await store(t);
  const a = await app(t, config);
  const first = await a.start(); await ready(first.base);
  assert.equal((await deliver(first.base, body, { id: "must-restore" })).status, 202);
  await first.stop();
  const source = (await storage.read())!.record.recovery!;
  const p = await proxy(t);
  let denied = false;
  p.intercept = async (req, res) => {
    if (req.method === "GET" && req.url!.includes(".ltx")) { denied = true; res.writeHead(403).end(); return true; }
    return false;
  };
  const b = await app(t, config, p.endpoint);
  const broken = await b.start();
  await until(async () => denied);
  assert.equal((await fetch(`${broken.base}/readyz`)).status, 503);
  assert.equal((await deliver(broken.base, body)).status, 503);
  assert.deepEqual(b.gh.requests, ["GET /github/user"]);
  assert.equal((await storage.read())!.record.recovery, source);
  await broken.stop();
});

// Lost successful renewal response must stop the owner even though RustFS committed the lease extension.
test("ambiguous renewal makes serve unready, aborts active work, stops its child and preserves recovery", { timeout: 70_000 }, async (t) => {
  const { config, storage } = await store(t);
  const p = await proxy(t);
  const started = Promise.withResolvers<void>();
  let modelAborted = false;
  const a = await app(t, config, p.endpoint, (_body, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": running\n\n");
    response.once("close", () => { modelAborted = true; });
    started.resolve();
  });
  const run = await a.start(); await ready(run.base);
  assert.equal((await deliver(run.base, body, { id: "before-uncertainty" })).status, 202);
  await started.promise;
  const before = (await storage.read())!;
  const lost = Promise.withResolvers<void>();
  p.intercept = async (req, res) => {
    if (req.method !== "PUT" || !req.url!.includes("control.json")) return false;
    const backend = new URL(process.env.PRONTO_S3_ENDPOINT!);
    await new Promise<void>((resolve, reject) => {
      const call = request({ hostname: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: req.headers }, (response) => {
        response.resume(); response.on("end", () => { assert.equal(response.statusCode, 200); resolve(); });
      });
      call.on("error", reject); req.pipe(call);
    });
    res.destroy(); lost.resolve(); return true;
  };
  await lost.promise;
  await until(async () => (await fetch(`${run.base}/readyz`)).status === 503);
  assert.equal((await deliver(run.base, body)).status, 503);
  await until(async () => modelAborted);
  assert.match(run.output, /Owner term ended; admission disabled and work interrupted: .*ECONNRESET/);
  assert.equal(a.gh.posts.length, 0);
  await until(async () => { try { await exec("pgrep", ["-P", String(run.child.pid)]); return false; } catch { return true; } });
  const retained = (await storage.read())!;
  assert.equal(retained.record.recovery, before.record.recovery);
  await run.stop();
});

// Authoring gate: no existing case covers promotion uncertainty or a same-owner
// revision conflict (a tempting fresh-ETag retry would succeed). Use real CAS and
// real lost responses, not a fake that declares stale requests rejected. The
// existing ambiguous-renewal test remains the owner of active-work cancellation.
for (const fault of ["promotion-conflict", "promotion-ambiguous", "renewal-conflict"] as const) {
  test(`${fault} ends the term without rebasing a stale control mutation`, { timeout: 90_000 }, async (t) => {
    const { config, storage } = await store(t);
    const seed = await app(t, config);
    const first = await seed.start(); await ready(first.base);
    assert.equal((await deliver(first.base, body, { id: "before-control-fault" })).status, 202);
    await first.stop();
    const source = (await storage.read())!.record.recovery!;
    const p = await proxy(t);
    const injected = Promise.withResolvers<{ owner: string; recovery: string; revision: string }>();
    const mutations: { owner: string | null; phase: string; revision: string; status: number }[] = [];
    let faultOwner: string | undefined;
    let faultIndex = -1;
    p.intercept = async (req, res) => {
      if (req.method !== "PUT" || !req.url!.includes("control.json")) return false;
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const record = JSON.parse(bytes.toString());
      // Do not let the runtime hide a fail-open term by promptly acquiring a new one.
      if (faultOwner && record.owner && record.owner !== faultOwner) { res.writeHead(503).end(); return true; }
      const previous = (await storage.read())!;
      const target = !faultOwner && previous.record.owner === record.owner && record.phase === "ready"
        && previous.record.phase === (fault === "renewal-conflict" ? "ready" : "bootstrapping");
      if (target) {
        faultOwner = record.owner;
        faultIndex = mutations.length;
        if (fault !== "promotion-ambiguous") {
          // Change ONLY the revision under the same owner. Blind rebasing would
          // now be allowed by S3, so rejection cannot be credited to term checks.
          await storage.write({ ...previous.record, revision: randomUUID() }, previous);
        }
      }
      const backend = new URL(process.env.PRONTO_S3_ENDPOINT!);
      const reply = await new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
        const call = request({ hostname: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: req.headers }, (response) => {
          const parts: Buffer[] = []; response.on("data", (part: Buffer) => parts.push(part));
          response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(parts) }));
        });
        call.on("error", reject); call.end(bytes);
      });
      mutations.push({ owner: record.owner, phase: record.phase, revision: record.revision, status: reply.status });
      if (target) {
        assert.equal(reply.status, fault === "promotion-ambiguous" ? 200 : 412);
        const actual = (await storage.read())!.record;
        injected.resolve({ owner: record.owner, recovery: actual.recovery!, revision: actual.revision });
        if (fault === "promotion-ambiguous") { res.destroy(); return true; }
      }
      res.writeHead(reply.status, reply.headers).end(reply.body);
      return true;
    };
    const a = await app(t, config, p.endpoint);
    const run = await a.start();
    if (fault === "renewal-conflict") await ready(run.base);
    const actual = await injected.promise;
    await until(async () => (await fetch(`${run.base}/readyz`)).status === 503);
    assert.equal((await deliver(run.base, body)).status, 503);
    await until(async () => { try { await exec("pgrep", ["-P", String(run.child.pid)]); return false; } catch { return true; } });
    await run.stop();
    assert.equal(mutations.slice(faultIndex).filter((m) => m.owner === actual.owner && m.phase !== "idle").length, 1,
      "an uncertain mutation must not re-read/retry; fresh-read idle cleanup is a separate operation");
    assert.equal((await storage.read())!.record.recovery, actual.recovery);
    if (fault === "promotion-ambiguous") assert.notEqual(actual.recovery, source, "successful promotion really committed before its response was lost");
    else if (fault === "promotion-conflict") assert.equal(actual.recovery, source);
    if (process.env.PRONTO_INTEGRATION_ARTIFACTS) await writeFile(join(process.env.PRONTO_INTEGRATION_ARTIFACTS, `${fault}.json`), JSON.stringify(mutations, null, 2));
    const b = await app(t, config);
    const successor = await b.start(); await ready(successor.base);
    const duplicate = await deliver(successor.base, body, { id: "before-control-fault" });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { status: "duplicate" });
    await successor.stop();
  });
}
