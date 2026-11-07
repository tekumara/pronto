import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Only GitHub/model HTTP boundaries are fixtures. All storage is real.
// The draft PR must be skipped without model inference or review publication.
const stats = { githubReads: 0, modelCalls: 0, publicationAttempts: 0, unexpected: [] };
const clientIntervalMs = 100, clientTimeoutMs = 1_000;
let clientProbe;

function clientProbeReport() {
  if (!clientProbe) return { state: "not-started" };
  const firstFailureIndex = clientProbe.samples.findIndex((sample) => !sample.success);
  const firstFailure = firstFailureIndex < 0 ? null : clientProbe.samples[firstFailureIndex];
  const previousSuccess = firstFailureIndex < 0
    ? clientProbe.baselineSuccess
    : [...clientProbe.samples.slice(0, firstFailureIndex)].reverse().find((sample) => sample.success) ?? clientProbe.baselineSuccess;
  const recovery = firstFailureIndex < 0 ? null : clientProbe.samples.slice(firstFailureIndex + 1).find((sample) => sample.success);
  const elapsed = (end, start) => end && start ? Math.round(end.completedMono - start.completedMono) : null;
  return {
    state: clientProbe.active ? "running" : "stopped",
    endpoint: "http://pronto-verify:8080/webhook",
    connectionPolicy: "close-after-each-request",
    intervalMs: clientIntervalMs,
    timeoutMs: clientTimeoutMs,
    startedAt: clientProbe.startedAt,
    armedAt: clientProbe.armedAt ?? null,
    baselineSuccessAt: clientProbe.baselineSuccess?.completedAt ?? null,
    attempts: clientProbe.samples.length,
    successes: clientProbe.samples.filter((sample) => sample.success).length,
    failures: clientProbe.samples.filter((sample) => !sample.success).length,
    noFailuresObserved: firstFailure === null,
    finishTimedOut: clientProbe.finishTimedOut ?? false,
    lastSuccessBeforeFailureAt: previousSuccess?.completedAt ?? null,
    firstFailureAt: firstFailure?.completedAt ?? null,
    firstFailureStartedAt: firstFailure?.startedAt ?? null,
    firstFailureStatus: firstFailure?.status ?? null,
    firstFailureError: firstFailure?.error ?? null,
    firstRecoveryAt: recovery?.completedAt ?? null,
    clientObservedGapMs: firstFailure ? elapsed(recovery, previousSuccess) : 0,
    firstFailureToRecoveryMs: elapsed(recovery, firstFailure),
    samples: clientProbe.samples.map(({ startedMono, completedMono, ...sample }) => sample),
  };
}

async function runClientProbe(probe) {
  const body = JSON.stringify({ action: "review_requested", sender: { login: "local-verifier" },
    requested_reviewer: { login: "verification-bot" },
    pull_request: { html_url: "https://github.com/pronto/verification/pull/7", requested_reviewers: [{ login: "verification-bot" }] } });
  const signature = `sha256=${createHmac("sha256", process.env.PRONTO_WEBHOOK_SECRET).update(body).digest("hex")}`;
  while (probe.active) {
    const startedMono = performance.now(), startedAt = new Date().toISOString();
    let status = null, outcome = null, error = null, success = false;
    try {
      // The Service selects a backend per TCP connection. Close each request so
      // successive probes can observe EndpointSlice changes instead of pinning
      // this monitor to a former backend through HTTP keep-alive.
      const response = await fetch("http://pronto-verify:8080/webhook", {
        method: "POST", signal: AbortSignal.timeout(clientTimeoutMs),
        headers: { "Connection": "close", "Content-Type": "application/json", "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": probe.delivery, "X-Hub-Signature-256": signature }, body,
      });
      status = response.status;
      const result = await response.json().catch(() => null);
      outcome = result?.status ?? null;
      success = status === 202 && (outcome === "queued" || outcome === "duplicate");
      if (!success) error = `Unexpected HTTP ${status}${outcome ? ` (${outcome})` : ""}`;
    } catch (cause) {
      error = `${cause.name}: ${cause.message}`;
    }
    const sample = { startedAt, completedAt: new Date().toISOString(), startedMono, completedMono: performance.now(),
      status, outcome, success, error };
    if (probe.armed && startedMono >= probe.armedMono) {
      probe.samples.push(sample);
      if (success && (probe.sawFailure || probe.finishAfterSuccess)) probe.active = false;
      else if (!success) probe.sawFailure = true;
    } else if (success) {
      probe.baselineSuccess = sample;
    } else {
      probe.preArmFailures++;
    }
    if (probe.finishAfterSuccess && performance.now() >= probe.finishDeadlineMono) {
      probe.finishTimedOut = true;
      probe.active = false;
    }
    if (probe.active) await delay(Math.max(0, clientIntervalMs - (performance.now() - startedMono)));
  }
  probe.finishedAt = new Date().toISOString();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), path = url.pathname;
  const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (path.startsWith("/client-probe") && req.headers["x-client-probe-control"] !== process.env.PRONTO_WEBHOOK_SECRET) {
    return reply(403, { error: "Forbidden" });
  }
  if ((path === "/client-probe" || path === "/client-probe/status") && req.method === "GET") return reply(200, clientProbeReport());
  if (path === "/client-probe/start" && req.method === "POST") {
    const delivery = url.searchParams.get("delivery");
    if (!delivery || !process.env.PRONTO_WEBHOOK_SECRET) return reply(400, { error: "Missing client probe configuration" });
    if (clientProbe?.active) return reply(409, { error: "Client probe is already running" });
    clientProbe = { delivery, active: true, armed: false, armedMono: Infinity, finishAfterSuccess: false,
      sawFailure: false, baselineSuccess: null, samples: [], preArmFailures: 0, startedAt: new Date().toISOString() };
    clientProbe.task = runClientProbe(clientProbe);
    return reply(202, clientProbeReport());
  }
  if (path === "/client-probe/arm" && req.method === "POST") {
    if (!clientProbe?.active || clientProbe.armed || !clientProbe.baselineSuccess) return reply(409, { error: "Client probe has no baseline success" });
    clientProbe.armed = true;
    clientProbe.armedAt = new Date().toISOString();
    clientProbe.armedMono = performance.now();
    return reply(200, clientProbeReport());
  }
  if (path === "/client-probe/finish" && req.method === "POST") {
    if (!clientProbe) return reply(409, { error: "Client probe has not started" });
    clientProbe.finishAfterSuccess = true;
    clientProbe.finishDeadlineMono = performance.now() + 15_000;
    await clientProbe.task;
    return reply(200, clientProbeReport());
  }
  if (path === "/client-probe/stop" && req.method === "POST") {
    if (clientProbe) { clientProbe.active = false; await clientProbe.task; }
    return reply(200, clientProbeReport());
  }
  if (path === "/stats") return reply(200, stats);
  if (path === "/v1/chat/completions") { stats.modelCalls++; return reply(500, { error: "Unexpected model call" }); }
  if (req.method === "POST") { stats.publicationAttempts++; return reply(500, { error: "Publication forbidden" }); }
  if (req.headers.authorization !== "Bearer verification-only") return reply(401, { error: "Invalid fixture token" });
  if (path === "/github/user") { stats.githubReads++; return reply(200, { login: "verification-bot" }); }
  if (/^\/github\/repos\/pronto\/verification\/pulls\/7$/.test(path)) {
    stats.githubReads++;
    return reply(200, { title: "Local recovery verification", body: "", merged: false, draft: true, labels: [], changed_files: 0,
      head: { sha: "a".repeat(40), repo: { full_name: "pronto/verification" } },
      base: { sha: "b".repeat(40), repo: { full_name: "pronto/verification" } } });
  }
  stats.unexpected.push(`${req.method} ${path}`);
  return reply(500, { error: "Unexpected fixture request" });
});
server.listen(8081, "0.0.0.0");
process.on("SIGTERM", () => server.close());
