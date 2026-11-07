import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readAudit } from "../src/discussion/audit-reader.ts";
import { fixture, reply, tool } from "./fixtures.ts";
import { prUrl, headSha, baseSha, commentUrl, githubEvidence, assessments, auditCheckpointHook } from "./audit-evidence.ts";

const auditEntry = resolve("src/cli/audit.ts");
const repositoryPath = (stateDir: string) => join(stateDir, "repos/github.com/acme~demo.sqlite");

test("discussion retains its selected attempt across restarts, newer successes and a failed latest audit", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let mode: "audit" | "chat" | "fail" = "audit";
  let auditTurn = 0;
  let firstId: number;
  let newerId: number;
  let chatTurn = 0;
  const f = await fixture(t, (body, response) => {
    if (mode === "audit") {
      if (auditTurn++ % 2 === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
      else tool(response, "report_review_assessment", assessments());
      return;
    }
    if (mode === "fail") { reply(response, [{ role: "assistant", content: "No complete assessment." }]); return; }
    const latest = body.messages.at(-1)!;
    if (latest.role === "user") {
      switch (latest.content) {
        case "Select the PR": tool(response, "read_audit", { prUrl, auditId: 0, latest: false, section: "summary", commentKey: "", offset: 0, limit: 8000 }); break;
        case "Follow up on the same PR": tool(response, "read_audit", { prUrl: "https://github.com/ACME/DEMO/pull/7/", auditId: 0 }); break;
        case "Switch to the latest": tool(response, "read_audit", { latest: true, auditId: 0, prUrl: "" }); break;
        case "Go back to the first": tool(response, "read_audit", { auditId: firstId }); break;
        case "Read the latest failed attempt": tool(response, "read_audit", { latest: true }); break;
        default: assert.fail(`Unexpected question: ${latest.content}`);
      }
      return;
    }
    const saved = JSON.parse(latest.content!);
    assert.equal(saved.audit.headSha, headSha);
    if (chatTurn === 0) firstId = saved.audit.auditId;
    if (chatTurn === 1) {
      newerId = saved.audit.latestAttemptId;
      assert.notEqual(newerId, firstId);
    }
    if (chatTurn === 0 || chatTurn === 1 || chatTurn === 3) assert.equal(saved.audit.auditId, firstId);
    if (chatTurn === 2) assert.equal(saved.audit.auditId, newerId);
    if (chatTurn === 4) {
      assert.notEqual(saved.audit.auditId, newerId);
      assert.equal(saved.audit.cachedSuccessId, newerId, "an older success is identified, not silently selected");
      assert.equal(saved.audit.status, "failed");
      assert.equal(saved.audit.reportAccepted, false);
    } else assert.equal(saved.audit.status, "completed");
    if (chatTurn > 0) assert.ok(body.messages.some((message) => message.role === "user" && message.content === "Select the PR"));
    chatTurn++;
    reply(response, [{ role: "assistant", content: `Selected saved attempt ${saved.audit.auditId}.` }]);
  }, { github: github.handle });
  await f.run("", [prUrl], { entrypoint: auditEntry });
  mode = "chat";
  await f.run("Select the PR\n/quit\n");
  mode = "audit";
  await f.run("", [prUrl, "--force"], { entrypoint: auditEntry });
  mode = "chat";
  const original = await readFile(repositoryPath(f.stateDir));
  await f.run("Follow up on the same PR\nSwitch to the latest\nGo back to the first\n/quit\n");
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), original);
  mode = "fail";
  const failed = f.start([prUrl, "--force"], { entrypoint: auditEntry });
  failed.child.stdin.end();
  assert.equal((await failed.done).code, 1);
  mode = "chat";
  await f.run("Read the latest failed attempt\n/quit\n");
  assert.equal(chatTurn, 5);
});

test("bounded audit reads preserve complete long author replies and their citation", { timeout: 20000 }, async (t) => {
  const originalReply = `A detailed explanation.\n${"Evidence 🔎 and safeguards. ".repeat(1800)}\nFinal qualification: no deployment was independently verified.`;
  const github = githubEvidence({ replyBody: originalReply });
  let building = true;
  let auditTurn = 0;
  let content = "";
  let pages = 0;
  let selectedId: number | undefined;
  const f = await fixture(t, (body, response) => {
    if (building) {
      if (auditTurn++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
      else tool(response, "report_review_assessment", assessments());
      return;
    }
    if (body.messages.at(-1)!.role === "user") {
      tool(response, "read_audit", { prUrl, section: "discussion", commentKey: "inline:102", limit: 16000 });
      return;
    }
    const page = JSON.parse(body.messages.at(-1)!.content!);
    selectedId ??= page.audit.auditId;
    assert.equal(page.audit.auditId, selectedId);
    assert.equal(page.offset, content.length);
    assert.ok(page.content.length <= 16000);
    content += page.content;
    pages++;
    if (page.nextOffset !== null) {
      tool(response, "read_audit", { section: "discussion", commentKey: "inline:102", offset: page.nextOffset, limit: 16000 });
    } else {
      const discussion = JSON.parse(content);
      assert.equal(discussion.replies[0].body, originalReply);
      assert.equal(discussion.replies[0].url, commentUrl(103));
      reply(response, [{ role: "assistant", content: "The original reply was retrieved in full, including its final qualification." }]);
    }
  }, { github: github.handle });
  await f.run("", [prUrl], { entrypoint: auditEntry });
  building = false;
  const reads = github.requests.length;
  await f.run("Read the full author reply\n/quit\n");
  assert.ok(pages > 2);
  assert.equal(github.requests.length, reads, "saved evidence reads must be offline");
});

for (const crash of ["report", "publication"] as const) {
  test(`reading an audit after a ${crash} checkpoint cannot resume work or publish, even while its owner lock is held`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let building = true;
    let auditTurn = 0;
    let chatTurn = 0;
    const f = await fixture(t, (body, response) => {
      if (building) {
        if (auditTurn++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
        else tool(response, "report_review_assessment", assessments());
      } else if (chatTurn++ === 0) tool(response, "read_audit", { prUrl });
      else {
        const saved = JSON.parse(body.messages.at(-1)!.content!);
        assert.equal(saved.audit.reportAccepted, true);
        assert.equal(saved.audit.status, crash === "report" ? "incomplete" : "completed");
        if (crash === "report") assert.ok(saved.audit.limitations.some((line: string) => line.includes("not a completed successful audit")));
        reply(response, [{ role: "assistant", content: "I read the saved attempt without executing its pending work." }]);
      }
    }, { github: github.handle });
    const hook = await auditCheckpointHook(f.directory, crash);
    const first = f.start([prUrl, ...(crash === "publication" ? ["--apply"] : [])], { entrypoint: auditEntry, nodeArgs: ["--import", hook] });
    first.child.stdin.end();
    const interrupted = await first.done;
    assert.equal(interrupted.code, 79, interrupted.stderr);
    building = false;
    const path = repositoryPath(f.stateDir);
    const original = await readFile(path);
    const queries = new DatabaseSync(path, { readOnly: true });
    const before = queries.prepare("SELECT record FROM tasks ORDER BY id").all();
    queries.close();
    const owner = new DatabaseSync(`${path}.lock`);
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const reads = github.requests.length;
      assert.match(await f.run("Explain this saved audit\n/quit\n"), /without executing its pending work/);
      assert.equal(github.requests.length, reads, "inspection must not call GitHub or recover a pending review");
      const after = new DatabaseSync(path, { readOnly: true });
      assert.deepEqual(after.prepare("SELECT record FROM tasks ORDER BY id").all(), before);
      after.close();
      assert.deepEqual(await readFile(path), original);
    } finally { owner.close(); }
    assert.equal(auditTurn, 2, "reading must not make another assessment request");
  });
}

test("chat rejects missing audits and unsafe tools and constrains additional file reads to the selected commits", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let building = true;
  let auditTurn = 0;
  let index = 0;
  const seed = "private local contents must never reach the model";
  const actions = [
    { name: "read_github_file", args: { path: "src/access.ts", revision: "head" }, error: /select an existing audit/ },
    { name: "read_audit", args: { prUrl: "https://github.com/acme/demo/pull/8" }, error: /No saved audit/ },
    { name: "read_audit", args: { prUrl: "https://github.com/other/missing/pull/7" }, error: /No saved audit/ },
    { name: "read_audit", args: { prUrl, auditId: 1 }, error: /Latest saved attempt/ },
    { name: "read_audit", args: { prUrl: "https://example.com/acme/demo/pull/7" }, error: /Expected a GitHub PR URL/ },
    { name: "bash", args: { command: "touch forbidden" }, error: /bash/ },
    { name: "write", args: { path: "forbidden", content: "changed" }, error: /write/ },
    { name: "edit", args: { path: "seed.txt", edits: [{ oldText: seed, newText: "changed" }] }, error: /edit/ },
    { name: "read", args: { path: "seed.txt" }, error: /read/ },
    { name: "report_review_assessment", args: {}, error: /report_review_assessment/ },
    { name: "read_audit", args: { prUrl }, error: null },
    { name: "read_github_file", args: { path: "../seed.txt", revision: "head" }, error: /without traversal/ },
    { name: "read_github_file", args: { path: "src/access.ts", revision: "branch" }, error: /revision/ },
    { name: "read_github_file", args: { path: "src/access.ts", revision: "head", repository: "evil/repo", sha: "main" }, error: /repository|sha/ },
    { name: "read_github_file", args: { path: "src/access.ts", revision: "base", offset: 1, limit: 2 }, error: null },
    { name: "read_audit", args: { latest: true, auditId: 1 }, error: /not both/ },
    { name: "read_audit", args: { limit: 20000 }, error: /limit/ },
  ];
  const f = await fixture(t, (body, response) => {
    if (building) {
      if (auditTurn++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
      else tool(response, "report_review_assessment", assessments());
      return;
    }
    const latest = body.messages.at(-1)!;
    if (latest.role === "tool") {
      const action = actions[index - 1]!;
      assert.ok(!latest.content!.includes(seed));
      if (action.error) assert.match(latest.content!, action.error);
      else if (action.name === "read_github_file") {
        const code = JSON.parse(latest.content!);
        assert.equal(code.sha, baseSha);
        assert.equal(code.url, `https://github.com/acme/demo/blob/${baseSha}/src/access.ts#L1-L2`);
      } else assert.equal(JSON.parse(latest.content!).audit.status, "completed");
    }
    const action = actions[index++];
    if (action) tool(response, action.name, action.args);
    else reply(response, [{ role: "assistant", content: "Only saved audits and their pinned code are accessible." }]);
  }, { github: github.handle });
  await writeFile(join(f.cwd, "seed.txt"), seed);
  await f.run("", [prUrl], { entrypoint: auditEntry });
  building = false;
  const original = await readFile(repositoryPath(f.stateDir));
  const reads = github.requests.length;
  await f.run("Inspect the available evidence safely\n/quit\n");
  assert.equal(index, actions.length + 1);
  assert.equal(github.requests.length, reads + 1);
  assert.equal(github.requests.at(-1), `/github/repos/acme/demo/contents/src/access.ts?ref=${baseSha}`);
  assert.equal(await readFile(join(f.cwd, "seed.txt"), "utf8"), seed);
  await assert.rejects(readFile(join(f.cwd, "forbidden")), { code: "ENOENT" });
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), original);
  assert.ok((await readdir(join(f.stateDir, "chats"))).some((name) => name.endsWith(".sqlite")));
  assert.ok(!(await readdir(join(f.stateDir, "repos/github.com"))).includes("other~missing.sqlite"));
});

test("older audits disclose missing instructions and code evidence rather than inventing a rubric or verification", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let building = true;
  let turn = 0;
  const f = await fixture(t, (body, response) => {
    if (building) {
      const report = assessments();
      for (const assessment of report.assessments) for (const finding of assessment.findings) finding.evidence = [prUrl];
      tool(response, "report_review_assessment", report);
      return;
    }
    const latest = body.messages.at(-1)?.content ?? "";
    switch (turn++) {
      case 0: tool(response, "read_audit", { prUrl }); break;
      case 1: {
        const saved = JSON.parse(latest);
        assert.equal(saved.audit.status, "completed");
        assert.ok(saved.audit.limitations.some((line: string) => line.includes("instructions") && line.includes("unavailable")));
        tool(response, "read_audit", { section: "instructions" });
        break;
      }
      case 2:
        assert.match(JSON.parse(JSON.parse(latest).content).unavailable, /original audit instructions were not saved/);
        tool(response, "read_audit", { section: "code" });
        break;
      case 3:
        assert.match(JSON.parse(JSON.parse(latest).content).unavailable, /No successful pinned-file excerpts were saved/);
        tool(response, "read_github_file", { path: "missing.ts", revision: "head" });
        break;
      case 4:
        assert.match(latest, /GitHub request failed \(404\)/);
        reply(response, [{ role: "assistant", content: "The original rubric and code evidence are unavailable; I cannot verify this claim." }]);
        break;
      default: assert.fail("Unexpected model turn");
    }
  }, { github: (request, response) => {
    if (request.url === `/github/repos/contributor/fork/contents/missing.ts?ref=${headSha}`) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
    } else return github.handle(request, response);
  } });
  await f.run("", [prUrl], { entrypoint: auditEntry });
  const saved = readAudit({ prUrl }, f.stateDir);
  // Older saved state may lack instructions. Exercise the real document codec, including a delta deletion.
  const agent = defineDoc<{ instructions?: string }>({ kind: "pi.agent", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
    checkpointWhen: () => false, initial: () => ({}) });
  const session = createSession(await openNodeSqliteStorage(repositoryPath(f.stateDir)));
  try {
    await session.commit(async (tx) => { delete (await tx.doc(agent, saved.audit.auditId as ConversationId)).instructions; }, BACKGROUND_CONTEXT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  building = false;
  const original = await readFile(repositoryPath(f.stateDir));
  assert.match(await f.run("Explain and verify the saved assessment\n/quit\n"), /cannot verify this claim/);
  assert.equal(turn, 5);
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), original);
});
