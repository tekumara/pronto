#!/usr/bin/env -S node --experimental-strip-types
import { AUDIT_CLI_USAGE, parseAuditOptions } from "./audit-options.ts";
import { resolveAuditUrl } from "./pr-discovery.ts";

async function main() {
  const args = process.argv.slice(2);
  // Reserved command names remain selectable as branches with --pr <branch>.
  if (args[0] === "serve") return (await import("./serve-command.ts")).runServe(args.slice(1));
  if (args[0] === "mcp") throw new Error("Use pronto serve --mcp --mcp-public-url <https-url-or-http-loopback-url>; the standalone MCP command has been removed. See pronto serve --help.");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(AUDIT_CLI_USAGE);
    console.log("pronto serve [options] starts a webhook server that audits a PR when you are asked to review it; see pronto serve --help.");
    console.log("pronto serve --mcp --mcp-public-url <https-url> exposes audit tools and the discussion skill to remote agents, including audit execution; use an HTTP loopback URL for local use.");
    console.log("--pr <target> adds a PR to a concurrent batch. Repeat for multiple targets; flags and the optional model apply to every PR.");
    console.log("Without a target, selects the current branch's PR using local Git configuration and the GitHub API. Set GH_REPO=owner/repo to select a number or branch without a checkout. Explicit URLs and owner/repo#number targets need neither Git nor a checkout.");
    console.log("--skip <label> skips the audit if the PR has that label (case-insensitive). Repeat for multiple labels; any match skips, even with --force or --apply.");
    console.log("--skip-drafts skips the audit if the PR is a draft (default: true; --skip-drafts=false audits anyway). Applies even with --force, --apply or --approve.");
    console.log("--skip-approved skips the audit if any reviewer has already approved the PR's current head commit (default: true; --skip-approved=false audits anyway). Applies even with --force.");
    console.log("--report-skips previews skip reviews, or posts them with --apply (default: off). Your own current approval remains a quiet skip.");
    console.log("--exclude <path> leaves matching changed files out of the size limit and the audit; their patches are withheld and they are listed in the output. Repeat for multiple paths. Paths are repository-relative: * and ? stay within a directory, ** crosses directories, and a directory excludes everything under it.");
    console.log("--force bypasses the assessment cache and restarts any unfinished audit.");
    console.log("--approve selects approval when no outstanding or uncertain findings remain; requires --apply to submit (default: false).");
    console.log("--allow-uncertain allows --approve with uncertain findings and no outstanding findings (default: false).");
    console.log("--approve-migrations allows --approve for database migrations or uncertain/missing migration status; the audit always runs (default: false).");
    console.log("--apply submits a verdict review to GitHub unless a matching review is recorded in local history (default: false; otherwise previews only).");
    return;
  }
  const { selectors, requested, skipLabels, skipDrafts, skipApproved, reportSkips, exclude, force, approve, allowUncertain, approveMigrations, apply } = parseAuditOptions(args, "cli");
  const cwd = process.cwd();
  const urls = await Promise.all(selectors.map((selector) => resolveAuditUrl(selector, cwd)));
  const { createModelRuntime } = await import("../model.ts");
  const { runAudits } = await import("../audit/auditor.ts");
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudits(urls, { models, model: { provider: model.provider, modelId: model.id }, skipLabels, skipDrafts, skipApproved, reportSkips, exclude, force, approve, allowUncertain, approveMigrations, apply });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
