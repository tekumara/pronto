import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseReviewTarget } from "./reviews.ts";

const exec = promisify(execFile);

export const AUDIT_CLI_USAGE = "Usage: pronto [--force] [--sticky[=true|false]] [--approve] [--allow-uncertain] [--apply] [<number> | <branch> | <GitHub PR URL>] [provider/model-id]";

export function parseAuditOptions(args: string[], source: "cli" | "chat") {
  const usage = source === "cli" ? AUDIT_CLI_USAGE : "Usage: /audit [--force] [--sticky[=true|false]] [--approve] [--allow-uncertain] [--apply] <GitHub PR URL>";
  const flags = ["--force", "--sticky", "--approve", "--allow-uncertain", "--apply"];
  const supplied = new Set<string>();
  const positional: string[] = [];
  let sticky = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const flag = arg.startsWith("--sticky=") ? "--sticky" : arg;
    if (!flags.includes(flag)) throw new Error(`Unknown audit option: ${arg}\n${usage}`);
    if (supplied.has(flag)) throw new Error(`${flag} can be supplied only once\n${usage}`);
    supplied.add(flag);
    if (flag === "--sticky") {
      const value = arg.startsWith("--sticky=") ? arg.slice("--sticky=".length)
        : ["true", "false"].includes(args[i + 1]) ? args[++i] : "true";
      if (value !== "true" && value !== "false") throw new Error(`--sticky must be true or false\n${usage}`);
      sticky = value === "true";
    }
  }
  if ((source === "chat" && !positional.length) || positional.length > (source === "cli" ? 2 : 1)) throw new Error(usage);
  const [selector = "", requested] = positional;
  // Chat still requires a URL. Reject malformed URLs before credentials, storage or network access.
  if (source === "chat" || selector.includes("://")) parseReviewTarget(selector);
  return { selector, requested, force: supplied.has("--force"), sticky,
    approve: supplied.has("--approve"), allowUncertain: supplied.has("--allow-uncertain"), apply: supplied.has("--apply") };
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
