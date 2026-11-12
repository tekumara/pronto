import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { missingReviewerReviews, reviewerPollDelayMs } from "../audit/reviewer-gate.ts";
import { auditTargetKey, parseReviewTarget } from "../github/reviews.ts";
import { createAuditQueue, type Enqueued } from "./audit-queue.ts";

type Pending = { url: string; task: TaskId<null>; running: boolean; rerun: boolean; requiredReviewers?: string[]; reason?: string };
type QueueState = { recent: string[]; pending: Record<string, Pending>; firstReady?: Record<string, true> };
const Queue = defineDoc<QueueState>({
  kind: "app.webhook-queue", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ recent: [], pending: {}, firstReady: {} }),
});
export type Accepted = Enqueued | "duplicate";
export type WebhookAdmission = { firstReady?: true; reason?: string };
type WorkInput = { pr: string; url: string; requiredReviewers?: string[]; reason?: string };
type WorkCheckpoint = { phase: "review"; attempt: number } | { phase: "dispatch"; attempt: number };

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

/** Durable admission per repository; the ordinary queue only dispatches ready tasks across repositories. */
export function createWebhookQueue({ concurrency, audit, onError, beforeDispatch, requiredReviewers = [],
  onReviewWait, onReviewSatisfied, onReviewError }: {
  concurrency: number;
  audit(url: string, reason?: string): Promise<void>;
  beforeDispatch?(url: string): Promise<void>;
  requiredReviewers?: string[];
  onError(url: string, error: unknown): void;
  onReviewWait?(url: string, missing: string[]): void;
  onReviewSatisfied?(url: string): void;
  onReviewError?(url: string, error: unknown): void;
}) {
  type Scheduled = { id: string; ready: ReturnType<typeof Promise.withResolvers<() => Promise<void>>> };
  const callbacks = new Map<string, Scheduled[]>();
  const scheduled = new Map<string, Scheduled>();
  const shutdown = new AbortController();
  const dispatchContext = withAbortSignal(shutdown.signal, BACKGROUND_CONTEXT);
  const key = (url: string) => auditTargetKey(parseReviewTarget(url));
  const configuredReviewers = [...requiredReviewers];
  let closed = false;
  const dispatch = createAuditQueue({
    concurrency,
    audit: async (url) => {
      const jobs = callbacks.get(key(url))!;
      const job = jobs.shift()!;
      if (!jobs.length) callbacks.delete(key(url));
      try {
        const run = await awaitWithContext(job.ready.promise, dispatchContext);
        await run();
      } finally {
        scheduled.delete(job.id);
      }
    },
  });

  // Reserve dispatch order at durable admission for ordinary work. Reviewer-gated work joins
  // the dispatch queue only after the required reviews exist, so a long wait uses no audit slot.
  function schedule(url: string, task: TaskId<null>): Scheduled {
    const pr = key(url);
    const id = `${pr}:${task}`;
    const existing = scheduled.get(id);
    if (existing) return existing;
    const job = { id, ready: Promise.withResolvers<() => Promise<void>>() };
    scheduled.set(id, job);
    const jobs = callbacks.get(pr) ?? [];
    jobs.push(job);
    callbacks.set(pr, jobs);
    dispatch.enqueue(url);
    return job;
  }

  const Work = defineTask<WorkInput, WorkCheckpoint, null>({
    name: "app.webhook-audit", version: 2,
    initial: (input) => input.requiredReviewers?.length
      ? { phase: "review", attempt: 0 }
      : { phase: "dispatch", attempt: 0 },
    migrate: (input, _checkpoint, fromVersion) => {
      if (fromVersion !== 1) throw new Error(`Unsupported webhook audit task version: ${fromVersion}`);
      const saved = record(input);
      if (typeof saved?.pr !== "string" || typeof saved.url !== "string") throw new Error("Malformed webhook audit task input");
      const reviewers = Array.isArray(saved.requiredReviewers)
        ? saved.requiredReviewers.filter((reviewer): reviewer is string => typeof reviewer === "string")
        : configuredReviewers;
      const reason = typeof saved.reason === "string" ? saved.reason : undefined;
      return {
        input: { pr: saved.pr, url: saved.url, requiredReviewers: reviewers, ...(reason ? { reason } : {}) },
        checkpoint: reviewers.length ? { phase: "review", attempt: 0 } : { phase: "dispatch", attempt: 0 },
      };
    },
    phases: {
      review: async (task, runtime, context) => {
        const reviewers = task.input.requiredReviewers ?? [];
        let missing: string[];
        try {
          missing = await missingReviewerReviews(parseReviewTarget(task.input.url), reviewers, context.abortSignal);
        } catch (error) {
          if (context.abortSignal?.aborted || runtime.signal.aborted) throw error;
          if (task.state.checkpoint.attempt === 0 || task.state.checkpoint.attempt % 10 === 0) onReviewError?.(task.input.url, error);
          await runtime.sleepUntil(runtime.now() + reviewerPollDelayMs(task.state.checkpoint.attempt), {
            phase: "review", attempt: task.state.checkpoint.attempt + 1,
          }, context);
          return;
        }
        if (missing.length) {
          if (task.state.checkpoint.attempt === 0) onReviewWait?.(task.input.url, missing);
          await runtime.sleepUntil(runtime.now() + reviewerPollDelayMs(task.state.checkpoint.attempt), {
            phase: "review", attempt: task.state.checkpoint.attempt + 1,
          }, context);
          return;
        }
        if (task.state.checkpoint.attempt > 0) onReviewSatisfied?.(task.input.url);
        schedule(task.input.url, task.id);
        await runtime.sleepUntil(runtime.now(), { phase: "dispatch", attempt: 0 }, context);
      },
      dispatch: async (task, runtime, context) => {
        const done = Promise.withResolvers<void>();
        const run = async () => {
          try {
            await runtime.commit(async (tx) => {
              const pending = (await tx.doc(Queue)).pending[task.input.pr];
              if (!pending || pending.task !== task.id) throw new Error("Webhook task lost its queue entry");
              pending.running = true;
              return undefined;
            }, context);
            // An already-running harness can invoke this task before the HTTP admission finishes.
            // Confirm the committed running/intake intent independently at the worker, before external work.
            await beforeDispatch?.(task.input.url);
            context.abortSignal?.throwIfAborted();
            try {
              await audit(task.input.url, task.input.reason);
            } catch (error) {
              // Shutdown leaves the intake task and its rerun intact, even before evidence admission.
              if (closed || runtime.signal.aborted) throw error;
              onError(task.input.url, error);
            }
            let rerun: TaskId<null> | undefined;
            await runtime.commit(async (tx) => {
              const queue = await tx.doc(Queue);
              const pending = queue.pending[task.input.pr]!;
              if (pending.rerun) {
                pending.task = rerun = await tx.createTask(Work, task.input, {
                  ownership: { kind: "conversation" }, conversationId: task.conversationId,
                });
                pending.running = false;
                pending.rerun = false;
              } else delete queue.pending[task.input.pr];
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }, context);
            if (rerun && !closed && !task.input.requiredReviewers?.length) schedule(task.input.url, rerun);
            done.resolve();
          } catch (error) {
            done.reject(error);
          }
        };
        if (closed) throw new Error("Webhook queue is closed");
        schedule(task.input.url, task.id).ready.resolve(run);
        try {
          await awaitWithContext(done.promise, context);
        } catch (error) {
          // Do not turn a transient bookkeeping failure into lost accepted work. A crash/close
          // preserves the checkpoint; other infrastructure failures retry with a bounded delay.
          if (closed || runtime.signal.aborted) throw error;
          runtime.report(error);
          await runtime.sleepUntil(runtime.now() + 1000, {
            phase: "dispatch", attempt: task.state.checkpoint.attempt + 1,
          }, context);
          return;
        }
      },
    },
    abort: async (_task, runtime, context) => {
      // Explicit cancellation is not used by serve. Keep the intent for startup repair.
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  return {
    extension: defineExtension({ name: "webhook-queue", tasks: [Work] }),
    /** Admission only: the owner resumes scheduling after all startup intents are in place. */
    async admit(harness: Harness, url: string, deliveryId?: string, admission: WebhookAdmission = {}): Promise<Accepted> {
      if (closed) return "closed";
      const pr = String(parseReviewTarget(url).pr);
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const result = await harness.commit(async (tx) => {
        if (closed) return { outcome: "closed" as const, pending: null };
        const queue = await tx.doc(Queue);
        queue.firstReady ??= {};
        const accepted = (outcome: Accepted) => {
          const pending = queue.pending[pr];
          return { outcome, pending: pending ? { url: pending.url, task: pending.task, gated: !!pending.requiredReviewers?.length } : null };
        };
        if (deliveryId && queue.recent.includes(deliveryId)) return accepted("duplicate");
        if (admission.firstReady && queue.firstReady[pr]) {
          if (deliveryId) {
            queue.recent.push(deliveryId);
            if (queue.recent.length > 1000) queue.recent.shift();
          }
          return accepted("duplicate");
        }
        if (admission.firstReady) queue.firstReady[pr] = true;
        const pending = queue.pending[pr];
        let outcome: Enqueued = "coalesced";
        if (!pending) {
          const taskInput: WorkInput = { pr, url, requiredReviewers: [...configuredReviewers], ...(admission.reason ? { reason: admission.reason } : {}) };
          const task = await tx.createTask(Work, taskInput, {
            ownership: { kind: "conversation" }, conversationId: conversation.id,
          });
          queue.pending[pr] = { url, task, running: false, rerun: false, requiredReviewers: [...configuredReviewers],
            ...(admission.reason ? { reason: admission.reason } : {}) };
          outcome = "queued";
        } else if (pending.running && !pending.rerun) {
          pending.rerun = true;
          outcome = "rerun";
        }
        if (deliveryId) {
          queue.recent.push(deliveryId);
          if (queue.recent.length > 1000) queue.recent.shift();
        }
        return accepted(outcome);
      }, BACKGROUND_CONTEXT);
      if (result.pending && !result.pending.gated && !closed) schedule(result.pending.url, result.pending.task);
      return result.outcome;
    },
    /** Called before normal admissions or scheduler startup, while the auditor owns this database. */
    async recover(harness: Harness, context: Context): Promise<string[]> {
      if (!await harness.snapshot(Queue, context)) return [];
      return harness.commit(async (tx) => {
        const queue = await tx.doc(Queue);
        queue.firstReady ??= {};
        for (const [pr, pending] of Object.entries(queue.pending)) {
          pending.requiredReviewers ??= [...configuredReviewers];
          const task = await tx.task(pending.task);
          if (!task || task.state.status === "terminal") {
            const root = await tx.conversation(ROOT_CONVERSATION_ID);
            if (!root) throw new Error("Webhook queue conversation is missing");
            pending.task = await tx.createTask(Work, {
              pr, url: pending.url, requiredReviewers: pending.requiredReviewers, ...(pending.reason ? { reason: pending.reason } : {}),
            }, {
              ownership: { kind: "conversation" }, conversationId: root.id,
            });
          }
          pending.running = false;
        }
        return Object.values(queue.pending).map(({ url }) => url);
      }, context);
    },
    close() { closed = true; dispatch.close(); shutdown.abort(new Error("Webhook queue is closed")); },
    idle: () => dispatch.idle(),
  };
}
