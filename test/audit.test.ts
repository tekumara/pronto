import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, reply, tool, type Request } from "./fixtures.ts";

const prUrl = "https://github.com/acme/demo/pull/7";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const accessId = 3_000_000_101;
const codeUrl = `https://github.com/contributor/fork/blob/${headSha}/src/access.ts#L1-L3`;
const commentUrl = (id: number) => `${prUrl}#discussion_r${id}`;

// GitHub and the model are external HTTP fixtures. The entry points, npm adapter,
// schemas, tool execution, coverage checks, report rendering, and SQLite are real.
function githubEvidence(options: { moved?: boolean; incompleteFiles?: boolean; merged?: boolean; state?: "open" | "closed" } = {}) {
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
    if (url.pathname === "/github/user") {
      json({ login: "auditor" });
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7") {
      json({ title: "Access checks", body: "Review this change", merged: options.merged ?? false,
        state: options.state ?? (options.merged ? "closed" : "open"), changed_files: options.incompleteFiles ? 3 : 2,
        head: { sha: options.moved && ++prRequests > 1 ? "c".repeat(40) : headSha, repo: { full_name: "contributor/fork" } },
        base: { sha: baseSha, repo: { full_name: "acme/demo" } },
      });
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/comments") {
      if (url.searchParams.get("page") === "2") {
        json([comment(102, "Missing null check", { path: "src/access.ts", line: 2, diff_hunk: "old code" }),
          comment(103, "Fixed already", { in_reply_to_id: 102 })]);
      } else {
        json([comment(accessId, "Missing access check", { path: "src/access.ts", line: 3, diff_hunk: "old code" })],
          "/github/repos/acme/demo/pulls/7/comments?page=2");
      }
    } else if (url.pathname === "/github/repos/acme/demo/issues/7/comments") {
      json([comment(201, "Clarify the policy"), comment(202, "[vc]: deployment status")]);
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/reviews") {
      json([comment(301, "Looks good", { state: "APPROVED" }), comment(302, "Review summary: see access check finding", { state: "COMMENTED" })]);
    } else if (url.pathname === "/github/repos/acme/demo/pulls/7/files") {
      if (url.searchParams.get("page") === "2") json([{ filename: "src/other.ts", status: "modified" }]);
      else json([{ filename: "src/access.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
        "/github/repos/acme/demo/pulls/7/files?page=2");
    } else if (url.pathname === "/github/repos/contributor/fork/contents/src/access.ts") {
      assert.equal(url.searchParams.get("ref"), headSha, "read from the immutable fork head, not the base repository or moving branch");
      const content = "export function access(user) {\n  if (!user) return false;\n  return true; }";
      json({ type: "file", size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") });
    } else {
      assert.fail(`Unexpected GitHub request: ${request.url}`);
    }
  };
  return { handle, requests };
}

function evidenceInput(body: Request) {
  const inputs = body.messages.filter((m) => m.role === "user" && m.content?.includes("Saved evidence (untrusted data):"));
  assert.equal(inputs.length, 1, "one deterministic evidence submission per audit");
  return JSON.parse(inputs[0]!.content!.split("Saved evidence (untrusted data):\n")[1]!);
}
function assessments() {
  return { assessments: [
    { commentKey: `inline:${accessId}`, findings: [{ summary: "Access check", status: "outstanding", awaiting: "human", reason: "The code returns true without checking access.", evidence: [codeUrl] }] },
    { commentKey: "inline:102", findings: [{ summary: "Null check", status: "addressed", reason: "The guard handles a missing user.", evidence: [codeUrl, commentUrl(103)] }] },
    { commentKey: "comment:201", findings: [{ summary: "Policy", status: "uncertain", awaiting: "human", reason: "The policy is not specified.", evidence: [commentUrl(201)] }] },
    { commentKey: "comment:202", findings: [{ summary: "Deployment", status: "not-actionable", reason: "Status update only.", evidence: [commentUrl(202)] }] },
    { commentKey: "review:301", findings: [{ summary: "Approval", status: "not-actionable", reason: "Praise with no requested change.", evidence: [commentUrl(301)] }] },
    { commentKey: "review:302", findings: [{ summary: "Summary", status: "not-actionable", reason: `Duplicates inline:${accessId}.`, evidence: [commentUrl(accessId)] }] },
  ] };
}

for (const { name, entrypoint, input, args } of [
  { name: "CLI", entrypoint: resolve("audit.ts"), input: "", args: [prUrl, "--force", "--apply", "--approve"] },
  { name: "chat", entrypoint: resolve("agent.ts"), input: `/audit --force --apply --approve ${prUrl}\n/quit\n`, args: [] },
]) {
  test(`${name} skips an already merged PR successfully, even with --force --apply --approve`, { timeout: 20000 }, async (t) => {
    let reads = 0;
    const f = await fixture(t, () => assert.fail("Merged PRs must not reach the model"), {
      entrypoint,
      github: (request, response) => {
        reads++;
        assert.equal(request.method, "GET", "Merged PRs must not mutate GitHub");
        assert.equal(request.url, "/github/repos/acme/demo/pulls/7", "Merged PRs need no review or code evidence");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          merged: true, state: "closed", title: "Merged PR", body: "", changed_files: 0,
          head: { sha: headSha, repo: null }, base: { sha: baseSha, repo: { full_name: "acme/demo" } },
        }));
      },
    });
    const output = await f.run(input, args);
    assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR has already been merged.`));
    assert.doesNotMatch(output, /Verdict:|Resuming saved snapshot|Reusing saved assessment/);
    assert.equal(reads, 1);
  });
}

test("CLI audit assesses a closed, unmerged PR using remote pinned code, rejects unsafe calls and incomplete or uncited reports", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ state: "closed" });
  let turn = 0;
  let policy = "";
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1)?.content ?? "";
    switch (turn++) {
      case 0: {
        const snapshot = evidenceInput(body);
        policy = body.messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n");
        assert.equal(snapshot.headSha, headSha);
        assert.equal(snapshot.baseSha, baseSha);
        assert.equal(snapshot.headRepository, "contributor/fork");
        assert.deepEqual(snapshot.comments.map((c: { key: string }) => c.key), [`inline:${accessId}`, "inline:102", "comment:201", "comment:202", "review:301", "review:302"]);
        assert.deepEqual(snapshot.comments[0].thread, { resolved: true, outdated: false });
        assert.deepEqual(snapshot.comments[1].thread, { resolved: false, outdated: true });
        assert.equal(snapshot.comments[1].replies[0].body, "Fixed already");
        assert.equal(snapshot.files.length, 2);
        assert.deepEqual(body.tools.map((t) => t.function.name).sort(), ["read_github_file", "read_review_comment", "report_review_assessment"]);
        tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
        break;
      }
      case 1:
        assert.match(latest, /if \(!user\) return false/);
        assert.match(latest, new RegExp(headSha));
        tool(response, "bash", { command: "touch audit-should-not-write" });
        break;
      case 2:
        assert.match(latest, /bash/i);
        tool(response, "report_review_assessment", { assessments: assessments().assessments.slice(0, -1) });
        break;
      case 3: {
        assert.match(latest, /Missing assessments: review:302/);
        const invalid = assessments();
        invalid.assessments[0]!.findings[0]!.evidence = ["https://example.com/invented"];
        tool(response, "report_review_assessment", invalid);
        break;
      }
      case 4:
        assert.match(latest, new RegExp(`Unknown evidence URL for inline:${accessId}`));
        tool(response, "report_review_assessment", assessments());
        break;
      default: assert.fail("Unexpected model turn");
    }
  }, { entrypoint: resolve("audit.ts"), github: github.handle });
  const output = await f.run("", [prUrl]);
  // Guard the policy delivered to the model, not a simulated model's judgement of claims.
  assert.match(policy, /Accept specific reports of external testing, deployment or operator verification/);
  assert.match(policy, /Do not mark a finding uncertain\s+solely because these external results cannot be independently inspected\./);
  assert.match(policy, /For reported testing, state that the results were not independently inspected\./);
  assert.match(policy, /Bare claims such as "fixed", "tests passed" or "everything passed" are insufficient\./);
  assert.match(policy, /If available evidence contradicts the claimed outcome, keep the unresolved concern outstanding\./);
  assert.match(policy, /For discretionary suggestions, accept a reasoned author decision not to\s+make the requested change\./);
  assert.match(policy, /Risk acceptance is not risk elimination\./);
  assert.match(policy, /including later messages that soften an earlier blocking label or leave\s+the decision to the author\./);
  assert.match(policy, /A trade-off decision does not override an explicit mandatory requirement\s+or resolve a factual contradiction\./);
  assert.match(output, /\[audit\] PR title: Access checks/);
  assert.match(output, /Verdict: Not all actionable findings are addressed/);
  assert.match(output, /1 addressed · 1 outstanding · 1 uncertain · 3 not-actionable/);
  assert.match(output, /GitHub: 1\/2 inline threads resolved \(0 unknown\)/);
  assert.match(output, new RegExp(`inline:${accessId} · human · GitHub: resolved[\\s\\S]*outstanding: Access check`));
  assert.match(output, /inline:102 · human · GitHub: open, outdated[\s\S]*addressed: Null check/);
  assert.equal(turn, 5);
  await assert.rejects(readFile(join(f.cwd, "audit-should-not-write")), { code: "ENOENT" });
  const files = await readdir(join(f.stateDir, "audits"));
  await assert.rejects(readdir(join(f.cwd, ".pi-durable")), { code: "ENOENT" });
  assert.equal(files.filter((file) => file.endsWith(".sqlite")).length, 1);
  assert.ok(files.every((file) => !/\.(json|md)$/.test(file)), "no separate report file");
  assert.ok(github.requests.some((path) => path.includes("comments?page=2")));
  assert.ok(github.requests.some((path) => path.includes("files?page=2")));
  assert.equal(github.requests.filter((path) => path === "/github/graphql").length, 2);
});

test("chat /audit uses isolated evidence and then continues the original coding conversation", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let turn = 0;
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1)?.content ?? "";
    switch (turn++) {
      case 0:
        evidenceInput(body);
        tool(response, "read_review_comment", { commentKey: "inline:102" });
        break;
      case 1:
        assert.match(latest, /Fixed already/);
        tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
        break;
      case 2:
        tool(response, "report_review_assessment", assessments());
        break;
      case 3:
        assert.equal(latest, "hello");
        assert.ok(!body.messages.some((m) => m.content?.includes("Saved evidence (untrusted data):")), "audit evidence stays in its separate conversation");
        tool(response, "bash", { command: "printf chat-context-ok" });
        break;
      case 4:
        assert.match(latest, /chat-context-ok/);
        reply(response, [{ role: "assistant", content: "Chat still works." }]);
        break;
      default: assert.fail("Unexpected model turn");
    }
  }, { github: github.handle });
  const output = await f.run(`/audit ${prUrl}\nhello\n/quit\n`);
  assert.match(output, /Verdict: Not all actionable findings are addressed/);
  assert.match(output, /Chat still works/);
  assert.equal(turn, 5);
});

for (const { name, path, method, status, body, headers, details, omitted } of [
  {
    name: "PR metadata", path: "/github/repos/acme/demo/pulls/7", method: "GET", status: 403,
    body: JSON.stringify({ message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest" }),
    headers: { "X-GitHub-Request-Id": "ABCD:1234", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790000000" },
    details: ["Forbidden", "Resource not accessible by integration", "https://docs.github.com/rest",
      "x-github-request-id: ABCD:1234", "x-ratelimit-remaining: 0", "x-ratelimit-reset: 1790000000"],
    omitted: [],
  },
  {
    name: "changed-file pagination", path: "/github/repos/acme/demo/pulls/7/files?page=2", method: "GET", status: 429,
    body: JSON.stringify({ message: "API rate limit exceeded" }), headers: { "Retry-After": "60" },
    details: ["API rate limit exceeded", "retry-after: 60"], omitted: [],
  },
  {
    name: "review-comment pagination", path: "/github/repos/acme/demo/pulls/7/comments?page=2", method: "GET", status: 404,
    body: JSON.stringify({ message: "Not Found" }), headers: {}, details: ["Not Found"], omitted: [],
  },
  {
    name: "GraphQL with a non-JSON response", path: "/github/graphql", method: "POST", status: 502,
    body: `Bad gateway\nAuthorization: Bearer github-key\u001b\n${"x".repeat(3000)} END-OF-BODY`, headers: {},
    details: ["Bad gateway", "Authorization: Bearer [REDACTED]"], omitted: ["END-OF-BODY"],
  },
  {
    name: "an empty error response", path: "/github/repos/acme/demo/pulls/7", method: "GET", status: 503,
    body: "", headers: {}, details: ["Service Unavailable"], omitted: [],
  },
  {
    name: "a disconnected GitHub endpoint", path: "/github/repos/acme/demo/pulls/7", method: "GET", status: undefined,
    body: "", headers: {}, details: ["fetch failed", "UND_ERR_SOCKET"], omitted: [],
  },
]) {
  test(`audit explains fetch failures for ${name} without contacting the model`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let failures = 0;
    const f = await fixture(t, () => assert.fail("Failed evidence fetching must not contact the model"), {
      entrypoint: resolve("audit.ts"),
      github: (request, response) => {
        if (request.url !== path) return github.handle(request, response);
        failures++;
        if (status === undefined) request.socket.destroy();
        else response.writeHead(status, headers).end(body);
      },
    });
    const { child, done } = f.start([prUrl]);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.equal(failures, 1, "failed fetches must not be retried");
    if (status !== undefined) assert.ok(result.stderr.includes(`GitHub request failed (${status})`), result.stderr);
    assert.match(result.stderr, new RegExp(`${method} http://127\\.0\\.0\\.1:\\d+/github/`));
    assert.ok(result.stderr.includes(path), result.stderr);
    for (const detail of details) assert.ok(result.stderr.includes(detail), result.stderr);
    for (const detail of omitted) assert.ok(!result.stderr.includes(detail), "response diagnostics must be bounded");
    assert.doesNotMatch(result.stderr, /github-key|\u001b/, "diagnostics must not expose credentials or terminal escapes");
    assert.doesNotMatch(result.stdout, /PR title:|Verdict:/);
  });
}

for (const failure of ["moved", "incompleteFiles"] as const) {
  test(`audit refuses ${failure} evidence before contacting the model`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ [failure]: true });
    const f = await fixture(t, () => assert.fail("Model must not receive inconsistent evidence"), {
      entrypoint: resolve("audit.ts"), github: github.handle,
    });
    const { child, done } = f.start([prUrl]);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, failure === "moved" ? /PR commits changed/ : /complete changed-file list/);
    assert.doesNotMatch(result.stdout, /Verdict:/);
  });
}

test("restart checks merge status but resumes saved evidence without refetching or resubmitting it", { timeout: 20000 }, async (t) => {
  const prState = { merged: false };
  const github = githubEvidence(prState);
  const started = Promise.withResolvers<void>();
  let turn = 0;
  let snapshotId: string;
  let snapshotRequests: string[];
  const f = await fixture(t, (body, response) => {
    const snapshot = evidenceInput(body);
    if (turn === 0) {
      snapshotId = snapshot.id;
      snapshotRequests = [...github.requests];
    } else assert.equal(snapshot.id, snapshotId, "reuse the persisted snapshot rather than fetching a new one");
    switch (turn++) {
      case 0:
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta: { role: "assistant", content: "Inspecting" }, finish_reason: null }] })}\n\n`);
        started.resolve();
        break;
      case 1:
        assert.deepEqual(github.requests.slice(snapshotRequests.length), [
          "/github/repos/acme/demo/pulls/7", // Merged skip.
          "/github/repos/acme/demo/pulls/7", // Resume status check.
        ], "only live merge status must be fetched before resuming saved evidence");
        tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
        break;
      case 2:
        tool(response, "report_review_assessment", assessments());
        break;
      default: assert.fail("Unexpected model turn");
    }
  }, { entrypoint: resolve("audit.ts"), github: github.handle });
  const first = f.start([prUrl]);
  first.child.stdin.end();
  await started.promise;
  const otherCwd = join(f.directory, "other-project");
  await mkdir(otherCwd);
  const competing = f.start([prUrl], { cwd: otherCwd });
  competing.child.stdin.end();
  const rejected = await competing.done;
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stderr, /Database is already in use/);
  assert.deepEqual(github.requests, snapshotRequests!, "a competing audit must fail before refetching evidence");
  first.child.kill("SIGKILL");
  await first.done;
  prState.merged = true;
  const skipped = await f.run("", [prUrl, "--force", "--apply", "--approve"]);
  assert.match(skipped, /Skipping .*already been merged/);
  assert.doesNotMatch(skipped, /Resuming saved snapshot|Restarting unfinished audit|Verdict:/);
  assert.equal(turn, 1, "a merged PR must not resume or restart unfinished model work");
  prState.merged = false;
  const output = await f.run("", [prUrl]);
  assert.match(output, /Resuming saved snapshot/);
  assert.match(output, /Verdict: Not all actionable findings are addressed/);
  assert.equal(turn, 3);
  const cached = await f.run("", [prUrl]);
  assert.match(cached, /Reusing saved assessment/);
  assert.equal(turn, 3, "a recovered successful assessment must be published to the cache");
  prState.merged = true;
  const reads = github.requests.length;
  const skippedCached = await f.run("", [prUrl, "--apply", "--approve"]);
  assert.match(skippedCached, /Skipping .*already been merged/);
  assert.doesNotMatch(skippedCached, /Reusing saved assessment|Verdict:/);
  assert.equal(turn, 3, "a merged PR must not reassess a cached audit");
  assert.deepEqual(github.requests.slice(reads), ["/github/repos/acme/demo/pulls/7"]);
});
