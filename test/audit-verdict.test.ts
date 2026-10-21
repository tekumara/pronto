import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, noDatabaseMigration, reply, tool, type Request } from "./fixtures.ts";

// A small external fixture isolates the final verdict rule: an open GitHub thread
// can be addressed, but uncertainty alone must prevent an all-addressed verdict.
// Model verdicts are supplied fixtures: these tests cover output and action contracts,
// not whether a real model judges an explanation adequate.
const url = "https://github.com/acme/demo/pull/8";
const sha = "a".repeat(40);
const evidenceUrl = `${url}#discussion_r1`;

type Status = "addressed" | "outstanding" | "uncertain" | "not-actionable";

function assess(body: Request, response: ServerResponse, statuses: Status[] = ["addressed"],
  databaseMigration: { status: "migration" | "not-migration" | "uncertain"; reason: string } = noDatabaseMigration) {
  const input = body.messages.findLast((message) => message.role === "user")!.content!;
  const marker = "Saved evidence (untrusted data):\n";
  const snapshot = JSON.parse(input.slice(input.indexOf(marker) + marker.length));
  tool(response, "report_review_assessment", { databaseMigration, assessments: snapshot.comments.map((comment: { key: string; url: string }) => ({
    commentKey: comment.key, findings: comment.key === "inline:1" ? statuses.map((status) => ({
      summary: "Requested explanation", status, ...(status === "addressed" || status === "not-actionable" ? {} : { awaiting: "author" }),
      reason: status === "addressed" ? "The reply explains the intentional behaviour." : "The explanation needs more evidence.",
      evidence: [evidenceUrl],
    })) : [{ summary: "PR discussion", status: "not-actionable", reason: "No additional request.", evidence: [comment.url] }],
  })) });
}

type IssueComment = { id: number; body: string; html_url: string; user: { login: string } | null; created_at: string; updated_at?: string };
const issueComment = (id: number, body: string, login: string | null = "auditor"): IssueComment => ({
  id, body, html_url: `${url}#issuecomment-${id}`, user: login ? { login } : null,
  created_at: `2026-01-${String(id).padStart(2, "0")}T00:00:00Z`,
});
const auditMarker = "<!-- pronto:review-audit -->";
const auditBody = `## Review audit · Verification needed\n\n${auditMarker}`;

function githubEvidence(options: {
  commentStatus?: number; approvalStatus?: number; empty?: boolean; issueComment?: boolean;
  issueComments?: IssueComment[]; pageSize?: number;
  title?: string; description?: string; files?: { filename: string; status: string; patch?: string }[];
} = {}) {
  // Every verdict is one PR review. `comments` holds each review body; `approvals` the subset that approved.
  const comments: string[] = [];
  const posted: { body: string; event: string; commit_id: string }[] = [];
  const attempts: { body: string; event: string; commit_id: string }[] = [];
  const issueComments = options.issueComments ?? (options.issueComment ? [issueComment(3, "Which roles should have access?", "human")] : []);
  const approvals: { body: string; event: string; commit_id: string }[] = [];
  const reviews: (IssueComment & { state: string; commit_id: string })[] = [];
  const state = { headSha: sha, baseSha: sha, draft: false, merged: false, login: "auditor", loseResponse: false, holdResponse: false };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url!, "http://fixture");
    const path = requestUrl.pathname;
    const json = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    if (request.method === "POST" && path === "/github/repos/acme/demo/pulls/8/reviews") {
      assert.equal(request.headers["content-type"], "application/json");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(typeof body.body, "string");
      assert.ok(["APPROVE", "COMMENT"].includes(body.event), "verdicts are posted as one APPROVE or COMMENT review");
      attempts.push(body);
      const approving = body.event === "APPROVE";
      response.statusCode = (approving ? options.approvalStatus : options.commentStatus) ?? 200;
      if (response.statusCode < 300) {
        const id = 100 + reviews.length;
        comments.push(body.body);
        posted.push(body);
        if (approving) approvals.push(body);
        reviews.push({ ...issueComment(id, body.body, state.login), html_url: `${url}#pullrequestreview-${id}`,
          state: approving ? "APPROVED" : "COMMENTED", commit_id: body.commit_id });
      }
      if (state.holdResponse) return; // Accepted remotely; the client cannot save an acknowledgement.
      if (state.loseResponse) response.statusCode = 502; // GitHub accepted the review, but its response was lost.
      json({ state: approving ? "APPROVED" : "COMMENTED", commit_id: body.commit_id, html_url: `${url}#pullrequestreview-${100 + reviews.length - 1}` });
      return;
    }
    assert.equal(request.method, path === "/github/graphql" ? "POST" : "GET");
    if (path === "/github/user") {
      json({ login: state.login });
    } else if (path === "/github/graphql") {
      json({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: options.empty ? [] : [{ isResolved: false, isOutdated: false, comments: { nodes: [{ fullDatabaseId: "1" }] } }],
      } } } } });
    } else if (path.endsWith("/pulls/8")) {
      json({ title: options.title ?? "Explain behaviour", body: options.description ?? "", changed_files: options.files?.length ?? 0,
        draft: state.draft, merged: state.merged,
        head: { sha: state.headSha, repo: { full_name: "acme/demo" } }, base: { sha: state.baseSha, repo: { full_name: "acme/demo" } } });
    } else if (path.endsWith("/pulls/8/comments")) {
      json(options.empty ? [] : [{ id: 1, body: "Why is this intentional?", html_url: evidenceUrl, user: { login: "human" }, created_at: "2026-01-01" },
        { id: 2, in_reply_to_id: 1, body: "This preserves the documented compatibility contract.", html_url: `${url}#discussion_r2`, user: { login: "author" }, created_at: "2026-01-02" }]);
    } else if (path.endsWith("/issues/8/comments")) {
      const page = Number(requestUrl.searchParams.get("page") ?? 1);
      const size = options.pageSize ?? 100;
      if (page * size < issueComments.length) response.setHeader("Link",
        `<http://${request.headers.host}${path}?page=${page + 1}>; rel="next"`);
      json(issueComments.slice((page - 1) * size, page * size));
    } else if (path.endsWith("/pulls/8/reviews")) {
      const page = Number(requestUrl.searchParams.get("page") ?? 1);
      const size = options.pageSize ?? 100;
      if (page * size < reviews.length) response.setHeader("Link",
        `<http://${request.headers.host}${path}?page=${page + 1}>; rel="next"`);
      json(reviews.slice((page - 1) * size, page * size));
    } else {
      assert.ok(path.endsWith("/pulls/8/files"));
      json(options.files ?? []);
    }
  };
  return { handler, comments, posted, attempts, issueComments, reviews, approvals, state };
}

async function recoverPublisher(f: Awaited<ReturnType<typeof fixture>>, completed = /Saved verdict published:/) {
  // No --apply, --approve or PR target: recovery must use only the saved publication intent.
  const run = f.start(["serve", "--port", "0"], { env: { PRONTO_WEBHOOK_SECRET: "publication-test-secret" } });
  let output = "";
  const published = Promise.withResolvers<void>();
  run.child.stdout.on("data", (chunk) => {
    output += chunk;
    if (completed.test(output)) published.resolve();
  });
  const timer = new AbortController();
  try {
    await Promise.race([published.promise,
      run.done.then((result) => { throw new Error(`Server exited before recovery: ${result.stderr}\n${output}`); }),
      delay(5000, undefined, { signal: timer.signal }).then(() => { throw new Error(`Publication was not recovered:\n${output}`); }),
    ]);
    return output;
  } finally {
    timer.abort();
    run.child.kill("SIGTERM");
    await run.done;
  }
}

for (const cached of [false, true]) {
  test(`${cached ? "cached" : "fresh"} assessment completion survives a crash before POST with its explicit approval choices`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    let interrupting = false;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, ["uncertain"], { status: "migration", reason: "This changes database data." });
    }, { entrypoint: resolve("audit.ts"), github: async (request, response) => {
      // The durable publisher may start before report printing. Hold preflight so the
      // kill point is unambiguously before POST, not an ambiguous accepted response.
      if (interrupting && request.url === "/github/user") return;
      await github.handler(request, response);
    } });
    if (cached) await f.run("", [url]);
    const preload = join(f.directory, "crash-before-publication.cjs");
    await writeFile(preload, `const write = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).includes(${JSON.stringify(cached ? "Reusing saved assessment" : "Verdict:")})) process.kill(process.pid, "SIGKILL");
  return write.call(this, chunk, ...args);
};`);
    interrupting = true;
    const killed = f.start([url, "--apply", "--approve", "--allow-uncertain", "--approve-migrations"], { nodeArgs: ["--require", preload] });
    killed.child.stdin.end();
    assert.equal((await killed.done).signal, "SIGKILL");
    assert.equal(calls, 1);
    assert.equal(github.attempts.length, 0);
    interrupting = false;
    await recoverPublisher(f);
    assert.equal(calls, 1, "publication recovery must not run the model, even for a cached handoff");
    assert.deepEqual(github.posted.map(({ event, commit_id }) => [event, commit_id]), [["APPROVE", sha]],
      "recovery must retain the uncertain/migration overrides, not the new server's defaults");
    assert.match(github.comments[0], /<!-- pronto:publication:[a-f0-9]{64} -->\n<!-- pronto:review-audit -->$/);
    const repeated = await f.run("", [url, "--skip-approved=false", "--apply", "--approve", "--allow-uncertain", "--approve-migrations"]);
    assert.match(repeated, /Comment skipped: matching verdict review recorded locally/);
    assert.equal(github.attempts.length, 1);
  });
}

for (const { revision, cached, status, event, crash } of [
  { revision: "headSha", cached: false, status: "uncertain", event: "APPROVE", crash: true },
  { revision: "baseSha", cached: true, status: "outstanding", event: "COMMENT", crash: false },
] as const) {
  test(`recovering a stale ${cached ? "cached" : "fresh"} approval reassesses the changed ${revision} with saved publication choices${crash ? " across another crash" : ""}`, { timeout: 20000 }, async (t) => {
    const publication = { approvalStatus: 403 as number | undefined };
    const github = githubEvidence(publication);
    const snapshots: { headSha: string; baseSha: string }[] = [];
    const f = await fixture(t, (body, response) => {
      const input = body.messages.findLast((message) => message.role === "user")!.content!;
      const marker = "Saved evidence (untrusted data):\n";
      snapshots.push(JSON.parse(input.slice(input.indexOf(marker) + marker.length)));
      assess(body, response, [snapshots.length === 1 ? "uncertain" : status], {
        status: "migration", reason: "This changes database data.",
      });
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    if (cached) await f.run("", [url]);
    const flags = ["--apply", "--approve", "--allow-uncertain", "--approve-migrations"];
    const failed = f.start([url, ...flags]);
    failed.child.stdin.end();
    assert.equal((await failed.done).code, 1);
    assert.equal(snapshots.length, 1);
    assert.equal(github.posted.length, 0);

    github.state[revision] = "b".repeat(40);
    publication.approvalStatus = undefined;
    if (crash) {
      const preload = join(f.directory, "crash-before-reassessment.cjs");
      await writeFile(preload, `const write = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).includes("reassessing before publishing")) process.kill(process.pid, "SIGKILL");
  return write.call(this, chunk, ...args);
};`);
      const killed = f.start(["serve", "--port", "0"], {
        nodeArgs: ["--require", preload], env: { PRONTO_WEBHOOK_SECRET: "[REDACTED:Generic Password Field]" },
      });
      assert.equal((await killed.done).signal, "SIGKILL");
      assert.equal(snapshots.length, 1, "the crash must be before fresh evidence is admitted");
      assert.equal(github.attempts.length, 1);
      github.state.login = "another-auditor";
      const blocked = f.start([url]);
      blocked.child.stdin.end();
      const result = await blocked.done;
      assert.equal(result.code, 1, "reassessment must retain the publication's original account restriction");
      assert.match(result.stderr, /Pending verdict belongs to auditor/);
      assert.equal(snapshots.length, 1);
      assert.equal(github.attempts.length, 1);
      github.state.login = "auditor";
    }
    const output = await recoverPublisher(f, /INFO\s+acme\/demo#8\s+Review: /);
    assert.match(output, /[Rr]eassess/);
    assert.equal(snapshots.length, 2, "stale publication recovery must run a fresh assessment, not just repin its review");
    assert.equal(snapshots[1][revision], github.state[revision], "the model must receive current evidence");
    assert.deepEqual(github.posted.map(({ event, commit_id }) => [event, commit_id]), [[event, github.state.headSha]],
      "the new verdict must govern publication and retain the saved uncertainty/migration overrides");
    assert.equal(github.attempts.length, 2, "the stale saved approval must never reach POST");

    const repeated = await f.run("", [url, "--skip-approved=false", ...flags]);
    assert.match(repeated, /Reusing saved assessment/);
    assert.match(repeated, /Comment skipped: matching verdict review recorded locally/);
    assert.doesNotMatch(repeated, /Pending publication|[Rr]eassess/);
    assert.equal(snapshots.length, 2, "the stale publication must be retired, not recovered again");
    assert.equal(github.attempts.length, 2);
  });
}

test("skip reviews deduplicate by head and reason across CLI and chat, and stay out of later audit evidence", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  github.state.draft = true;
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    const input = body.messages.findLast((message) => message.role === "user")!.content!;
    assert.doesNotMatch(input, /Review audit · Skipped/);
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });

  await f.run("", [url, "--apply", "--approve"]);
  assert.equal(github.posted.length, 1);
  const repeated = await f.run(`/audit ${url} --force --apply\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
  assert.match(repeated, /Skip comment skipped: matching skip review recorded locally/);
  const preview = await f.run("", [url]);
  assert.match(preview, /Skip comment would be skipped: matching skip review recorded locally/);
  assert.equal(github.posted.length, 1, "changing action flags must not duplicate a skip review");

  github.state.headSha = "c".repeat(40);
  await f.run("", [url, "--apply"]);
  assert.equal(github.posted.length, 2, "a new head needs its own skip explanation");
  assert.equal(github.posted[1]!.commit_id, github.state.headSha);
  github.state.merged = true;
  await f.run("", [url, "--apply"]);
  assert.equal(github.posted.length, 3, "a different reason at the same head needs its own explanation");
  assert.match(github.posted[2]!.body, /PR has already been merged/);
  assert.ok(github.posted.every(({ event }) => event === "COMMENT"));
  assert.equal(calls, 0);

  github.state.draft = github.state.merged = false;
  await f.run("", [url]);
  assert.equal(calls, 1, "skipping must not create an assessment or poison a later audit");
});

test("a skip publication survives a crash without an assessment and recovers without --apply", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  github.state.draft = true;
  const publishing = Promise.withResolvers<void>();
  let interrupting = true;
  const f = await fixture(t, () => assert.fail("Skip publication must not run the model"), {
    entrypoint: resolve("audit.ts"),
    github: async (request, response) => {
      if (interrupting && request.url === "/github/user") { publishing.resolve(); return; }
      await github.handler(request, response);
    },
  });
  const killed = f.start([url, "--apply", "--approve"]);
  killed.child.stdin.end();
  await publishing.promise;
  killed.child.kill("SIGKILL");
  assert.equal((await killed.done).signal, "SIGKILL");
  assert.equal(github.attempts.length, 0);
  interrupting = false;
  await recoverPublisher(f);
  assert.equal(github.posted.length, 1);
  assert.equal(github.posted[0]!.event, "COMMENT");
  assert.equal(github.posted[0]!.commit_id, sha);
  assert.match(github.posted[0]!.body, /PR is a draft/);
  await f.run("", [url, "--apply"]);
  assert.equal(github.attempts.length, 1, "recovery must save the same duplicate-prevention receipt");
});

for (const status of ["addressed", "uncertain"] as const) {
  test(`${status} verdict is read-only by default and gates opt-in approval independently of an open GitHub thread`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, [status]);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const verdict = status === "addressed" ? /Verdict: All actionable findings appear addressed/ : /Verdict: Not all actionable findings are addressed/;
    const commentHeadline = status === "addressed" ? /## Review audit · All actionable findings addressed/ : /## Review audit · Verification needed/;
    const output = await f.run("", [url]);
    assert.match(output, verdict);
    assert.match(output, /GitHub: 0\/1 inline threads resolved/);
    const preview = output.split("[audit:dry-run] Verdict comment preview:\n\n");
    assert.equal(preview.length, 2);
    for (const report of preview) {
      assert.match(report, /Addressed includes code fixes and supported explanations or scope decisions, not necessarily the requested code change\./);
    }
    assert.match(preview[0], /^Findings: 1 across 1 source$/m);
    if (status === "addressed") {
      assert.match(preview[0], /^\[1\] addressed: Requested explanation$/m);
      assert.match(preview[0], /^    The reply explains the intentional behaviour\.$/m);
    }
    assert.equal(github.comments.length, 0, "dry-runs must not post comments");
    assert.equal(github.approvals.length, 0, "audits must not approve without --approve");

    if (status === "addressed") {
      const firstPost = await f.run("", [url, "--apply"]);
      assert.match(firstPost, /Reusing saved assessment/);
      assert.equal(calls, 1, "output flags must not bypass the assessment cache");
      assert.equal(github.comments.length, 1);
      assert.deepEqual([github.posted[0].event, github.posted[0].commit_id], ["COMMENT", sha], "without --approve the verdict is a comment review pinned to the audited head");
      assert.equal(github.approvals.length, 0, "posting a comment must not imply approval");
    }
    const published = structuredClone(github.reviews);
    const posted = status === "addressed"
      ? await f.run("", [url, "local/test", "--approve", "--apply"])
      : await f.run(`/audit --approve --force --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
    assert.match(posted, verdict);
    assert.match(posted, /Verdict comment posted/);
    assert.equal(github.comments.length, status === "addressed" ? 2 : 1, "selecting approval can publish a different review type from the same assessment");
    const latestComment = github.comments.at(-1)!;
    assert.match(latestComment, commentHeadline);
    assert.ok(latestComment.includes(`audited head: \`${sha}\``));
    assert.match(latestComment, status === "addressed" ? /1 addressed · 0 outstanding · 0 uncertain/ : /0 addressed · 0 outstanding · 1 uncertain/);
    assert.match(latestComment, /Addressed includes code fixes and supported explanations or scope decisions, not necessarily the requested code change\./);
    if (status === "addressed") {
      assert.deepEqual(github.reviews.slice(0, published.length), published, "a new review must leave the earlier verdict review untouched");
      assert.equal(github.reviews.length, published.length + 1);
      assert.match(posted, /Verdict comment posted to the PR with the approval review/);
      assert.match(posted, /Reusing saved assessment/);
      assert.equal(calls, 1, "publishing an audit review must not invalidate the cache");
      assert.equal(github.approvals.length, 1, "the verdict and the approval are one review");
      assert.equal(github.approvals[0].event, "APPROVE");
      assert.equal(github.approvals[0].commit_id, sha);
      assert.equal(github.approvals[0].body, latestComment, "the approval review carries the verdict");
      assert.doesNotMatch(latestComment, /Reasoning and evidence|The reply explains the intentional behaviour/);
      assert.match(posted, /PR approved/);
      const rechecked = await f.run("", [url, "--skip-approved=false", "--approve", "--apply"]);
      assert.match(rechecked, /Reusing saved assessment/);
      assert.match(rechecked, /Comment skipped: matching verdict review recorded locally/);
      assert.match(rechecked, /Approval previously submitted/);
      assert.doesNotMatch(rechecked, /Verdict comment posted|PR approved/);
      assert.equal(github.approvals.length, 1, "repeating approval must not submit another review");
      assert.equal(calls, 1, "an approval review carrying the verdict must not invalidate the cache either");
    } else {
      assert.doesNotMatch(posted, /Reusing saved assessment/);
      assert.equal(calls, 2, "--approve and --force can be combined in chat");
      assert.equal(github.approvals.length, 0);
      assert.equal(github.posted.at(-1)!.event, "COMMENT", "a skipped approval still posts the verdict as a comment review");
      assert.match(posted, /Approval skipped/);
    }
  });
}

test("--apply skips duplicate verdict reviews using local history across directories, CLI, chat and forced refreshes", { timeout: 20000 }, async (t) => {
  // Audit comments left by earlier versions are neither edited nor assessed as evidence.
  const seeds = [
    { ...issueComment(10, auditBody), updated_at: "2026-06-01T00:00:00Z" },
    issueComment(11, auditBody),
    issueComment(12, `PR review audit · ${url}\n\nHead: ${sha}\n\nAn unmarked report from the same account.`),
    issueComment(13, `Someone else's report\n\n${auditMarker}`, "another-auditor"),
    issueComment(14, auditMarker, null),
  ];
  const original = structuredClone(seeds);
  const github = githubEvidence({ issueComments: seeds, pageSize: 1 });
  let status: Status = "uncertain";
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    assess(body, response, [status]);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });

  const preview = await f.run("", [url]);
  assert.match(preview, /Comment would be posted/);
  assert.equal(github.comments.length, 0);
  assert.deepEqual(github.issueComments, original, "dry-run must not change existing comments");

  const first = await f.run("", ["--apply", url]);
  assert.match(first, /Reusing saved assessment/);
  assert.ok(first.includes(`[audit] Verdict comment posted to the PR: ${url}#pullrequestreview-100`));
  assert.equal(github.comments.length, 1, "an assessment first run as a preview can still be published");

  // A later GitHub edit must not change the local submission receipt.
  github.reviews[0].body = `Edited outside Pronto\n\n${auditMarker}`;
  const published = structuredClone(github.reviews);
  const cachedPreview = await f.run("", [url]);
  assert.match(cachedPreview, /Comment would be skipped: matching verdict review recorded locally/);
  const otherCwd = join(f.directory, "other-project");
  await mkdir(otherCwd);
  const cached = await f.run("", ["--apply", url, "local/test"], { cwd: otherCwd });
  assert.match(cached, /Reusing saved assessment/);
  assert.ok(cached.includes(`Comment skipped: matching verdict review recorded locally: ${url}#pullrequestreview-100`));
  assert.doesNotMatch(cached, /Verdict comment posted/);
  const chat = await f.run(`/audit --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
  assert.match(chat, /Comment skipped: matching verdict review recorded locally/);
  assert.equal(calls, 1, "publishing or skipping output must not invalidate the assessment cache");

  const forced = await f.run("", ["--force", "--apply", url]);
  assert.match(forced, /Comment skipped: matching verdict review recorded locally/);
  assert.equal(calls, 2, "--force refreshes the assessment, not an unchanged verdict review");
  assert.deepEqual(github.reviews, published, "matching reviews must not be posted again or edited");
  assert.equal(github.attempts.length, 1);

  status = "addressed";
  const changed = await f.run(`/audit --force --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
  assert.match(changed, /Verdict comment posted/);
  assert.equal(github.comments.length, 2, "a changed verdict still posts a new review");
  assert.match(github.comments[1], /## Review audit · All actionable findings addressed/);
  assert.deepEqual(github.reviews.slice(0, published.length), published, "earlier reviews stay as posted");

  github.state.headSha = "b".repeat(40);
  const newHead = await f.run("", ["--apply", url]);
  assert.match(newHead, /Verdict comment posted/);
  assert.equal(github.comments.length, 3, "the same verdict for a different head is a new review");
  assert.deepEqual(github.posted.map((review) => [review.event, review.commit_id]),
    [["COMMENT", sha], ["COMMENT", sha], ["COMMENT", github.state.headSha]]);

  github.state.login = "another-auditor";
  const otherAccount = await f.run("", ["--apply", url]);
  assert.match(otherAccount, /Comment skipped: matching verdict review recorded locally/);
  assert.equal(github.comments.length, 3, "local review submission history is shared across GitHub accounts");
  assert.equal(calls, 4, "changing the GitHub account must not require a fresh assessment");
  assert.deepEqual(github.issueComments, original, "earlier audit comments must not change and no issue comment is created");
});

test("local approval history is not reconciled with GitHub dismissals, change requests or deletions", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const args = [url, "--skip-approved=false", "--approve", "--apply"];
  await f.run("", args);
  assert.equal(github.approvals.length, 1);

  github.reviews[0].state = "DISMISSED";
  const dismissed = await f.run("", args);
  assert.match(dismissed, /Approval previously submitted/);
  assert.equal(github.approvals.length, 1, "a remote dismissal does not remove the local receipt");

  github.reviews.push({ ...issueComment(200, auditBody), state: "CHANGES_REQUESTED", commit_id: sha });
  const requested = await f.run("", args);
  assert.match(requested, /Approval previously submitted/);
  assert.equal(github.approvals.length, 1, "local review submission history does not track later GitHub decisions");

  github.reviews.length = 0;
  const deleted = await f.run("", args);
  assert.match(deleted, /Approval previously submitted/);
  assert.equal(github.attempts.length, 1, "a deleted review is still recorded locally");
  assert.equal(calls, 1);
});

test("a fresh local history does not adopt matching reviews from GitHub", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  await f.run("", [url, "--apply"]);
  assert.equal(github.comments.length, 1);

  const fresh = await f.run("", [url, "--apply"], {
    env: { PRONTO_STATE_DIR: join(f.directory, "fresh-state") },
  });
  assert.match(fresh, /Verdict comment posted/);
  assert.equal(github.comments.length, 2, "GitHub reviews alone do not count as local review submission history");
  assert.equal(calls, 2, "a fresh state directory has neither an assessment nor a submission receipt");
});

test("terminal reports number each finding and verdict comments keep open findings visible with collapsed context", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ issueComment: true });
  const issueUrl = `${url}#issuecomment-3`;
  const f = await fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [
      { commentKey: "inline:1", findings: [
        { summary: "Missing access check", status: "outstanding",
          reason: "The current code still grants access without checking roles.\u001b", awaiting: "author",
          nextStep: "Check the user's role before granting access.", evidence: [evidenceUrl, `${url}#discussion_r2`] },
        { summary: "Null guard", status: "addressed", reason: "The null guard is already fixed.", evidence: [evidenceUrl] },
        { summary: "Duplicate request", status: "not-actionable", reason: "This repeats the access check finding.", evidence: [evidenceUrl] },
      ] },
      { commentKey: "comment:3", findings: [
        { summary: "Undefined access policy", status: "uncertain",
          reason: "The discussion does not specify which roles should have access.",
          awaiting: "human", nextStep: "Confirm which roles should have access.", evidence: [issueUrl] },
        { summary: "Missing policy documentation", status: "outstanding",
          reason: "The requested policy documentation is still absent.", awaiting: "author", evidence: [issueUrl] },
      ] },
    ] });
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const terminal = await f.run("", ["--apply", url]);
  assert.match(terminal, /^Findings: 5 across 2 sources$/m);
  const findings = terminal.split("\n\n").filter((block) => /^\[\d+\] /.test(block));
  assert.deepEqual(findings.map((block) => block.split("\n")[0]), [
    "[1] outstanding: Missing access check",
    "[2] addressed: Null guard",
    "[3] not-actionable: Duplicate request",
    "[4] uncertain: Undefined access policy",
    "[5] outstanding: Missing policy documentation",
  ]);
  for (const [index, finding] of findings.entries()) {
    const inline = index < 3;
    assert.ok(finding.includes(`    Source: ${inline ? "inline:1" : "comment:3"} · human`));
    assert.ok(finding.includes(`    ${inline ? evidenceUrl : issueUrl}\n`));
    if (inline) assert.match(finding, /^    GitHub thread: open$/m);
    else assert.doesNotMatch(finding, /GitHub thread:/, "PR-level comments have no thread state");
    assert.ok(finding.includes(`    Evidence: ${inline ? evidenceUrl : issueUrl}`));
  }
  assert.match(findings[0], /The current code still grants access without checking roles\./);
  assert.match(findings[0], /Raised by: human · Awaiting: author/);
  assert.match(findings[0], /Next step: Check the user's role before granting access\./);
  assert.ok(findings[0].includes(`    Evidence: ${url}#discussion_r2`));
  assert.match(findings[1], /The null guard is already fixed\./);
  assert.match(findings[2], /This repeats the access check finding\./);
  assert.match(findings[3], /The discussion does not specify which roles should have access\./);
  assert.match(findings[3], /Raised by: human · Awaiting: human/);
  assert.match(findings[3], /Next step: Confirm which roles should have access\./);
  assert.match(findings[4], /The requested policy documentation is still absent\./);
  assert.match(findings[4], /Next step: Address the finding with a code fix or an evidence-supported explanation\./);
  assert.doesNotMatch(terminal, /@author|@human|\u001b/);
  assert.equal(github.comments.length, 1);
  const body = github.comments[0];
  const disclosures = [...body.matchAll(/<details>\n<summary>(.*?)<\/summary>\n([\s\S]*?)\n<\/details>/g)];
  assert.deepEqual(disclosures.map((match) => match[1]), ["Reasoning and evidence", "Audit context"]);
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.match(visible, /## Review audit · Changes needed/);
  assert.match(visible, /1 addressed · 2 outstanding · 1 uncertain · 1 not-actionable/);
  assert.match(visible, /### Changes needed: Missing access check/);
  assert.match(visible, /Next step: Check the user's role before granting access\./);
  assert.match(visible, /Raised by: human · Awaiting: @author/, "only the person who acts next is @-mentioned");
  assert.doesNotMatch(visible, /@human · /, "the person who raised the finding is not tagged");
  assert.ok(visible.includes(`[Original review finding](${evidenceUrl})`));
  assert.match(visible, /### Needs verification: Undefined access policy/);
  assert.match(visible, /Next step: Confirm which roles should have access\./);
  assert.match(visible, /Raised by: human · Awaiting: @human/, "the thread opener is tagged when they act next");
  assert.ok(visible.includes(`[Original review finding](${issueUrl})`));
  assert.match(visible, /### Changes needed: Missing policy documentation/);
  assert.match(visible, /Next step: Address the finding with a code fix or an evidence-supported explanation\./,
    "older assessments without a next step must still render");
  assert.ok(visible.indexOf("Changes needed: Missing policy documentation") < visible.indexOf("Needs verification: Undefined access policy"),
    "confirmed outstanding findings must precede uncertain findings");
  assert.doesNotMatch(visible, /still grants access|does not specify|still absent|audited head|evidence fetched|inline threads|not actionable/);
  assert.match(disclosures[0][2], /The current code still grants access without checking roles\./);
  assert.match(disclosures[0][2], /The discussion does not specify which roles should have access\./);
  assert.match(disclosures[0][2], /The requested policy documentation is still absent\./);
  assert.ok(disclosures[0][2].includes(`${url}#discussion_r2`), "all evidence links must be retained inside the disclosure");
  assert.ok(disclosures[1][2].includes(`audited head: \`${sha}\``));
  assert.match(disclosures[1][2], /evidence fetched: .* to /);
  assert.match(disclosures[1][2], /inline threads: 0\/1 resolved \(0 unknown\)/);
  assert.match(disclosures[1][2], /other findings: 1 not actionable/);
  assert.doesNotMatch(body, /Null guard|already fixed|Duplicate request|repeats the access check|\u001b/);
});

test("an unstructured final answer cannot bypass complete report validation, post a verdict or approve", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  const f = await fixture(t, (_body, response) => reply(response, [{ role: "assistant", content: "Everything is addressed." }]), {
    entrypoint: resolve("audit.ts"), github: github.handler,
  });
  const { child, done } = f.start(["--approve", "--apply", url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  assert.doesNotMatch(result.stdout, /Verdict:|Everything is addressed/);
  assert.equal(github.comments.length, 0);
  assert.equal(github.approvals.length, 0);
});

test("a report without a database-migration classification cannot post a verdict or approve", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ empty: true });
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    if (++calls === 1) return tool(response, "report_review_assessment", { assessments: [] });
    assert.match(body.messages.at(-1)?.content ?? "", /databaseMigration/);
    reply(response, [{ role: "assistant", content: "Done." }]);
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const { child, done } = f.start(["--approve", "--apply", url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  assert.doesNotMatch(result.stdout, /Verdict:/);
  assert.equal(github.comments.length, 0);
  assert.equal(github.approvals.length, 0);
});

test("posted comments @-mention only the person who acts next and never bots, and the terminal report stays plain", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ issueComments: [issueComment(3, "Automated finding.", "Copilot"), issueComment(4, "Another.", "scanner[bot]")] });
  const f = await fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [
      { commentKey: "inline:1", findings: [{ summary: "Explain", status: "addressed", reason: "Explained.", evidence: [evidenceUrl] }] },
      { commentKey: "comment:3", findings: [{ summary: "Bot one", status: "outstanding", reason: "Open.", awaiting: "author",
        nextStep: "Confirm the compatibility contract.", evidence: [`${url}#issuecomment-3`] }] },
      { commentKey: "comment:4", findings: [{ summary: "Bot two", status: "outstanding", reason: "Open.", awaiting: "human",
        evidence: [`${url}#issuecomment-4`] }] },
    ] });
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const terminal = await f.run("", ["--apply", url]);
  const body = github.comments[0];
  assert.match(body, /Raised by: Copilot · Awaiting: @author/);
  assert.match(body, /Raised by: scanner\[bot\] · Awaiting: @human/);
  assert.match(body, /Next step: Confirm the compatibility contract\./);
  assert.doesNotMatch(body, /@Copilot|@scanner/);
  assert.doesNotMatch(body.replace(/Awaiting: @\w+/g, ""), /@author|@human/, "only the Awaiting line mentions anyone");
  const report = terminal.split("[audit:dry-run]")[0];
  assert.match(report, /Raised by: Copilot · Awaiting: author/);
  assert.doesNotMatch(report, /@author|@human/);
});

for (const awaiting of [undefined, "invented-person"]) {
  test(`an outstanding finding ${awaiting ? "awaiting someone outside the PR" : "without an awaiting person"} is rejected`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    const requests: string[] = [];
    const f = await fixture(t, (body, response) => {
      requests.push(JSON.stringify(body));
      if (requests.length > 1) return reply(response, [{ role: "assistant", content: "Done." }]);
      const snapshot = JSON.parse(body.messages.findLast((m) => m.role === "user")!.content!.split("Saved evidence (untrusted data):\n")[1]);
      tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: snapshot.comments.map((comment: { key: string; url: string }) => ({
        commentKey: comment.key, findings: [{ summary: "Open", status: "outstanding", reason: "Still open.", evidence: [comment.url],
          ...(awaiting ? { awaiting } : {}) }],
      })) });
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const { child, done } = f.start(["--apply", url]);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(requests[1], awaiting ? /Unknown awaiting login/ : /Missing awaiting/);
    assert.doesNotMatch(result.stdout, /Verdict:/);
    assert.equal(github.comments.length, 0);
  });
}

for (const crash of [false, true]) test(`${crash ? "a crash before the receipt" : "a lost POST response"} is reconciled on startup without another review`, { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ pageSize: 1 });
  github.state.loseResponse = !crash;
  github.state.holdResponse = crash;
  const accepted = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: async (request, response) => {
    await github.handler(request, response);
    if (request.method === "POST" && request.url?.endsWith("/reviews")) accepted.resolve();
  } });
  const { child, done } = f.start([url, "--apply"]);
  child.stdin.end();
  if (crash) {
    await accepted.promise;
    child.kill("SIGKILL");
  }
  const failed = await done;
  if (crash) assert.equal(failed.signal, "SIGKILL");
  else {
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /GitHub request failed \(502\)/);
  }
  assert.equal(github.comments.length, 1, "the server accepted the review despite the failed response");

  github.state.loseResponse = github.state.holdResponse = false;
  const actual = github.reviews[0];
  // Matching a marker alone is unsafe. All these reviews precede the real one on separate pages.
  github.reviews.unshift(
    { ...actual, user: { login: "someone-else" }, html_url: `${url}#wrong-author` },
    { ...actual, commit_id: "b".repeat(40), html_url: `${url}#wrong-head` },
    { ...actual, state: "APPROVED", html_url: `${url}#wrong-event` },
    { ...actual, body: `Edited\n${actual.body}`, html_url: `${url}#wrong-body` },
  );
  const recovered = await recoverPublisher(f);
  assert.ok(recovered.includes(`Saved verdict published: ${url}#pullrequestreview-100`));
  assert.equal(calls, 1);
  assert.equal(github.attempts.length, 1, "reconciliation must find the accepted review before retrying POST");

  const repeated = await f.run("", [url, "--apply", "--skip-approved=false"]);
  assert.ok(repeated.includes(`Comment skipped: matching verdict review recorded locally: ${url}#pullrequestreview-100`));
  assert.equal(github.attempts.length, 1, "recovery saved a receipt for later invocations");
});

test("submitting an audit review does not require a separate GitHub duplicate lookup after assessment", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let assessed = false;
  const f = await fixture(t, (body, response) => {
    assessed = true;
    assess(body, response);
  }, { entrypoint: resolve("audit.ts"), github: (request, response) => {
    if (assessed && request.method === "GET" && request.url?.includes("/reviews")) {
      response.writeHead(503).end("Review lookup unavailable");
      return;
    }
    return github.handler(request, response);
  } });
  const output = await f.run("", [url, "--apply"]);
  assert.match(output, /Verdict comment posted/);
  assert.equal(github.comments.length, 1, "only local history is needed to decide whether to post");
});

for (const action of ["comment", "approve"] as const) {
  test(`a failed ${action} request exits nonzero, retaining the assessment and explicit publication intent`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ commentStatus: action === "approve" ? undefined : 403, approvalStatus: 403 });
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const { child, done } = f.start(["--apply", ...(action === "approve" ? ["--approve"] : []), url]);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GitHub request failed \(403\)/);
    assert.match(result.stdout, /Verdict: All actionable findings appear addressed/);
    assert.doesNotMatch(result.stdout, /Verdict comment posted|PR approved/);
    assert.deepEqual(github.attempts.map((review) => review.event), [action === "approve" ? "APPROVE" : "COMMENT"], "writes must not retry");
    assert.equal(github.comments.length, 0, "a failed approval review must not leave the verdict anywhere else");
    assert.equal(github.approvals.length, 0);

    const cached = await f.run("", [url]);
    assert.match(cached, /Reusing saved assessment/);
    assert.match(cached, /Comment would be posted/, "a failed write must not create a submission receipt");
    assert.equal(calls, 1, "a failed write must not invalidate the completed assessment");
    assert.equal(github.attempts.length, 2, "startup retries the earlier explicit --apply, not the new preview");
  });
}

for (const { statuses, migrationStatus } of [
  { statuses: ["addressed"], migrationStatus: "migration" },
  { statuses: [], migrationStatus: "migration" },
  { statuses: ["uncertain"], migrationStatus: "migration" },
  { statuses: ["addressed"], migrationStatus: "uncertain" },
] satisfies { statuses: Status[]; migrationStatus: "migration" | "uncertain" }[]) {
  test(`--approve-migrations opts into approval for ${migrationStatus} with ${statuses.join(" + ") || "no findings"} across cached and forced audits without persisting`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ empty: !statuses.length,
      ...(migrationStatus === "migration" ? {
        title: "Backfill customer IDs", description: "Run a database data migration before deploying the new customer lookup.",
        files: [{ filename: "db/migrations/004_customer_ids.sql", status: "added", patch: "@@ -0,0 +1 @@\n+UPDATE customers SET external_id = id;" }],
      } : {
        title: "Change customer lookup storage", description: "The deployment plan is not available.",
        files: [{ filename: "services/customer/storage.ts", status: "modified" }],
      }),
    });
    const reason = migrationStatus === "migration" ? "The added SQL backfills customer IDs in the database."
      : "The changed storage code is unavailable, so a database migration cannot be ruled out.";
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, statuses, { status: migrationStatus, reason });
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const flags = ["--approve", "--allow-uncertain"];
    const verdict = !statuses.length ? /Verdict: No actionable findings identified/
      : statuses[0] === "addressed" ? /Verdict: All actionable findings appear addressed/
      : /Verdict: Not all actionable findings are addressed/;

    const preview = await f.run("", [...flags, url]);
    assert.match(preview, verdict);
    assert.match(preview, /Approval would be skipped: database migration/);
    assert.doesNotMatch(preview, /PR would be approved/);
    assert.equal(github.comments.length, 0);
    assert.equal(github.approvals.length, 0);

    const cached = await f.run(`/audit --apply ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
    assert.match(cached, /Reusing saved assessment/);
    assert.match(cached, verdict);
    assert.match(cached, /Approval skipped: database migration/);
    assert.equal(calls, 1);
    assert.equal(github.comments.length, 1, "blocking approval must still publish the verdict comment");
    const comment = github.comments[0];
    const visible = comment.replace(/<details>[\s\S]*?<\/details>/g, "");
    assert.match(visible, migrationStatus === "migration" ? /^Approval blocked: database migration requires human approval\.$/m
      : /^Approval blocked: database migration status is uncertain; human approval is required\.$/m);
    assert.equal(visible.includes(reason), false, "the classification rationale must not clutter the visible approval message");
    const reasoning = comment.match(/<details>\n<summary>Reasoning and evidence<\/summary>\n([\s\S]*?)\n<\/details>/);
    assert.ok(reasoning, "a migration rationale needs a disclosure even without pending findings");
    assert.match(reasoning[1], /### Database migration assessment/);
    assert.ok(reasoning[1].includes(reason), "the classification rationale must remain available in the disclosure");
    assert.ok(cached.includes(reason), "the terminal report must retain the classification rationale");
    if (migrationStatus === "uncertain") assert.match(cached, /database migration status is uncertain/);
    assert.equal(github.approvals.length, 0);

    const fresh = await f.run("", ["--force", "--apply", ...flags, url]);
    assert.match(fresh, verdict);
    assert.match(fresh, /Comment skipped: matching verdict review recorded locally/);
    assert.match(fresh, /Approval skipped: database migration/);
    assert.equal(calls, 2);
    assert.equal(github.comments.length, 1);
    assert.equal(github.approvals.length, 0, "neither --force nor --allow-uncertain may override the migration guard");

    const withoutApproval = await f.run("", ["--apply", "--approve-migrations", url]);
    assert.doesNotMatch(withoutApproval, /PR approved/);
    assert.equal(github.approvals.length, 0, "--approve-migrations must not imply --approve");

    const allowed = await f.run("", [...flags, "--approve-migrations", url]);
    assert.match(allowed, /Reusing saved assessment/);
    assert.match(allowed, /PR would be approved/);
    assert.doesNotMatch(allowed, /Approval blocked:|Approval would be skipped/);
    assert.equal(github.approvals.length, 0, "allowing migrations still requires --apply to submit approval");

    const allowedApply = await f.run(`/audit --apply --approve-migrations ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
    assert.match(allowedApply, /Reusing saved assessment/);
    assert.match(allowedApply, /PR approved/);
    assert.doesNotMatch(allowedApply, /Approval blocked:|Approval skipped/);
    assert.equal(github.approvals.length, 1);

    const guardedAgain = await f.run("", [...flags, "--skip-approved=false", url]);
    assert.match(guardedAgain, /Approval would be skipped: database migration/);
    assert.equal(github.approvals.length, 1, "allowing migrations must not persist to later invocations");
    assert.equal(calls, 2, "allowing migration approval must not invalidate the assessment cache");
  });
}

for (const { statuses, approve, chat, allowUncertain, approveMigrations } of [
  { statuses: ["addressed", "not-actionable"], approve: true, chat: true, allowUncertain: false },
  { statuses: ["addressed", "outstanding"], approve: false, chat: false, allowUncertain: false },
  { statuses: ["addressed", "uncertain"], approve: false, chat: false, allowUncertain: false },
  { statuses: ["not-actionable"], approve: true, chat: false, allowUncertain: false },
  { statuses: [], approve: true, chat: false, allowUncertain: false },
  { statuses: ["uncertain"], approve: true, chat: false, allowUncertain: true },
  { statuses: ["addressed", "uncertain"], approve: true, chat: true, allowUncertain: true },
  { statuses: ["addressed", "outstanding", "uncertain"], approve: false, chat: false, allowUncertain: true },
  { statuses: ["not-actionable"], approve: true, chat: false, allowUncertain: true },
  { statuses: [], approve: true, chat: false, allowUncertain: true },
  { statuses: ["outstanding"], approve: false, chat: true, allowUncertain: true, approveMigrations: true },
  { statuses: ["uncertain"], approve: false, chat: false, allowUncertain: false, approveMigrations: true },
] satisfies { statuses: Status[]; approve: boolean; chat: boolean; allowUncertain: boolean; approveMigrations?: boolean }[]) {
  const flags = ["--approve", "--apply", ...(allowUncertain ? ["--allow-uncertain"] : []), ...(approveMigrations ? ["--approve-migrations"] : [])];
  test(`${flags.join(" ")} ${approve ? "approves" : "skips"} ${statuses.join(" + ") || "an empty audit"} and posts a verdict comment`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ empty: !statuses.length });
    const f = await fixture(t, (body, response) => assess(body, response, statuses,
      approveMigrations ? { status: "migration", reason: "The PR backfills database records." } : noDatabaseMigration),
    { entrypoint: resolve("audit.ts"), github: github.handler });
    const noActionable = statuses.every((status) => status === "not-actionable");
    if (noActionable) {
      const preview = await f.run("", ["--approve", url]);
      assert.match(preview, /## Review audit · No actionable findings identified/);
      assert.doesNotMatch(preview, /Reasoning and evidence/);
      assert.match(preview, /PR would be approved/);
      assert.equal(github.comments.length, 0);
      assert.equal(github.approvals.length, 0, "clean audits still require --apply to submit approval");
      await f.run("", ["--apply", url]);
      assert.equal(github.approvals.length, 0, "publishing a clean verdict must not imply approval");
    }
    const output = chat
      ? await f.run(`/audit ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : await f.run("", [...flags, url]);
    assert.equal(github.comments.length, noActionable ? 2 : 1, "a matching comment review must not suppress a later approval review");
    assert.match(github.comments[0], /## Review audit ·/);
    assert.equal(github.approvals.length, approve ? 1 : 0);
    assert.deepEqual([github.posted.at(-1)!.event, github.posted.at(-1)!.commit_id], [approve ? "APPROVE" : "COMMENT", sha]);
    assert.match(output, approve ? /PR approved/ : /Approval skipped/);
    if (noActionable) {
      assert.match(output, /Reusing saved assessment/);
      assert.match(output, /Verdict comment posted/);
      assert.match(output, /Verdict: No actionable findings identified/);
      if (!statuses.length) {
        assert.match(output, /^Findings: 0 across 0 sources$/m);
        assert.doesNotMatch(output, /^\[\d+\] /m);
      }
      assert.match(github.comments[0], /0 addressed · 0 outstanding · 0 uncertain/);
    }
    if (approve) {
      assert.equal(github.approvals[0].event, "APPROVE");
      assert.equal(github.approvals[0].commit_id, sha);
      assert.equal(github.approvals[0].body, github.comments.at(-1), "the approval review carries the verdict");
      assert.equal(github.approvals.length, 1, "the verdict and the approval are one review");
      const hasUncertain = statuses.some((status) => status === "uncertain");
      assert.match(github.comments[0], hasUncertain ? /## Review audit · Verification needed/
        : noActionable ? /## Review audit · No actionable findings identified/ : /## Review audit · All actionable findings addressed/);
      if (hasUncertain) {
        assert.match(output, /Verdict: Not all actionable findings are addressed/);
        assert.match(github.comments[0], /### Needs verification: Requested explanation/);
      }
    }
  });
}

for (const { flags, status, approve, chat } of [
  { flags: [] as string[], status: "addressed", approve: false, chat: false },
  { flags: ["--approve"], status: "addressed", approve: true, chat: true },
  { flags: [] as string[], status: "not-actionable", approve: false, chat: false },
  { flags: ["--approve"], status: "not-actionable", approve: true, chat: true },
  { flags: ["--approve"], status: "uncertain", approve: false, chat: false },
  { flags: ["--allow-uncertain"], status: "uncertain", approve: false, chat: false },
  { flags: ["--approve", "--allow-uncertain"], status: "uncertain", approve: true, chat: true },
] satisfies { flags: string[]; status: Status; approve: boolean; chat: boolean }[]) {
  test(`default dry-run previews ${flags.join(" ") || "no mutation flags"} (${status}) and requires --apply on every invocation`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, [status]);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const run = () => chat
      ? f.run(`/audit ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : f.run("", [...flags, url, "local/test"]);
    const output = await run();
    const preview = output.match(/\[audit:dry-run\] Verdict comment preview:\n\n([\s\S]*?)\n\n\[audit:dry-run\] Comment would/);
    assert.ok(preview, "dry-run must show the exact proposed comment body");
    assert.ok(preview[1].includes(`audited head: \`${sha}\``));
    assert.match(preview[1], status === "uncertain" ? /## Review audit · Verification needed/
      : status === "addressed" ? /## Review audit · All actionable findings addressed/ : /## Review audit · No actionable findings identified/);
    assert.match(output, /Comment would be posted/);
    if (flags.includes("--approve")) {
      assert.match(output, approve ? /PR would be approved/ : /Approval would be skipped/);
    } else assert.doesNotMatch(output, /PR would be approved/);
    assert.doesNotMatch(output, /Verdict comment posted|\[audit\] PR approved/);
    assert.equal(github.comments.length, 0);
    assert.equal(github.approvals.length, 0);

    const cached = await run();
    assert.match(cached, /Reusing saved assessment/);
    assert.equal(calls, 1, "dry-run must use and publish the normal assessment cache");
    if (flags.includes("--approve") && flags.includes("--allow-uncertain")) {
      const strict = await f.run("", ["--approve", url]);
      assert.match(strict, /Reusing saved assessment/);
      assert.match(strict, /Approval would be skipped/);
      assert.equal(calls, 1, "uncertainty policy must not persist or invalidate the assessment cache");
    }
    assert.equal(github.comments.length, 0);
    assert.equal(github.approvals.length, 0, "cached dry-runs must not submit reviews either");

    const applied = chat
      ? await f.run(`/audit --apply ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : await f.run("", [...flags, url, "--apply"]);
    assert.doesNotMatch(applied, /\[audit:dry-run\]/);
    assert.equal(github.comments.length, 1);
    assert.equal(github.approvals.length, approve ? 1 : 0);
    assert.equal(github.comments[0], preview[1]);
    assert.equal(calls, 1);

    await run();
    assert.equal(github.comments.length, 1);
    assert.equal(github.approvals.length, approve ? 1 : 0, "--apply must not persist to later cached or fresh audits");
  });
}

for (const revision of ["headSha", "baseSha"] as const) {
  for (const apply of [false, true]) {
    test(`--approve${apply ? " --apply reassesses" : " preview refuses"} when ${revision} changes during assessment`, { timeout: 20000 }, async (t) => {
      const github = githubEvidence();
      let calls = 0;
      const f = await fixture(t, (body, response) => {
        calls++;
        github.state[revision] = "b".repeat(40);
        assess(body, response, [calls === 1 ? "addressed" : "outstanding"]);
      }, { entrypoint: resolve("audit.ts"), github: github.handler });
      const { child, done } = f.start(["--approve", ...(apply ? ["--apply"] : []), url]);
      child.stdin.end();
      const result = await done;
      assert.equal(result.code, apply ? 0 : 1, result.stderr);
      assert.match(result.stdout, /Verdict: All actionable findings appear addressed/);
      assert.doesNotMatch(result.stdout, /PR would be approved/);
      assert.equal(github.approvals.length, 0, "the old approval must not be submitted");
      if (apply) {
        assert.equal(calls, 2);
        assert.match(result.stdout, /[Rr]eassess/);
        assert.match(result.stdout, /Approval skipped: outstanding or uncertain findings remain/);
        assert.deepEqual(github.posted.map(({ event, commit_id }) => [event, commit_id]), [["COMMENT", github.state.headSha]]);
        assert.equal(github.attempts.length, 1, "only the new assessment's verdict may be published");
      } else {
        assert.equal(calls, 1, "a refused preview must not authorise an automatic reassessment");
        assert.match(result.stderr, /PR commits changed since the audit snapshot/);
        assert.equal(github.comments.length, 0);
        assert.equal(github.attempts.length, 0);
      }
    });
  }
}
