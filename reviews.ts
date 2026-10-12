import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";

// agent-reviews has no public library entry point. Keep its pinned internal imports here.
const require = createRequire(import.meta.url);
const { fetchPRComments } = require("agent-reviews/lib/comments.js") as {
  fetchPRComments(owner: string, repo: string, pr: number, token: string, fetcher: typeof fetch): Promise<{
    reviewComments: RawComment[]; issueComments: RawComment[]; reviews: RawComment[];
  }>;
};
const { getGitHubToken, getProxyFetch } = require("agent-reviews/lib/github.js") as {
  getGitHubToken(): string | null;
  getProxyFetch(): typeof fetch;
};

type RawComment = {
  id: number; user: { login: string } | null; body: string | null; html_url: string;
  created_at?: string; submitted_at?: string; updated_at?: string; state?: string;
  in_reply_to_id?: number; path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string;
};
export type ReviewTarget = { owner: string; repo: string; pr: number; url: string };
export type ReviewComment = {
  key: string; kind: "inline" | "comment" | "review"; author: string; body: string; url: string;
  createdAt: string; updatedAt: string; path: string | null; line: number | null; diffHunk: string | null;
  reviewState: string | null; thread: { resolved: boolean; outdated: boolean } | null;
  replies: { author: string; body: string; url: string; createdAt: string }[];
};
export type ReviewSnapshot = {
  id: string; target: ReviewTarget; startedAt: string; fetchedAt: string; title: string; description: string;
  headSha: string; headRepository: string; baseSha: string; baseRepository: string;
  comments: ReviewComment[];
  files: { path: string; previousPath: string | null; status: string; patch: string | null }[];
};
type PullRequest = {
  title: string; body: string | null; changed_files: number;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } | null };
};
type ThreadPage = { data?: { repository?: { pullRequest?: { reviewThreads: {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { fullDatabaseId: number | string | null }[] } }[];
} } } }; errors?: { message: string }[] };

export function parseReviewTarget(value: string): ReviewTarget {
  const url = new URL(value);
  const configuredHost = process.env.GITHUB_API_URL ? new URL(process.env.GITHUB_API_URL).hostname : "github.com";
  const match = url.pathname.match(/^\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || !["github.com", configuredHost].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || !match
    || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error("Expected a GitHub PR URL: https://github.com/owner/repo/pull/42");
  }
  return { owner: match[1]!, repo: match[2]!, pr: Number(match[3]), url: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
}

function failureDetails(error: unknown): string {
  const details: string[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 10) {
    const failure = pending.shift();
    if (seen.has(failure)) continue;
    seen.add(failure);
    if (failure instanceof Error) {
      const code = (failure as NodeJS.ErrnoException).code;
      details.push(`${failure.message}${code ? ` (${code})` : ""}`);
      if (failure.cause !== undefined) pending.push(failure.cause);
      if (failure instanceof AggregateError) pending.push(...failure.errors);
    } else details.push(String(failure));
  }
  return details.filter(Boolean).join(": ");
}

function github() {
  const token = getGitHubToken();
  if (!token) throw new Error("GitHub authentication required. Run gh auth login or set GITHUB_TOKEN/GH_TOKEN.");
  const base = (process.env.GITHUB_API_URL || "https://api.github.com").trim().replace(/\/+$/, "");
  const graphql = process.env.GITHUB_GRAPHQL_URL?.trim().replace(/\/+$/, "")
    || (base.endsWith("/api/v3") ? base.replace(/\/api\/v3$/, "/api/graphql") : `${base}/graphql`);
  const proxyFetch = getProxyFetch();
  // Error bodies and transport messages are untrusted and may echo request credentials.
  const diagnostic = (value: string) => value.replaceAll(token, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 2_000);
  const checkedFetch: typeof fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    url.username = "";
    url.password = "";
    const method = options.method ?? (input instanceof Request ? input.method : "GET");
    const endpoint = `${method} ${diagnostic(url.href)}`;
    let response: Response;
    try {
      response = await proxyFetch(input, { ...options, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`GitHub request failed: ${endpoint}\n${diagnostic(failureDetails(error))}`, { cause: error });
    }
    if (!response.ok) {
      const details = [`GitHub request failed (${response.status}): ${endpoint}`,
        diagnostic(response.statusText || STATUS_CODES[response.status] || "")];
      try {
        const body = diagnostic(await response.text());
        if (body) details.push(`Response: ${body}`);
      } catch (error) {
        details.push(`Response body unavailable: ${diagnostic(failureDetails(error))}`);
      }
      for (const name of ["x-github-request-id", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = response.headers.get(name);
        if (value !== null) details.push(`${name}: ${diagnostic(value)}`);
      }
      throw new Error(details.filter(Boolean).join("\n"));
    }
    return response;
  };
  // Paginated REST links must not send the token to another origin.
  const fetcher: typeof fetch = (input, options = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== new URL(base).origin) throw new Error("Unexpected GitHub REST origin");
    return checkedFetch(input, options);
  };
  async function request<T>(url: string, body?: object, method: "GET" | "POST" | "PATCH" = body ? "POST" : "GET"): Promise<T> {
    const response = await checkedFetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-durable-auditor",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.json() as Promise<T>;
  }
  async function pages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let url: string | null = `${base}${path}`;
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url)) throw new Error("Repeated GitHub pagination link");
      seen.add(url);
      const response: Response = await fetcher(url, { headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-durable-auditor",
      } });
      values.push(...await response.json() as T[]);
      url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return values;
  }
  return { token, base, graphql, fetcher, request, pages };
}

export async function fetchReviewSnapshot(target: ReviewTarget): Promise<ReviewSnapshot> {
  const client = github();
  const path = `/repos/${target.owner}/${target.repo}/pulls/${target.pr}`;
  const startedAt = new Date().toISOString();
  const pr = await client.request<PullRequest>(`${client.base}${path}`);
  if (!pr.head.repo || !pr.base.repo || !/^[a-f\d]{40}$/i.test(pr.head.sha) || !/^[a-f\d]{40}$/i.test(pr.base.sha)) {
    throw new Error("PR repositories or immutable commit SHAs are unavailable");
  }
  const [raw, files] = await Promise.all([
    fetchPRComments(target.owner, target.repo, target.pr, client.token, client.fetcher),
    client.pages<{ filename: string; previous_filename?: string; status: string; patch?: string }>(`${path}/files?per_page=100`),
  ]);
  if (files.length !== pr.changed_files) throw new Error("GitHub did not return the complete changed-file list; audit stopped");

  const threads = new Map<string, { resolved: boolean; outdated: boolean }>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const result: ThreadPage = await client.request(client.graphql, {
      query: `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$pr) {
          reviewThreads(first:100,after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { isResolved isOutdated comments(first:1) { nodes { fullDatabaseId } } }
          }
        } }
      }`,
      variables: { owner: target.owner, repo: target.repo, pr: target.pr, cursor },
    });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map((e) => e.message).join("; ")}`);
    const page = result.data?.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error("GitHub review threads are unavailable");
    for (const thread of page.nodes) {
      const id = thread.comments.nodes[0]?.fullDatabaseId;
      if (id !== undefined && id !== null) threads.set(String(id), { resolved: thread.isResolved, outdated: thread.isOutdated });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error("Incomplete GitHub thread pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);

  // Preserve bodies and review summaries. Let the auditor classify boilerplate, not a heuristic filter.
  const groups: [ReviewComment["kind"], RawComment[]][] = [
    ["inline", raw.reviewComments.filter((c) => !c.in_reply_to_id)],
    ["comment", raw.issueComments],
    ["review", raw.reviews.filter((c) => c.body?.trim())],
  ];
  const comments: ReviewComment[] = groups.flatMap(([kind, list]) => list.map((c) => ({
    key: `${kind}:${c.id}`, kind, author: c.user?.login ?? "unknown", body: c.body ?? "", url: c.html_url,
    createdAt: c.created_at ?? c.submitted_at ?? "", updatedAt: c.updated_at ?? c.created_at ?? c.submitted_at ?? "",
    path: c.path ?? null, line: c.line ?? c.original_line ?? null, diffHunk: c.diff_hunk ?? null,
    reviewState: c.state ?? null, thread: kind === "inline" ? threads.get(String(c.id)) ?? null : null,
    replies: kind === "inline" ? raw.reviewComments.filter((r) => r.in_reply_to_id === c.id).map((r) => ({
      author: r.user?.login ?? "unknown", body: r.body ?? "", url: r.html_url, createdAt: r.created_at ?? "",
    })) : [],
  })));
  const latest = await client.request<PullRequest>(`${client.base}${path}`);
  if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha) {
    throw new Error("PR commits changed while fetching evidence. Run the audit again.");
  }
  return {
    id: randomUUID(), target, startedAt, fetchedAt: new Date().toISOString(), title: pr.title, description: pr.body ?? "",
    headSha: pr.head.sha, headRepository: pr.head.repo.full_name, baseSha: pr.base.sha, baseRepository: pr.base.repo.full_name,
    comments, files: files.map((f) => ({ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, patch: f.patch ?? null })),
  };
}

// Keep this marker stable across package renames so existing sticky comments remain identifiable.
export const AUDIT_COMMENT_MARKER = "<!-- pi-durable-demo:review-audit -->";

export async function postReviewComment(target: ReviewTarget, body: string, sticky = true, apply = false): Promise<{
  action: "posted" | "updated"; url: string | null;
}> {
  const client = github();
  const path = `/repos/${target.owner}/${target.repo}/issues`;
  let existing: RawComment | undefined;
  if (sticky) {
    // Look up live comments, not the saved snapshot: cached/resumed audits must still find the latest post.
    const [viewer, comments] = await Promise.all([
      client.request<{ login: string }>(`${client.base}/user`),
      client.pages<RawComment>(`${path}/${target.pr}/comments?per_page=100`),
    ]);
    existing = comments.filter((comment) => comment.user?.login.toLowerCase() === viewer.login.toLowerCase()
      && (comment.body?.trimEnd().endsWith(AUDIT_COMMENT_MARKER)
        // Recognise verdicts posted before the marker was introduced.
        || comment.body?.startsWith(`PR review audit · ${target.url}\n\nHead: `)))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)[0];
  }
  const action = existing ? "updated" : "posted";
  if (!apply) return { action, url: null };
  const comment = existing
    ? await client.request<{ html_url: string }>(`${client.base}${path}/comments/${existing.id}`, { body }, "PATCH")
    : await client.request<{ html_url: string }>(`${client.base}${path}/${target.pr}/comments`, { body });
  return { action, url: comment.html_url };
}

export async function approveReview(snapshot: ReviewSnapshot, body: string, apply = false): Promise<void> {
  const client = github();
  const { owner, repo, pr } = snapshot.target;
  const path = `${client.base}/repos/${owner}/${repo}/pulls/${pr}`;
  const latest = await client.request<PullRequest>(path);
  if (latest.head.sha !== snapshot.headSha || latest.base.sha !== snapshot.baseSha) {
    throw new Error("PR commits changed since the audit snapshot. No approval was submitted; run the audit again.");
  }
  // Pin the approval even if the head changes between the check and the write.
  if (apply) await client.request(`${path}/reviews`, { event: "APPROVE", commit_id: snapshot.headSha, body });
}

export async function readGithubFile(snapshot: ReviewSnapshot, path: string, revision: "head" | "base", offset: number, limit: number) {
  if (path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("Expected a repository-relative file path without traversal");
  }
  const client = github();
  const sha = revision === "head" ? snapshot.headSha : snapshot.baseSha;
  const repository = revision === "head" ? snapshot.headRepository : snapshot.baseRepository;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = await client.request<{ type: string; size: number; encoding: string; content?: string }>(
    `${client.base}/repos/${repository}/contents/${encodedPath}?ref=${sha}`,
  );
  if (file.type !== "file" || file.size > 1_000_000 || file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error("File is not a supported text file (maximum 1 MB). Mark findings uncertain if needed.");
  }
  const text = Buffer.from(file.content, "base64").toString("utf8");
  if (text.includes("\0")) throw new Error("Binary files are not supported");
  const lines = text.split("\n");
  if (offset > lines.length) throw new Error(`Offset exceeds file length (${lines.length} lines)`);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const content = selected.map((line, i) => `${offset + i}: ${line}`).join("\n");
  if (Buffer.byteLength(content) > 24_000) throw new Error("Selected lines exceed 24 KB. Request fewer lines.");
  const end = offset + selected.length - 1;
  return {
    path, revision, sha, offset, end, totalLines: lines.length, hasMore: end < lines.length, content,
    url: `${new URL(snapshot.target.url).origin}/${repository}/blob/${sha}/${encodedPath}#L${offset}-L${end}`,
  };
}
