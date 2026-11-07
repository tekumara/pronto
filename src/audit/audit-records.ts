import { defineDoc, defineDocFamily, type ConversationId, type ModelRef, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { ReviewSnapshot } from "../github/reviews.ts";
import type { PublicationChoices, PublicationResult } from "./publication.ts";

export type MigrationAssessment = { status: "migration" | "not-migration" | "uncertain"; reason: string };
export type ModelCostInfo = { model: ModelRef | null; costUsd: string };
export type Assessment = { commentKey: string; findings: {
  summary: string; status: string; reason: string; nextStep?: string; awaiting?: string; evidence: string[];
}[] };
export type AuditState = {
  snapshot: ReviewSnapshot | null; report: Assessment[] | null; inspected: string[];
  databaseMigration?: MigrationAssessment | null; // Older saved reports have no classification.
  modelCost?: ModelCostInfo | null; // Older saved reports have no model or cost metadata.
};
export const AuditDocument = defineDoc<AuditState>({
  kind: "app.review-audit", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
  initial: () => ({ snapshot: null, report: null, inspected: [], databaseMigration: null, modelCost: null }),
});
export type CachedAssessment = {
  fingerprint: string; conversationId: ConversationId; assessedAt: string; lastCheckedAt: string;
};
export type AuditResult = { submissionId: SubmissionId };
export type AuditRunsState = {
  active: ConversationId | null; controllerTask: TaskId<AuditResult> | null; complete: boolean;
  restartModel: ModelRef | null; latestSuccess: CachedAssessment | null;
};
export const AuditRuns = defineDocFamily<AuditRunsState, null>({
  kind: "app.review-audit-runs", version: 1, scope: "session", family: true, checkpointWhen: () => false,
  initial: () => ({ active: null, controllerTask: null, complete: true, restartModel: null, latestSuccess: null }),
});
export const AuditIdentity = defineDoc<{ fingerprint: string | null; policy: string | null }>({
  kind: "app.review-audit-identity", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
  initial: () => ({ fingerprint: null, policy: null }),
});
export const AUDIT_CONTROLLER_KIND = "app.review-audit-controller";

// Explicit caller choices saved before model execution. Recovery never substitutes server flags.
export const PublicationRequests = defineDoc<{
  choices: PublicationChoices[]; tasks: Record<string, TaskId<PublicationResult>>;
}>({
  kind: "app.audit-publication-requests", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
  initial: () => ({ choices: [], tasks: {} }),
});
