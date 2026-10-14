import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileExclusions } from "./exclusions.ts";
import { parseReviewTarget } from "./reviews.ts";

const exec = promisify(execFile);

export const AUDIT_CLI_USAGE = "Usage: pronto [--skip <label>]... [--skip-drafts[=true|false]] [--skip-approved[=true|false]] [--exclude <path>]... [--force] [--approve] [--allow-uncertain] [--approve-migrations] [--apply] [<number> | <branch> | <GitHub PR URL> | --pr <target>...] [provider/model-id]";

export function parseAuditOptions(args: string[], source: "cli" | "chat") {
  const usage = source === "cli" ? AUDIT_CLI_USAGE : "Usage: /audit [--skip <label>]... [--skip-drafts[=true|false]] [--skip-approved[=true|false]] [--exclude <path>]... [--force] [--approve] [--allow-uncertain] [--approve-migrations] [--apply] <GitHub PR URL> | --pr <GitHub PR URL>...";
  // Boolean flags default to true and take an optional true|false value.
  const booleanFlags = ["--skip-drafts", "--skip-approved"];
  const flags = ["--force", ...booleanFlags, "--approve", "--allow-uncertain", "--approve-migrations", "--apply"];
  const supplied = new Set<string>();
  const positional: string[] = [];
  const targets: string[] = [];
  const skipLabels: string[] = [];
  const exclude: string[] = [];
  const booleans = { "--skip-drafts": true, "--skip-approved": true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (arg === "--pr" || arg.startsWith("--pr=")) {
      const target = arg === "--pr" ? args[++i] : arg.slice("--pr=".length);
      if (!target?.trim() || target.startsWith("-")) throw new Error(`--pr requires a non-empty target\n${usage}`);
      targets.push(target);
      continue;
    }
    if (arg === "--skip" || arg.startsWith("--skip=")) {
      const label = arg === "--skip" ? args[++i] : arg.slice("--skip=".length);
      if (!label?.trim() || (arg === "--skip" && label.startsWith("-"))) {
        throw new Error(`--skip requires a non-empty label\n${usage}`);
      }
      skipLabels.push(label);
      continue;
    }
    if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      const path = arg === "--exclude" ? args[++i] : arg.slice("--exclude=".length);
      if (!path?.trim() || (arg === "--exclude" && path.startsWith("-"))) {
        throw new Error(`--exclude requires a non-empty path\n${usage}`);
      }
      try { compileExclusions([path]); } catch (error) {
        throw new Error(`${(error as Error).message}\n${usage}`, { cause: error });
      }
      exclude.push(path);
      continue;
    }
    const flag = booleanFlags.find((name) => arg.startsWith(`${name}=`)) ?? arg;
    if (!flags.includes(flag)) throw new Error(`Unknown audit option: ${arg}\n${usage}`);
    if (supplied.has(flag)) throw new Error(`${flag} can be supplied only once\n${usage}`);
    supplied.add(flag);
    if (flag === "--skip-drafts" || flag === "--skip-approved") {
      const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1)
        : ["true", "false"].includes(args[i + 1]) ? args[++i] : "true";
      if (value !== "true" && value !== "false") throw new Error(`${flag} must be true or false\n${usage}`);
      booleans[flag] = value === "true";
    }
  }
  if (targets.length ? positional.length > (source === "cli" ? 1 : 0)
    : (source === "chat" && !positional.length) || positional.length > (source === "cli" ? 2 : 1)) throw new Error(usage);
  const selectors = targets.length ? targets : [positional[0] ?? ""];
  const requested = targets.length ? positional[0] : positional[1];
  if (targets.length && requested && (requested.includes("://") || !requested.includes("/"))) {
    throw new Error(`Use --pr for every target in a batch; the only positional argument is provider/model-id\n${usage}`);
  }
  // Chat still requires URLs. Validate every explicit URL before credentials, storage or network access.
  for (const selector of selectors) if (source === "chat" || selector.includes("://")) parseReviewTarget(selector);
  return { selectors, requested, skipLabels, skipDrafts: booleans["--skip-drafts"], skipApproved: booleans["--skip-approved"], exclude, force: supplied.has("--force"),
    approve: supplied.has("--approve"), allowUncertain: supplied.has("--allow-uncertain"),
    approveMigrations: supplied.has("--approve-migrations"), apply: supplied.has("--apply") };
}

export async function resolveAuditUrl(selector: string, cwd: string): Promise<string> {
  if (selector.includes("://")) return parseReviewTarget(selector).url;
  let stdout: string;
  try {
    // Leave omitted selectors omitted: gh's PR finder resolves tracking refs, push config and fork owners.
    // https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/pr/shared/finder.go
    ({ stdout } = await exec("gh", ["pr", "view", ...(selector ? [selector] : []), "--json", "url", "--jq", ".url"], {
      cwd, timeout: 30_000,
    }));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new Error("GitHub CLI (gh) is required to infer a PR or select one by branch or number. Install gh or provide a GitHub PR URL.", { cause: error });
    }
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error });
  }
  return parseReviewTarget(stdout.trim()).url;
}
