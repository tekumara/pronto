import { setTimeout as delay } from "node:timers/promises";
import { findSubmittedReviewers, type ReviewTarget } from "../github/reviews.ts";

const INITIAL_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;

/** Exponential backoff keeps durable reviewer waits from polling GitHub too aggressively. */
export function reviewerPollDelayMs(attempt: number): number {
  return Math.min(MAX_POLL_MS, INITIAL_POLL_MS * 2 ** Math.max(0, Math.min(attempt, 20)));
}

/** Reviewer logins whose submitted reviews are not yet visible on GitHub. */
export async function missingReviewerReviews(target: ReviewTarget, reviewers: readonly string[], signal?: AbortSignal): Promise<string[]> {
  if (!reviewers.length) return [];
  const submitted = await findSubmittedReviewers(target, signal);
  return reviewers.filter((reviewer) => !submitted.has(reviewer.toLowerCase()));
}

/** Wait for one submitted review per configured reviewer. Aborting the caller stops this wait, never passes the gate. */
export async function waitForReviewerReviews(target: ReviewTarget, reviewers: readonly string[], signal?: AbortSignal,
  onStatus?: (status: "waiting" | "satisfied" | "unavailable", detail?: string[] | unknown) => void): Promise<void> {
  let attempt = 0;
  let announcedWait = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const missing = await missingReviewerReviews(target, reviewers, signal);
      if (!missing.length) {
        if (announcedWait) onStatus?.("satisfied");
        return;
      }
      if (!announcedWait) {
        onStatus?.("waiting", missing);
        announcedWait = true;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!announcedWait) {
        onStatus?.("waiting", [...reviewers]);
        announcedWait = true;
      }
      if (attempt === 0 || attempt % 10 === 0) onStatus?.("unavailable", error);
    }
    await delay(reviewerPollDelayMs(attempt++), undefined, signal ? { signal } : undefined);
  }
}
