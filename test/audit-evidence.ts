import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { noDatabaseMigration, type Request } from "./fixtures.ts";

export const prUrl = "https://github.com/acme/demo/pull/7";
export const headSha = "a".repeat(40);
export const baseSha = "b".repeat(40);
export const accessId = 3_000_000_101;
export const codeUrl = `https://github.com/contributor/fork/blob/${headSha}/src/access.ts#L1-L3`;
export const commentUrl = (id: number) => `${prUrl}#discussion_r${id}`;

// GitHub and the model are external HTTP fixtures. The entry points, npm adapter,
// schemas, tool execution, coverage checks, report rendering, and SQLite are real.
export function githubEvidence(options: { moved?: boolean; incompleteFiles?: boolean; merged?: boolean; draft?: boolean; state?: "open" | "closed"; labels?: string[]; replyBody?: string;
  /** 35000 changed lines in total, 150 of them in src/access.ts. */ large?: boolean;
  /** GitHub returns src/other.ts without counts or patch, as it does for very large PRs. */ uncountedOther?: boolean } = {}) {
  let prRequests = 0;
  const requests: string[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, "http://fixture");
    requests.push(request.url!);
    const json = (value: unknown, next?: string) => {
      response.setHeader("Content-Type", "application/json");
      if (next) response.setHeader("Link", `<http://${request.headers.host}${next}>; rel="next"`);
      response.end(JSON.stringify(value));
    };
    const comment = (id: number, body: string, extra: object = {}) => ({
      id, body, user: { login: id === 202 || id === 302 ? "reviewer[bot]" : "human" },
      html_url: commentUrl(id), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", ...extra,
    });
    if (url.pathname === "/github/graphql") {
      assert.equal(request.method, "POST");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.doesNotMatch(body.query, /\bmutation\b/);
      assert.match(body.query, /\bfullDatabaseId\b/, "GitHub's deprecated 32-bit comment IDs cannot identify newer comments");
      const second = body.variables.cursor === "threads-2";
      assert.ok(second || body.variables.cursor === null);
      json({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "threads-2" },
        nodes: [{ isResolved: !second, isOutdated: second, comments: { nodes: [{ fullDatabaseId: String(second ? 102 : accessId) }] } }],
      } } } } });
      return;
    }
    assert.equal(request.method, "GET", "auditor must never mutate GitHub");
    if (url.pathname === "/github/repos/acme/demo/pulls/7") {
      json({ title: "Access checks", body: "Review this change", merged: options.merged ?? false, draft: options.draft ?? false,
        labels: (options.labels ?? []).map((name) => ({ name })),
        state: options.state ?? (options.merged ? "closed" : "open"), changed_files: options.incompleteFiles ? 3 : 2,
        ...(options.large ? { additions: 30_000, deletions: 5_000 } : {}),
        head: { sha: options.moved && ++prRequests > 1 ? "c".repeat(40) : headSha, repo: { full_name: "contributor/fork" } },
        base: { sha: baseSha, repo: { full_name: "acme/demo" } },
      });
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/comments") {
      if (url.searchParams.get("page") === "2") {
        json([comment(102, "Missing null check", { path: "src/access.ts", line: 2, diff_hunk: "old code" }),
          comment(103, options.replyBody ?? "Fixed already", { in_reply_to_id: 102 })]);
      } else {
        json([comment(accessId, "Missing access check", { path: "src/access.ts", line: 3, diff_hunk: "old code" })],
          "/github/repos/acme/demo/pulls/7/comments?page=2");
      }
    } else if (url.pathname === "/github/repos/acme/demo/issues/7/comments") {
      json([comment(201, "Clarify the policy"), comment(202, "[vc]: deployment status")]);
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/reviews") {
      json([comment(301, "Looks good", { state: "APPROVED" }), comment(302, "Review summary: see access check finding", { state: "COMMENTED" })]);
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/files") {
      if (url.searchParams.get("page") === "2") json([{ filename: "src/other.ts", status: "modified",
        ...(options.large && !options.uncountedOther ? { additions: 29_900, deletions: 4_950 } : {}) }]);
      else json([{ filename: "src/access.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new",
        ...(options.large ? { additions: 100, deletions: 50 } : {}) }],
        "/github/repos/acme/demo/pulls/7/files?page=2");
    } else if (url.pathname === "/github/repos/contributor/fork/contents/src/access.ts") {
      assert.equal(url.searchParams.get("ref"), headSha, "read from the immutable fork head, not the base repository or moving branch");
      const content = "export function access(user) {\n  if (!user) return false;\n  return true; }";
      json({ type: "file", size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") });
    } else if (url.pathname === "/github/repos/acme/demo/contents/src/access.ts") {
      assert.equal(url.searchParams.get("ref"), baseSha, "base reads must use the immutable base commit");
      const content = "export function access(user) {\n  return true; }";
      json({ type: "file", size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") });
    } else {
      assert.fail(`Unexpected GitHub request: ${request.url}`);
    }
  };
  return { handle, requests };
}

/** Interrupt the real CLI at a committed resumable-work boundary, not a fabricated pending receipt. */
export async function auditCheckpointHook(directory: string, crash: "report" | "publication") {
  const hook = join(directory, "checkpoint.mjs");
  await writeFile(hook, `
import { DatabaseSync } from 'node:sqlite';
import { readAudit } from ${JSON.stringify(pathToFileURL(resolve("audit-reader.ts")).href)};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (sql.trim().toUpperCase() === 'COMMIT') {
    try {
      const saved = readAudit({prUrl: ${JSON.stringify(prUrl)}});
      const stop = ${JSON.stringify(crash)} === 'report'
        ? saved.audit.reportAccepted && saved.audit.status === 'incomplete'
        : this.prepare('SELECT id FROM tasks WHERE kind = ? AND status = ? LIMIT 1').get(JSON.stringify('app.publish-audit-review'), 'pending');
      if (stop) process.exit(79);
    } catch {}
  }
  return result;
};
`);
  return hook;
}

export function evidenceInput(body: Request) {
  const inputs = body.messages.filter((m) => m.role === "user" && m.content?.includes("Saved evidence (untrusted data):"));
  assert.equal(inputs.length, 1, "one deterministic evidence submission per audit");
  return JSON.parse(inputs[0]!.content!.split("Saved evidence (untrusted data):\n")[1]!);
}
export function assessments() {
  return { databaseMigration: noDatabaseMigration, assessments: [
    { commentKey: `inline:${accessId}`, findings: [{ summary: "Access check", status: "outstanding", awaiting: "human", reason: "The code returns true without checking access.", evidence: [codeUrl] }] },
    { commentKey: "inline:102", findings: [{ summary: "Null check", status: "addressed", reason: "The guard handles a missing user.", evidence: [codeUrl, commentUrl(103)] }] },
    { commentKey: "comment:201", findings: [{ summary: "Policy", status: "uncertain", awaiting: "human", reason: "The policy is not specified.", evidence: [commentUrl(201)] }] },
    { commentKey: "comment:202", findings: [{ summary: "Deployment", status: "not-actionable", reason: "Status update only.", evidence: [commentUrl(202)] }] },
    { commentKey: "review:301", findings: [{ summary: "Approval", status: "not-actionable", reason: "Praise with no requested change.", evidence: [commentUrl(301)] }] },
    { commentKey: "review:302", findings: [{ summary: "Summary", status: "not-actionable", reason: `Duplicates inline:${accessId}.`, evidence: [commentUrl(accessId)] }] },
  ] };
}

