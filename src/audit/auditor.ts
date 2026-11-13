import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, ProviderDoc, type ConversationId, type Cursor, type Harness } from "@earendil-works/pi-durable";
import { auditTargetKey, parseReviewTarget, type ReviewTarget } from "../github/reviews.ts";
import { auditLabel, stripControlCharacters, type Log } from "../logging.ts";
import { createWebhookQueue, type WebhookAdmission } from "../server/webhook-queue.ts";
import { createReviewerWakeups, waitForReviewerReviews } from "./reviewer-gate.ts";
import { createAuditScheduler } from "../server/audit-scheduler.ts";
import { listRepositoryDatabases, openStateHarness, repositoryDatabaseIdentity } from "../state.ts";
import { createAuditDiagnostics, type AuditDiagnostics } from "./audit-diagnostics.ts";
import { createAuditExecutionGate } from "./audit-execution.ts";
import { AuditDocument, AuditRuns, type AuditResult } from "./audit-records.ts";
import { auditAssessment } from "./assessment.ts";
import { createPublisher, pendingReassessments, recoverPublications, waitForPublication } from "./publication.ts";
import { auditRequest, type AuditLog, type AuditOptions, type AuditOutcome, type RepositoryAudit } from "./request.ts";

export type { AuditOptions } from "./request.ts";
export type AuditTrigger = { source: "webhook"; reason?: string } | { source: "mcp"; tool: string; requestId?: string };
type PendingReviewGate = { url: string; reviewers: string[] };
type Recovery = { urls: string[]; gates: PendingReviewGate[]; skipped: { database: string; error: unknown }[] };

function describeTrigger(trigger: AuditTrigger): string {
  return trigger.source === "webhook" ? `GitHub webhook${trigger.reason ? ` · ${trigger.reason}` : ""}`
    : `MCP tool ${trigger.tool}${trigger.requestId ? ` requestId=${trigger.requestId}` : ""}`;
}

/** One in-process owner. Concurrent calls share a harness per repository; close only at host shutdown. */
export function createAuditor(models: ModelRuntime, { labelOutput = true, log: output, webhooks, state }: {
  labelOutput?: boolean; log?: Log;
  webhooks?: { concurrency: number; options: AuditOptions; requiredReviewers?: string[] };
  state?: { root: string; enroll(relative: string): Promise<void>; confirm(relative: string): Promise<void>; strictRecovery: boolean };
} = {}) {
  const repositories = new Map<string, Promise<RepositoryAudit>>();
  const requests = new Set<string>();
  const failedRecoveries = new Set<string>();
  const restoredRequests = new Set<string>();
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  let recovering: Promise<Recovery> | undefined;
  const scheduler = webhooks ? createAuditScheduler(webhooks.concurrency) : undefined;
  const reviewerWakeups = createReviewerWakeups();
  const webhookQueue = webhooks ? createWebhookQueue({
    concurrency: webhooks.concurrency,
    requiredReviewers: webhooks.requiredReviewers,
    reviewerWakeups,
    audit: async (url, reason) => {
      await auditor.scheduleAudit(url, webhooks.options, { source: "webhook", ...(reason ? { reason } : {}) }, BACKGROUND_CONTEXT, true);
    },
    beforeDispatch: state ? async (url) => {
      const repository = await repositoryFor(parseReviewTarget(url));
      await state.confirm(repository.database);
    } : undefined,
    onError: (url, error) => {
      const target = parseReviewTarget(url);
      output?.("error", `${target.owner}/${target.repo}#${target.pr}`, `Audit failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    onReviewWait: (url, missing) => output?.("info", auditLabel(url), `Waiting for required review from ${missing.join(", ")}`),
    onReviewSatisfied: (url) => output?.("info", auditLabel(url), "Required reviewer review received"),
    onReviewError: (url, error) => output?.("warn", auditLabel(url), `Could not check required reviewer reviews; gate remains closed: ${error instanceof Error ? error.message : String(error)}`),
  }) : undefined;

  const repositoryKey = (target: ReviewTarget) => `${new URL(target.url).origin}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;

  /** Opens a repository's database, which takes its process lock. `host` and `name` are the path components in openStateHarness. */
  function openRepository(host: string, name: string): Promise<RepositoryAudit> {
    const database = repositoryDatabaseIdentity(host, name);
    const registry = createRegistry();
    registry.install(createPublisher(state ? () => state.confirm(database) : undefined));
    if (webhookQueue) registry.install(webhookQueue.extension);
    const gate = createAuditExecutionGate(models);
    registry.install(auditAssessment.gated(gate));
    return openStateHarness({ kind: "repo", host, name }, {
      models: gate.models, registry, settings: auditAssessment.settings,
      onReport: (error) => output ? output("error", `${host}/${name}`, error instanceof Error ? error.message : String(error)) : console.error(error),
      // No execution environment or coding tools: audits cannot access local files.
    }, BACKGROUND_CONTEXT, state?.root).then(async (harness) => {
      gate.attach(harness);
      try {
        await state?.enroll(database);
        const publications = await recoverPublications(harness, BACKGROUND_CONTEXT);
        return {
          harness, publications, database,
          allow: async (id: ConversationId, diagnostics: AuditDiagnostics, context: Context) => {
            const provider = await harness.snapshot(ProviderDoc, id, context);
            if (!provider) throw new Error("Audit provider session identity is missing");
            gate.allow(provider.sessionId, { ...diagnostics, warn: (message) => diagnostics.warn(`${output ? "" : "[audit:model] "}conversation=${id} ${message}`) });
          },
        };
      } catch (error) {
        await harness.close(BACKGROUND_CONTEXT);
        throw error;
      }
    });
  }

  function repositoryFor(target: ReviewTarget): Promise<RepositoryAudit> {
    const repository = repositoryKey(target);
    let opened = repositories.get(repository);
    if (!opened) {
      const name = `${target.owner.toLowerCase()}~${target.repo.toLowerCase()}`;
      const host = encodeURIComponent(new URL(target.url).hostname.toLowerCase());
      opened = openRepository(host, name).catch((error) => {
        repositories.delete(repository);
        throw error;
      });
      // Publish the opening promise before yielding: admission and audits share one owner.
      repositories.set(repository, opened);
    }
    return opened;
  }

  const auditor = {
    async enqueue(url: string, deliveryId?: string, admission?: WebhookAdmission) {
      if (!webhookQueue) throw new Error("Webhook queue is not enabled");
      if (closing) return "closed" as const;
      if (recovering) await recovering;
      if (closing) return "closed" as const;
      const { harness, database } = await repositoryFor(parseReviewTarget(url));
      const outcome = await webhookQueue.admit(harness, url, deliveryId, admission);
      // Includes duplicate and coalesced admissions: every 202 needs fresh remote confirmation.
      if (outcome !== "closed") await state?.confirm(database);
      // Admission is already durable. Scheduler startup is reconstructible, not acceptance.
      if (!closing) harness.resume();
      return outcome;
    },
    reviewSubmitted(url: string, reviewer: string): void {
      reviewerWakeups.notify(parseReviewTarget(url), reviewer);
    },
    /** Starts staged recovery work, without readmitting a PR that may already be running. */
    async resume(): Promise<void> {
      if (recovering) await recovering;
      if (closing) return;
      for (const opened of repositories.values()) {
        const { harness, publications } = await opened;
        if (!closing) {
          harness.resume();
          for (const { target, taskId } of publications) {
            const scope = `${target.owner}/${target.repo}#${target.pr}`;
            void waitForPublication(harness, taskId, BACKGROUND_CONTEXT).then(async (url) => {
              if (url) output?.("info", scope, stripControlCharacters(`Saved verdict published: ${url}`));
              else {
                output?.("info", scope, "PR commits changed since the audit snapshot · reassessing before publishing");
                // An active caller consumes the saved reassessment itself. Otherwise use normal
                // durable admission and concurrency limits; a crash before admission keeps the request.
                if (webhookQueue && !requests.has(auditTargetKey(target))) await auditor.enqueue(target.url);
              }
            }, () => {}).catch((error) => {
              output?.("error", scope, `Could not queue reassessment: ${error instanceof Error ? error.message : String(error)}`);
            }); // Other failures are reported by the task and retain their saved publication intent.
          }
        }
      }
    },
    /** Share serve's concurrency limit and per-PR exclusion with webhook work. */
    async scheduleAudit(url: string, options: AuditOptions, trigger: AuditTrigger, callerContext: Context = BACKGROUND_CONTEXT,
      reviewerGateSatisfied = false): Promise<AuditOutcome> {
      if (!scheduler) throw new Error("Audit scheduling is not enabled");
      const context = withAbortSignal(shutdown.signal, callerContext);
      const requiredReviewers = webhooks?.requiredReviewers ?? [];
      if (requiredReviewers.length && !reviewerGateSatisfied) {
        const target = parseReviewTarget(url);
        let announcedWait = false;
        await waitForReviewerReviews(target, requiredReviewers, context.abortSignal, (status, detail) => {
          const scope = `${target.owner}/${target.repo}#${target.pr}`;
          if (status === "waiting") {
            announcedWait = true;
            output?.("info", scope, `Waiting for required review from ${(detail as string[]).join(", ")}`);
          } else if (status === "satisfied") {
            if (announcedWait) output?.("info", scope, "Required reviewer review received");
          } else {
            const error = detail;
            output?.("warn", scope, `Could not check required reviewer reviews; gate remains closed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }, reviewerWakeups);
      }
      return scheduler.run(url, () => {
        context.abortSignal?.throwIfAborted();
        return auditor.audit(url, options, context, trigger);
      }, context.abortSignal);
    },
    async audit(url: string, options: AuditOptions, callerContext: Context = BACKGROUND_CONTEXT, trigger?: AuditTrigger): Promise<AuditOutcome> {
      if (recovering) await recovering;
      if (closing) throw new Error("Auditor is closed");
      const target = parseReviewTarget(url);
      const requestKey = auditTargetKey(target);
      if (requests.has(requestKey)) throw new Error(`Audit is already in progress: ${target.url}`);
      requests.add(requestKey);
      const scope = `${target.owner}/${target.repo}#${target.pr}`;
      const label = labelOutput ? `[${scope}] ` : "";
      const log: AuditLog = (level, message, cliText) => {
        if (output) output(level, scope, message);
        else if (cliText !== null) console.log(`${label}${cliText ?? `[audit] ${message}`}`);
      };
      if (trigger) {
        const description = describeTrigger(trigger);
        log("info", `Triggered by ${description}`, `[audit] Triggered by ${description}`);
      }
      const diagnostics = createAuditDiagnostics((message) => output ? output("warn", scope, message) : console.error(`${label}${message}`));
      const context = withAbortSignal(shutdown.signal, callerContext);
      try {
        const repositoryAudit = await awaitWithContext(repositoryFor(target), context);
        // A short/skipped CLI audit must not close storage while a saved publisher is running.
        await Promise.all(repositoryAudit.publications.map(async ({ taskId }) => {
          try { await waitForPublication(repositoryAudit.harness, taskId, context); }
          catch (error) { log("error", `Pending publication: ${error instanceof Error ? error.message : String(error)}`); }
        }));
        const retryFailed = failedRecoveries.delete(requestKey);
        const restored = restoredRequests.delete(requestKey);
        let outcome: AuditOutcome;
        do {
          outcome = await auditRequest({ target, options: { ...options, retryFailed, restored, models },
            repository: repositoryAudit, context, log, diagnostics });
          // A live assessment can also become stale before publication. Retire its old
          // approval and consume the durable reassessment without needing another webhook.
        } while ((await pendingReassessments(repositoryAudit.harness, context))[String(target.pr)]);
        return outcome;
      } catch (error) {
        if (closing && webhooks) log("info", "Audit interrupted · saved work resumes when the server starts again", null);
        throw error;
      } finally {
        requests.delete(requestKey);
      }
    },
    /**
     * Startup-only discovery of pending intake, unfinished audits and latest failed assessments.
     * Retain every database with pending work, including ones without an assessment conversation.
     * Normal admissions wait for discovery; discovery cannot race an already-used auditor.
     */
    recover(context: Context = BACKGROUND_CONTEXT): Promise<Recovery> {
      if (recovering) return recovering;
      if (repositories.size || requests.size) return Promise.reject(new Error("Recover before admitting audits"));
      return recovering = (async () => {
        const urls: string[] = [];
        const gates: PendingReviewGate[] = [];
        const skipped: { database: string; error: unknown }[] = [];
        for (const { host, name } of await listRepositoryDatabases(state?.root)) {
          if (closing) throw new Error("Auditor is closed");
          let repository: RepositoryAudit | undefined;
          try {
            repository = await openRepository(host, name);
            const intake = webhookQueue ? await webhookQueue.recover(repository.harness, context) : { urls: [], gates: [] };
            const unfinished = await unfinishedAudits(repository.harness, context);
            const failed = await failedAudits(repository.harness, context);
            const reassessments = Object.values(await pendingReassessments(repository.harness, context));
            // Intake and assessment recovery for the same PR select one execution, not a rerun.
            const selected = new Map<string, string>();
            for (const url of [...unfinished.map((target) => target.url), ...failed.map((target) => target.url),
              ...reassessments.map(({ target }) => target.url), ...intake.urls]) {
              selected.set(String(parseReviewTarget(url).pr), url);
            }
            if (closing || (!selected.size && !repository.publications.length)) {
              await repository.harness.close(context);
              repository = undefined;
              if (closing) throw new Error("Auditor is closed");
              continue;
            }
            const target = selected.size ? parseReviewTarget(selected.values().next().value!) : repository.publications[0]!.target;
            for (const { target: publication } of repository.publications) {
              output?.("info", `${publication.owner}/${publication.repo}#${publication.pr}`, "Recovering saved verdict publication");
            }
            repositories.set(repositoryKey(target), Promise.resolve(repository));
            repository = undefined;
            for (const url of selected.values()) {
              const target = parseReviewTarget(url);
              restoredRequests.add(auditTargetKey(target));
            }
            for (const target of failed) failedRecoveries.add(auditTargetKey(target));
            urls.push(...selected.values());
            gates.push(...intake.gates);
          } catch (error) {
            await repository?.harness.close(BACKGROUND_CONTEXT).catch(() => {});
            if (closing || state?.strictRecovery) throw error;
            skipped.push({ database: `${host}/${name}`, error });
          }
        }
        // Stage all recovery intents before starting any scheduler or HTTP admission. If a
        // write fails partway through, fail startup and close the dispatcher, rather than
        // leaving a reserved slot waiting on a repository that discovery has skipped.
        if (webhookQueue) for (const url of urls) {
          const { harness } = await repositoryFor(parseReviewTarget(url));
          await webhookQueue.admit(harness, url);
        }
        return { urls, gates, skipped };
      })();
    },
    close(): Promise<void> {
      if (!closing) {
        webhookQueue?.close();
        scheduler?.close();
        shutdown.abort(new Error("Auditor is closed"));
        closing = (async () => {
          await recovering?.catch(() => {});
          const results = await Promise.allSettled([...repositories.values()].map((opened) =>
            opened.then(({ harness }) => harness.close(BACKGROUND_CONTEXT), () => {})));
          const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          await webhookQueue?.idle();
          if (errors.length) throw new AggregateError(errors, "Failed to close audit storage");
        })();
      }
      return closing;
    },
  };
  return auditor;
}

/** Validate the whole batch before any audit starts. */
export function validateAuditTargets(urls: string[]): void {
  const keys = new Set<string>();
  for (const url of urls) {
    const target = parseReviewTarget(url);
    const key = auditTargetKey(target);
    if (keys.has(key)) throw new Error(`Duplicate PR target: ${target.url}`);
    keys.add(key);
  }
}

/** CLI/chat batch lifecycle. A failed PR never closes another PR's harness or ends its request. */
export async function runAudits(urls: string[], options: AuditOptions & { models: ModelRuntime }): Promise<void> {
  validateAuditTargets(urls);
  const auditor = createAuditor(options.models, { labelOutput: urls.length > 1 });
  let interrupted = false;
  const quit = () => { interrupted = true; void auditor.close().catch((error) => console.error(error)); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  try {
    const results = await Promise.allSettled(urls.map((url) => auditor.audit(url, options)));
    if (interrupted) {
      console.log("\nAudit interrupted. Run the same audit again to recover its saved work.");
      return;
    }
    const failures = results.flatMap((result, i) => result.status === "rejected" ? [{ url: urls[i], error: result.reason }] : []);
    if (failures.length === 1 && urls.length === 1) throw failures[0].error;
    if (failures.length) throw new Error(failures.map(({ url, error }) =>
      `${url}: ${error instanceof Error ? error.message : String(error)}`).join("\n"));
  } finally {
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    await auditor.close();
  }
}

/** PRs whose audit controller is still live in this database. A blocked one cannot run, so resuming it would only wait. */
async function unfinishedAudits(harness: Harness, context: Context): Promise<ReviewTarget[]> {
  const targets = new Map<string, ReviewTarget>();
  for (const { record, state } of (await harness.inspect(context)).tasks) {
    if (record.kind !== auditAssessment.controller.definition.name || state.kind === "blocked") continue;
    const target = (await harness.snapshot(AuditDocument, record.conversationId, context))?.snapshot?.target;
    if (target) targets.set(target.url, target);
  }
  return [...targets.values()];
}

/** Read existing receipts, including failures saved before startup recovery supported them. Never revive old or cancelled attempts. */
async function failedAudits(harness: Harness, context: Context): Promise<ReviewTarget[]> {
  const targets: ReviewTarget[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanTasks({
      kind: auditAssessment.controller.definition.name, status: "terminal",
    }, 100, cursor), context);
    for (const record of page.items) {
      if (record.version !== auditAssessment.controller.definition.version || record.state.status !== "terminal"
        || record.state.outcome.status !== "completed") continue;
      const { pr } = record.input as { pr: string };
      const runs = await harness.snapshot(AuditRuns, pr, context);
      if (runs?.active !== record.conversationId || runs.controllerTask !== record.id || !runs.complete) continue;
      const saved = await harness.snapshot(AuditDocument, record.conversationId, context);
      if (!saved?.snapshot || saved.report) continue;
      // The controller completes its bookkeeping even when the model never produces an assessment.
      const { submissionId } = record.state.outcome.result as AuditResult;
      const submission = await harness.submission(submissionId, context);
      const settled = await submission?.status(context);
      if (settled?.status === "done" || (settled?.status === "unanswered" && settled.reason === "model_error")) {
        targets.push(saved.snapshot.target);
      }
    }
    cursor = page.next;
  } while (cursor);
  return targets;
}
