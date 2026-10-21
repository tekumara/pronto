import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineExtension, defineTask, type ConversationId, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { fetchViewerLogin, reconcileAuditReview, StaleReviewSnapshotError, submitAuditReview, type ReviewSnapshot } from "./reviews.ts";

export type PublicationChoices = { apply: boolean; approve: boolean; allowUncertain: boolean; approveMigrations: boolean };
export type PublicationIntent = {
  choices: PublicationChoices; target: ReviewSnapshot["target"]; headSha: string; baseSha: string;
  event: "COMMENT" | "APPROVE"; body: string; fingerprint: string;
};
// A null URL hands a stale approval back to assessment, rather than recording a submission.
export type PublicationResult = { url: string | null };
type ReassessmentRequest = Pick<PublicationIntent, "target" | "choices" | "fingerprint"> & { author: string | null };
const Reassessments = defineDoc<{ pending: Record<string, ReassessmentRequest> }>({
  kind: "app.audit-reassessments", version: 1, scope: "session",
  initial: () => ({ pending: {} }),
});

/** Requests survive the gap between retiring a stale publication and admitting fresh evidence. */
export async function pendingReassessments(harness: Harness, context: Context): Promise<Record<string, ReassessmentRequest>> {
  return (await harness.snapshot(Reassessments, context))?.pending ?? {};
}

export async function completeReassessment(tx: Tx, pr: string, request: ReassessmentRequest | undefined): Promise<void> {
  if (!request) return;
  const reassessments = await tx.doc(Reassessments);
  if (reassessments.pending[pr]?.fingerprint === request.fingerprint) delete reassessments.pending[pr];
}
export const SubmittedAuditReviews = defineDocFamily<{
  reviews: Record<string, { headSha: string; event: "COMMENT" | "APPROVE"; url: string; recordedAt: string }>;
}, null>({
  kind: "app.submitted-audit-reviews", version: 1, scope: "session", family: true,
  initial: () => ({ reviews: {} }),
});
// The intent is immutable. Only delivery state and the pointer to a retry task change.
const Publications = defineDocFamily<{
  pending: Record<string, { intent: PublicationIntent; taskId: TaskId<PublicationResult>; author: string | null; attempted: boolean; failed: boolean }>;
}, null>({
  kind: "app.audit-publications", version: 1, scope: "session", family: true,
  initial: () => ({ pending: {} }),
});

function publicationTask(beforePublish?: () => Promise<void>) {
  return defineTask<PublicationIntent, { phase: "publish" }, PublicationResult>({
  name: "app.publish-audit-review", version: 1,
  initial: () => ({ phase: "publish" }),
  phases: {
    publish: async (task, runtime, context) => {
      const intent = task.input;
      const pr = String(intent.target.pr);
      try {
        if (!intent.choices.apply) throw new Error("Publication requires explicit --apply");
        const receipt = (await runtime.snapshot(SubmittedAuditReviews, pr, context))?.reviews[intent.fingerprint];
        let url = receipt?.url;
        if (!url) {
          const pending = (await runtime.snapshot(Publications, pr, context))?.pending[intent.fingerprint];
          if (!pending || pending.taskId !== task.id) throw new Error("Publication intent is missing or superseded");
          const author = pending.author ?? await fetchViewerLogin(context.abortSignal);
          // A persisted attempt means the previous process may have posted, even without a response.
          // Reconciliation failures must not fall through to another POST.
          if (pending.attempted) url = await reconcileAuditReview(intent, author, context.abortSignal) ?? undefined;
          if (!url) {
            const currentAuthor = pending.author ? await fetchViewerLogin(context.abortSignal) : author;
            if (currentAuthor.toLowerCase() !== author.toLowerCase()) {
              throw new Error(`Pending verdict belongs to ${author}; restore that GitHub account before retrying.`);
            }
            // Commit before entering the ambiguous network boundary. This state survives failed tasks too.
            await runtime.commit(async (tx) => {
              const delivery = (await tx.doc(Publications, pr, null)).pending[intent.fingerprint]!;
              delivery.author = author;
              delivery.attempted = true;
              return undefined;
            }, context);
            // The attempt marker must be remotely durable and this term still ready before the POST.
            await beforePublish?.();
            context.abortSignal?.throwIfAborted();
            url = (await submitAuditReview(intent, intent.body, {
              approve: intent.event === "APPROVE", apply: true, signal: context.abortSignal,
            }))!;
          }
        }
        const submittedUrl = url;
        // Receipt and terminal outcome share a commit. If close/crash wins, reconciliation runs next time.
        await runtime.commit(async (tx) => {
          (await tx.doc(SubmittedAuditReviews, pr, null)).reviews[intent.fingerprint] = {
            headSha: intent.headSha, event: intent.event, url: submittedUrl, recordedAt: new Date(runtime.now()).toISOString(),
          };
          delete (await tx.doc(Publications, pr, null)).pending[intent.fingerprint];
          return { status: "terminal", outcome: { status: "completed", result: { url: submittedUrl } } };
        }, context);
      } catch (error) {
        if (runtime.signal.aborted) throw error; // Closing leaves the task recoverable, not failed.
        if (error instanceof StaleReviewSnapshotError) {
          await runtime.commit(async (tx) => {
            const publications = await tx.doc(Publications, pr, null);
            const pending = publications.pending[intent.fingerprint];
            if (pending?.taskId !== task.id) throw new Error("Publication intent is missing or superseded");
            (await tx.doc(Reassessments)).pending[pr] = {
              target: intent.target, choices: intent.choices, fingerprint: intent.fingerprint, author: pending.author,
            };
            delete publications.pending[intent.fingerprint];
            return { status: "terminal", outcome: { status: "completed", result: { url: null } } };
          }, context);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await runtime.commit(async (tx) => {
          const pending = (await tx.doc(Publications, pr, null)).pending[intent.fingerprint];
          if (pending?.taskId === task.id) pending.failed = true;
          return { status: "terminal", outcome: { status: "failed", error: { message } } };
        }, context);
        runtime.report(new Error(`Verdict publication pending for ${intent.target.url}: ${message}`));
      }
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      delete (await tx.doc(Publications, String(task.input.target.pr), null)).pending[task.input.fingerprint];
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
  });
}
const PublishReview = publicationTask();
export function createPublisher(beforePublish?: () => Promise<void>) {
  return defineExtension({ name: "audit-publisher", tasks: [publicationTask(beforePublish)] });
}

/** Atomic handoff for verdict and skip reviews. Skips use the root conversation. */
export async function enqueuePublication(tx: Tx, conversationId: ConversationId, intent: PublicationIntent): Promise<TaskId<PublicationResult> | null> {
  if (!intent.choices.apply) return null;
  const pr = String(intent.target.pr);
  if ((await tx.doc(SubmittedAuditReviews, pr, null)).reviews[intent.fingerprint]) return null;
  const publications = await tx.doc(Publications, pr, null);
  const pending = publications.pending[intent.fingerprint];
  if (pending && !pending.failed) return pending.taskId;
  const savedIntent = pending?.intent ?? intent;
  const taskId = await tx.createTask(PublishReview, savedIntent, {
    conversationId, ownership: { kind: "conversation" }, background: true,
  });
  publications.pending[intent.fingerprint] = {
    intent: savedIntent, taskId, author: pending?.author ?? null, attempted: pending?.attempted ?? false, failed: false,
  };
  return taskId;
}

/** Discover both live tasks and failed deliveries, without admitting a model run or consulting new CLI flags. */
export async function recoverPublications(harness: Harness, context: Context): Promise<{ target: ReviewSnapshot["target"]; taskId: TaskId<PublicationResult> }[]> {
  const pending: { target: ReviewSnapshot["target"]; taskId: TaskId<PublicationResult> }[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanTasks({ kind: PublishReview.definition.name }, 100, cursor), context);
    for (const record of page.items) {
      if (record.version !== PublishReview.definition.version) continue;
      const intent = record.input as PublicationIntent;
      const delivery = (await harness.snapshot(Publications, String(intent.target.pr), context))?.pending[intent.fingerprint];
      if (delivery?.taskId !== record.id) continue;
      let taskId = delivery.taskId;
      if (record.state.status === "terminal") {
        if (!["failed", "faulted"].includes(record.state.outcome.status)) continue;
        taskId = (await harness.commit(async (tx) => {
          (await tx.doc(Publications, String(intent.target.pr), null)).pending[intent.fingerprint]!.failed = true;
          return enqueuePublication(tx, record.conversationId, intent);
        }, context))!;
      }
      pending.push({ target: intent.target, taskId });
    }
    cursor = page.next;
  } while (cursor);
  // A retry created while scanning can appear on a later page.
  return [...new Map(pending.map((item) => [item.taskId, item])).values()];
}

export async function waitForPublication(harness: Harness, taskId: TaskId<PublicationResult>, context: Context): Promise<string | null> {
  const outcome = (await harness.waitForTask(taskId, context)).state.outcome;
  if (outcome.status === "completed") return outcome.result.url;
  throw new Error(outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.message : `Verdict publication ${outcome.status}`);
}
