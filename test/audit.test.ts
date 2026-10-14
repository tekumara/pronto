import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, noDatabaseMigration, reply, tool, type Request } from "./fixtures.ts";

const prUrl = "https://github.com/acme/demo/pull/7";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const accessId = 3_000_000_101;
const codeUrl = `https://github.com/contributor/fork/blob/${headSha}/src/access.ts#L1-L3`;
const commentUrl = (id: number) => `${prUrl}#discussion_r${id}`;

// GitHub and the model are external HTTP fixtures. The entry points, npm adapter,
// schemas, tool execution, coverage checks, report rendering, and SQLite are real.
function githubEvidence(options: { moved?: boolean; incompleteFiles?: boolean; merged?: boolean; draft?: boolean; state?: "open" | "closed"; labels?: string[];
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
      if (url.searchParams.get("page") === "2") json([{ filename: "src/other.ts", status: "modified",
        ...(options.large && !options.uncountedOther ? { additions: 29_900, deletions: 4_950 } : {}) }]);
      else json([{ filename: "src/access.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new",
        ...(options.large ? { additions: 100, deletions: 50 } : {}) }],
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
  return { databaseMigration: noDatabaseMigration, assessments: [
    { commentKey: `inline:${accessId}`, findings: [{ summary: "Access check", status: "outstanding", awaiting: "human", reason: "The code returns true without checking access.", evidence: [codeUrl] }] },
    { commentKey: "inline:102", findings: [{ summary: "Null check", status: "addressed", reason: "The guard handles a missing user.", evidence: [codeUrl, commentUrl(103)] }] },
    { commentKey: "comment:201", findings: [{ summary: "Policy", status: "uncertain", awaiting: "human", reason: "The policy is not specified.", evidence: [commentUrl(201)] }] },
    { commentKey: "comment:202", findings: [{ summary: "Deployment", status: "not-actionable", reason: "Status update only.", evidence: [commentUrl(202)] }] },
    { commentKey: "review:301", findings: [{ summary: "Approval", status: "not-actionable", reason: "Praise with no requested change.", evidence: [commentUrl(301)] }] },
    { commentKey: "review:302", findings: [{ summary: "Summary", status: "not-actionable", reason: `Duplicates inline:${accessId}.`, evidence: [commentUrl(accessId)] }] },
  ] };
}

for (const { name, entrypoint, input, args, draft = false } of [
  { name: "CLI", entrypoint: resolve("audit.ts"), input: "", args: [prUrl, "--force", "--apply", "--approve"] },
  { name: "chat", entrypoint: resolve("agent.ts"), input: `/audit --force --apply --approve ${prUrl}\n/quit\n`, args: [] },
  { name: "CLI default", entrypoint: resolve("audit.ts"), input: "", draft: true,
    args: [prUrl, "--force", "--apply", "--approve", "--exclude", "generated"] },
  { name: "CLI --skip-drafts", entrypoint: resolve("audit.ts"), input: "", draft: true,
    args: [prUrl, "--skip-drafts", "--force", "--apply", "--approve"] },
  { name: "CLI --skip-drafts=true", entrypoint: resolve("audit.ts"), input: "", draft: true,
    args: [prUrl, "--force", "--apply", "--approve", "--skip-drafts=true"] },
  { name: "chat default", entrypoint: resolve("agent.ts"), draft: true, args: [],
    input: `/audit --force --apply --approve ${prUrl}\n/quit\n` },
]) {
  test(`${name} skips ${draft ? "a draft" : "an already merged"} PR successfully, even with --force --apply --approve`, { timeout: 20000 }, async (t) => {
    let reads = 0;
    const f = await fixture(t, () => assert.fail("Skipped PRs must not reach the model"), {
      entrypoint,
      github: (request, response) => {
        reads++;
        assert.equal(request.method, "GET", "Skipped PRs must not mutate GitHub");
        assert.equal(request.url, "/github/repos/acme/demo/pulls/7", "Skipped PRs need no review or code evidence");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          merged: !draft, draft, state: draft ? "open" : "closed", title: "Skipped PR", body: "", changed_files: 0,
          additions: 20_000, deletions: 0,
          head: { sha: headSha, repo: null }, base: { sha: baseSha, repo: { full_name: "acme/demo" } },
        }));
      },
    });
    const output = await f.run(input, args);
    assert.ok(output.includes(`[audit] Skipping ${prUrl}: ${draft ? "PR is a draft. Use --skip-drafts=false to audit anyway." : "PR has already been merged."}`));
    assert.doesNotMatch(output, /Verdict:|Resuming saved snapshot|Reusing saved assessment/);
    assert.equal(reads, 1);
  });
}

for (const { name, entrypoint, input, args, label } of [
  { name: "CLI single label", entrypoint: resolve("audit.ts"), input: "", label: "do not audit",
    args: ["--skip", "do not audit", prUrl, "local/test", "--force", "--apply", "--approve"] },
  { name: "CLI multiple labels", entrypoint: resolve("audit.ts"), input: "", label: "Skip-Audit",
    args: ["--skip", "unmatched", prUrl, "--skip=skip-audit", "--skip", "skip-audit", "--force", "--apply", "--approve"] },
  { name: "chat multiple labels", entrypoint: resolve("agent.ts"), label: "Skip-Audit", args: [],
    input: `/audit --skip unmatched ${prUrl} --skip=skip-audit --force --apply --approve\n/quit\n` },
]) {
  test(`${name} skips a matching PR without fetching evidence or writing to GitHub`, { timeout: 20000 }, async (t) => {
    let reads = 0;
    const f = await fixture(t, () => assert.fail("Skipped PRs must not reach the model"), {
      entrypoint,
      github: (request, response) => {
        reads++;
        assert.equal(request.method, "GET", "Skipped PRs must not mutate GitHub");
        assert.equal(request.url, "/github/repos/acme/demo/pulls/7", "Skipped PRs need no review or code evidence");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          merged: false, labels: [{ name: "unrelated" }, { name: label }],
          head: { sha: headSha, repo: null }, base: { sha: baseSha, repo: null },
        }));
      },
    });
    const output = await f.run(input, args);
    assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR has matching skip label: "${label}".`));
    assert.doesNotMatch(output, /Verdict:|Resuming saved snapshot|Reusing saved assessment/);
    assert.equal(reads, 1);
  });
}

for (const { name, entrypoint, input, args } of [
  { name: "CLI", entrypoint: resolve("audit.ts"), input: "", args: [prUrl, "--force", "--apply", "--approve"] },
  { name: "chat", entrypoint: resolve("agent.ts"), input: `/audit --force --apply --approve ${prUrl}\n/quit\n`, args: [] },
]) {
  test(`${name} skips a PR changing more than 10000 lines without fetching evidence or writing to GitHub`, { timeout: 20000 }, async (t) => {
    let reads = 0;
    const f = await fixture(t, () => assert.fail("Oversized PRs must not reach the model"), {
      entrypoint,
      github: (request, response) => {
        reads++;
        assert.equal(request.method, "GET", "Oversized PRs must not mutate GitHub");
        assert.equal(request.url, "/github/repos/acme/demo/pulls/7", "Oversized PRs need no review or code evidence");
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          merged: false, additions: 6_000, deletions: 4_001, changed_files: 40,
          head: { sha: headSha, repo: null }, base: { sha: baseSha, repo: null },
        }));
      },
    });
    const output = await f.run(input, args);
    assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR changes 10001 lines, more than the 10000 line limit.`));
    assert.doesNotMatch(output, /Verdict:|Resuming saved snapshot|Reusing saved assessment/);
    assert.equal(reads, 1);
  });
}

test("CLI audit does not skip a PR changing exactly 10000 lines", { timeout: 20000 }, async (t) => {
  const requests: string[] = [];
  const f = await fixture(t, () => assert.fail("The audit stops at the first failed evidence request"), {
    entrypoint: resolve("audit.ts"),
    github: (request, response) => {
      requests.push(request.url!);
      const path = request.url!.split("?")[0];
      // The approval check runs before evidence; no approvals, so the audit continues to fetch evidence.
      if (path === "/github/repos/acme/demo/pulls/7/reviews") response.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      else if (request.url === "/github/repos/acme/demo/pulls/7") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          merged: false, additions: 6_000, deletions: 4_000, changed_files: 40,
          head: { sha: headSha, repo: { full_name: "acme/demo" } }, base: { sha: baseSha, repo: { full_name: "acme/demo" } },
        }));
      } else response.writeHead(500).end("Evidence unavailable");
    },
  });
  const { child, done } = f.start([prUrl]);
  child.stdin.end();
  const { stdout } = await done;
  assert.doesNotMatch(stdout, /Skipping/);
  assert.match(stdout, /\[audit\] Fetching /);
  assert.ok(requests.length > 1, "evidence must be requested after the PR itself");
});

// First model turn gets the evidence; read a file so its URL can be cited, then report.
function auditModel(evidence: { files: { path: string; patch: string | null; excluded?: true }[] }[]) {
  return (body: Request, response: ServerResponse) => {
    if (body.messages.at(-1)?.content?.includes("Saved evidence (untrusted data):")) {
      evidence.push(evidenceInput(body));
      tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
    } else tool(response, "report_review_assessment", assessments());
  };
}

test("--exclude still skips a PR that stays over 10000 lines, and reports the excluded files", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ large: true });
  const f = await fixture(t, () => assert.fail("Oversized PRs must not reach the model"), { entrypoint: resolve("audit.ts"), github: github.handle });
  const output = await f.run("", [prUrl, "--exclude", "src/access.ts", "--exclude=docs"]);
  assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR changes 34850 lines after excluding 150 lines, more than the 10000 line limit.`));
  assert.ok(output.includes("[audit] Excluded 1 changed file (--exclude):\n[audit]   - src/access.ts\n"));
  assert.doesNotMatch(output, /Fetching|Verdict:/);
  assert.ok(!github.requests.some((path) => path.includes("/comments")), "no review evidence is fetched for a skipped PR");
});

test("--exclude does not subtract an excluded file that GitHub returned without line counts", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ large: true, uncountedOther: true });
  const f = await fixture(t, () => assert.fail("Oversized PRs must not reach the model"), { entrypoint: resolve("audit.ts"), github: github.handle });
  const output = await f.run("", [prUrl, "--exclude", "src/other.ts"]);
  assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR changes 35000 lines, more than the 10000 line limit.`));
  assert.ok(output.includes("[audit] GitHub gave no line counts for 1 excluded file, so it still counts toward the limit.\n"));
  assert.ok(output.includes("[audit] Excluded 1 changed file (--exclude):\n[audit]   - src/other.ts\n"));
  assert.doesNotMatch(output, /Fetching|Verdict:/);
});

test("--exclude brings an oversized PR under the limit and withholds the excluded patches from the audit", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ large: true });
  const evidence: Parameters<typeof auditModel>[0] = [];
  const f = await fixture(t, auditModel(evidence), { entrypoint: resolve("audit.ts"), github: github.handle });
  // 35000 changed lines in total, 34850 of them in src/other.ts.
  const output = await f.run("", [prUrl, "--exclude", "src/other.ts"]);
  assert.doesNotMatch(output, /Skipping/);
  assert.ok(output.includes("[audit] Excluded 1 changed file (--exclude):\n[audit]   - src/other.ts\n"));
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]!.files.map(({ path, patch, excluded }) => ({ path, patch: patch === null ? null : "patch", excluded })),
    [{ path: "src/access.ts", patch: "patch", excluded: undefined }, { path: "src/other.ts", patch: null, excluded: true }]);
  const comment = output.slice(output.indexOf("Verdict comment preview"));
  assert.match(comment, /- excluded from review \(patches withheld\): 1 of 2 changed files\n {2}- `src\/other\.ts`/);
});

test("--exclude reports patterns that match nothing, and exclusions change cache identity", { timeout: 30000 }, async (t) => {
  const github = githubEvidence();
  const evidence: Parameters<typeof auditModel>[0] = [];
  const f = await fixture(t, auditModel(evidence), { entrypoint: resolve("audit.ts"), github: github.handle });
  const unmatched = await f.run("", [prUrl, "--exclude", "nothing/**"]);
  assert.ok(unmatched.includes("[audit] --exclude matched no changed files."));
  assert.doesNotMatch(unmatched, /excluded from review/);
  assert.ok(evidence[0]!.files.every((file) => !("excluded" in file)), "evidence without exclusions keeps its existing shape");

  const excluded = await f.run("", [prUrl, "--exclude", "src/other.ts"]);
  assert.match(excluded, /file "src\/other\.ts" changed \(excluded\)/);
  assert.ok(excluded.includes("[audit] Excluded 1 changed file (--exclude):\n[audit]   - src/other.ts\n"));
  assert.equal(evidence.length, 2);

  const reused = await f.run("", [prUrl, "--exclude=src/other.ts"]);
  assert.match(reused, /Reusing saved assessment/);
  assert.ok(reused.includes("[audit] Excluded 1 changed file (--exclude):\n[audit]   - src/other.ts\n"));
  assert.equal(evidence.length, 2, "unchanged exclusions reuse the saved assessment");

  const included = await f.run("", [prUrl]);
  assert.match(included, /file "src\/other\.ts" changed \(excluded\)/);
  assert.doesNotMatch(included, /Excluded \d+ changed file/);
  assert.equal(evidence.length, 3);
});

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
        tool(response, "report_review_assessment", { ...assessments(), assessments: assessments().assessments.slice(0, -1) });
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
  assert.match(policy, /Accept an explicit author decision not to make the requested change because of effort,/);
  assert.match(policy, /A concise cost-benefit judgment can suffice when the original\s+finding supplies the context/);
  assert.match(policy, /Risk acceptance is not risk elimination\./);
  assert.match(policy, /A bot's "blocking" label does not establish a mandatory requirement\./);
  assert.match(policy, /Explicit project requirements and unresolved human demands for a fix remain blocking\./);
  assert.match(policy, /including later messages that soften an earlier blocking label or leave\s+the decision to the author\./);
  assert.match(policy, /A trade-off decision does not override an explicit mandatory requirement or excuse\s+a factual claim contradicted by evidence\./);
  assert.match(policy, /Do not treat the remaining bug itself as a factual\s+contradiction of an author's cost-benefit judgment\./);
  assert.match(policy, /Accept an explicit author reply that the finding will be addressed in future work\./);
  assert.match(policy, /No separate rationale, mitigation, deadline or follow-up link is required\./);
  assert.match(policy, /An acknowledged bug or documentation inconsistency remaining at the pinned head\s+does not contradict a future-work deferral\./);
  assert.doesNotMatch(policy, /unexplained promise(?:s)? to fix later/);
  assert.match(output, /\[audit\] PR title: Access checks/);
  assert.match(output, /Verdict: Not all actionable findings are addressed/);
  assert.match(output, /1 addressed · 1 outstanding · 1 uncertain · 3 not-actionable/);
  assert.match(output, /GitHub: 1\/2 inline threads resolved \(0 unknown\)/);
  assert.ok(output.includes(`[1] outstanding: Access check\n    Source: inline:${accessId} · human\n    ${commentUrl(accessId)}\n    GitHub thread: resolved`));
  assert.ok(output.includes(`[2] addressed: Null check\n    Source: inline:102 · human\n    ${commentUrl(102)}\n    GitHub thread: open, outdated`));
  assert.equal(turn, 5);
  await assert.rejects(readFile(join(f.cwd, "audit-should-not-write")), { code: "ENOENT" });
  const files = await readdir(join(f.stateDir, "repos", "github.com"));
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

test("restart checks live merge status, draft status and skip labels but preserves saved evidence and cache", { timeout: 30000 }, async (t) => {
  const prState = { merged: false, draft: false, labels: [] as string[] };
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
        assert.deepEqual(github.requests.slice(snapshotRequests.length).sort(), [
          "/github/repos/acme/demo/pulls/7", // Label skip.
          "/github/repos/acme/demo/pulls/7", // Merged skip.
          "/github/repos/acme/demo/pulls/7", // Draft skip.
          "/github/repos/acme/demo/pulls/7", // Resume status check.
          "/github/repos/acme/demo/pulls/7/reviews?per_page=100", // Approval check, which runs only for the resume.
        ], "only live PR metadata and the approval check must be fetched before resuming saved evidence");
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
  prState.labels = ["skip-audit"];
  const skippedLabel = await f.run("", [prUrl, "--skip", "skip-audit", "--force", "--apply", "--approve"]);
  assert.match(skippedLabel, /Skipping .*matching skip label: "skip-audit"/);
  assert.doesNotMatch(skippedLabel, /Resuming saved snapshot|Restarting unfinished audit|Verdict:/);
  assert.equal(turn, 1, "a matching label must not resume or restart unfinished model work");
  prState.labels = [];
  prState.merged = true;
  const skipped = await f.run("", [prUrl, "--force", "--apply", "--approve"]);
  assert.match(skipped, /Skipping .*already been merged/);
  assert.doesNotMatch(skipped, /Resuming saved snapshot|Restarting unfinished audit|Verdict:/);
  assert.equal(turn, 1, "a merged PR must not resume or restart unfinished model work");
  prState.merged = false;
  prState.draft = true;
  const skippedDraft = await f.run("", [prUrl, "--force", "--apply", "--approve"]);
  assert.match(skippedDraft, /Skipping .*PR is a draft.*--skip-drafts=false/);
  assert.doesNotMatch(skippedDraft, /Resuming saved snapshot|Restarting unfinished audit|Verdict:/);
  assert.equal(turn, 1, "a draft PR must not resume or restart unfinished model work");
  const output = await f.run("", [prUrl, "--skip-drafts=false"]);
  assert.match(output, /Resuming saved snapshot/);
  assert.match(output, /Verdict: Not all actionable findings are addressed/);
  assert.equal(turn, 3);
  const draftReads = github.requests.length;
  const skippedDraftCached = await f.run("", [prUrl, "--apply", "--approve"]);
  assert.match(skippedDraftCached, /Skipping .*PR is a draft/);
  assert.doesNotMatch(skippedDraftCached, /Reusing saved assessment|Verdict:/);
  assert.deepEqual(github.requests.slice(draftReads), ["/github/repos/acme/demo/pulls/7"]);
  assert.equal(turn, 3, "the draft opt-out must not persist across invocations");
  const cached = await f.run("", [prUrl, "--skip-drafts=false"]);
  assert.match(cached, /Reusing saved assessment/);
  assert.equal(turn, 3, "a recovered successful assessment must be published to the cache");
  prState.draft = false;
  prState.labels = ["skip-audit"];
  const labelReads = github.requests.length;
  const skippedLabelCached = await f.run("", [prUrl, "--skip=skip-audit", "--apply", "--approve"]);
  assert.match(skippedLabelCached, /Skipping .*matching skip label/);
  assert.doesNotMatch(skippedLabelCached, /Reusing saved assessment|Verdict:/);
  assert.deepEqual(github.requests.slice(labelReads), ["/github/repos/acme/demo/pulls/7"]);
  const withoutSkip = await f.run("", [prUrl]);
  assert.match(withoutSkip, /Reusing saved assessment/);
  assert.equal(turn, 3, "skipping must preserve the cache, and skip flags must not persist");
  prState.merged = true;
  const reads = github.requests.length;
  const skippedCached = await f.run("", [prUrl, "--apply", "--approve"]);
  assert.match(skippedCached, /Skipping .*already been merged/);
  assert.doesNotMatch(skippedCached, /Reusing saved assessment|Verdict:/);
  assert.equal(turn, 3, "a merged PR must not reassess a cached audit");
  assert.deepEqual(github.requests.slice(reads), ["/github/repos/acme/demo/pulls/7"]);
});
