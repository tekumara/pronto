import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const target = process.env.TARGET_URL;
const intervalMs = Number(process.env.PROBE_INTERVAL_MS ?? "100");
const timeoutMs = 1_000;
if (!target) throw new Error("TARGET_URL is required");
if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000) throw new Error("PROBE_INTERVAL_MS must be an integer from 1 to 1000");

function describeError(error, depth = 0, seen = new Set()) {
  if (error === null || error === undefined) return null;
  if (typeof error !== "object") return { value: String(error) };
  if (seen.has(error)) return { message: "[circular error cause]" };
  const details = {
    name: error.name ?? error.constructor?.name ?? "Error",
    message: String(error.message ?? error),
    code: error.code ?? null,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
    address: error.address ?? null,
    port: error.port ?? null,
  };
  if (depth >= 4) return details;
  seen.add(error);
  if (error.cause !== undefined) details.cause = describeError(error.cause, depth + 1, seen);
  if (Array.isArray(error.errors)) details.errors = error.errors.slice(0, 8).map((child) => describeError(child, depth + 1, seen));
  return details;
}

let run;
function report() {
  if (!run) return { state: "not-started" };
  const samples = run.samples;
  let consecutiveBaselineSuccesses = 0;
  for (const sample of [...samples].reverse()) {
    if (sample.phase !== "baseline" || !sample.success) break;
    consecutiveBaselineSuccesses++;
  }
  return {
    state: run.active ? "running" : "stopped",
    endpoint: target,
    connectionPolicy: "close-after-each-request",
    intervalMs,
    timeoutMs,
    startedAt: run.startedAt,
    armedAt: run.armedAt ?? null,
    stoppedAt: run.stoppedAt ?? null,
    attempts: samples.length,
    baselineAttempts: samples.filter((sample) => sample.phase === "baseline").length,
    baselineSuccesses: samples.filter((sample) => sample.phase === "baseline" && sample.success).length,
    consecutiveBaselineSuccesses,
    measurementAttempts: samples.filter((sample) => sample.phase === "measurement").length,
    samples,
  };
}

async function probeLoop(current) {
  while (current.active) {
    const phase = current.armed ? "measurement" : "baseline";
    const startedMono = performance.now();
    const startedAt = new Date().toISOString();
    const requestId = `${current.id}-${++current.sequence}`;
    let status = null, responder = null, responderUid = null, outcome = null, error = null, errorDetails = null, success = false;
    try {
      const response = await fetch(target, {
        method: "GET",
        headers: { Connection: "close", "X-Probe-Id": requestId },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      responder = response.headers.get("x-serving-pod");
      responderUid = response.headers.get("x-serving-pod-uid");
      const body = await response.json();
      outcome = body;
      success = status === 200 && body.requestId === requestId
        && body.pod === responder && body.podUid === responderUid;
      if (!success) error = `Unexpected HTTP ${status} or mismatched responder/request identity`;
    } catch (cause) {
      error = `${cause.name}: ${cause.message}`;
      errorDetails = describeError(cause);
    }
    const completedMono = performance.now();
    current.samples.push({
      requestId,
      phase,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(completedMono - startedMono),
      status,
      responder,
      responderUid,
      outcome,
      success,
      error,
      errorDetails,
    });
    if (current.active) await delay(Math.max(0, intervalMs - (performance.now() - startedMono)));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://stateless-probe");
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/healthz") return reply(200, { ok: true });
  if (req.method === "GET" && url.pathname === "/status") return reply(200, report());
  if (req.method === "POST" && url.pathname === "/start") {
    if (run?.active) return reply(409, { error: "Probe is already running" });
    run = { id: randomUUID(), active: true, armed: false, sequence: 0, samples: [], startedAt: new Date().toISOString() };
    run.task = probeLoop(run);
    return reply(202, report());
  }
  if (req.method === "POST" && url.pathname === "/arm") {
    if (!run?.active || run.armed) return reply(409, { error: "Probe is not available to arm" });
    const baseline = run.samples.slice(-20);
    if (baseline.length < 20 || baseline.some((sample) => !sample.success)) {
      return reply(409, { error: "Need 20 consecutive successful baseline requests", report: report() });
    }
    run.armed = true;
    run.armedAt = new Date().toISOString();
    return reply(200, report());
  }
  if (req.method === "POST" && url.pathname === "/stop") {
    if (!run) return reply(409, { error: "Probe has not started" });
    run.active = false;
    await run.task;
    run.stoppedAt = new Date().toISOString();
    return reply(200, report());
  }
  return reply(404, { error: "Not found" });
});

server.listen(8081, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "listening", port: 8081, target, intervalMs, timeoutMs }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
