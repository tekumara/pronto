import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAuditor, type AuditOptions } from "./auditor.ts";
import type { createModelRuntime } from "./model.ts";
import type { Log } from "./logging.ts";
import { Litestream } from "./litestream.ts";
import { S3Control, conditionalConflict, type ControlHead, type ReplicaConfig } from "./s3-control.ts";

const LEASE_MS = 30_000;
const MARGIN_MS = 5_000;
const RENEW_MS = 5_000;
type Auditor = ReturnType<typeof createAuditor>;
type Term = {
  id: string; prefix: string; root: string; head: ControlHead; deadline: number; ready: boolean;
  cancellation: AbortController; lost: ReturnType<typeof Promise.withResolvers<void>>;
  serial: Promise<unknown>; child: Litestream; auditor?: Auditor; timer?: NodeJS.Timeout;
};

/**
 * Experimental single-primary lifecycle. Standby has no auditor, database or child.
 * Every callback captures a Term; no old callback reads the next term's root or socket.
 */
export async function createPrimaryRuntime(config: ReplicaConfig, options: {
  models: Awaited<ReturnType<typeof createModelRuntime>>["models"];
  audit: AuditOptions; concurrency: number; log: Log;
}) {
  // Standbys may inspect executable configuration, but must not execute even a version child.
  await access(config.binary, constants.X_OK);
  const storage = new S3Control(config);
  let stopping = false;
  let active: Term | undefined;
  const stopped = new AbortController();

  function lose(term: Term, error: unknown): void {
    if (term.cancellation.signal.aborted) return;
    term.ready = false;
    term.cancellation.abort(new Error("Replicated-state ownership is uncertain", { cause: error }));
    term.lost.resolve();
    // Do not log errors containing URLs, request headers or child command environments.
    options.log("warn", "replication", "Owner term ended; admission disabled and work interrupted");
    void term.auditor?.close().catch(() => {});
    void term.child.close().catch(() => {});
  }
  function live(term: Term): void {
    if (stopping || term.cancellation.signal.aborted || performance.now() >= term.deadline) {
      lose(term, new Error("Lease deadline exceeded"));
      throw new Error("Not the ready replicated-state owner");
    }
  }
  function serialize<T>(term: Term, operation: () => Promise<T>): Promise<T> {
    const result = term.serial.then(operation);
    term.serial = result.catch(() => {});
    return result;
  }
  async function mutate(term: Term, promote = false): Promise<void> {
    return serialize(term, async () => {
      live(term);
      const previous = term.head;
      if (previous.record.owner !== term.id || (promote && previous.record.phase !== "bootstrapping")) throw new Error("Unexpected control mutation source");
      const start = performance.now();
      const record = { ...previous.record, revision: randomUUID(), expires: Date.now() + LEASE_MS,
        ...(promote ? { phase: "ready" as const, recovery: term.prefix } : {}) };
      try {
        // No reread/retry on CAS failure, including an ambiguous successful write.
        term.head = await storage.write(record, previous);
        live(term);
        term.deadline = start + LEASE_MS - MARGIN_MS;
      } catch (error) { lose(term, error); throw error; }
    });
  }
  async function confirm(term: Term, relative: string): Promise<void> {
    try {
      live(term);
      if (!term.ready) throw new Error("Owner is bootstrapping");
      await term.child.sync(relative);
      // This GET must be fresh and AFTER remote sync. Never use term.head as confirmation.
      const current = await storage.read();
      live(term);
      if (!current || current.record.owner !== term.id || current.record.phase !== "ready"
        || current.record.recovery !== term.prefix || current.record.expires <= Date.now() + MARGIN_MS) {
        throw new Error("Remote ownership confirmation failed");
      }
    } catch (error) { lose(term, error); throw new Error("Remote durability is unconfirmed", { cause: error }); }
  }
  async function cleanup(term: Term): Promise<void> {
    term.ready = false;
    clearInterval(term.timer);
    term.cancellation.abort(new Error("Owner term closed"));
    await Promise.allSettled([term.auditor?.close(), term.child.close()]);
    await term.serial;
    // Stop writing first. Preserve the complete pointer, even if promotion's response was lost.
    // A fresh read may authorize this NEW operation only for our unique, never-reused term.
    try {
      const current = await storage.read();
      if (current?.record.owner === term.id
        && ((current.record.phase === "ready" && current.record.recovery === term.prefix)
          || (current.record.phase === "bootstrapping" && current.record.recovery === term.head.record.recovery))) {
        await storage.write({ ...current.record, revision: randomUUID(), owner: null, phase: "idle", expires: 0 }, current);
      }
    } catch { /* Never clobber a successor or retry an uncertain release. Expiry permits takeover. */ }
    if (active === term) active = undefined;
  }
  async function attempt(): Promise<void> {
    const head = await storage.read();
    if (stopping || (head?.record.owner && head.record.expires > Date.now())) return;
    const id = randomUUID();
    const start = performance.now();
    let acquired: ControlHead;
    try {
      acquired = await storage.write({ revision: randomUUID(), owner: id, expires: Date.now() + LEASE_MS,
        phase: "bootstrapping", recovery: head?.record.recovery ?? null }, head);
    } catch (error) { if (conditionalConflict(error)) return; throw error; }
    const prefix = `${config.prefix}/terms/${id}`;
    const root = join(config.stateBase, "terms", id);
    const cancellation = new AbortController();
    const term: Term = { id, prefix, root, head: acquired, deadline: start + LEASE_MS - MARGIN_MS, ready: false,
      cancellation, lost: Promise.withResolvers<void>(), serial: Promise.resolve(),
      child: new Litestream(config, root, prefix, cancellation.signal, (error) => lose(term, error)) };
    active = term;
    term.timer = setInterval(() => {
      try { live(term); } catch { return; }
      // Serialize renewal with promotion; a failed mutation ends the term rather than rebasing a stale update.
      void mutate(term).catch(() => {});
    }, RENEW_MS);
    try {
      live(term);
      await mkdir(root, { recursive: false, mode: 0o700 });
      const source = acquired.record.recovery;
      const plan = source ? await storage.inventory(source) : [];
      live(term);
      if (source) await term.child.restore(source, plan);
      await term.child.start();
      for (const point of plan) await term.child.enroll(point.relative);
      live(term);
      term.auditor = createAuditor(options.models, { log: options.log, webhooks: { concurrency: options.concurrency, options: options.audit },
        state: { root, enroll: async (relative) => {
          try { live(term); await term.child.enroll(relative); live(term); } catch (error) { lose(term, error); throw error; }
        }, confirm: (relative) => confirm(term, relative), strictRecovery: true } });
      // recover() stages intent only. No harness resumes before the independent baseline is complete.
      const recovered = await term.auditor.recover();
      if (recovered.skipped.length) throw new Error("Incomplete repository recovery");
      await term.child.flush();
      live(term);
      await mutate(term, true);
      live(term);
      term.ready = true;
      options.log("info", "replication", `Ready owner term ${id}`);
      await term.auditor.resume();
      await term.lost.promise;
    } catch (error) { lose(term, error); }
    finally { await cleanup(term); }
  }
  // No local state is inspected or created until a conditional acquisition succeeds.
  await mkdir(join(config.stateBase, "terms"), { recursive: true, mode: 0o700 });
  const loop = (async () => {
    while (!stopping) {
      try { await attempt(); }
      catch { options.log("warn", "replication", "Control storage unavailable; remaining unready"); }
      if (!stopping) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); stopped.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1_000);
        stopped.signal.addEventListener("abort", done, { once: true });
        if (stopped.signal.aborted) done();
      });
    }
  })();
  const ready = () => {
    if (!active?.ready || stopping) return false;
    try { live(active); return true; } catch { return false; }
  };
  return {
    ready,
    async enqueue(url: string, deliveryId?: string) {
      const term = active;
      if (!ready() || !term?.auditor) return "closed" as const;
      return term.auditor.enqueue(url, deliveryId);
    },
    async close(): Promise<void> {
      stopping = true;
      stopped.abort();
      if (active) lose(active, new Error("Server stopping"));
      await loop;
      storage.close();
    },
  };
}
