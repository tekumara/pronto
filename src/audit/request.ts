import type { Context } from "@earendil-works/chord";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry, LiveDoc, ToolResultEntry, UsageDoc,
  type Conversation, type ConversationId, type ConversationView, type Cursor, type Harness, type LiveState, type ModelRef,
} from "@earendil-works/pi-durable";
import { fetchChangedFiles, fetchPullRequest, fetchReviewSnapshot, fetchViewerLogin, findApprovals, isAuditComment, submitAuditReview, type ChangedFile, type ReviewSnapshot, type ReviewTarget } from "../github/reviews.ts";
import { stripControlCharacters, type LogLevel } from "../logging.ts";
import type { AuditDiagnostics } from "./audit-diagnostics.ts";
import { AuditDocument, AuditIdentity, AuditRuns, PublicationRequests, type ModelCostInfo } from "./audit-records.ts";
import { auditAssessment } from "./assessment.ts";
import { compileExclusions, excludedPaths, MAX_LISTED_FILES } from "./exclusions.ts";
import { canonical, evidenceChanges, evidenceFingerprint } from "./fingerprints.ts";
import { SubmittedAuditReviews, completeReassessment, enqueuePublication, pendingReassessments, publicationChoices, waitForPublication, type recoverPublications } from "./publication.ts";
import { planSkip, planVerdict } from "./verdict.ts";

/** The optional CLI text preserves its detailed transcript; null marks serve-only summaries. */
export type AuditLog = (level: LogLevel, message: string, cliText?: string | null) => void;

/** PRs changing more lines than this (additions plus deletions) are skipped before any evidence is fetched. */
const MAX_CHANGED_LINES = 10_000;
/** GitHub omits counts and patches for some files when the PR diff is too large. A rename can legitimately have neither. */
function uncountedFile(file: ChangedFile): boolean {
  return file.lines === 0 && file.patch === null && file.status !== "renamed";
}
function outputExcludedFiles(paths: string[], log: AuditLog): void {
  log("debug", `Excluded ${paths.length} changed file${paths.length === 1 ? "" : "s"} (--exclude):`);
  for (const path of paths.slice(0, MAX_LISTED_FILES)) log("debug", stripControlCharacters(`  - ${path}`));
  if (paths.length > MAX_LISTED_FILES) log("debug", `  - ${paths.length - MAX_LISTED_FILES} more files`);
}
function outputSnapshotExclusions(snapshot: ReviewSnapshot, patterns: string[] | undefined, log: AuditLog): void {
  const paths = excludedPaths(snapshot);
  if (paths.length) outputExcludedFiles(paths, log);
  else if (patterns?.length) log("debug", "--exclude matched no changed files.");
}
function outputRefreshReasons(conversationId: ConversationId, reasons: string[], log: AuditLog): void {
  log("debug", `Refreshing audit ${conversationId}; reasons:`);
  for (const reason of reasons.slice(0, 10)) log("debug", `  - ${reason}`);
  if (reasons.length > 10) log("debug", `  - ${reasons.length - 10} more changes`);
}

function formatCost(usd: string): string {
  return `US$${usd}`;
}

async function resolveModelCost(harness: Harness, conversationId: ConversationId, context: Context,
  saved?: ModelCostInfo | null): Promise<ModelCostInfo> {
  if (saved) return saved;
  const conversation = await harness.conversation(conversationId, context);
  const model = conversation ? (await conversation.agent(context)).model ?? null : null;
  return { model, costUsd: auditAssessment.cost(await harness.snapshot(UsageDoc, conversationId, context)) };
}

async function outputSkip(harness: Harness, snapshot: Pick<ReviewSnapshot, "target" | "headSha" | "baseSha">, reason: string,
  options: AuditOptions, log: AuditLog, context: Context): Promise<void> {
  reason = stripControlCharacters(reason);
  log("info", `Skipped · ${reason}`, `[audit] Skipping ${snapshot.target.url}: ${reason}`);
  const intent = planSkip({ snapshot, reason, choices: options });
  const existing = (await harness.snapshot(SubmittedAuditReviews, String(snapshot.target.pr), context))?.reviews[intent.fingerprint];
  const dryRun = !options.apply;
  if (dryRun) log("debug", `Skip comment preview:\n\n${intent.body}\n`, `[audit:dry-run] Skip comment preview:\n\n${intent.body}\n`);
  if (existing) {
    const message = stripControlCharacters(`Skip comment ${dryRun ? "would be skipped" : "skipped"}: matching skip review recorded locally: ${existing.url}`);
    log("debug", message, `${dryRun ? "[audit:dry-run]" : "[audit]"} ${message}`);
  } else if (dryRun) {
    log("debug", "Skip comment would be posted.", "[audit:dry-run] Skip comment would be posted.");
  } else {
    // A skip has no assessment conversation. Publish under the root without changing saved audit work.
    const root = await harness.root(context);
    const taskId = await harness.commit((tx) => enqueuePublication(tx, root.id, intent), context);
    if (taskId) {
      const url = await waitForPublication(harness, taskId, context);
      const message = stripControlCharacters(`Skip comment posted to the PR: ${url}`);
      log("debug", message, `[audit] ${message}`);
      log("info", stripControlCharacters(`Review: ${url}`), null);
    }
  }
}

async function outputReport({ harness, plan, log, context, started, conversationId, taskId, existing, cached = false }: {
  harness: Harness; plan: ReturnType<typeof planVerdict>; log: AuditLog; context: Context; started: number;
  conversationId: ConversationId; taskId: Awaited<ReturnType<typeof enqueuePublication>>; existing: { url: string } | undefined; cached?: boolean;
}): Promise<void> {
  const { intent, approve, skipped } = plan;
  const { report, counts } = plan.render();
  log("debug", report, `\n${report}\n`);
  const body = intent.body;
  const dryRun = !intent.choices.apply;
  if (dryRun) log("debug", `Verdict comment preview:\n\n${body}\n`, `[audit:dry-run] Verdict comment preview:\n\n${body}\n`);
  // Preview approval retains its live-head safety check, but never creates a publication task.
  if (dryRun) await submitAuditReview(intent, body, { approve, signal: context.abortSignal });
  const url = taskId ? await waitForPublication(harness, taskId, context)
    : !dryRun ? (await harness.snapshot(SubmittedAuditReviews, String(intent.target.pr), context))?.reviews[intent.fingerprint]?.url ?? null : null;
  if (taskId && !url) {
    log("info", "PR commits changed since the audit snapshot · reassessing before publishing");
    return;
  }
  if (existing) {
    const message = stripControlCharacters(`Comment ${dryRun ? "would be skipped" : "skipped"}: matching verdict review recorded locally: ${existing.url}`);
    log("debug", message, `${dryRun ? "[audit:dry-run]" : "[audit]"} ${message}`);
  } else {
    const message = dryRun ? `Comment would be posted${approve ? " with the approval review" : ""}.`
      : stripControlCharacters(`Verdict comment posted to the PR${approve ? " with the approval review" : ""}: ${url}`);
    log("debug", message, `${dryRun ? "[audit:dry-run]" : "[audit]"} ${message}`);
  }
  if (skipped) {
    log("info", `Approval blocked: ${skipped}`, stripControlCharacters(`${dryRun ? "[audit:dry-run] Approval would be skipped" : "[audit] Approval skipped"}: ${skipped}`));
  } else if (approve) {
    const message = existing ? `Approval previously submitted at ${intent.headSha}`
      : dryRun ? `PR would be approved at ${intent.headSha}` : `PR approved at ${intent.headSha}`;
    log("debug", message, `${dryRun ? "[audit:dry-run]" : "[audit]"} ${message}`);
  }
  const outcome = dryRun ? `Preview only · would ${existing ? "skip existing review" : approve ? "approve" : "comment"}`
    : existing ? "Already submitted" : approve ? "Approved" : "Completed";
  const cost = cached ? "0" : auditAssessment.cost(await harness.snapshot(UsageDoc, conversationId, context));
  log("info", `${outcome} · ${counts.addressed} addressed · ${counts.outstanding} outstanding · ${counts.uncertain} uncertain · ${counts["not-actionable"]} not actionable · ${((performance.now() - started) / 1000).toFixed(1)}s · ${formatCost(cost)}`, null);
  if (url || existing) log("info", `Review: ${url ?? existing!.url}`, null);
}

export type AuditOptions = {
  model: ModelRef; skipLabels?: string[]; skipDrafts?: boolean; skipApproved?: boolean; force?: boolean;
  approve?: boolean; allowUncertain?: boolean; approveMigrations?: boolean; apply?: boolean;
  /** Path patterns left out of the size limit and the audit; see compileExclusions. */
  exclude?: string[];
};

export type RepositoryAudit = {
  database: string;
  harness: Harness;
  publications: Awaited<ReturnType<typeof recoverPublications>>;
  allow(id: ConversationId, diagnostics: AuditDiagnostics, context: Context): Promise<void>;
};

/** Run or resume one PR against the repository's existing durable owner. */
export async function auditRequest({ target, options, repository, context, log, diagnostics }: {
  target: ReviewTarget;
  options: AuditOptions & { models: ModelRuntime; retryFailed: boolean; restored: boolean };
  repository: RepositoryAudit; context: Context; log: AuditLog; diagnostics: AuditDiagnostics;
}): Promise<void> {
  const started = performance.now();
  const { harness } = repository;
  const { warn, text: diagnosticText } = diagnostics;
  const prKey = String(target.pr);
  if (options.restored) {
    const runs = await harness.snapshot(AuditRuns, prKey, context);
    if (runs?.active != null) {
      const requests = await harness.snapshot(PublicationRequests, runs.active, context);
      // Startup flags govern new deliveries, never an already admitted assessment.
      options = { ...options, ...(requests?.choices.at(-1) ?? publicationChoices({})) };
    }
  }
  const reassessment = (await pendingReassessments(harness, context))[prKey];
  if (reassessment) {
    if (reassessment.author && (await fetchViewerLogin(context.abortSignal)).toLowerCase() !== reassessment.author.toLowerCase()) {
      throw new Error(`Pending verdict belongs to ${reassessment.author}; restore that GitHub account before retrying.`);
    }
    options = { ...options, ...reassessment.choices };
  }
  let stream: Awaited<ReturnType<Conversation["watch"]>> | undefined;
  try {
    const startedAt = new Date().toISOString();
    log("info", "Preparing · fetching GitHub evidence", null);
    const pr = await fetchPullRequest(target, context.abortSignal);
    const skip = async (reason: string, { publish = true } = {}) => {
      if (publish) await outputSkip(harness, { target, headSha: pr.head.sha, baseSha: pr.base.sha }, reason, options, log, context);
      else {
        reason = stripControlCharacters(reason);
        log("info", `Skipped · ${reason}`, `[audit] Skipping ${target.url}: ${reason}`);
      }
      if (reassessment) await harness.commit((tx) => completeReassessment(tx, prKey, reassessment), context);
    };
    if (pr.merged) {
      await skip("PR has already been merged.");
      return;
    }
    if ((options.skipDrafts ?? true) && pr.draft) {
      await skip("PR is a draft. Use --skip-drafts=false to audit anyway.");
      return;
    }
    const skipLabels = new Set(options.skipLabels?.map((label) => label.toLowerCase()));
    const skippedLabel = pr.labels?.find((label) => skipLabels.has(label.name.toLowerCase()));
    if (skippedLabel) {
      await skip(`PR has matching skip label: ${JSON.stringify(stripControlCharacters(skippedLabel.name))}.`);
      return;
    }
    const isExcluded = compileExclusions(options.exclude ?? []);
    let changedLines = (pr.additions ?? 0) + (pr.deletions ?? 0);
    let excluded: ChangedFile[] = [];
    let excludedLines = 0;
    let uncounted = 0;
    if (changedLines > MAX_CHANGED_LINES && options.exclude?.length) {
      // The PR's totals include excluded files, so measure what remains from the per-file counts.
      excluded = (await fetchChangedFiles(target, pr, context.abortSignal)).filter(isExcluded);
      // Files without counts stay in the total: subtracting an unknown size would understate it.
      const counted = excluded.filter((file) => !uncountedFile(file));
      excludedLines = counted.reduce((sum, file) => sum + file.lines, 0);
      uncounted = excluded.length - counted.length;
      changedLines -= excludedLines;
    }
    if (changedLines > MAX_CHANGED_LINES) {
      await skip(`PR changes ${changedLines} lines${excludedLines ? ` after excluding ${excludedLines} lines` : ""}, more than the ${MAX_CHANGED_LINES} line limit.`);
      if (uncounted) log("debug", `GitHub gave no line counts for ${uncounted} excluded file${uncounted === 1 ? "" : "s"}, so ${uncounted === 1 ? "it still counts" : "they still count"} toward the limit.`);
      if (excluded.length) outputExcludedFiles(excluded.map((file) => file.path), log);
      return;
    }
    if (options.skipApproved ?? true) {
      const approvers = await findApprovals(target, pr.head.sha, context.abortSignal);
      if (approvers.length) {
        const viewer = await fetchViewerLogin(context.abortSignal);
        const ownApproval = approvers.find((login) => login.toLowerCase() === viewer.toLowerCase());
        const approver = ownApproval ?? approvers[0]!;
        await skip(`PR is already approved by ${stripControlCharacters(approver)} at ${pr.head.sha}. Use --skip-approved=false to audit anyway.`, { publish: !ownApproval });
        return;
      }
    }
    // Persist restart intent before cancellation/evidence fetching. A crash must not turn a requested restart into
    // a cache hit or switch its selected model. Clear the intent only when the new snapshot is admitted.
    if (options.retryFailed) log("info", "Retrying failed audit after startup recovery", null);
    if (reassessment) log("info", "Reassessing · PR commits changed before approval publication", null);
    if (options.force || options.retryFailed || reassessment) await harness.commit(async (tx) => {
      (await tx.doc(AuditRuns, prKey, null)).restartModel = options.model;
    }, context);
    let state = await harness.snapshot(AuditRuns, prKey, context);
    const previousId = state?.latestSuccess?.conversationId ?? state?.active;
    if (state?.restartModel && previousId != null) {
      const reason = options.force ? "--force requested"
        : options.retryFailed ? "retrying failed audit after startup recovery"
        : reassessment ? "PR commits changed before approval publication" : "saved restart intent";
      outputRefreshReasons(state.active ?? previousId, [reason], log);
    }
    if (state?.restartModel && state.active !== null && !state.complete) {
      const existing = await harness.conversation(state.active, context);
      if (!existing) throw new Error("Incomplete audit conversation is missing");
      log("info", "Restarting unfinished audit; cancelling its saved work");
      await existing.abort(context);
      await harness.commit(async (tx) => { (await tx.doc(AuditRuns, prKey, null)).complete = true; }, context);
      state = await harness.snapshot(AuditRuns, prKey, context);
    }
    let conversation: Conversation;
    let controllerTask = state?.controllerTask;
    let snapshot: ReviewSnapshot;
    if (state && state.active !== null && !state.complete) {
      const existing = await harness.conversation(state.active, context);
      const saved = await harness.snapshot(AuditDocument, state.active, context);
      if (!existing || !saved?.snapshot) throw new Error("Incomplete audit session has no saved evidence");
      if (saved.snapshot.comments.some((comment) => isAuditComment(comment.body)
        || comment.replies.some((reply) => isAuditComment(reply.body)))) {
        throw new Error("The saved audit contains Pronto output. Run again with --force to fetch fresh evidence without it.");
      }
      conversation = existing;
      snapshot = saved.snapshot;
      const fallbackModelCost = await resolveModelCost(harness, existing.id, context, saved.modelCost);
      await harness.commit(async (tx) => {
        const requests = await tx.doc(PublicationRequests, existing.id);
        const choices = publicationChoices(options);
        if (!requests.choices.some((saved) => canonical(saved) === canonical(choices))) requests.choices.push(choices);
        // The controller might have completed since the host read its pointer. Either
        // it sees this request, or this transaction performs the handoff itself.
        const runs = await tx.doc(AuditRuns, prKey, null);
        const report = await tx.doc(AuditDocument, existing.id);
        if (runs.complete && report.report) {
          const modelCost = report.modelCost ?? fallbackModelCost;
          const { intent } = planVerdict({ snapshot: saved.snapshot!, assessments: report.report,
            databaseMigration: report.databaseMigration, choices, modelCost });
          const id = await enqueuePublication(tx, existing.id, intent);
          if (id) requests.tasks[intent.fingerprint] = id;
        }
      }, context);
      log("info", "Resuming saved snapshot", `[audit] Resuming saved snapshot ${snapshot.id} at ${snapshot.headSha}`);
      log("debug", `Snapshot: ${snapshot.id} · head ${snapshot.headSha}`, null);
      // The saved evidence keeps the exclusions it was fetched with; --force applies different ones.
      outputSnapshotExclusions(snapshot, undefined, log);
    } else {
      const model = state?.restartModel ?? options.model;
      const policy = auditAssessment.policyFingerprint(options.models, model);
      log("debug", `Fetching ${target.url}`);
      snapshot = await fetchReviewSnapshot(target, pr, startedAt, context.abortSignal, isExcluded);
      log("debug", `PR title: ${stripControlCharacters(snapshot.title)}`);
      outputSnapshotExclusions(snapshot, options.exclude, log);
      const fingerprint = evidenceFingerprint(snapshot, policy);
      const cached = !state?.restartModel && state?.latestSuccess;
      const refreshReasons: string[] = [];
      if (cached) {
        const saved = await harness.snapshot(AuditDocument, cached.conversationId, context);
        const identity = await harness.snapshot(AuditIdentity, cached.conversationId, context);
        if (cached.fingerprint === fingerprint && saved?.snapshot && saved.report
          && identity?.fingerprint === fingerprint && identity.policy === policy) {
          const modelCost = await resolveModelCost(harness, cached.conversationId, context, saved.modelCost);
          const plan = planVerdict({ snapshot: saved.snapshot, assessments: saved.report,
            databaseMigration: saved.databaseMigration, choices: options, modelCost });
          const existing = (await harness.snapshot(SubmittedAuditReviews, prKey, context))?.reviews[plan.intent.fingerprint];
          const publication = await harness.commit(async (tx) => {
            const taskId = await enqueuePublication(tx, cached.conversationId, plan.intent);
            const runs = await tx.doc(AuditRuns, prKey, null);
            runs.latestSuccess!.lastCheckedAt = snapshot.fetchedAt;
            await tx.appendEntry(cached.conversationId, { kind: "app.review-audit-recheck", data: {
              fingerprint, snapshotId: snapshot.id, startedAt: snapshot.startedAt, fetchedAt: snapshot.fetchedAt,
            } });
            return taskId;
          }, context);
          const detail = `Reusing saved assessment ${cached.conversationId} from ${cached.assessedAt}; evidence rechecked ${snapshot.fetchedAt} (unchanged)`;
          log("info", "Reusing saved assessment", `[audit] ${detail}`);
          log("debug", detail, null);
          outputSnapshotExclusions(snapshot, options.exclude, log);
          await outputReport({ harness, plan, log, context, started, conversationId: cached.conversationId,
            taskId: publication, existing, cached: true });
          return;
        }
        if (!identity?.fingerprint || !identity.policy) refreshReasons.push("saved assessment has no cache identity");
        else {
          if (identity.policy !== policy) refreshReasons.push("audit policy changed (model, inference settings, instructions or tools)");
          if (identity.fingerprint !== cached.fingerprint) refreshReasons.push("saved cache identity is inconsistent");
        }
        if (!saved?.report) refreshReasons.push("saved assessment report is missing");
        if (saved?.snapshot) refreshReasons.push(...evidenceChanges(saved.snapshot, snapshot));
        else refreshReasons.push("saved evidence snapshot is missing");
        if (!refreshReasons.length) refreshReasons.push("saved fingerprint does not match current evidence and policy");
      } else if (!state?.restartModel && previousId != null) {
        refreshReasons.push("no reusable successful assessment is available");
      }
      if (previousId != null && refreshReasons.length) outputRefreshReasons(previousId, refreshReasons, log);
      conversation = await harness.createConversation({
        ownership: { kind: "ownerless" }, agent: auditAssessment.agent(model),
        init: async (tx, id) => {
          (await tx.doc(AuditDocument, id)).snapshot = snapshot;
          (await tx.doc(PublicationRequests, id)).choices.push(publicationChoices(options));
          await completeReassessment(tx, prKey, reassessment);
          const identity = await tx.doc(AuditIdentity, id);
          identity.fingerprint = fingerprint;
          identity.policy = policy;
          const runs = await tx.doc(AuditRuns, prKey, null);
          runs.active = id;
          runs.complete = false;
          runs.restartModel = null;
          controllerTask = await tx.createTask(auditAssessment.controller, { pr: prKey }, {
            ownership: { kind: "conversation" }, conversationId: id,
          });
          runs.controllerTask = controllerTask;
        },
      }, context);
      log("info", `Started · ${snapshot.comments.length} comments`, `[audit] ${snapshot.comments.length} comments · head ${snapshot.headSha}`);
      log("debug", `Head: ${snapshot.headSha}`, null);
    }
    const savedModel = (await conversation.agent(context)).model;
    if (!options.models.getAvailableSnapshot().some((m) => m.provider === savedModel?.provider && m.id === savedModel.modelId)) {
      throw new Error("The saved audit model is unavailable. Restore its Pi credentials before resuming.");
    }
    await repository.allow(conversation.id, diagnostics, context);
    stream = await conversation.watch(context);
    const seenTools = new Set<string>();
    let lastRetry: string | undefined;
    const logProgress = (view: ConversationView) => {
      const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
      for (const slot of live?.tools ?? []) {
        if (slot.status !== "running" || seenTools.has(slot.callId)) continue;
        seenTools.add(slot.callId);
        const name = slot.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        const call = view.entries.flatMap((entry) => entry.model ?? []).flatMap((message) =>
          message.role === "assistant" ? message.content : []).find((block) => block.type === "toolCall" && block.id === slot.callId);
        const args = call?.type === "toolCall" ? call.arguments : {};
        const argument = String(args.path ?? args.commentKey ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        log("debug", `${name} ${argument}`, `[audit:${name}] ${argument}`);
      }
      const retry = live?.generation?.retry;
      if (retry) {
        const key = `${live.generation?.attempt}:${retry.at}:${retry.error}`;
        if (key !== lastRetry) {
          lastRetry = key;
          warn(`Audit retry ${live.generation?.attempt}: ${retry.error} (conversation=${conversation.id}, model=${savedModel?.provider}/${savedModel?.modelId}, retryAt=${new Date(retry.at).toISOString()}, delayMs=${Math.max(0, retry.at - Date.now())})`);
        }
      }
    };
    logProgress(stream.value);
    stream.start(async (call) => {
      if (call.kind === "value") logProgress(call.value);
    });
    if (controllerTask == null) throw new Error("Incomplete audit has no controller task");
    const priorReceipts = await harness.snapshot(SubmittedAuditReviews, prKey, context);
    // The controller durably admits the request and publishes completion, including after a crash.
    const outcome = (await harness.waitForTask(controllerTask, context)).state.outcome;
    if (outcome.status !== "completed") {
      const reason = outcome.status === "failed" || outcome.status === "faulted"
        ? outcome.error.message : outcome.reason ?? outcome.status;
      throw new Error(`Audit controller failed: ${reason}`);
    }
    const submission = await harness.submission(outcome.result.submissionId, context);
    if (!submission) throw new Error("Audit submission is missing");
    const settled = await submission.wait(context);
    const saved = await harness.snapshot(AuditDocument, conversation.id, context);
    if (settled.status === "unanswered") {
      const detail = settled.detail === undefined ? "" : `: ${diagnosticText(settled.detail)}`;
      throw new Error(diagnosticText(`Audit failed: ${settled.reason} (conversation=${conversation.id}, submission=${settled.id}, model=${savedModel?.provider}/${savedModel?.modelId})${detail}`));
    }
    if (!saved?.report) {
      const { answer, rejection } = await conversation.commit(async (tx) => {
        const answer = settled.type === "input" ? (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] : undefined;
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({ conversationId: conversation.id, minEntryId: settled.entry,
            maxEntryId: settled.type === "input" ? settled.answer : settled.entry, order: "descending" }, 100, cursor);
          for (const entry of page.items) {
            if (!ToolResultEntry.is(entry)) continue;
            const message = entry.model?.[0];
            if (message?.role !== "toolResult" || message.toolName !== auditAssessment.reportToolName || !message.isError) continue;
            const errors = entry.data?.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) =>
              // Pi's schema error includes the entire submitted report. Keep only the validation explanation.
              diagnostic.code === "invalid_arguments" ? diagnostic.message.split("\n\nReceived arguments:\n", 1)[0] : diagnostic.message);
            return { answer, rejection: errors?.join("; ") || "report_review_assessment failed without a saved diagnostic." };
          }
          cursor = page.next;
        } while (cursor);
        return { answer, rejection: undefined };
      }, context);
      let reason = "";
      if (answer?.role === "assistant") {
        const stopReason = answer.rawStopReason ? `${answer.stopReason} (${answer.rawStopReason})` : answer.stopReason;
        reason = answer.stopReason === "length"
          ? ` The model hit its token limit: ${stopReason}; ${answer.usage.totalTokens} total tokens.`
          : ` Model stop reason: ${stopReason}.`;
      }
      const detail = rejection ? ` Last assessment rejection: ${rejection}` : " No assessment rejection was recorded.";
      throw new Error(diagnosticText(`Agent finished without a complete assessment.${reason} No verdict was produced. (conversation=${conversation.id}, submission=${settled.id}, model=${savedModel?.provider}/${savedModel?.modelId})${detail}`, 3_500));
    }
    const modelCost = await resolveModelCost(harness, conversation.id, context, saved.modelCost);
    const plan = planVerdict({ snapshot, assessments: saved.report, databaseMigration: saved.databaseMigration, choices: options, modelCost });
    const publications = (await harness.snapshot(PublicationRequests, conversation.id, context))?.tasks ?? {};
    try {
      await outputReport({ harness, plan, log, context, started, conversationId: conversation.id,
        taskId: publications[plan.intent.fingerprint] ?? null, existing: priorReceipts?.reviews[plan.intent.fingerprint] });
    } finally {
      // A resumed caller can request a preview while an earlier explicit apply is still due.
      // Keep the repository open for every handoff, not just the current output's review type.
      await Promise.allSettled(Object.values(publications).map((id) => waitForPublication(harness, id, context)));
    }
  } finally {
    await stream?.stop();
  }
}
