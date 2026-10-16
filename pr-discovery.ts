import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findPullRequestUrl, parseReviewTarget } from "./reviews.ts";

// Selection rules follow gh's non-interactive finder and push-ref resolver:
// https://github.com/cli/cli/tree/v2.100.0/pkg/cmd/pr/shared
const exec = promisify(execFile);
type Repository = { host: string; owner: string; repo: string };
type Remote = Repository & { name: string };

async function git(cwd: string, args: string[], optionalExitCodes: number[] = []): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { code?: string | number };
    if (typeof failure.code === "number" && optionalExitCodes.includes(failure.code)) return "";
    if (failure.code === "ENOENT") throw new Error("Git is required to select a PR from a checkout. Install Git or provide a GitHub PR URL (or GH_REPO with a number or branch).");
    // Git errors can contain remote URLs with embedded credentials. Do not echo them.
    throw new Error(`Could not read Git checkout (${args[0]}). Provide a GitHub PR URL or set GH_REPO=owner/repo with a number or branch.`, { cause: error });
  }
}

function repositoryHost(): string {
  const apiHost = new URL(process.env.GITHUB_API_URL || "https://api.github.com").hostname;
  const host = process.env.GH_HOST?.toLowerCase() || (["api.github.com", "localhost", "127.0.0.1", "[::1]"].includes(apiHost) ? "github.com" : apiHost);
  if (!/^[\w.-]+$/.test(host)) throw new Error("GH_HOST must be a GitHub hostname");
  if (host !== "github.com" && host !== apiHost) throw new Error("Set GITHUB_API_URL for the GitHub host selected by GH_HOST");
  return host;
}

/** Parse both URL and scp-style Git remotes, without accepting other hosts. */
function remoteRepository(value: string, host: string): Repository | null {
  let remote: URL;
  try {
    remote = new URL(value.includes("://") ? value : value.replace(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/, "ssh://$1/$2"));
  } catch { return null; }
  if (!["https:", "http:", "ssh:", "git:"].includes(remote.protocol) || remote.hostname !== host) return null;
  const match = remote.pathname.replace(/\/$/, "").replace(/\.git$/, "").match(/^\/([\w-]+)\/([\w.-]+)$/);
  return match ? { host, owner: match[1]!, repo: match[2]! } : null;
}

function configuredRepository(value: string, host: string): Repository {
  const repository = remoteRepository(value.includes("://") ? value : `https://${value.split("/").length === 2 ? `${host}/` : ""}${value}`, host);
  if (!repository) throw new Error("Expected a GitHub repository on the configured host: [host/]owner/repo");
  return repository;
}

async function readRemotes(cwd: string, host: string): Promise<Remote[]> {
  const entries = new Map<string, Remote>();
  for (const line of (await git(cwd, ["remote", "-v"])).split("\n")) {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const repository = remoteRepository(match[2]!, host);
    // Prefer fetch URLs, as gh does; use the push URL only without a usable fetch URL.
    if (repository && (!entries.has(match[1]!) || match[3] === "fetch")) entries.set(match[1]!, { ...repository, name: match[1]! });
  }
  const priority = (name: string) => ["origin", "github", "upstream"].indexOf(name.toLowerCase());
  return [...entries.values()].sort((a, b) => priority(b.name) - priority(a.name));
}

async function readConfig(cwd: string): Promise<Map<string, string>> {
  const output = await git(cwd, ["config", "--null", "--get-regexp", "^(branch\\..*\\.(remote|merge|pushremote)|remote\\..*\\.gh-resolved|remote\\.pushdefault|push\\.default)$"], [1]);
  return new Map(output.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\n");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function baseRepository(remotes: Remote[], config: Map<string, string>, host: string): Repository {
  for (const remote of remotes) {
    const resolved = config.get(`remote.${remote.name}.gh-resolved`);
    if (resolved) return resolved === "base" ? remote : configuredRepository(resolved, host);
  }
  const repository = remotes[0];
  if (!repository) throw new Error("No GitHub remote found. Set GH_REPO=owner/repo or provide a GitHub PR URL.");
  return repository;
}

async function currentBranchSelector(cwd: string, base: Repository, remotes: Remote[], config: Map<string, string>): Promise<number | string> {
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [1]);
  if (!branch) throw new Error("Could not determine current branch: not on any branch (detached HEAD). Provide a PR number, branch or GitHub PR URL.");
  const merge = config.get(`branch.${branch}.merge`) || "";
  const trackingPR = merge.match(/^refs\/pull\/([1-9]\d*)\/head$/);
  if (trackingPR) return Number(trackingPR[1]);

  // Let Git resolve push refspecs and renamed upstream branches before falling back to config.
  const pushRef = await git(cwd, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", `${branch}@{push}`], [1, 128]);
  const pushRemote = [...remotes].sort((a, b) => b.name.length - a.name.length)
    .find((remote) => pushRef.startsWith(`refs/remotes/${remote.name}/`));
  let headRepository: Repository | undefined = pushRemote;
  let headBranch = pushRemote ? pushRef.slice(`refs/remotes/${pushRemote.name}/`.length) : branch;
  if (!pushRemote) {
    const pushDefault = config.get("push.default") || "simple";
    if (!["nothing", "current", "upstream", "tracking", "simple", "matching"].includes(pushDefault)) throw new Error(`Unknown push.default value: ${pushDefault}`);
    if (["upstream", "tracking"].includes(pushDefault) && merge) headBranch = merge.replace(/^refs\/heads\//, "");
    const branchRemote = (setting: "pushremote" | "remote") => {
      const value = config.get(`branch.${branch}.${setting}`);
      // gh ignores filesystem paths in branch remote settings before trying the next setting.
      return value === "." || value?.startsWith("./") || value?.startsWith("/") ? undefined : value;
    };
    const remoteName = branchRemote("pushremote") || config.get("remote.pushdefault") || branchRemote("remote");
    if (remoteName) {
      headRepository = remotes.find((remote) => remote.name === remoteName) ?? remoteRepository(remoteName, base.host) ?? undefined;
      if (!headRepository) throw new Error("Could not resolve the branch's GitHub push remote. Provide a PR number or GitHub PR URL.");
    }
  }
  if (headRepository && `${headRepository.owner}/${headRepository.repo}`.toLowerCase() !== `${base.owner}/${base.repo}`.toLowerCase()) {
    return `${headRepository.owner}:${headBranch}`;
  }
  return headBranch;
}

/** Resolve a URL, number or branch using local Git configuration and Pronto's GitHub credentials. */
export async function resolveAuditUrl(selector: string, cwd: string): Promise<string> {
  if (selector.includes("://")) return parseReviewTarget(selector).url;
  const host = repositoryHost();
  const override = process.env.GH_REPO ? configuredRepository(process.env.GH_REPO, host) : undefined;
  // Explicit selectors with GH_REPO need neither Git nor a checkout.
  const [remotes, config] = !override || !selector
    ? await Promise.all([readRemotes(cwd, host), readConfig(cwd)]) : [[], new Map<string, string>()];
  const repository = override ?? baseRepository(remotes, config, host);
  const selected = !selector ? await currentBranchSelector(cwd, repository, remotes, config)
    : /^#?\d+$/.test(selector) ? Number(selector.replace(/^#/, "")) : selector;
  if (typeof selected === "number" && (!Number.isSafeInteger(selected) || selected < 1)) throw new Error("Expected a positive, safe PR number");
  return findPullRequestUrl(repository, selected);
}
