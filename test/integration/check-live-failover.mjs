#!/usr/bin/env node
// Live smoke test: starts two real `pronto serve` processes and SIGKILLs the active owner.
// Start RustFS separately (for example, `make s3`) and provide a base PRONTO_REPLICA_URL
// whose bucket already exists. The script appends a unique remote prefix and leaves it intact.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseReplicaURL = process.env.PRONTO_REPLICA_URL?.replace(/\/+$/, "");
const replicaMatch = /^s3:\/\/([a-z0-9][a-z0-9.-]+)\/([A-Za-z0-9_./-]+)$/.exec(baseReplicaURL ?? "");
if (!replicaMatch || replicaMatch[2].split("/").some((part) => !part || part === "." || part === "..")) {
  throw new Error("Set PRONTO_REPLICA_URL to s3://bucket/base-prefix; its bucket must already exist");
}
if (!process.env.PRONTO_WEBHOOK_SECRET) throw new Error("Set PRONTO_WEBHOOK_SECRET before running the failover check");
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) throw new Error("Set AWS_REGION");
if (process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE) throw new Error("Unset AWS_PROFILE and AWS_DEFAULT_PROFILE; replicated state requires environment credentials");
if (spawnSync("pgrep", ["-P", String(process.pid)]).error) throw new Error("This script requires pgrep to clean up Litestream children after a simulated crash");

function litestreamPath() {
  if (process.env.PRONTO_LITESTREAM_BIN) {
    if (!isAbsolute(process.env.PRONTO_LITESTREAM_BIN)) throw new Error("PRONTO_LITESTREAM_BIN must be an absolute Litestream path");
    const target = realpathSync(process.env.PRONTO_LITESTREAM_BIN);
    return basename(target) === "mise"
      ? realpathSync(execFileSync(target, ["which", "litestream"], { encoding: "utf8" }).trim())
      : target;
  }
  const located = spawnSync("/bin/sh", ["-c", "command -v litestream"], { encoding: "utf8" });
  if (located.error || located.status !== 0) throw new Error("Install litestream on PATH (or set PRONTO_LITESTREAM_BIN)", { cause: located.error });
  const target = realpathSync(resolve(located.stdout.trim()));
  return basename(target) === "mise"
    ? realpathSync(execFileSync(target, ["which", "litestream"], { encoding: "utf8" }).trim())
    : target;
}
const binary = litestreamPath();
const litestreamVersion = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
if (!/^v?0\.5\.17(?:\s|$)/.test(litestreamVersion)) throw new Error(`Replicated serve requires Litestream v0.5.17, found ${litestreamVersion}`);

const env = { ...process.env, PRONTO_LITESTREAM_BIN: binary };
if (!env.AWS_REGION) env.AWS_REGION = env.AWS_DEFAULT_REGION;
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
env.PRONTO_REPLICA_URL = `${baseReplicaURL}/live-failover-${runId}`;
const runDirectory = mkdtempSync(join(tmpdir(), "pronto-live-failover-"));
const stateA = join(runDirectory, "state-a");
const stateB = join(runDirectory, "state-b");
mkdirSync(stateA);
mkdirSync(stateB);
const servers = [];
const orphanPids = new Set();
let interrupted;
let exitCode = 0;

function directChildren(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`pgrep failed for process ${pid}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}
function startServer(name, stateDir) {
  const logPath = join(runDirectory, `${name}.log`);
  writeFileSync(logPath, "");
  const child = spawn(process.execPath, ["--experimental-strip-types", "audit.ts", "serve", "--replicated-state", "--host", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env: { ...env, PRONTO_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { name, child, logPath, output: "", port: undefined, done: undefined };
  const capture = (stream) => stream.on("data", (chunk) => {
    const text = chunk.toString();
    server.output += text;
    appendFileSync(logPath, text);
    process.stdout.write(`[${name}] ${text}`);
  });
  capture(child.stdout);
  capture(child.stderr);
  child.on("error", (error) => { server.output += `${error.message}\n`; });
  server.done = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  servers.push(server);
  return server;
}
function isRunning(server) {
  return server.child.exitCode === null && server.child.signalCode === null;
}
async function waitForListening(server, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/.exec(server.output);
    if (match) { server.port = Number(match[1]); return; }
    if (!isRunning(server)) throw new Error(`${server.name} exited before listening:\n${server.output}`);
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${server.name} to listen:\n${server.output}`);
}
async function status(port, path) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_000) });
    return response.status;
  } catch { return 0; }
}
async function waitForInitialOwner(a, b, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    for (const server of [a, b]) if (!isRunning(server)) throw new Error(`${server.name} exited:\n${server.output}`);
    const [readyA, readyB] = await Promise.all([status(a.port, "/readyz"), status(b.port, "/readyz")]);
    if (readyA === 200 && readyB === 200) throw new Error("Both serve processes report ready; expected exactly one owner");
    if (readyA === 200 || readyB === 200) {
      const owner = readyA === 200 ? a : b;
      const standby = owner === a ? b : a;
      if (await status(owner.port, "/healthz") !== 200 || await status(standby.port, "/healthz") !== 200 || await status(standby.port, "/readyz") !== 503) {
        throw new Error("Expected one ready owner and one live, unready standby");
      }
      return { owner, standby };
    }
    await sleep(250);
  }
  throw new Error("Neither serve process became ready within 60 seconds");
}
async function waitForPromotion(server, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    if (!isRunning(server)) throw new Error(`${server.name} exited before taking ownership:\n${server.output}`);
    if (await status(server.port, "/readyz") === 200) return;
    await sleep(250);
  }
  throw new Error(`${server.name} did not become ready within ${timeoutMs / 1_000}s; the lease may not have expired`);
}
function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
async function stopOrphan(pid) {
  if (!pidExists(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let i = 0; i < 20 && pidExists(pid); i++) await sleep(100);
  if (pidExists(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  orphanPids.delete(pid);
}
async function stopServer(server) {
  if (!server) return;
  const children = directChildren(server.child.pid);
  for (const pid of children) orphanPids.add(pid);
  if (isRunning(server)) {
    server.child.kill("SIGTERM");
    let timeout;
    const stopped = await Promise.race([server.done.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); })]);
    clearTimeout(timeout);
    if (!stopped && isRunning(server)) {
      server.child.kill("SIGKILL");
      await server.done;
    }
  }
  for (const pid of children) await stopOrphan(pid);
}

const onSignal = (signal) => {
  interrupted ??= signal;
  exitCode = signal === "SIGINT" ? 130 : 143;
  for (const server of servers) if (isRunning(server)) server.child.kill(signal);
};
const onSIGINT = () => onSignal("SIGINT");
const onSIGTERM = () => onSignal("SIGTERM");
process.on("SIGINT", onSIGINT);
process.on("SIGTERM", onSIGTERM);

try {
  console.log(`Litestream ${litestreamVersion}; remote test prefix ${env.PRONTO_REPLICA_URL}`);
  console.log("Requires normal Pronto GitHub/model credentials. No webhook is sent; serve still checks GitHub auth on startup.");
  const a = startServer("A", stateA);
  const b = startServer("B", stateB);
  await Promise.all([waitForListening(a), waitForListening(b)]);
  console.log(`A (pid=${a.child.pid}): http://127.0.0.1:${a.port}; B (pid=${b.child.pid}): http://127.0.0.1:${b.port}`);
  const { owner, standby } = await waitForInitialOwner(a, b);
  console.log(`${owner.name} owns the term; ${standby.name} is live but unready.`);

  const litestreamPids = directChildren(owner.child.pid);
  if (litestreamPids.length !== 1) throw new Error(`Expected one Litestream child under ${owner.name}, found ${litestreamPids.length}`);
  for (const pid of litestreamPids) orphanPids.add(pid);
  console.log(`SIGKILL ${owner.name} to test crash failover; waiting for the lease to expire.`);
  owner.child.kill("SIGKILL");
  await owner.done;
  for (const pid of litestreamPids) await stopOrphan(pid);

  await waitForPromotion(standby);
  if (await status(standby.port, "/healthz") !== 200) throw new Error(`${standby.name} is ready but not healthy`);
  console.log(`FAILOVER OK: ${standby.name} became ready after ${owner.name} crashed.`);
} catch (error) {
  exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  process.off("SIGINT", onSIGINT);
  process.off("SIGTERM", onSIGTERM);
  for (const server of [...servers].reverse()) await stopServer(server);
  for (const pid of [...orphanPids]) await stopOrphan(pid);
  rmSync(stateA, { recursive: true, force: true });
  rmSync(stateB, { recursive: true, force: true });
  console.log(`Logs: ${runDirectory}/A.log and ${runDirectory}/B.log`);
}
process.exitCode = exitCode;
