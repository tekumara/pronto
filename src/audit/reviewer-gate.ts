import { auditTargetKey, findSubmittedReviewers, type ReviewTarget } from "../github/reviews.ts";

const INITIAL_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;

/** Exponential backoff keeps durable reviewer waits from polling GitHub too aggressively. */
export function reviewerPollDelayMs(attempt: number): number {
  return Math.min(MAX_POLL_MS, INITIAL_POLL_MS * 2 ** Math.max(0, Math.min(attempt, 20)));
}

type WaitingReviewer = { reviewers: Set<string>; wake(): void };
export type ReviewerWait = { promise: Promise<void>; close(): void };
export type ReviewerTimer = (callback: () => void, delayMs: number) => () => void;

/** In-process wake signals for signed submitted-review webhooks; callers still verify GitHub history after a wake. */
export function createReviewerWakeups() {
  const waiters = new Map<string, Set<WaitingReviewer>>();
  return {
    subscribe(target: ReviewTarget, reviewers: readonly string[]): ReviewerWait {
      const key = auditTargetKey(target);
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      const waiting: WaitingReviewer = { reviewers: new Set(reviewers.map((reviewer) => reviewer.toLowerCase())), wake: resolve };
      let group = waiters.get(key);
      if (!group) waiters.set(key, group = new Set());
      group.add(waiting);
      let closed = false;
      return { promise, close() {
        if (closed) return;
        closed = true;
        group!.delete(waiting);
        if (!group!.size) waiters.delete(key);
      } };
    },
    notify(target: ReviewTarget, reviewer: string): void {
      const login = reviewer.toLowerCase();
      for (const waiting of waiters.get(auditTargetKey(target)) ?? []) {
        if (waiting.reviewers.has(login)) waiting.wake();
      }
    },
  };
}

export type ReviewerWakeups = ReturnType<typeof createReviewerWakeups>;

const nodeTimer: ReviewerTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Wake on a matching submitted-review webhook, or poll after the fallback delay. */
export function waitForReviewerWakeOrPoll(waiter: ReviewerWait | undefined, delayMs: number, signal?: AbortSignal,
  timer: ReviewerTimer = nodeTimer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimer = () => {};
    const cleanup = () => {
      cancelTimer();
      signal?.removeEventListener("abort", abort);
      waiter?.close();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason ?? new Error("Reviewer wait aborted"));
    };
    waiter?.promise.then(finish);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    cancelTimer = timer(finish, delayMs);
    if (settled) cancelTimer();
  });
}

/** Reviewer logins whose submitted reviews are not yet visible on GitHub. */
export async function missingReviewerReviews(target: ReviewTarget, reviewers: readonly string[], signal?: AbortSignal): Promise<string[]> {
  if (!reviewers.length) return [];
  const submitted = await findSubmittedReviewers(target, signal);
  return reviewers.filter((reviewer) => !submitted.has(reviewer.toLowerCase()));
}

/** Wait for one submitted review per configured reviewer. Aborting the caller stops this wait, never passes the gate. */
export async function waitForReviewerReviews(target: ReviewTarget, reviewers: readonly string[], signal?: AbortSignal,
  onStatus?: (status: "waiting" | "satisfied" | "unavailable", detail?: string[] | unknown) => void,
  wakeups?: ReviewerWakeups): Promise<void> {
  let attempt = 0;
  let announcedWait = false;
  for (;;) {
    signal?.throwIfAborted();
    const waiter = wakeups?.subscribe(target, reviewers);
    try {
      let missing: string[];
      try {
        missing = await missingReviewerReviews(target, reviewers, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!announcedWait) {
          onStatus?.("waiting", [...reviewers]);
          announcedWait = true;
        }
        if (attempt === 0 || attempt % 10 === 0) onStatus?.("unavailable", error);
        await waitForReviewerWakeOrPoll(waiter, reviewerPollDelayMs(attempt++), signal);
        continue;
      }
      if (!missing.length) {
        if (announcedWait) onStatus?.("satisfied");
        return;
      }
      if (!announcedWait) {
        onStatus?.("waiting", missing);
        announcedWait = true;
      }
      await waitForReviewerWakeOrPoll(waiter, reviewerPollDelayMs(attempt++), signal);
    } finally {
      waiter?.close();
    }
  }
}
