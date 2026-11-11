import { randomUUID } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RunAuditArguments } from "./run-audit.ts";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_TASK_POLL_INTERVAL_MS = 1_000;

const QUICK_RESPONSE_WINDOW_MS = 1_000;
const TASK_TTL_MS = 24 * 60 * 60 * 1_000;
const STORE_VERSION = 1;
const TASK_FILE = "mcp-tasks.sqlite";
const TASK_COLUMNS = `task_id AS taskId, status, args_json AS argsJson, created_at AS createdAt,
  last_updated_at AS lastUpdatedAt, expires_at AS expiresAt, cancel_requested AS cancelRequested,
  result_json AS resultJson, error_json AS errorJson`;

type TaskStatus = "working" | "completed" | "failed" | "cancelled";
type TaskError = { code: number; message: string };
type ToolResult = CallToolResult & { resultType?: "complete" };

type TaskRecord = {
  taskId: string;
  status: TaskStatus;
  args: RunAuditArguments;
  createdAt: string;
  lastUpdatedAt: string;
  expiresAt: number;
  cancelRequested: boolean;
  result?: ToolResult;
  error?: TaskError;
};

export type McpTask = {
  taskId: string;
  status: TaskStatus;
  ttlMs: number;
  pollIntervalMs: number;
  createdAt: string;
  lastUpdatedAt: string;
  statusMessage?: string;
  result?: ToolResult;
  error?: TaskError;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "working" || value === "completed" || value === "failed" || value === "cancelled";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 3_500) || "MCP task failed";
}

function taskView(record: TaskRecord, now = Date.now()): McpTask {
  return {
    taskId: record.taskId,
    status: record.status,
    ttlMs: Math.max(0, record.expiresAt - now),
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ...(record.cancelRequested && record.status === "working" ? { statusMessage: "Cancellation requested" } : {}),
    ...(record.result === undefined ? {} : { result: clone(record.result) }),
    ...(record.error === undefined ? {} : { error: clone(record.error) }),
  };
}

function parseStoredJson(value: unknown, label: string): unknown | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Pronto MCP task database contains invalid ${label}`);
  try { return JSON.parse(value); } catch (error) {
    throw new Error(`Pronto MCP task database contains invalid ${label}`, { cause: error });
  }
}

function decodeTaskRow(row: Record<string, unknown>): TaskRecord {
  const taskId = row.taskId;
  const status = row.status;
  const createdAt = row.createdAt;
  const lastUpdatedAt = row.lastUpdatedAt;
  const expiresAt = row.expiresAt;
  const cancelRequested = row.cancelRequested;
  const args = parseStoredJson(row.argsJson, "task arguments");
  const result = parseStoredJson(row.resultJson, "task result");
  const error = parseStoredJson(row.errorJson, "task error");
  if (typeof taskId !== "string" || !isTaskStatus(status) || !isRecord(args)
    || typeof createdAt !== "string" || typeof lastUpdatedAt !== "string"
    || typeof expiresAt !== "number" || (cancelRequested !== 0 && cancelRequested !== 1)) {
    throw new Error("Pronto MCP task database contains an invalid task");
  }
  if (result !== undefined && !isRecord(result)) throw new Error("Pronto MCP task database contains an invalid task result");
  if (error !== undefined && (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string")) {
    throw new Error("Pronto MCP task database contains an invalid task error");
  }
  return {
    taskId, status, args: args as RunAuditArguments, createdAt, lastUpdatedAt, expiresAt,
    cancelRequested: cancelRequested === 1,
    ...(result === undefined ? {} : { result: result as ToolResult }),
    ...(error === undefined ? {} : { error: error as TaskError }),
  };
}

/** A SQLite-backed store: acknowledged task IDs and results survive a server restart. */
class DurableTaskStore {
  private readonly path: string;
  private database?: DatabaseSync;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.path = join(root, TASK_FILE);
  }

  private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async connection(create: boolean): Promise<DatabaseSync | undefined> {
    if (this.closed) throw new Error("Pronto MCP task store is closed");
    if (this.database) return this.database;
    if (create) {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    } else {
      try { await access(this.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    await (await open(this.path, "a", 0o600)).close();
    const database = new DatabaseSync(this.path);
    try {
      database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const versionRow = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
      const version = versionRow?.user_version;
      if (typeof version !== "number" || version > STORE_VERSION) {
        throw new Error("Pronto MCP task database has an unsupported version");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS mcp_tasks (
            task_id TEXT PRIMARY KEY NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('working', 'completed', 'failed', 'cancelled')),
            args_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_updated_at TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
            result_json TEXT,
            error_json TEXT
          );
          CREATE INDEX IF NOT EXISTS mcp_tasks_status_expiry ON mcp_tasks(status, expires_at);
          PRAGMA user_version = ${STORE_VERSION};
        `);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve schema error */ }
        throw error;
      }
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    return database;
  }

  private transaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve operation error */ }
      throw error;
    }
  }

  private prune(database: DatabaseSync, now: number): void {
    database.prepare("DELETE FROM mcp_tasks WHERE status <> 'working' AND expires_at <= ?").run(now);
  }

  private row(database: DatabaseSync, taskId: string): Record<string, unknown> | undefined {
    return database.prepare(`SELECT ${TASK_COLUMNS} FROM mcp_tasks WHERE task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
  }

  async create(record: TaskRecord): Promise<void> {
    return this.locked(async () => {
      const database = await this.connection(true);
      if (!database) throw new Error("Could not open Pronto MCP task database");
      this.transaction(database, () => {
        this.prune(database, Date.now());
        database.prepare(`
          INSERT INTO mcp_tasks (task_id, status, args_json, created_at, last_updated_at, expires_at, cancel_requested, result_json, error_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.taskId, record.status, JSON.stringify(record.args), record.createdAt, record.lastUpdatedAt,
          record.expiresAt, record.cancelRequested ? 1 : 0,
          record.result === undefined ? null : JSON.stringify(record.result),
          record.error === undefined ? null : JSON.stringify(record.error),
        );
      });
    });
  }

  async get(taskId: string): Promise<McpTask | undefined> {
    return this.locked(async () => {
      const database = await this.connection(false);
      if (!database) return undefined;
      const row = this.row(database, taskId);
      if (!row) return undefined;
      const record = decodeTaskRow(row);
      if (record.status !== "working" && record.expiresAt <= Date.now()) {
        database.prepare("DELETE FROM mcp_tasks WHERE task_id = ? AND status <> 'working' AND expires_at <= ?").run(taskId, Date.now());
        return undefined;
      }
      return taskView(record);
    });
  }

  async working(): Promise<TaskRecord[]> {
    return this.locked(async () => {
      const database = await this.connection(false);
      if (!database) return [];
      return this.transaction(database, () => {
        this.prune(database, Date.now());
        const rows = database.prepare(`SELECT ${TASK_COLUMNS} FROM mcp_tasks WHERE status = 'working' ORDER BY created_at`).all() as Record<string, unknown>[];
        return rows.map(decodeTaskRow);
      });
    });
  }

  async requestCancellation(taskId: string): Promise<{ found: boolean; working: boolean }> {
    return this.locked(async () => {
      const database = await this.connection(false);
      if (!database) return { found: false, working: false };
      return this.transaction(database, () => {
        const row = this.row(database, taskId);
        if (!row) return { found: false, working: false };
        const record = decodeTaskRow(row);
        if (record.status !== "working") {
          if (record.expiresAt <= Date.now()) {
            database.prepare("DELETE FROM mcp_tasks WHERE task_id = ? AND status <> 'working' AND expires_at <= ?").run(taskId, Date.now());
            return { found: false, working: false };
          }
          return { found: true, working: false };
        }
        database.prepare("UPDATE mcp_tasks SET cancel_requested = 1, last_updated_at = ? WHERE task_id = ? AND status = 'working'")
          .run(new Date().toISOString(), taskId);
        return { found: true, working: true };
      });
    });
  }

  async finish(taskId: string, update: { status: "completed"; result: ToolResult } | { status: "failed"; error: TaskError } | { status: "cancelled" }): Promise<void> {
    return this.locked(async () => {
      const database = await this.connection(false);
      if (!database) return;
      const result = update.status === "completed" ? JSON.stringify(update.result) : null;
      const error = update.status === "failed" ? JSON.stringify(update.error) : null;
      database.prepare(`
        UPDATE mcp_tasks
        SET status = ?, last_updated_at = ?, expires_at = ?, result_json = ?, error_json = ?
        WHERE task_id = ? AND status = 'working'
      `).run(update.status, new Date().toISOString(), Date.now() + TASK_TTL_MS, result, error, taskId);
    });
  }

  async close(): Promise<void> {
    return this.locked(() => {
      this.closed = true;
      this.database?.close();
      this.database = undefined;
    });
  }
}

function raceQuickWindow<T>(operation: Promise<T>, signal: AbortSignal): Promise<
  { kind: "settled"; value: T } | { kind: "failed"; error: unknown } | { kind: "timeout" } | { kind: "aborted" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timer = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), QUICK_RESPONSE_WINDOW_MS);
  });
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const settled = operation.then(
    (value) => ({ kind: "settled" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  return Promise.race([settled, timer, aborted]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** Implements the Tasks extension around Pronto's existing audit runner. */
export function createMcpTaskManager({ root, execute, onError = () => {} }: {
  root: string;
  execute(args: RunAuditArguments, signal: AbortSignal, requestId?: string): Promise<CallToolResult>;
  onError?: (message: string) => void;
}) {
  const store = new DurableTaskStore(root);
  const running = new Map<string, AbortController>();
  let started = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function startExecution(record: TaskRecord, operation: Promise<CallToolResult>, controller: AbortController): void {
    running.set(record.taskId, controller);
    void operation.then(async (result) => {
      if (!closing) await store.finish(record.taskId, {
        status: "completed", result: { ...result, resultType: "complete" },
      });
    }, async (error: unknown) => {
      if (closing) return;
      if (controller.signal.aborted || record.cancelRequested) await store.finish(record.taskId, { status: "cancelled" });
      else await store.finish(record.taskId, { status: "failed", error: { code: -32603, message: errorMessage(error) } });
    }).catch((error: unknown) => onError(`Could not save MCP task ${record.taskId}: ${errorMessage(error)}`)).finally(() => {
      running.delete(record.taskId);
    });
  }

  return {
    async run(args: RunAuditArguments, requestSignal: AbortSignal, supportsTasks: boolean, requestId?: string): Promise<CallToolResult> {
      if (closing) throw new Error("Pronto MCP endpoint is closing");
      const controller = new AbortController();
      const abortForRequest = () => controller.abort(requestSignal.reason);
      if (requestSignal.aborted) abortForRequest();
      else requestSignal.addEventListener("abort", abortForRequest, { once: true });
      const operation = Promise.resolve().then(() => execute(args, controller.signal, requestId));
      const detachRequest = () => requestSignal.removeEventListener("abort", abortForRequest);

      if (!supportsTasks) {
        try { return await operation; } finally { detachRequest(); }
      }

      const outcome = await raceQuickWindow(operation, requestSignal);
      if (outcome.kind === "settled") {
        detachRequest();
        return outcome.value;
      }
      if (outcome.kind === "failed") {
        detachRequest();
        throw outcome.error;
      }
      if (outcome.kind === "aborted") {
        controller.abort(requestSignal.reason);
        detachRequest();
        throw requestSignal.reason ?? new Error("MCP request was cancelled");
      }

      if (closing) {
        controller.abort(new Error("Pronto MCP endpoint is closing"));
        detachRequest();
        throw new Error("Pronto MCP endpoint is closing");
      }

      const now = new Date();
      const record: TaskRecord = {
        taskId: randomUUID(), status: "working", args: clone(args),
        createdAt: now.toISOString(), lastUpdatedAt: now.toISOString(),
        expiresAt: now.getTime() + TASK_TTL_MS, cancelRequested: false,
      };
      try {
        await store.create(record);
      } catch (error) {
        controller.abort(error);
        detachRequest();
        throw error;
      }
      detachRequest();
      startExecution(record, operation, controller);
      // The SDK's TypeScript CallToolResult omits this Tasks extension, while its 2026 tools/call wire schema passes through the open resultType.
      return {
        content: [],
        resultType: "task",
        task: taskView(record),
      } as unknown as CallToolResult;
    },

    async get(taskId: string): Promise<McpTask | undefined> {
      return store.get(taskId);
    },

    async cancel(taskId: string): Promise<boolean> {
      const result = await store.requestCancellation(taskId);
      if (!result.found) return false;
      if (result.working) {
        const controller = running.get(taskId);
        if (controller) controller.abort(new Error("MCP task cancellation requested"));
        else await store.finish(taskId, { status: "cancelled" });
      }
      return true;
    },

    /** Resume acknowledged in-progress tasks after the audit runtime has recovered its durable work. */
    async resume(): Promise<void> {
      if (started || closing) return;
      started = true;
      for (const record of await store.working()) {
        if (record.cancelRequested) {
          await store.finish(record.taskId, { status: "cancelled" });
          continue;
        }
        const controller = new AbortController();
        const operation = Promise.resolve().then(() => execute(record.args, controller.signal));
        startExecution(record, operation, controller);
      }
    },

    close(): Promise<void> {
      if (!closePromise) {
        closing = true;
        for (const controller of running.values()) controller.abort(new Error("Pronto MCP endpoint is closing"));
        closePromise = store.close();
      }
      return closePromise;
    },
  };
}
