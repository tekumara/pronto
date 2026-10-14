import { parseReviewTarget } from "./reviews.ts";

/** `queued`: a new job, which may start at once. `rerun`: it runs again after the current audit. `coalesced`: already covered. */
export type Enqueued = "queued" | "rerun" | "coalesced" | "closed";

type Entry = { url: string; running: boolean; rerun: boolean };

function prKey(url: string): string {
  const target = parseReviewTarget(url);
  return `${new URL(target.url).origin}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.pr}`;
}

/**
 * Runs audits requested by webhook deliveries, at most `concurrency` at once and never two for one PR.
 * A request for a PR that is already waiting changes nothing. A request for a running PR queues one re-run behind the
 * other waiting PRs, because its evidence may have changed after the running audit fetched it.
 *
 * The queue lives in memory. `onError` receives audit failures and must not throw.
 */
export function createAuditQueue({ concurrency, audit, onError }: {
  concurrency: number;
  audit: (url: string) => Promise<void>;
  onError?: (url: string, error: unknown) => void;
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Audit concurrency must be a positive integer.");
  const entries = new Map<string, Entry>();
  const waiting: string[] = [];
  const idleWaiters: (() => void)[] = [];
  let active = 0;
  let closed = false;

  function notifyIdle() {
    if (!entries.size) for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function settle(key: string, entry: Entry) {
    active--;
    entry.running = false;
    if (entry.rerun && !closed) {
      entry.rerun = false;
      waiting.push(key);
    } else entries.delete(key);
    pump();
    notifyIdle();
  }

  function pump() {
    while (!closed && active < concurrency && waiting.length) {
      const key = waiting.shift()!;
      const entry = entries.get(key)!;
      entry.running = true;
      active++;
      // A throw before the first await is a failed audit too.
      void (async () => audit(entry.url))().catch((error) => onError?.(entry.url, error)).finally(() => settle(key, entry));
    }
  }

  return {
    enqueue(url: string): Enqueued {
      if (closed) return "closed";
      const key = prKey(url);
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, { url, running: false, rerun: false });
        waiting.push(key);
        pump();
        return "queued";
      }
      if (entry.running && !entry.rerun) {
        entry.rerun = true;
        return "rerun";
      }
      return "coalesced";
    },
    /** Resolves when nothing is running or waiting. */
    idle(): Promise<void> {
      return entries.size ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
    },
    /**
     * Stops starting audits. Running audits finish on their own, so abort them through their owner. Returns the URLs of
     * requests that were accepted but never ran, or whose re-run was dropped: nothing saves them, so the caller reports them.
     */
    close(): string[] {
      closed = true;
      const dropped: string[] = [];
      for (const [key, entry] of entries) {
        if (!entry.running) {
          dropped.push(entry.url);
          entries.delete(key);
        } else if (entry.rerun) {
          dropped.push(entry.url);
          entry.rerun = false;
        }
      }
      waiting.length = 0;
      notifyIdle();
      return dropped;
    },
  };
}
