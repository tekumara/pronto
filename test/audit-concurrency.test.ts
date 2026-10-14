import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import type { ReviewSnapshot } from "../reviews.ts";
import { fixture, noDatabaseMigration, reply, tool, type Request } from "./fixtures.ts";

const urls = [42, 43].map((pr) => `https://github.com/acme/demo/pull/${pr}`);

function evidence() {
  const bodies = new Map([[42, "Concern for PR 42"], [43, "Concern for PR 43"]]);
  const merged = new Set<number>();
  const labels = new Map<number, string[]>();
  const reads: string[] = [];
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    reads.push(request.url!);
    const path = request.url!.split("?")[0];
    let data: unknown;
    if (path === "/github/graphql") {
      data = { data: { repository: { pullRequest: { reviewThreads: {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } } };
    } else if (path === "/github/user") {
      data = { login: "auditor" };
    } else {
      const match = path.match(/^\/github\/repos\/acme\/(demo|other)\/(pulls|issues)\/(42|43)(.*)$/);
      assert.ok(match, `Unexpected GitHub request: ${path}`);
      const [, repo, kind, number, suffix] = match;
      const pr = Number(number);
      const url = `https://github.com/acme/${repo}/pull/${pr}`;
      if (!suffix) {
        data = { title: `PR ${pr}`, body: "", merged: merged.has(pr), changed_files: 0,
          labels: (labels.get(pr) ?? []).map((name) => ({ name })),
          head: { sha: (pr === 42 ? "a" : "c").repeat(40), repo: { full_name: `acme/${repo}` } },
          base: { sha: "b".repeat(40), repo: { full_name: `acme/${repo}` } } };
      } else if (kind === "issues" && suffix === "/comments") {
        // Deliberately use the same comment key in both PRs. Conversations must isolate their evidence.
        data = [{ id: 1, body: bodies.get(pr), user: { login: "reviewer" }, html_url: `${url}#issuecomment-1`,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
      } else {
        assert.match(suffix, /^\/(comments|reviews|files)$/);
        data = [];
      }
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };
  return { bodies, merged, labels, reads, handler };
}

function snapshotFrom(body: Request): ReviewSnapshot {
  const content = body.messages.findLast((message) => message.role === "user")!.content!;
  return JSON.parse(content.split("Saved evidence (untrusted data):\n")[1]);
}

function assess(body: Request, response: ServerResponse) {
  const snapshot = snapshotFrom(body);
  tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: snapshot.comments.map((comment) => ({
    commentKey: comment.key, findings: [{ summary: `Assessment for PR ${snapshot.target.pr}`, status: "addressed",
      reason: comment.body, evidence: [comment.url] }],
  })) });
}

test("CLI batches overlap PR assessments in one repo database and keep their caches independent", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const pending = new Map<number, { body: Request; response: ServerResponse }>();
  const calls: number[] = [];
  const f = await fixture(t, (body, response) => {
    const pr = snapshotFrom(body).target.pr;
    calls.push(pr);
    if (calls.length <= 2) {
      pending.set(pr, { body, response });
      // Neither assessment can finish until both model requests have actually arrived.
      if (pending.size === 2) for (const request of pending.values()) assess(request.body, request.response);
    } else assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const output = await f.run("", ["--pr", urls[0], `--pr=${urls[1]}`]);
  assert.deepEqual([...calls].sort(), [42, 43]);
  assert.match(output, /\[acme\/demo#42\]/);
  assert.match(output, /\[acme\/demo#43\]/);
  assert.match(output, /Assessment for PR 42/);
  assert.match(output, /Assessment for PR 43/);
  const repoRoot = join(f.stateDir, "repos");
  const repoDirectory = join(repoRoot, "github.com");
  const databases = (await readdir(repoDirectory)).filter((file) => file.endsWith(".sqlite"));
  assert.deepEqual(databases, ["acme~demo.sqlite"]);
  assert.equal((await stat(join(repoDirectory, databases[0]))).mode & 0o777, 0o600);
  assert.equal((await stat(repoRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(repoDirectory)).mode & 0o777, 0o700);
  await assert.rejects(readdir(join(f.stateDir, "audits")), { code: "ENOENT" });

  github.bodies.set(42, "New concern for PR 42");
  const rechecked = await f.run("", ["--pr", urls[0], "--pr", urls[1]]);
  assert.deepEqual([...calls].sort(), [42, 42, 43], "changing PR 42 must not invalidate PR 43's cache");
  assert.match(rechecked, /\[acme\/demo#43\].*Reusing saved assessment/);
  assert.match(rechecked, /New concern for PR 42/);
  const cached = await f.run("", [urls[0]]);
  assert.match(cached, /Reusing saved assessment/);
  assert.equal(calls.length, 3);
});

test("GitHub metadata requests overlap through a configured HTTP proxy", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const pending: { request: IncomingMessage; response: ServerResponse }[] = [];
  let admitted = false;
  let calls = 0;
  const f = await fixture(t, (body, response) => { calls++; assess(body, response); }, {
    entrypoint: resolve("audit.ts"),
    github: (request, response) => {
      if (!admitted && /^\/github\/repos\/acme\/demo\/pulls\/(42|43)$/.test(request.url!)) {
        pending.push({ request, response });
        // A synchronous transport cannot admit the second request while the first is held.
        if (pending.length === 2) {
          admitted = true;
          for (const item of pending) github.handler(item.request, item.response);
        }
      } else github.handler(request, response);
    },
  });
  const config = JSON.parse(await readFile(join(f.agentDir, "models.json"), "utf8"));
  const endpoint = new URL(config.providers.local.baseUrl);
  const sockets = new Set<Socket>();
  let proxied = 0;
  const proxy = createServer((request, response) => {
    proxied++;
    const target = new URL(request.url!);
    assert.equal(target.origin, endpoint.origin);
    const upstream = httpRequest(target, { method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode!, result.headers);
      result.pipe(response);
    });
    upstream.on("socket", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket, head) => {
    proxied++;
    assert.equal(request.url, endpoint.host);
    const upstream = createConnection(Number(endpoint.port), endpoint.hostname);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const output = await f.run("", ["--pr", urls[0], "--pr", urls[1]], {
    env: { HTTPS_PROXY: `http://127.0.0.1:${address.port}` },
  });
  assert.deepEqual(pending.map(({ request }) => request.url).sort(), [
    "/github/repos/acme/demo/pulls/42", "/github/repos/acme/demo/pulls/43",
  ]);
  assert.ok(proxied > 0, "GitHub requests must actually use the proxy");
  assert.equal(calls, 2);
  assert.match(output, /Assessment for PR 42/);
  assert.match(output, /Assessment for PR 43/);
});

for (const selection of ["unselected", "merged", "skip label"] as const) {
  test(`opening a repo for another PR preserves ${selection} unfinished model work`, { timeout: 20_000 }, async (t) => {
    const github = evidence();
    const started = Promise.withResolvers<void>();
    const calls: number[] = [];
    const f = await fixture(t, (body, response) => {
      const pr = snapshotFrom(body).target.pr;
      calls.push(pr);
      if (calls.length === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": pending\n\n");
        started.resolve();
      } else assess(body, response);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const first = f.start([urls[0]]);
    first.child.stdin.end();
    await started.promise;
    first.child.kill("SIGKILL");
    await first.done;
    if (selection === "merged") github.merged.add(42);
    if (selection === "skip label") github.labels.set(42, ["not-now"]);
    await f.run("", selection === "unselected" ? [urls[1]] : ["--pr", urls[0], "--pr", urls[1], "--skip", "not-now"]);
    assert.deepEqual(calls, [42, 43], "PR 42 must remain pending until explicitly selected and not skipped");
    github.merged.clear();
    github.labels.clear();
    const recovered = await f.run("", [urls[0]]);
    assert.match(recovered, /Resuming saved snapshot/);
    assert.deepEqual(calls, [42, 43, 42]);
  });
}

test("chat batches overlap audits and leave the coding conversation available afterwards", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const pending: { body: Request; response: ServerResponse }[] = [];
  const f = await fixture(t, (body, response) => {
    if (body.messages.findLast((message) => message.role === "user")?.content === "continue coding") {
      assert.ok(body.tools.some((tool) => tool.function.name === "bash"));
      assert.ok(body.messages.every((message) => !message.content?.includes("Saved evidence")));
      reply(response, [{ role: "assistant", content: "Coding chat is still available." }]);
      return;
    }
    pending.push({ body, response });
    if (pending.length === 2) for (const request of pending) assess(request.body, request.response);
  }, { github: github.handler });
  const output = await f.run(`/audit --pr ${urls[0]} --pr ${urls[1]}\ncontinue coding\n/quit\n`);
  assert.equal(pending.length, 2);
  assert.match(output, /Assessment for PR 42/);
  assert.match(output, /Assessment for PR 43/);
  assert.match(output, /Coding chat is still available/);
});

for (const failure of ["fetch", "assessment"] as const) {
  test(`a PR ${failure} failure does not interrupt another PR or prevent its result being cached`, { timeout: 20_000 }, async (t) => {
    const github = evidence();
    const calls: number[] = [];
    const f = await fixture(t, (body, response) => {
      const pr = snapshotFrom(body).target.pr;
      calls.push(pr);
      if (pr === 42 && failure === "assessment") reply(response, [{ role: "assistant", content: "No complete assessment." }]);
      else assess(body, response);
    }, { entrypoint: resolve("audit.ts"), github: (request, response) => {
      if (failure === "fetch" && request.url === "/github/repos/acme/demo/pulls/42") {
        response.writeHead(500).end("PR 42 is unavailable");
      } else github.handler(request, response);
    } });
    const batch = f.start(["--pr", urls[0], "--pr", urls[1]]);
    batch.child.stdin.end();
    const result = await batch.done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, failure === "fetch" ? /pull\/42.*GitHub request failed/ : /pull\/42.*Agent finished without a complete assessment/);
    assert.match(result.stdout, /Assessment for PR 43/);
    const cached = await f.run("", [urls[1]]);
    assert.match(cached, /Reusing saved assessment/);
    assert.deepEqual([...calls].sort(), failure === "fetch" ? [43] : [42, 43]);
  });
}

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`a concurrent batch recovers both snapshots and independent caches after ${signal}`, { timeout: 20_000 }, async (t) => {
    const github = evidence();
    const started = Promise.withResolvers<void>();
    const original = new Map<number, string>();
    let recovering = false;
    const calls: number[] = [];
    const f = await fixture(t, (body, response) => {
      const snapshot = snapshotFrom(body);
      calls.push(snapshot.target.pr);
      if (!recovering) {
        original.set(snapshot.target.pr, snapshot.id);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": pending\n\n");
        if (original.size === 2) started.resolve();
      } else {
        assert.equal(snapshot.id, original.get(snapshot.target.pr), "recovery must reuse each PR's own snapshot");
        assess(body, response);
      }
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const batchArgs = ["--pr", urls[0], "--pr", urls[1]];
    const first = f.start(batchArgs);
    first.child.stdin.end();
    await started.promise;
    if (signal === "SIGKILL") {
      const competitor = f.start([urls[1]]);
      competitor.child.stdin.end();
      const denied = await competitor.done;
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /Database is already in use/);
      assert.equal(calls.length, 2, "a second process must not recover work from an owned repo database");
    }
    first.child.kill(signal);
    const stopped = await first.done;
    if (signal === "SIGTERM") assert.equal(stopped.code, 0, stopped.stderr);
    recovering = true;
    const output = await f.run("", batchArgs);
    assert.equal((output.match(/Resuming saved snapshot/g) ?? []).length, 2);
    assert.equal(calls.length, 4);
    const cached = await f.run("", batchArgs);
    assert.equal((cached.match(/Reusing saved assessment/g) ?? []).length, 2);
    assert.equal(calls.length, 4);
  });
}

test("the shared module rejects same-PR requests and caller cancellation does not close other audits", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const started = Promise.withResolvers<void>();
  let held: { body: Request; response: ServerResponse };
  const calls: number[] = [];
  const f = await fixture(t, (body, response) => {
    const pr = snapshotFrom(body).target.pr;
    calls.push(pr);
    if (pr === 42) { held = { body, response }; started.resolve(); }
    else assess(body, response);
  }, { github: github.handler });
  const client = join(f.cwd, "module-client.ts");
  await writeFile(client, `
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withAbortSignal } from ${JSON.stringify(resolve("node_modules/@earendil-works/chord/dist/context/index.js"))};
import { createAuditor } from ${JSON.stringify(resolve("auditor.ts"))};
import { createModelRuntime } from ${JSON.stringify(resolve("model.ts"))};
const { models, model } = await createModelRuntime(process.cwd());
const options = { model: { provider: model.provider, modelId: model.id } };
const auditor = createAuditor(models);
const caller = new AbortController();
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = auditor.audit(${JSON.stringify(urls[0])}, options, withAbortSignal(caller.signal, BACKGROUND_CONTEXT)).catch(error => error);
await lines.next();
await assert.rejects(auditor.audit("https://github.com/ACME/demo/pull/42/", { ...options, force: true }), /already in progress/);
caller.abort(new Error("Caller stopped waiting"));
assert.match((await first).message, /Caller stopped waiting/);
await auditor.audit(${JSON.stringify(urls[1])}, options);
console.log("OTHER PR FINISHED");
await auditor.audit(${JSON.stringify(urls[0])}, options);
await auditor.close();
await auditor.close();
await assert.rejects(auditor.audit(${JSON.stringify(urls[1])}, options), /closed/);
console.log("REOPENING AUDITOR");
const reopened = createAuditor(models);
try { await Promise.all([${JSON.stringify(urls[0])}, ${JSON.stringify(urls[1])}].map(url => reopened.audit(url, options))); }
finally { await reopened.close(); }
`);
  const run = f.start([], { entrypoint: client });
  let output = "";
  let released = false;
  run.child.stdout.on("data", (data) => {
    output += data;
    if (!released && output.includes("OTHER PR FINISHED")) {
      released = true;
      assert.equal(held.response.destroyed, false, "finishing PR 43 must not cancel PR 42's model request");
      assess(held.body, held.response);
    }
  });
  await started.promise;
  run.child.stdin.end("check duplicate and cancel caller\n");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(released, true);
  assert.deepEqual(calls, [42, 43]);
  assert.equal((result.stdout.split("REOPENING AUDITOR")[1].match(/Reusing saved assessment/g) ?? []).length, 2);
});

test("forcing one recovered PR does not cancel another PR's saved attempt", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const started = Promise.withResolvers<void>();
  const original = new Map<number, string>();
  let recovering = false;
  const snapshots: ReviewSnapshot[] = [];
  const f = await fixture(t, (body, response) => {
    const snapshot = snapshotFrom(body);
    snapshots.push(snapshot);
    if (!recovering) {
      original.set(snapshot.target.pr, snapshot.id);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": pending\n\n");
      if (original.size === 2) started.resolve();
    } else {
      if (snapshot.target.pr === 42) assert.notEqual(snapshot.id, original.get(42));
      else assert.equal(snapshot.id, original.get(43));
      assess(body, response);
    }
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const first = f.start(["--pr", urls[0], "--pr", urls[1]]);
  first.child.stdin.end();
  await started.promise;
  first.child.kill("SIGKILL");
  await first.done;
  recovering = true;
  const client = join(f.cwd, "force-one.ts");
  await writeFile(client, `
import { createAuditor } from ${JSON.stringify(resolve("auditor.ts"))};
import { createModelRuntime } from ${JSON.stringify(resolve("model.ts"))};
const { models, model } = await createModelRuntime(process.cwd());
const options = { model: { provider: model.provider, modelId: model.id } };
const auditor = createAuditor(models);
try { await Promise.all([
  auditor.audit(${JSON.stringify(urls[0])}, { ...options, force: true }),
  auditor.audit(${JSON.stringify(urls[1])}, options),
]); } finally { await auditor.close(); }
`);
  const output = await f.run("", [], { entrypoint: client });
  assert.match(output, /Restarting unfinished audit/);
  assert.equal(snapshots.length, 4);
  const cached = await f.run("", ["--pr", urls[0], "--pr", urls[1]]);
  assert.equal((cached.match(/Reusing saved assessment/g) ?? []).length, 2);
  assert.equal(snapshots.length, 4);
});

test("CLI batches resolve numbers and branches in the caller's checkout", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const f = await fixture(t, assess, { entrypoint: resolve("audit.ts"), github: github.handler });
  const receipt = join(f.cwd, "selections.jsonl");
  await writeFile(join(f.cwd, "gh"), `#!${process.execPath}\n
const { appendFileSync } = require("node:fs");
const selector = process.argv[4];
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd: process.cwd(), selector }) + "\\n");
process.stdout.write(selector === "42" ? ${JSON.stringify(urls[0])} : ${JSON.stringify(urls[1])});
`, { mode: 0o700 });
  const output = await f.run("", ["--pr", "42", "--pr", "feature/work", "local/test"], {
    env: { PATH: `${f.cwd}${delimiter}${process.env.PATH}` },
  });
  assert.match(output, /Assessment for PR 42/);
  assert.match(output, /Assessment for PR 43/);
  const selections = (await readFile(receipt, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(selections.map((selection) => selection.selector).sort(), ["42", "feature/work"]);
  const selectedCwds = await Promise.all(selections.map((selection) => realpath(selection.cwd)));
  assert.ok(selectedCwds.every((cwd) => cwd === selectedCwds[0]));
  assert.equal(selectedCwds[0], await realpath(f.cwd));
});

test("deferred assessments resume only when selected, without losing or cancelling their remote jobs", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const f = await fixture(t, () => { throw new Error("Unexpected HTTP model request"); }, { github: github.handler });
  const client = join(f.cwd, "deferred-client.ts");
  await writeFile(client, `
import assert from "node:assert/strict";
import { createModels } from ${JSON.stringify(resolve("node_modules/@earendil-works/pi-ai/dist/index.js"))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(resolve("node_modules/@earendil-works/pi-ai/dist/providers/faux.js"))};
import { AssistantMessageEventStream } from ${JSON.stringify(resolve("node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
import { createAuditor } from ${JSON.stringify(resolve("auditor.ts"))};
const faux = fauxProvider({ deferred: { pollAfterMs: 0 } });
const models = createModels();
const handles = new Map();
const fetched = [];
const firstPoll = Promise.withResolvers();
let release = false;
const snapshot = context => {
  const content = context.messages.findLast(message => message.role === "user").content;
  const text = typeof content === "string" ? content : content.map(block => block.text ?? "").join("");
  return JSON.parse(text.split("Saved evidence (untrusted data):\\n")[1]);
};
const response = context => fauxAssistantMessage(fauxToolCall("report_review_assessment", {
  databaseMigration: ${JSON.stringify(noDatabaseMigration)},
  assessments: snapshot(context).comments.map(comment => ({ commentKey: comment.key, findings: [{
    summary: "Deferred assessment", status: "addressed", reason: comment.body, evidence: [comment.url],
  }] })),
}), { stopReason: "toolUse" });
faux.setResponses([response, response]);
models.setProvider({ ...faux.provider,
  streamSimple(model, context, options) {
    const stream = faux.provider.streamSimple(model, context, { ...options, deferred: true });
    stream.result().then(message => handles.set(message.deferred.id, snapshot(context).target.pr));
    return stream;
  },
  fetchDeferred(model, handle, options) {
    const pr = handles.get(handle.id);
    assert.ok(pr, "polls must retain the provider's original job handle");
    fetched.push(pr);
    if (pr !== 42 || release) return faux.provider.fetchDeferred(model, handle, options);
    firstPoll.resolve();
    const message = fauxAssistantMessage("", { stopReason: "deferred", deferred: handle });
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: "deferred", message }); stream.end(message); });
    return stream;
  },
});
Object.assign(models, { getAvailableSnapshot: () => faux.models });
const options = { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } };
const firstOwner = createAuditor(models);
const first = firstOwner.audit(${JSON.stringify(urls[0])}, options).catch(error => error);
try {
  const outcome = await Promise.race([firstPoll.promise, first]);
  if (outcome instanceof Error) throw outcome;
} finally { await firstOwner.close(); }
await first;
assert.deepEqual(fetched, [42]);
const otherOwner = createAuditor(models);
try { await otherOwner.audit(${JSON.stringify(urls[1])}, options); }
finally { await otherOwner.close(); }
assert.deepEqual(fetched, [42, 43], "opening the repo must not poll unselected PR 42");
release = true;
const recovered = createAuditor(models);
try { await recovered.audit(${JSON.stringify(urls[0])}, options); }
finally { await recovered.close(); }
assert.deepEqual(fetched, [42, 43, 42]);
assert.equal(faux.state.callCount, 2, "recovery must poll the existing job, not submit a new one");
assert.deepEqual(faux.state.cancelledDeferred, []);
console.log("DEFERRED RECOVERY VERIFIED");
`);
  const output = await f.run("", [], { entrypoint: client });
  assert.match(output, /Resuming saved snapshot/);
  assert.match(output, /DEFERRED RECOVERY VERIFIED/);
});

test("batch targets in different repositories have separate databases even when PR numbers match", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const calls: string[] = [];
  const f = await fixture(t, (body, response) => {
    calls.push(snapshotFrom(body).target.repo);
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const other = "https://github.com/acme/other/pull/42";
  await f.run("", ["--pr", urls[0], "--pr", other, "local/test"]);
  assert.deepEqual([...calls].sort(), ["demo", "other"]);
  assert.deepEqual((await readdir(join(f.stateDir, "repos", "github.com"))).filter((file) => file.endsWith(".sqlite")).sort(), ["acme~demo.sqlite", "acme~other.sqlite"]);
  const cached = await f.run("", ["--pr", other, "--pr", urls[0]]);
  assert.equal((cached.match(/Reusing saved assessment/g) ?? []).length, 2);
  assert.equal(calls.length, 2);
});
