import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { withTasks } from "@modelcontextprotocol/ext-tasks/client";
import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import type { Log } from "../src/logging.ts";
import { createAuditMcpEndpoint, MCP_PROTOCOL_VERSION } from "../src/discussion/mcp.ts";
import { createMcpAuditRunner } from "../src/discussion/run-audit.ts";
import { MCP_TASKS_EXTENSION, MCP_TASK_POLL_INTERVAL_MS } from "../src/discussion/mcp-tasks.ts";

const target = "https://github.com/acme/demo/pull/42";
type AuditRunner = ReturnType<typeof createMcpAuditRunner>;
type AuditResult = Awaited<ReturnType<AuditRunner>>;
const result: AuditResult = {
  results: [{ prUrl: target, status: "completed", auditId: 31 as unknown as ConversationId, cached: false }],
  apply: false,
};
type RpcResult = {
  resultType?: string;
  structuredContent?: unknown;
  taskId?: string;
  status?: string;
  ttlMs?: number;
  pollIntervalMs?: number;
  result?: { resultType?: string; structuredContent?: unknown };
  capabilities?: { extensions?: Record<string, unknown> };
};
type RpcBody = { result?: RpcResult; error?: { code: number; message: string } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function host(root: string, runAudit: AuditRunner, log: Log = () => {}) {
  const token = randomBytes(32).toString("hex");
  const endpoint = await createAuditMcpEndpoint({
    token, root, publicUrl: "http://127.0.0.1:43210/mcp", runAudit, log,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void endpoint.handle(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  let id = 0;
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token, endpoint,
    async request(method: string, params: Record<string, unknown> = {}, supportsTasks = true, signal?: AbortSignal) {
      const capabilities = supportsTasks ? { extensions: { [MCP_TASKS_EXTENSION]: {} } } : {};
      const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": capabilities,
          "io.modelcontextprotocol/clientInfo": { name: "task-contract-test", version: "1" },
        },
      } });
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": method,
          ...(typeof (params.name ?? params.uri ?? params.taskId) === "string"
            ? { "Mcp-Name": String(params.name ?? params.uri ?? params.taskId) } : {}),
        },
        body,
        signal,
      });
      return { status: response.status, body: await response.json() as RpcBody };
    },
    async close() {
      if (closed) return;
      closed = true;
      await endpoint.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function taskClient(server: Awaited<ReturnType<typeof host>>) {
  return withTasks({
    endpointId: "pronto-test",
    taskCapabilities: { generation: "v2", capabilities: {} },
    invalidated: false,
    async dispatch(request, options) {
      const { method, params } = request as { method: string; params?: Record<string, unknown> };
      const response = await server.request(method, params, true, options?.signal);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      if (response.body.error) return { kind: "error", error: response.body.error };
      assert.ok(response.body.result, JSON.stringify(response.body));
      return { kind: "result", result: response.body.result as JsonValue };
    },
    onServerRequest: () => () => {},
    onNotification: () => () => {},
    onInvalidated: () => () => {},
  });
}

test("MCP task-capable clients get fast results synchronously and can resume long tasks after restart", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pronto-mcp-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = deferred<void>();
  const quickRunner: AuditRunner = async (args, signal) => {
    if (!args.targets) return result;
    started.resolve();
    return new Promise<AuditResult>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const first = await host(root, quickRunner);
  t.after(() => first.close());

  const discovered = await first.request("server/discover");
  assert.deepEqual(discovered.body.result?.capabilities?.extensions?.[MCP_TASKS_EXTENSION], {});
  const quick = await first.request("tools/call", { name: "run_audit", arguments: {} });
  assert.equal(quick.status, 200);
  assert.equal(quick.body.result?.resultType, "complete");
  assert.deepEqual(quick.body.result?.structuredContent, result);

  const client = taskClient(first);
  t.after(() => client.close());
  const pendingCall = client.callTool("run_audit", { targets: [target] });
  await started.promise;
  const execution = await pendingCall;
  assert.equal(execution.kind, "task");
  if (execution.kind !== "task") throw new Error("Expected a task-backed audit");
  const taskId = execution.handle.taskId;
  const reference = execution.serializeReference();
  const databaseHeader = await readFile(join(root, "mcp-tasks.sqlite"));
  assert.equal(databaseHeader.subarray(0, 16).toString("utf8"), "SQLite format 3\0");
  const working = await first.request("tasks/get", { taskId });
  assert.equal(working.body.result?.status, "working");
  assert.equal(working.body.result?.pollIntervalMs, MCP_TASK_POLL_INTERVAL_MS);
  assert.ok(working.body.result?.ttlMs && working.body.result.ttlMs > 0);

  await execution.detach();
  await client.close();
  await first.close();
  const resumed = deferred<void>();
  const finish = deferred<AuditResult>();
  const recoveredRunner: AuditRunner = async () => {
    resumed.resolve();
    return finish.promise;
  };
  const second = await host(root, recoveredRunner);
  t.after(() => second.close());
  await second.endpoint.resumeTasks();
  await resumed.promise;
  const afterRestart = await second.request("tasks/get", { taskId });
  assert.equal(afterRestart.body.result?.status, "working");
  const resumedClient = taskClient(second);
  t.after(() => resumedClient.close());
  const resumedExecution = await resumedClient.resumeTask(reference);
  finish.resolve(result);
  const { outcome } = await resumedExecution.settle();
  assert.equal(outcome.status, "completed");
  if (outcome.status !== "completed") throw new Error("Expected a completed audit");
  assert.deepEqual(outcome.result.structuredContent, result);
});

test("MCP logs when a synchronous run_audit request is aborted", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pronto-mcp-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = deferred<void>();
  const runner: AuditRunner = async (_args, signal) => {
    started.resolve();
    return new Promise<AuditResult>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const entries: string[] = [];
  const server = await host(root, runner, (level, _scope, message) => entries.push(`${level} ${message}`));
  t.after(() => server.close());

  const clientWait = new AbortController();
  const request = server.request("tools/call", { name: "run_audit", arguments: { targets: [target] } }, false, clientWait.signal);
  await started.promise;
  clientWait.abort(new DOMException("client wait timed out", "TimeoutError"));
  await assert.rejects(request);

  const deadline = Date.now() + 1_000;
  const abortedLog = () => entries.find((entry) => /info pronto-audits\/run_audit request (?:aborted|timed out) requestId=/.test(entry));
  while (Date.now() < deadline && !abortedLog()) await new Promise((resolve) => setTimeout(resolve, 10));
  const startedLog = entries.find((entry) => /info pronto-audits\/run_audit started requestId=/.test(entry));
  const abortEntry = abortedLog();
  assert.ok(startedLog, entries.join("\n"));
  assert.ok(abortEntry, entries.join("\n"));
  const startedRequestId = startedLog.match(/requestId=([a-f0-9-]+)/)?.[1];
  const abortedRequestId = abortEntry.match(/requestId=([a-f0-9-]+)/)?.[1];
  assert.ok(startedRequestId);
  assert.equal(abortedRequestId, startedRequestId);
});

test("MCP tasks/cancel asks cooperative audit work to stop", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pronto-mcp-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = deferred<void>();
  const runner: AuditRunner = async (_args, signal) => {
    started.resolve();
    return new Promise<AuditResult>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const server = await host(root, runner);
  t.after(() => server.close());
  const pendingCall = server.request("tools/call", { name: "run_audit", arguments: { targets: [target] } });
  await started.promise;
  const created = await pendingCall;
  assert.equal(created.body.result?.resultType, "task");
  const taskId = created.body.result?.taskId;
  assert.ok(taskId);

  const cancelled = await server.request("tasks/cancel", { taskId });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.result?.resultType, "complete");
  const deadline = Date.now() + 3_000;
  let state: RpcResult | undefined;
  do {
    const response = await server.request("tasks/get", { taskId });
    state = response.body.result;
    if (state?.status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(state?.status, "cancelled", JSON.stringify(state));

  const unsupported = await server.request("tasks/get", { taskId }, false);
  assert.equal(unsupported.body.error?.code, -32602);
});
