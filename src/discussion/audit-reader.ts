import { statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { ToolResultEntry, type AgentState, type EntryRecord, type SubmissionRecord, type TaskRecord } from "@earendil-works/pi-durable";
import { AUDIT_CONTROLLER_KIND, AuditDocument, AuditIdentity, AuditRuns, type AuditResult, type AuditRunsState, type AuditState } from "../audit/audit-records.ts";
import { parseReviewTarget } from "../github/reviews.ts";
import { repositoryDatabaseIdentity, repositoryDatabasePath, stateDirectory } from "../state.ts";

export type AuditSection = "summary" | "findings" | "discussion" | "files" | "instructions" | "code";
export type AuditSelection = { prUrl: string; auditId: number; snapshotId: string };

type DocumentRow = { id: number };
type RevisionRow = { seq: number; kind: string; version: number; content: string };
type Controller = TaskRecord<{ pr: string }, { phase: "assess" }, AuditResult>;

/**
 * A read-only view of the pinned Durable SQLite format. Do not open a Harness or SqliteStorage here: both initialise
 * writable state, and a repository Harness can recover assessments and explicitly authorised publications.
 * BEGIN is a deferred read transaction so WAL readers see a consistent commit without taking Pronto's writer lock.
 */
export function readAudit({ prUrl, auditId, section = "summary", commentKey }: {
  prUrl: string; auditId?: number; section?: AuditSection; commentKey?: string;
}, root = stateDirectory()) {
  const target = parseReviewTarget(prUrl);
  const host = encodeURIComponent(new URL(target.url).hostname.toLowerCase());
  const name = `${target.owner.toLowerCase()}~${target.repo.toLowerCase()}`;
  const path = repositoryDatabasePath(root, repositoryDatabaseIdentity(host, name));
  try { statSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No saved audit for ${target.url}. Chat does not run audits.`);
    throw error;
  }
  if (auditId !== undefined && (!Number.isSafeInteger(auditId) || auditId < 1)) throw new Error("auditId must be a positive integer.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
    if (!schema || Number(schema.version) < 1 || Number(schema.version) > CURRENT_SQLITE_SCHEMA_VERSION) {
      throw new Error("Unsupported saved audit database version. Chat will not migrate it.");
    }
    const record = <T>(sql: string, ...params: SQLInputValue[]): T | undefined => {
      const row = db.prepare(sql).get(...params);
      return row ? JSON.parse(String(row.record)) as T : undefined;
    };
    // This matches SqliteStorage.materializeDocument: the latest base plus every same-version delta after it.
    const document = <T>(kind: string, scope: "session" | "conversation", owner: number, key?: string): T | undefined => {
      const row = db.prepare(`SELECT id FROM documents
        WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
        ORDER BY created_at DESC LIMIT 1`).get(JSON.stringify(kind), scope, owner, key === undefined ? 0 : 1, JSON.stringify(key ?? "")) as DocumentRow | undefined;
      if (!row) return undefined;
      const base = db.prepare(`SELECT seq, kind, version, content FROM document_revisions
        WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1`).get(row.id) as RevisionRow | undefined;
      if (!base) throw new Error(`Saved ${kind} document has no base.`);
      if (base.version !== 1) throw new Error(`Unsupported saved ${kind} document version. Chat will not migrate it.`);
      let value = JSON.parse(base.content);
      const tail = db.prepare(`SELECT seq, kind, version, content FROM document_revisions
        WHERE document_id = ? AND seq > ? ORDER BY seq`).all(row.id, base.seq) as RevisionRow[];
      for (const revision of tail) {
        if (revision.kind !== "delta" || revision.version !== base.version) throw new Error(`Invalid saved ${kind} document revisions.`);
        value = apply(value, JSON.parse(revision.content));
      }
      return value as T;
    };
    const runs = document<AuditRunsState>(AuditRuns.definition.kind, "session", 0, String(target.pr));
    const id = auditId ?? runs?.active;
    if (!id) throw new Error(`No saved audit for ${target.url}. Chat does not run audits.`);
    const saved = document<AuditState>(AuditDocument.definition.kind, "conversation", id);
    const snapshot = saved?.snapshot;
    if (!saved || !snapshot) throw new Error(`Saved audit ${id} has no evidence snapshot. This does not establish that the PR has no audit. Latest saved attempt: ${runs?.active ?? "none"}; use the default lookup unless the user requested this ID.`);
    const savedTarget = parseReviewTarget(snapshot.target.url);
    const sameTarget = snapshot.target.pr === target.pr && savedTarget.pr === target.pr
      && snapshot.target.owner.toLowerCase() === target.owner.toLowerCase() && savedTarget.owner.toLowerCase() === target.owner.toLowerCase()
      && snapshot.target.repo.toLowerCase() === target.repo.toLowerCase() && savedTarget.repo.toLowerCase() === target.repo.toLowerCase()
      && new URL(savedTarget.url).origin === new URL(target.url).origin;
    if (!sameTarget) throw new Error(`Audit ${id} does not belong to ${target.url}.`);
    // These values will also be used by the constrained file tool, never supplied by the conversation model.
    for (const sha of [snapshot.headSha, snapshot.baseSha]) {
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Saved audit has an invalid pinned commit.");
    }
    for (const repository of [snapshot.headRepository, snapshot.baseRepository]) {
      if (!/^[\w-]+\/[\w.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) {
        throw new Error("Saved audit has an invalid pinned repository.");
      }
    }
    const controller = record<Controller>("SELECT record FROM tasks WHERE conversation_id = ? AND kind = ? ORDER BY id DESC LIMIT 1", id, JSON.stringify(AUDIT_CONTROLLER_KIND));
    const submission = record<SubmissionRecord>("SELECT record FROM submissions WHERE conversation_id = ? AND request_id = ?", id, JSON.stringify(`review-audit:${snapshot.id}`));
    const accepted = Array.isArray(saved.report);
    const successful = accepted && controller?.input.pr === String(target.pr)
      && controller.state.status === "terminal" && controller.state.outcome.status === "completed"
      && submission?.status === "done" && controller.state.outcome.result.submissionId === submission.id
      && (runs?.active !== id || runs.complete);
    const status = successful ? "completed" : controller?.state.status === "terminal"
      ? controller.state.outcome.status === "completed" ? "failed" : controller.state.outcome.status
      : "incomplete";
    const agent = document<AgentState>("pi.agent", "conversation", id);
    const identity = document<{ fingerprint: string | null; policy: string | null }>(AuditIdentity.definition.kind, "conversation", id);
    const cached = runs?.latestSuccess?.conversationId === id ? runs.latestSuccess : null;
    const audit = {
      prUrl: snapshot.target.url, auditId: id, snapshotId: snapshot.id,
      title: snapshot.title, headSha: snapshot.headSha, baseSha: snapshot.baseSha,
      headRepository: snapshot.headRepository, baseRepository: snapshot.baseRepository,
      startedAt: snapshot.startedAt, fetchedAt: snapshot.fetchedAt,
      status, reportAccepted: accepted, submissionStatus: submission?.status ?? "unknown",
      failure: submission?.status === "unanswered" ? submission.reason : null,
      assessedAt: cached?.assessedAt ?? null, lastCheckedAt: cached?.lastCheckedAt ?? null,
      latestAttemptId: runs?.active ?? null, cachedSuccessId: runs?.latestSuccess?.conversationId ?? null,
      model: saved.modelCost?.model ?? agent?.model ?? null, policyHash: identity?.policy ?? null,
      limitations: [
        "This is saved audit evidence, not current GitHub thread, approval or merge status.",
        ...(!successful ? ["This attempt is not a completed successful audit, even if a report was accepted."] : []),
        ...(typeof agent?.instructions !== "string" ? ["The instructions used for this audit are unavailable."] : []),
      ],
    };
    if (commentKey && !snapshot.comments.some((comment) => comment.key === commentKey)) throw new Error(`Unknown saved source: ${commentKey}`);
    let data: unknown;
    switch (section) {
      case "summary": {
        const sources = new Map(snapshot.comments.map((comment) => [comment.key, comment]));
        const findings = saved.report?.flatMap((assessment) => assessment.findings.map((finding, index) => ({
          commentKey: assessment.commentKey, sourceAuthor: sources.get(assessment.commentKey)?.author ?? "unknown",
          sourceUrl: sources.get(assessment.commentKey)?.url ?? null, findingIndex: index + 1,
          summary: finding.summary, status: finding.status, reason: finding.reason, evidence: finding.evidence,
          ...(finding.nextStep !== undefined ? { nextStep: finding.nextStep } : {}),
          ...(finding.awaiting !== undefined ? { awaiting: finding.awaiting } : {}),
        }))) ?? [];
        const counts: Record<string, number> = {};
        for (const finding of findings) counts[finding.status] = (counts[finding.status] ?? 0) + 1;
        data = { author: snapshot.author, counts, databaseMigration: saved.databaseMigration ?? null, findings,
          sections: ["findings", "discussion", "files", "instructions", "code"] };
        break;
      }
      case "findings":
        data = saved.report?.filter((assessment) => !commentKey || assessment.commentKey === commentKey).map((assessment) => ({
          ...assessment, source: snapshot.comments.find((comment) => comment.key === assessment.commentKey),
        })) ?? { unavailable: "No assessment was accepted for this attempt." };
        break;
      case "discussion":
        data = commentKey ? snapshot.comments.find((comment) => comment.key === commentKey)
          : { description: snapshot.description, author: snapshot.author, comments: snapshot.comments };
        break;
      case "files": data = snapshot.files; break;
      case "instructions": data = agent?.instructions ?? { unavailable: "The original audit instructions were not saved." }; break;
      case "code": {
        const rows = db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id").all(id);
        const excerpts = rows.flatMap((row) => {
          const entry = JSON.parse(String(row.record)) as EntryRecord;
          if (!ToolResultEntry.is(entry)) return [];
          return (entry.model ?? []).flatMap((message) => message.role === "toolResult" && message.toolName === "read_github_file" && !message.isError
            ? message.content.flatMap((block) => block.type === "text" ? [{ entryId: entry.id, result: JSON.parse(block.text) }] : []) : []);
        });
        data = excerpts.length ? excerpts : { unavailable: "No successful pinned-file excerpts were saved. Use read_github_file if verification needs more code." };
        break;
      }
      default: throw new Error("Unknown audit section.");
    }
    return { audit, snapshot, data };
  } finally {
    // Closing a read connection does not checkpoint, create a lock file, or invoke any Durable scheduler.
    db.close();
  }
}
