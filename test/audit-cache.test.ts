import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ReviewSnapshot } from "../reviews.ts";
import { fixture, noDatabaseMigration, reply, tool, type Request } from "./fixtures.ts";

const url = "https://github.com/acme/project/pull/9";
const audit = resolve("audit.ts");
const chat = resolve("agent.ts");
// Persisted document contracts used to inspect evidence and simulate a pre-filtering snapshot.
const auditRuns = defineDoc<{ active: ConversationId | null }>({
  kind: "app.review-audit-runs", version: 2, scope: "session", initial: () => ({ active: null }),
});
const auditDocument = defineDoc<{ snapshot: ReviewSnapshot | null }>({
  kind: "app.review-audit", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ snapshot: null }),
});

function evidence(extra: { inline?: object[]; comments?: object[]; reviews?: object[] } = {}) {
  const state = {
    headSha: "a".repeat(40), baseSha: "b".repeat(40), title: "Example PR", description: "The intended change.",
    commentBody: "Please explain this behaviour.", replyBody: "An explanation.", reviewBody: "Please document the trade-off.",
    reviewState: "COMMENTED", resolved: false, outdated: false, reverse: false,
    files: [] as { filename: string; status: string; patch?: string }[],
  };
  let reads = 0;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    reads++;
    const path = request.url!.split("?")[0];
    const comment = (id: number, body: string) => ({
      id, body, user: { login: "reviewer" }, html_url: `${url}#discussion_r${id}`,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    let data: unknown;
    switch (path) {
      case "/github/user": data = { login: "auditor" }; break;
      case "/github/repos/acme/project/pulls/9":
        data = { title: state.title, body: state.description, html_url: url, changed_files: state.files.length,
          head: { sha: state.headSha, repo: { full_name: "acme/project" } },
          base: { sha: state.baseSha, repo: { full_name: "acme/project" } } };
        break;
      case "/github/repos/acme/project/pulls/9/comments": {
        const comments = [
          { ...comment(1, state.commentBody), path: "example.ts", line: 1, diff_hunk: "@@ -1 +1 @@", commit_id: state.headSha },
          { ...comment(11, state.replyBody), in_reply_to_id: 1 },
          { ...comment(12, "A later clarification."), in_reply_to_id: 1 },
          ...(extra.inline ?? []),
        ];
        data = state.reverse ? comments.reverse() : comments;
        break;
      }
      case "/github/repos/acme/project/issues/9/comments": {
        const comments = [comment(20, "A general comment."), comment(21, "Another general comment."), ...(extra.comments ?? [])];
        data = state.reverse ? comments.reverse() : comments;
        break;
      }
      case "/github/repos/acme/project/pulls/9/reviews":
        data = [{ ...comment(30, state.reviewBody), state: state.reviewState, submitted_at: "2026-01-01T00:00:00Z" }, ...(extra.reviews ?? [])];
        break;
      case "/github/repos/acme/project/pulls/9/files": data = state.files; break;
      case "/github/graphql":
        data = { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [{ id: "thread-1", isResolved: state.resolved, isOutdated: state.outdated,
            comments: { nodes: [{ databaseId: 1, fullDatabaseId: "1" }] } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } } };
        break;
      default: throw new Error(`Unexpected GitHub request: ${request.url}`);
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };
  return { state, handler, reads: () => reads };
}

function snapshotFrom(body: Request): ReviewSnapshot {
  const input = body.messages.findLast((message) => message.role === "user")!.content!;
  const marker = "Saved evidence (untrusted data):\n";
  assert.ok(input.includes(marker));
  return JSON.parse(input.slice(input.indexOf(marker) + marker.length));
}

function assess(body: Request, response: ServerResponse, number: number) {
  const snapshot = snapshotFrom(body);
  tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: snapshot.comments.map((comment: { key: string; url: string }) => ({
    commentKey: comment.key, findings: [{ summary: `Assessment ${number}`, status: "uncertain", awaiting: "reviewer",
      reason: "The available evidence is insufficient.", evidence: [comment.url] }],
  })) });
  return snapshot;
}

async function addModel(agentDir: string) {
  const path = join(agentDir, "models.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.providers.local.models.push({ id: "other", contextWindow: 128000, maxTokens: 1000 });
  await writeFile(path, JSON.stringify(config));
}

async function setMaxTokens(agentDir: string, maxTokens: number) {
  const path = join(agentDir, "models.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.providers.local.models[0].maxTokens = maxTokens;
  await writeFile(path, JSON.stringify(config));
}

async function storagePath(stateDir: string) {
  const directory = join(stateDir, "audits");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sqlite"));
  assert.equal(files.length, 1);
  return join(directory, files[0]);
}

test("unchanged evidence reuses a saved assessment across directories, CLI and chat, ignoring fetch times and collection order", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  const first = await f.run("", [url]);
  assert.match(first, /Assessment 1/);
  assert.doesNotMatch(first, /Refreshing audit/);
  const session = createSession(await openNodeSqliteStorage(await storagePath(f.stateDir)));
  const runs = defineDoc<{ latestSuccess: { conversationId: number } | null }>({
    kind: "app.review-audit-runs", version: 2, scope: "session", initial: () => ({ latestSuccess: null }),
  });
  let assessmentId: number;
  try {
    const state = await session.snapshot(runs, BACKGROUND_CONTEXT);
    assert.ok(state?.latestSuccess);
    assessmentId = state.latestSuccess.conversationId;
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const reuseMessage = new RegExp(`Reusing saved assessment ${assessmentId} from`);
  const reads = github.reads();
  github.state.reverse = true;
  const otherCwd = join(f.directory, "other-project");
  await mkdir(otherCwd);
  const second = await f.run("", [url], { cwd: otherCwd });
  assert.equal(calls, 1, "a different working directory, snapshot ID, fetch time or ordering must not trigger reassessment");
  assert.ok(github.reads() > reads, "cache hits must still check GitHub");
  assert.match(second, reuseMessage);
  assert.doesNotMatch(second, /Refreshing audit/);
  assert.match(second, /Assessment 1/);
  assert.match(second, /Not all actionable findings are addressed/);
  const output = await f.run(`/audit ${url}\n/quit\n`, [], { entrypoint: chat });
  assert.match(output, reuseMessage);
  assert.equal(calls, 1);
});

test("marked audit output from any account is omitted from saved and model evidence without hiding ordinary discussion", { timeout: 20_000 }, async (t) => {
  const marker = "<!-- pronto:review-audit -->";
  const comment = (id: number, body: string, login: string, extra: object = {}) => ({
    id, body, user: { login }, html_url: `${url}#issuecomment-${id}`, ...extra,
  });
  const comments = [
    comment(40, `Own audit output\n\n${marker}\n  `, "auditor"),
    comment(41, `Another account's audit output\n\n${marker}`, "another-auditor"),
    comment(42, "A human explanation from the auditor's account.", "auditor"),
    comment(43, `PR review audit · ${url}\n\nHead: ${"a".repeat(40)}\n\nAn unmarked older report.`, "another-auditor"),
    comment(44, `Discussing ${marker}`, "auditor"),
    comment(45, `Quoting the marker:\n> ${marker}`, "another-auditor"),
    comment(46, `Showing the marker as code:\n\n    ${marker}`, "auditor"),
  ];
  const reviews = [comment(50, `Approval audit output\n\n${marker}`, "another-auditor", { state: "APPROVED" })];
  const inline = [
    comment(60, `Inline audit output\n\n${marker}`, "another-auditor"),
    comment(61, `Audit reply\n\n${marker}`, "auditor", { in_reply_to_id: 1 }),
  ];
  const github = evidence({ comments, reviews, inline });
  const expectedKeys = ["inline:1", "comment:20", "comment:21", "comment:42", "comment:43", "comment:44", "comment:45", "comment:46", "review:30"];
  let calls = 0;
  let supplied: ReviewSnapshot | undefined;
  const f = await fixture(t, (body, response) => {
    supplied = assess(body, response, ++calls);
  }, { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  assert.deepEqual(supplied?.comments.map((c) => c.key), expectedKeys);
  assert.deepEqual(supplied?.comments[0]!.replies.map((r) => r.body), ["An explanation.", "A later clarification."]);

  const session = createSession(await openNodeSqliteStorage(await storagePath(f.stateDir)));
  try {
    const state = await session.snapshot(auditRuns, BACKGROUND_CONTEXT);
    assert.ok(state?.active);
    const saved = await session.snapshot(auditDocument, state.active, BACKGROUND_CONTEXT);
    assert.deepEqual(saved?.snapshot?.comments.map((c) => c.key), expectedKeys);
    assert.deepEqual(saved?.snapshot?.comments[0]!.replies.map((r) => r.body), ["An explanation.", "A later clarification."]);
  } finally { await session.close(BACKGROUND_CONTEXT); }

  // Changing, adding or removing only marked output must leave the assessment reusable.
  comments.splice(0, 2);
  reviews[0]!.body = `Updated approval report\n\n${marker}`;
  inline.push(comment(62, `A new audit reply\n\n${marker}`, "another-auditor", { in_reply_to_id: 1 }));
  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing saved assessment/);
  assert.equal(calls, 1);
});

for (const [field, value, reason] of [
  ["headSha", "c".repeat(40), /headSha changed/], ["baseSha", "d".repeat(40), /baseSha changed/],
  ["title", "Different intent", /title changed/], ["description", "A different intended change.", /description changed/],
  ["commentBody", "An edited concern.", /inline:1 changed \(body\)/],
  ["replyBody", "A new explanation.", /inline:1 changed \(replies\)/],
  ["reviewBody", "A revised review summary.", /review:30 changed \(body\)/],
  ["reviewState", "CHANGES_REQUESTED", /review:30 changed \(reviewState\)/],
  ["resolved", true, /inline:1 changed \(thread\)/], ["outdated", true, /inline:1 changed \(thread\)/],
] as const) {
  test(`changed ${field} invalidates the assessment cache`, { timeout: 20_000 }, async (t) => {
    const github = evidence();
    let calls = 0;
    const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
    await f.run("", [url]);
    Object.assign(github.state, { [field]: value });
    const output = await f.run("", [url]);
    assert.equal(calls, 2);
    assert.match(output, /Assessment 2/);
    assert.doesNotMatch(output, /Reusing.*assessment/);
    const diagnostics = output.slice(output.indexOf("[audit] Refreshing audit"), output.indexOf("[audit:report_review_assessment]"));
    assert.match(diagnostics, reason, "explain the cache miss before model execution");
    assert.doesNotMatch(diagnostics, /audit policy changed/);
  });
}

test("refresh diagnostics identify metadata-only bot changes and added, removed or changed files", { timeout: 20_000 }, async (t) => {
  const botComment = (id: number) => ({
    id, body: "An unchanged status report.", user: { login: "status[bot]" }, html_url: `${url}#issuecomment-${id}`,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  const comments = [botComment(40), botComment(41)];
  const github = evidence({ comments });
  github.state.files = [{ filename: "example.ts", status: "modified", patch: "Original patch" },
    { filename: "removed.ts", status: "added" }];
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);

  comments[0]!.updated_at = "2026-01-02T00:00:00Z";
  comments[1] = botComment(42);
  const metadata = await f.run("", [url]);
  const commentReasons = metadata.split("\n").filter((line) => line.startsWith("[audit]   - ")).join("\n");
  assert.match(commentReasons, /comment:40 changed \(updatedAt\)/);
  assert.match(commentReasons, /comment:41 removed/);
  assert.match(commentReasons, /comment:42 added/);
  assert.doesNotMatch(commentReasons, /body|headSha|baseSha|file |audit policy/);

  github.state.files = [{ filename: "example.ts", status: "modified", patch: "Updated patch" },
    { filename: "added\u001b\n.ts", status: "added" }];
  const files = await f.run("", [url]);
  const fileReasons = files.split("\n").filter((line) => line.startsWith("[audit]   - ")).join("\n");
  assert.match(fileReasons, /file "example.ts" changed \(patch\)/);
  assert.match(fileReasons, /file "removed.ts" removed/);
  assert.ok(fileReasons.includes('file "added\\u001b\\n.ts" added'), "quote untrusted paths without terminal control characters or newlines");
  assert.doesNotMatch(fileReasons, /Original patch|Updated patch|comment:|audit policy/);
  assert.equal(calls, 3);
});

test("cache lookup considers only the latest success and includes the selected model", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const models: string[] = [];
  const f = await fixture(t, (body, response) => {
    models.push(body.model);
    assess(body, response, models.length);
  }, { entrypoint: audit, github: github.handler });
  await addModel(f.agentDir);
  await f.run("", [url]);
  const changedModel = await f.run("", [url, "local/other"]);
  assert.match(changedModel, /audit policy changed/);
  await f.run("", [url]);
  const cached = await f.run("", [url]);
  assert.deepEqual(models, ["test", "other", "test"]);
  assert.match(cached, /Assessment 3/);
  assert.match(cached, /Reusing.*assessment/);
});

test("changing inference configuration invalidates the cache without changing the model ID", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  await setMaxTokens(f.agentDir, 2000);
  const output = await f.run("", [url]);
  assert.equal(calls, 2);
  assert.doesNotMatch(output, /Reusing.*assessment/);
  assert.match(output, /audit policy changed/);
});

test("a successful mixed-policy audit cannot publish a cache entry or reuse an older success", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let id: string;
  const f = await fixture(t, (body, response) => {
    calls++;
    if (calls === 2) {
      id = snapshotFrom(body).id;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": unfinished\n\n");
      started.resolve();
    } else {
      const snapshot = assess(body, response, calls);
      if (calls === 3) assert.equal(snapshot.id, id);
      if (calls > 3) assert.notEqual(snapshot.id, id);
    }
  }, { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  const first = f.start([url, "--force"]);
  first.child.stdin.end();
  await started.promise;
  first.child.kill("SIGKILL");
  await first.done;
  await setMaxTokens(f.agentDir, 2000);
  const resumed = await f.run("", [url]);
  assert.match(resumed, /Resuming saved snapshot/);
  await setMaxTokens(f.agentDir, 1000);
  const fresh = await f.run("", [url]);
  assert.equal(calls, 4, "latest-success-only lookup must not fall back after a newer uncacheable success");
  assert.doesNotMatch(fresh, /Reusing.*assessment/);
  assert.match(fresh, /no reusable successful assessment is available/);
  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing.*assessment/);
  assert.equal(calls, 4);
});

test("resuming an older saved report without migration status preserves the audit but cannot approve", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  // Simulate an older report committed before its completion bookkeeping was saved.
  const session = createSession(await openNodeSqliteStorage(await storagePath(f.stateDir)));
  const report = defineDoc<JsonObject>({
    kind: "app.review-audit", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
  });
  const runs = defineDoc<JsonObject>({ kind: "app.review-audit-runs", version: 2, scope: "session", initial: () => ({}) });
  try {
    const state = await session.snapshot(auditRuns, BACKGROUND_CONTEXT);
    assert.ok(state?.active);
    const active = state.active;
    await session.commit(async (tx) => {
      delete (await tx.doc(report, active)).databaseMigration;
      (await tx.doc(runs)).complete = false;
    }, BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const resumed = await f.run("", [url, "--approve", "--allow-uncertain"]);
  assert.match(resumed, /Resuming saved snapshot/);
  assert.match(resumed, /Assessment 1/);
  assert.match(resumed, /Verdict: Not all actionable findings are addressed/);
  assert.match(resumed, /Approval would be skipped: database migration status was not assessed/);
  assert.match(resumed, /Run again with --force before approving/);
  assert.doesNotMatch(resumed, /PR would be approved/);
  assert.equal(calls, 1, "an existing report must not need a new model request to enforce the approval guard");
  const allowed = await f.run("", [url, "--approve", "--allow-uncertain", "--approve-migrations"]);
  assert.match(allowed, /PR would be approved/);
  assert.doesNotMatch(allowed, /Approval blocked:|Approval would be skipped/);
  assert.equal(calls, 1, "explicitly bypassing missing migration status must reuse the assessment");
});

test("chat --force bypasses a completed cache entry", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  const output = await f.run(`/audit --force ${url}\n/quit\n`, [], { entrypoint: chat });
  assert.equal(calls, 2);
  assert.match(output, /Assessment 2/);
  assert.doesNotMatch(output, /Reusing.*assessment/);
  assert.match(output, /--force requested/);
});

test("invalid audit flags are rejected before audit storage or network access in CLI and chat", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  const f = await fixture(t, () => assert.fail("Invalid commands must not reach the model"), { entrypoint: audit, github: github.handler });
  for (const args of [[url, "--froce"], [url, "--force", "--force"],
    [url, "--comment"], [url, "--approve", "--approve"], [url, "--approve=false"],
    [url, "--approve-migrations", "--approve-migrations"], [url, "--approve-migrations=false"],
    [url, "--apply", "--apply"], [url, "--apply=false"], [url, "--dry-run"], [url, "--apply", "--dry-run"], [url, "local/test", "extra"],
    [url, "--sticky="], [url, "--sticky=maybe"], [url, "--sticky", "--sticky=false"],
    [url, "--sticky=true", "--sticky", "false"]]) {
    const { child, done } = f.start(args);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const { child, done } = f.start([], { entrypoint: chat });
  child.stdin.end(`/audit ${url} --force --force\n/audit ${url} --comment\n/audit ${url} --approve --approve\n/audit ${url} --approve-migrations --approve-migrations\n/audit ${url} --apply --apply\n/audit ${url} --dry-run\n/audit ${url} --sticky --sticky=false\n/audit ${url} --sticky=maybe\n/audit ${url} --skip\n/audit ${url} --skip=\n/audit ${url} --skip --apply\n/quit\n`);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /--force can be supplied only once/);
  assert.match(result.stderr, /Unknown audit option: --comment/);
  assert.match(result.stderr, /--approve can be supplied only once/);
  assert.match(result.stderr, /--approve-migrations can be supplied only once/);
  assert.match(result.stderr, /--apply can be supplied only once/);
  assert.match(result.stderr, /Unknown audit option: --dry-run/);
  assert.match(result.stderr, /--sticky can be supplied only once/);
  assert.match(result.stderr, /--sticky must be true or false/);
  assert.match(result.stderr, /--skip requires a non-empty label/);
  assert.equal(github.reads(), 0);
  await assert.rejects(readdir(join(f.stateDir, "audits")), { code: "ENOENT" });
});

test("matching cached assessments do not expire", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  const session = createSession(await openNodeSqliteStorage(await storagePath(f.stateDir)));
  // Exercise the persisted v2 state protocol with an assessment that has aged since it was saved.
  const runs = defineDoc<JsonObject>({ kind: "app.review-audit-runs", version: 2, scope: "session", initial: () => ({}) });
  try {
    await session.commit(async (tx) => {
      const doc = await tx.doc(runs);
      assert.ok(doc.latestSuccess && typeof doc.latestSuccess === "object" && !Array.isArray(doc.latestSuccess));
      doc.latestSuccess.assessedAt = "2000-01-01T00:00:00.000Z";
      doc.latestSuccess.lastCheckedAt = "2000-01-01T00:00:00.000Z";
    }, BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const cached = await f.run("", [url]);
  assert.equal(calls, 1);
  assert.match(cached, /Reusing.*2000-01-01/);
});

test("a failed forced reassessment leaves the previous successful cache usable", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    calls++;
    if (calls === 1) assess(body, response, calls);
    else reply(response, [{ role: "assistant", content: "No structured report." }]);
  }, { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  const failed = f.start(["--force", url]);
  failed.child.stdin.end();
  const result = await failed.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  const cached = await f.run("", [url]);
  assert.equal(calls, 2);
  assert.match(cached, /Reusing.*assessment/);
  assert.match(cached, /Assessment 1/);
});

test("unfinished snapshots containing marked audit output require --force to restart with fresh evidence", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const ids: string[] = [];
  const f = await fixture(t, (body, response) => {
    calls++;
    if (calls === 1) {
      ids.push(snapshotFrom(body).id);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": unfinished\n\n");
      started();
    } else ids.push(assess(body, response, calls).id);
  }, { entrypoint: audit, github: github.handler });
  const first = f.start([url]);
  first.child.stdin.end();
  await pending;
  first.child.kill("SIGKILL");
  await first.done;
  // Model an unfinished snapshot saved before audit-output filtering was introduced.
  const session = createSession(await openNodeSqliteStorage(await storagePath(f.stateDir)));
  try {
    const state = await session.snapshot(auditRuns, BACKGROUND_CONTEXT);
    assert.ok(state?.active);
    const active = state.active;
    await session.commit(async (tx) => {
      const doc = await tx.doc(auditDocument, active);
      assert.ok(doc.snapshot);
      doc.snapshot.comments[0]!.body = "Saved auditor output\n\n<!-- pronto:review-audit -->";
    }, BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const blocked = f.start([url]);
  blocked.child.stdin.end();
  const rejected = await blocked.done;
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /saved audit.*Pronto output.*--force/i);
  assert.equal(calls, 1, "contaminated saved evidence must not be sent to the model on resume");

  github.state.commentBody = "A newer concern.";
  const restarted = await f.run("", [url, "--force"]);
  assert.equal(calls, 2, "the cancelled request must not be resumed before the new one");
  assert.notEqual(ids[0], ids[1]);
  assert.match(restarted, /Restarting unfinished audit/);
  assert.match(restarted, /--force requested/);
  assert.doesNotMatch(restarted, /Resuming saved snapshot/);
  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing.*assessment/);
  assert.equal(calls, 2);
});

test("force-restart intent and model survive a crash during fresh evidence fetching", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  let stalled = false;
  let started!: () => void;
  let fetching!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const fetchPending = new Promise<void>((resolve) => { fetching = resolve; });
  const models: string[] = [];
  const f = await fixture(t, (body, response) => {
    models.push(body.model);
    calls++;
    if (calls === 2) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": unfinished\n\n");
      started();
    } else assess(body, response, calls);
  }, { entrypoint: audit, github: (request, response) => {
    if (stalled && request.url === "/github/repos/acme/project/pulls/9/files?per_page=100") { fetching(); return; }
    github.handler(request, response);
  } });
  await addModel(f.agentDir);
  await f.run("", [url]);
  const interrupted = f.start([url, "--force"]);
  interrupted.child.stdin.end();
  await pending;
  interrupted.child.kill("SIGKILL");
  await interrupted.done;
  stalled = true;
  const restarting = f.start([url, "local/other", "--force"]);
  restarting.child.stdin.end();
  await fetchPending;
  restarting.child.kill("SIGKILL");
  await restarting.done;
  stalled = false;
  const recovered = await f.run("", [url]);
  assert.deepEqual(models, ["test", "test", "other"]);
  assert.doesNotMatch(recovered, /Reusing.*assessment/);
  assert.match(recovered, /saved --force restart intent/);
  const cached = await f.run("", [url, "local/other"]);
  assert.match(cached, /Reusing.*assessment/);
  assert.equal(calls, 3);
});

test("a crash before terminal report delivery leaves a reusable completed assessment", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  const preload = join(f.cwd, "interrupt-output.mjs");
  await writeFile(preload, `const write = process.stdout.write;
process.stdout.write = function(chunk, ...args) {
  if (String(chunk).includes("Verdict:")) { process.kill(process.pid, "SIGKILL"); return false; }
  return write.call(this, chunk, ...args);
};\n`);
  const first = f.start([url], { nodeArgs: ["--import", preload] });
  first.child.stdin.end();
  const killed = await first.done;
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.doesNotMatch(killed.stdout, /Verdict:/);
  const recovered = await f.run("", [url]);
  assert.match(recovered, /Reusing.*assessment/);
  assert.match(recovered, /Verdict:/);
  assert.equal(calls, 1);
});

test("directory-local audit databases are ignored and left untouched", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  await f.run("", [url]);
  const path = await storagePath(f.stateDir);
  const legacyDirectory = join(f.cwd, ".pi-durable", "audits");
  await mkdir(legacyDirectory, { recursive: true });
  const legacy = join(legacyDirectory, basename(path));
  await rename(path, legacy);
  const original = await readFile(legacy);
  const fresh = await f.run("", [url]);
  assert.doesNotMatch(fresh, /Reusing.*assessment/);
  assert.match(fresh, /Assessment 2/);
  assert.equal(calls, 2, "a directory-local cached assessment must not be imported");
  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing.*assessment/);
  assert.match(cached, /Assessment 2/);
  assert.equal(calls, 2, "new assessments must persist in the configured state directory");
  assert.deepEqual(await readFile(legacy), original);
});

test("existing v1 controller state migrates without being mistaken for a cached assessment", { timeout: 20_000 }, async (t) => {
  const github = evidence();
  let calls = 0;
  const f = await fixture(t, (body, response) => assess(body, response, ++calls), { entrypoint: audit, github: github.handler });
  const directory = join(f.stateDir, "audits");
  await mkdir(directory, { recursive: true });
  // The v1 per-PR key and controller document shape are independent compatibility contracts.
  const key = createHash("sha256").update("https://github.com/acme/project#9").digest("hex").slice(0, 20);
  const session = createSession(await openNodeSqliteStorage(join(directory, `${key}.sqlite`)));
  const legacy = defineDoc<JsonObject>({ kind: "app.review-audit-runs", version: 1, scope: "session", initial: () => ({ active: null, complete: true }) });
  try {
    await session.commit(async (tx) => { await tx.doc(legacy); }, BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  const output = await f.run("", [url]);
  assert.match(output, /Assessment 1/);
  assert.doesNotMatch(output, /Reusing.*assessment/);
  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing.*assessment/);
  assert.equal(calls, 1);
});
