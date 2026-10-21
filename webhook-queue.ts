import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { createAuditQueue, type Enqueued } from "./audit-queue.ts";
import { parseReviewTarget } from "./reviews.ts";

type Pending = { url: string; task: TaskId<null>; running: boolean; rerun: boolean };
const Queue = defineDoc<{ recent: string[]; pending: Record<string, Pending> }>({
  kind: "app.webhook-queue", version: 1, scope: "session",
  initial: () => ({ recent: [], pending: {} }),
});
export type Accepted = Enqueued | "duplicate";

/** Durable admission per repository; the ordinary queue only dispatches task invocations across repositories. */
export function createWebhookQueue({ concurrency, audit, onError, beforeDispatch }: {
  concurrency: number;
  audit(url: string): Promise<void>;
  beforeDispatch?(url: string): Promise<void>;
  onError(url: string, error: unknown): void;
}) {
  type Scheduled = { id: string; ready: ReturnType<typeof Promise.withResolvers<() => Promise<void>>> };
  const callbacks = new Map<string, Scheduled[]>();
  const scheduled = new Map<string, Scheduled>();
  const shutdown = new AbortController();
  const dispatchContext = withAbortSignal(shutdown.signal, BACKGROUND_CONTEXT);
  const key = (url: string) => {
    const target = parseReviewTarget(url);
    return `${new URL(target.url).origin}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.pr}`;
  };
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

  // Reserve dispatch order at durable admission, not when a repository scheduler happens to
  // invoke the task. A slot can wait for that invocation without starting an audit.
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

  const Work = defineTask<{ pr: string; url: string }, { phase: "dispatch"; attempt: number }, null>({
    name: "app.webhook-audit", version: 1,
    initial: () => ({ phase: "dispatch", attempt: 0 }),
    phases: {
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
              await audit(task.input.url);
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
            if (rerun && !closed) schedule(task.input.url, rerun);
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
          await runtime.sleep(runtime.now() + 1000, context);
          await runtime.commit(() => ({ status: "running", checkpoint: {
            phase: "dispatch", attempt: task.state.checkpoint.attempt + 1,
          } }), context);
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
    async admit(harness: Harness, url: string, deliveryId?: string): Promise<Accepted> {
      if (closed) return "closed";
      const pr = String(parseReviewTarget(url).pr);
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      const result = await harness.commit(async (tx) => {
        if (closed) return { outcome: "closed" as const, pending: null };
        const queue = await tx.doc(Queue);
        const accepted = (outcome: Accepted) => {
          const pending = queue.pending[pr];
          return { outcome, pending: pending ? { url: pending.url, task: pending.task } : null };
        };
        if (deliveryId && queue.recent.includes(deliveryId)) return accepted("duplicate");
        const pending = queue.pending[pr];
        let outcome: Enqueued = "coalesced";
        if (!pending) {
          const task = await tx.createTask(Work, { pr, url }, {
            ownership: { kind: "conversation" }, conversationId: conversation.id,
          });
          queue.pending[pr] = { url, task, running: false, rerun: false };
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
      if (result.pending && !closed) schedule(result.pending.url, result.pending.task);
      return result.outcome;
    },
    /** Called before normal admissions or scheduler startup, while the auditor owns this database. */
    async recover(harness: Harness, context: Context): Promise<string[]> {
      if (!await harness.snapshot(Queue, context)) return [];
      return harness.commit(async (tx) => {
        const queue = await tx.doc(Queue);
        for (const [pr, pending] of Object.entries(queue.pending)) {
          const task = await tx.task(pending.task);
          if (!task || task.state.status === "terminal") {
            const root = await tx.conversation(ROOT_CONVERSATION_ID);
            if (!root) throw new Error("Webhook queue conversation is missing");
            pending.task = await tx.createTask(Work, { pr, url: pending.url }, {
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
