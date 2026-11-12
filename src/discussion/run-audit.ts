import { arr, bool, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { validateAuditTargets, type AuditTrigger, type createAuditor } from "../audit/auditor.ts";
import { parseAuditOptions } from "../cli/audit-options.ts";
import { resolveAuditUrl } from "../cli/pr-discovery.ts";
import { stripControlCharacters } from "../logging.ts";
import { selectModel } from "../model.ts";

export const runAuditTool = {
  name: "run_audit",
  description: "Run the CLI audit for one or more PRs. This can spend model credits; apply=true can post GitHub reviews, including approvals. Use only when explicitly requested. Defaults match pronto, not serve's webhook flags. Omitted targets select the server's current branch; numbers and branches use the server's Git/GH_REPO, never the client's checkout. Returns a normal result if the audit finishes within one second. If the client declares io.modelcontextprotocol/tasks, longer calls return a durable task; poll tasks/get at its pollIntervalMs. tasks/cancel is cooperative and cannot undo saved audit or publication work. Use read_audit with the returned auditId to inspect completed evidence.",
  parameters: obj({
    targets: opt(arr(str({ minLength: 1 }), { minItems: 1, description: "CLI PR selectors: URL, owner/repo#number, number or branch. Omit for the server's current branch." })),
    model: opt(str({ minLength: 1, description: "CLI provider/model-id; omitted uses the server's CLI default model." })),
    skipLabels: opt(arr(str({ minLength: 1 }), { description: "Repeatable --skip labels." })),
    skipDrafts: opt(bool({ description: "--skip-drafts; default true." })),
    skipApproved: opt(bool({ description: "--skip-approved; default true." })),
    exclude: opt(arr(str({ minLength: 1 }), { description: "Repeatable --exclude path patterns." })),
    force: opt(bool({ description: "--force bypasses cache and restarts unfinished work." })),
    approve: opt(bool({ description: "--approve selects approval when eligible; it does not publish without apply." })),
    allowUncertain: opt(bool({ description: "--allow-uncertain allows approval of uncertain findings." })),
    approveMigrations: opt(bool({ description: "--approve-migrations permits approval of migration or uncertain migration status." })),
    apply: opt(bool({ description: "--apply publishes the verdict or skip review using the server's GitHub credentials; default false." })),
  }),
};
export type RunAuditArguments = Static<typeof runAuditTool.parameters>;

/** Resolve and validate the entire batch before starting it, as the CLI does. */
export function createMcpAuditRunner(auditor: ReturnType<typeof createAuditor>, models: ModelRuntime, cwd: string) {
  return async (args: RunAuditArguments, signal: AbortSignal, requestId?: string) => {
    const argv = [
      ...(args.skipLabels ?? []).map((value) => `--skip=${value}`),
      ...(args.exclude ?? []).map((value) => `--exclude=${value}`),
      ...(args.skipDrafts === undefined ? [] : [`--skip-drafts=${args.skipDrafts}`]),
      ...(args.skipApproved === undefined ? [] : [`--skip-approved=${args.skipApproved}`]),
      ...(args.force ? ["--force"] : []), ...(args.approve ? ["--approve"] : []),
      ...(args.allowUncertain ? ["--allow-uncertain"] : []), ...(args.approveMigrations ? ["--approve-migrations"] : []),
      ...(args.apply ? ["--apply"] : []),
      ...(args.targets ? args.targets.map((target) => `--pr=${target}`) : [""]),
      ...(args.model === undefined ? [] : [args.model]),
    ];
    const { selectors, requested, ...options } = parseAuditOptions(argv, "cli");
    const urls = await Promise.all(selectors.map((selector) => resolveAuditUrl(selector, cwd, signal)));
    signal.throwIfAborted();
    const { model } = selectModel(models, cwd, requested);
    validateAuditTargets(urls);
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const trigger: AuditTrigger = { source: "mcp", tool: runAuditTool.name, ...(requestId ? { requestId } : {}) };
    const settled = await Promise.allSettled(urls.map((url) => auditor.scheduleAudit(url, {
      ...options, model: { provider: model.provider, modelId: model.id },
    }, trigger, context)));
    signal.throwIfAborted();
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? { prUrl: urls[index]!, ...result.value }
      : { prUrl: urls[index]!, status: "failed" as const,
        error: stripControlCharacters(result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 3500) });
    return { results, apply: options.apply };
  };
}
