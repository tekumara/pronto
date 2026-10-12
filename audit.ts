#!/usr/bin/env -S node --experimental-strip-types
import { runAudit } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { AUDIT_CLI_USAGE, parseAuditOptions, resolveAuditUrl } from "./audit-options.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(AUDIT_CLI_USAGE);
    console.log("Without a target, selects the current branch's PR using gh pr view. Branch and number selection require gh; explicit URLs need no checkout.");
    console.log("--force bypasses the assessment cache and restarts any unfinished audit.");
    console.log("--sticky updates your latest verdict comment after a fresh assessment; reused assessments leave it unchanged (default: true; --sticky=false creates a new comment).");
    console.log("--approve selects approval when no outstanding or uncertain findings remain; requires --apply to submit (default: false).");
    console.log("--allow-uncertain allows --approve with uncertain findings and no outstanding findings (default: false).");
    console.log("--apply publishes the verdict comment and any selected approval to GitHub (default: false; otherwise previews only).");
    return;
  }
  const { selector, requested, force, sticky, approve, allowUncertain, apply } = parseAuditOptions(args, "cli");
  const cwd = process.cwd();
  const url = await resolveAuditUrl(selector, cwd);
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudit(url, { models, model: { provider: model.provider, modelId: model.id }, force, sticky, approve, allowUncertain, apply });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
