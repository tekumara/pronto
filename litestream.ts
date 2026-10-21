import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { open, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { repositoryDatabasePath } from "./state.ts";
import { replicaURL, type ReplicaConfig, type RestorePoint } from "./s3-control.ts";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A daemon is never restarted or reset within an incarnation. */
export class Litestream {
  private child?: ChildProcess;
  private ipcDirectory?: string;
  private socket?: string;
  private stopped = false;
  private closing?: Promise<void>;
  private starting?: Promise<void>;
  private registrations = new Map<string, Promise<void>>();
  private config: ReplicaConfig;
  readonly root: string;
  readonly prefix: string;
  private signal: AbortSignal;
  private failed: (error: Error) => void;
  constructor(config: ReplicaConfig, root: string, prefix: string, signal: AbortSignal, failed: (error: Error) => void) {
    this.config = config; this.root = root; this.prefix = prefix; this.signal = signal; this.failed = failed;
  }

  async restore(source: string, plan: RestorePoint[]): Promise<void> {
    for (const { relative, txid } of plan) {
      this.signal.throwIfAborted();
      const path = repositoryDatabasePath(this.root, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // No -if-replica-exists or -if-db-not-exists: a missing history is a bootstrap failure.
      await exec(this.config.binary, ["restore", "-o", path, "-integrity-check", "full", "-txid", txid,
        replicaURL(this.config, `${source}/${relative}`)], { signal: this.signal, timeout: 120_000, maxBuffer: 1024 * 1024 });
    }
  }
  start(): Promise<void> {
    if (this.starting || this.stopped) return Promise.reject(new Error("Litestream incarnations cannot be restarted"));
    return this.starting = this.startProcess();
  }
  private async startProcess(): Promise<void> {
    this.signal.throwIfAborted();
    // Short, private socket paths also work on Darwin (104-byte sockaddr_un limit).
    this.ipcDirectory = await mkdtemp(join(tmpdir(), "pronto-ls-"));
    this.socket = join(this.ipcDirectory, "ipc.sock");
    const configPath = join(this.root, "litestream.yml");
    await writeFile(configPath, `socket:\n  enabled: true\n  path: ${JSON.stringify(this.socket)}\nretention:\n  enabled: false\nauto-recover: false\ndbs: []\n`, { mode: 0o600 });
    const log = await open(join(this.root, "litestream.log"), "a", 0o600);
    try {
      this.signal.throwIfAborted();
      if (this.stopped) throw new Error("Litestream closed during startup");
      const child = this.child = spawn(this.config.binary, ["replicate", "-config", configPath], { stdio: ["ignore", log.fd, log.fd] });
      child.on("error", () => { if (!this.stopped) this.failed(new Error("Litestream process failed to start")); });
      child.on("exit", () => { if (!this.stopped) this.failed(new Error("Litestream child exited; ending owner term")); });
    } finally { await log.close(); }
    for (let i = 0; i < 100; i++) {
      this.signal.throwIfAborted();
      if (this.stopped) throw new Error("Litestream closed during startup");
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Litestream exited during startup");
      try { await this.ipc("info"); return; } catch { await delay(50); }
    }
    throw new Error("Litestream IPC did not become available");
  }
  private ipc(route: string, body?: object): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    if (!this.socket) return Promise.reject(new Error("Litestream is not started"));
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socket, path: `/${route}`, method: body ? "POST" : "GET", signal: this.signal,
        headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Litestream /${route} failed (HTTP ${res.statusCode})`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error("Invalid Litestream IPC response")); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error(`Litestream /${route} timed out`)), 12_000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  enroll(relative: string): Promise<void> {
    let registered = this.registrations.get(relative);
    if (!registered) {
      registered = (async () => {
        const path = repositoryDatabasePath(this.root, relative);
        const result = await this.ipc("register", { path, replica_url: replicaURL(this.config, `${this.prefix}/${relative}`) });
        if (result.status !== "registered") throw new Error("Unexpected duplicate Litestream registration; refusing prefix reuse");
        // /register opens and starts monitoring; /start is unnecessary.
      })();
      this.registrations.set(relative, registered);
    }
    return registered;
  }
  async sync(relative: string): Promise<void> {
    await this.enroll(relative);
    const result = await this.ipc("sync", { path: repositoryDatabasePath(this.root, relative), wait: true, timeout: 8 });
    // Stock /sync reports no_change when its monitor already processed the WAL. With wait=true,
    // SyncDB still runs SyncAndWait before returning either successful status.
    if (!["synced", "no_change"].includes(String(result.status)) || typeof result.replicated_txid !== "number" || result.replicated_txid < 1) {
      throw new Error("Litestream did not confirm remote sync");
    }
    // Never compare this with sampled local TXID: concurrent writers can advance it during sync.
  }
  async flush(): Promise<void> { for (const relative of this.registrations.keys()) await this.sync(relative); }
  close(): Promise<void> {
    this.stopped = true;
    return this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      const child = this.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "close").catch(() => {});
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
        await exited;
        clearTimeout(force);
      }
      if (this.ipcDirectory) await rm(this.ipcDirectory, { recursive: true, force: true });
    })();
  }
}
