#!/usr/bin/env -S node --experimental-strip-types
import { runAudits } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { AUDIT_CLI_USAGE, parseAuditOptions, resolveAuditUrl } from "./audit-options.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(AUDIT_CLI_USAGE);
    console.log("--pr <target> adds a PR to a concurrent batch. Repeat for multiple targets; flags and the optional model apply to every PR.");
    console.log("Without a target, selects the current branch's PR using gh pr view. Branch and number selection require gh; explicit URLs need no checkout.");
    console.log("--skip <label> skips the audit if the PR has that label (case-insensitive). Repeat for multiple labels; any match skips, even with --force or --apply.");
    console.log("--skip-approved skips the audit if you already approved the PR's current head commit (default: true; --skip-approved=false audits anyway). Applies even with --force.");
    console.log("--force bypasses the assessment cache and restarts any unfinished audit.");
    console.log("--sticky updates your latest verdict comment after a fresh assessment; reused assessments leave it unchanged (default: true; --sticky=false creates a new comment).");
    console.log("--approve selects approval when no outstanding or uncertain findings remain; requires --apply to submit (default: false).");
    console.log("--allow-uncertain allows --approve with uncertain findings and no outstanding findings (default: false).");
    console.log("--approve-migrations allows --approve for database migrations or uncertain/missing migration status; the audit always runs (default: false).");
    console.log("--apply publishes the verdict comment and any selected approval to GitHub (default: false; otherwise previews only).");
    return;
  }
  const { selectors, requested, skipLabels, skipApproved, force, sticky, approve, allowUncertain, approveMigrations, apply } = parseAuditOptions(args, "cli");
  const cwd = process.cwd();
  const urls = await Promise.all(selectors.map((selector) => resolveAuditUrl(selector, cwd)));
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudits(urls, { models, model: { provider: model.provider, modelId: model.id }, skipLabels, skipApproved, force, sticky, approve, allowUncertain, approveMigrations, apply });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
