import { parseReviewTarget } from "../github/reviews.ts";

/** Canonical identity shared by batch validation and the server's execution scheduler. */
export function auditTargetKey(url: string): string {
  const target = parseReviewTarget(url);
  return `${new URL(target.url).origin}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.pr}`;
}

/** Limits webhook and manual work together and never overlaps two audits of the same PR. */
export function createAuditScheduler(concurrency: number) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Audit concurrency must be a positive integer.");
  type Job = { key: string; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void;
    signal?: AbortSignal; onAbort: () => void };
  const waiting: Job[] = [];
  const active = new Set<string>();
  let closed = false;

  function pump() {
    while (!closed && active.size < concurrency) {
      const index = waiting.findIndex((job) => !active.has(job.key));
      if (index < 0) break;
      const [job] = waiting.splice(index, 1);
      job!.signal?.removeEventListener("abort", job!.onAbort);
      active.add(job!.key);
      void Promise.resolve().then(job!.run).then(job!.resolve, job!.reject).finally(() => {
        active.delete(job!.key);
        pump();
      });
    }
  }

  return {
    run<T>(url: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(new Error("Audit scheduler is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const key = auditTargetKey(url);
      return new Promise<T>((resolve, reject) => {
        const job: Job = { key, run, resolve: (value) => resolve(value as T), reject, signal, onAbort: () => {
          const index = waiting.indexOf(job);
          if (index >= 0) {
            waiting.splice(index, 1);
            reject(signal?.reason ?? new Error("Audit cancelled"));
            pump();
          }
        } };
        waiting.push(job);
        signal?.addEventListener("abort", job.onAbort, { once: true });
        pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of waiting.splice(0)) {
        job.signal?.removeEventListener("abort", job.onAbort);
        job.reject(new Error("Audit scheduler is closed"));
      }
    },
  };
}
