import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

type StateTarget = { kind: "chat"; cwd: string } | { kind: "repo"; key: string };

function stateDirectory(): string {
  const override = process.env.PRONTO_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("PRONTO_STATE_DIR must be an absolute path.");
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "pronto");
}

async function lockDatabase(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  await (await open(lockPath, "a", 0o600)).close();
  const lock = new DatabaseSync(lockPath);
  try {
    // Use a separate file so ownership does not block Durable's own transactions. SQLite/OS
    // locking releases on close or process death, without PID files or stale-lock timeouts.
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error(`Database is already in use: ${path}. Stop the other Pronto process and retry.`, { cause: error });
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    lock.close();
    released = true;
    // Do not unlink lock files: another process may already be locking the same inode.
  };
}

/** Open private user state. Closing the harness releases ownership. */
export async function openStateHarness(target: StateTarget, options: HarnessOptions, context: Context): Promise<Harness> {
  const key = target.kind === "repo" ? target.key
    : createHash("sha256").update(await realpath(target.cwd)).digest("hex").slice(0, 20);
  const path = join(stateDirectory(), target.kind === "repo" ? "repos" : "chats", `${key}.sqlite`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockDatabase(path);
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  try {
    await (await open(path, "a", 0o600)).close();
    storage = await openNodeSqliteStorage(path);
    const close = storage.close.bind(storage);
    let closing: Promise<void> | undefined;
    storage.close = (ctx) => closing ??= close(ctx).finally(release);
    return await Harness.open(storage, options, context);
  } catch (error) {
    // Harness initialisation can fail too. Keep the original error, but never leak ownership.
    await storage?.close(context).catch(() => {});
    release();
    throw error;
  }
}
