import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, reply, tool } from "./fixtures.ts";
import { prUrl, headSha, accessId, codeUrl, commentUrl, githubEvidence, assessments } from "./audit-evidence.ts";

test("terminal chat keeps help local and refuses the former audit runner", { timeout: 20000 }, async (t) => {
  let requests = 0;
  const f = await fixture(t, (_body, response) => {
    requests++;
    reply(response, [{ role: "assistant", content: "Unexpected model request." }]);
  });
  const banner = await f.run("/quit\n");
  assert.ok(banner.includes("local/test"));
  assert.ok(banner.includes(f.cwd));
  assert.match(banner, /saved audit.*PR URL/);
  assert.match(banner, /\/help/);
  assert.match(banner, /Ctrl\+C.*unfinished discussion/);
  assert.doesNotMatch(banner, /--skip|--approve|--exclude/);

  const { child, done } = f.start();
  child.stdin.end("/help\n/audit " + prUrl + " --apply\n/quit\n");
  const help = await done;
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /read_audit/);
  assert.match(help.stdout, /pinned commits/);
  assert.match(help.stderr, /Chat only reads existing audits/);
  assert.equal(requests, 0, "help and rejected commands must not call the model");
  await assert.rejects(readdir(join(f.stateDir, "repos")), { code: "ENOENT" });
});

test("terminal chat streams answers using saved credentials and persisted discussion history", { timeout: 20000 }, async (t) => {
  let turn = 0;
  const partial = Promise.withResolvers<ServerResponse>();
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1);
    if (turn++ === 0) {
      assert.equal(latest?.content, "what can we discuss?");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: { role: "assistant", content: "Saved " }, finish_reason: null }] })}\n\n`);
      partial.resolve(response);
    } else {
      assert.equal(latest?.content, "what did you say?");
      assert.ok(body.messages.some((message) => message.role === "user" && message.content === "what can we discuss?"));
      assert.ok(body.messages.some((message) => message.role === "assistant" && message.content === "Saved audits."));
      reply(response, [{ role: "assistant", content: "We can discuss existing audits." }]);
    }
  });
  const first = f.start();
  const streamed = new Promise<void>((done) => {
    let output = "";
    const onData = (data: Buffer) => {
      output += data;
      if (output.includes("Saved ")) {
        first.child.stdout.off("data", onData);
        done();
      }
    };
    first.child.stdout.on("data", onData);
  });
  first.child.stdin.end("what can we discuss?\n/quit\n");
  const response = await partial.promise;
  await streamed;
  reply(response, [{ content: "audits." }]);
  const result = await first.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split("Saved audits.").length - 1, 1, "streamed answer must appear exactly once");
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "missing", defaultModel: "missing" }));
  assert.match(await f.run("what did you say?\n/quit\n"), /We can discuss existing audits/);
  assert.equal(turn, 2);
});

test("chat retrieves original findings, replies, rubric and pinned code through real tools", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let building = true;
  let auditTurns = 0;
  let turn = 0;
  let selectedId: number | undefined;
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1)?.content ?? "";
    if (building) {
      if (auditTurns++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
      else tool(response, "report_review_assessment", assessments());
      return;
    }
    const page = () => {
      const value = JSON.parse(latest);
      assert.equal(value.audit.auditId, selectedId);
      assert.equal(value.audit.headSha, headSha);
      assert.equal(value.audit.status, "completed");
      assert.equal(value.nextOffset, null);
      return JSON.parse(value.content);
    };
    switch (turn++) {
      case 0:
        assert.ok(body.tools.every((entry) => ["read_audit", "read_github_file"].includes(entry.function.name)));
        tool(response, "read_audit", { prUrl });
        break;
      case 1: {
        const summary = JSON.parse(latest);
        selectedId = summary.audit.auditId;
        assert.equal(summary.audit.status, "completed");
        assert.equal(JSON.parse(summary.content).counts.outstanding, 1);
        tool(response, "read_audit", { section: "findings", commentKey: `inline:${accessId}` });
        break;
      }
      case 2:
        assert.equal(page()[0].findings[0].reason, "The code returns true without checking access.");
        assert.equal(page()[0].source.url, commentUrl(accessId));
        reply(response, [{ role: "assistant", content: `The access-check finding is outstanding: ${codeUrl}` }]);
        break;
      case 3:
        assert.equal(latest, "What did the author say?");
        tool(response, "read_audit", { section: "discussion", commentKey: "inline:102" });
        break;
      case 4:
        assert.equal(page().replies[0].body, "Fixed already");
        assert.equal(page().replies[0].url, commentUrl(103));
        reply(response, [{ role: "assistant", content: `The reply says “Fixed already”: ${commentUrl(103)}` }]);
        break;
      case 5:
        tool(response, "read_audit", { section: "findings", commentKey: "inline:102" });
        break;
      case 6:
        assert.equal(page()[0].findings[0].status, "addressed");
        assert.equal(page()[0].findings[0].reason, "The guard handles a missing user.");
        tool(response, "read_audit", { section: "code" });
        break;
      case 7:
        assert.equal(page()[0].result.url, codeUrl);
        assert.match(page()[0].result.content, /if \(!user\) return false/);
        reply(response, [{ role: "assistant", content: `The saved code supports the null-check fix: ${codeUrl}` }]);
        break;
      case 8:
        tool(response, "read_github_file", { path: "src/access.ts", revision: "head", offset: 1, limit: 3 });
        break;
      case 9: {
        const code = JSON.parse(latest);
        assert.equal(code.auditId, selectedId);
        assert.equal(code.sha, headSha);
        assert.equal(code.url, codeUrl);
        assert.match(code.provenance, /Additional.*not saved audit evidence/);
        reply(response, [{ role: "assistant", content: `My additional pinned-code inspection supports the claim: ${codeUrl}` }]);
        break;
      }
      case 10:
        tool(response, "read_audit", { section: "instructions", limit: 16000 });
        break;
      case 11:
        assert.match(page(), /not a fixer/);
        assert.match(page(), /explanation\/scope decision/);
        reply(response, [{ role: "assistant", content: "The saved rubric accepts a supported explanation or scope decision, not just a code fix." }]);
        break;
      case 12:
        tool(response, "read_audit", { section: "findings", commentKey: `inline:${accessId}` });
        break;
      case 13:
        assert.equal(page()[0].findings[0].status, "outstanding");
        reply(response, [{ role: "assistant", content: "A proposed explanation must be truthful and supported; discussion does not change the recorded verdict." }]);
        break;
      default: assert.fail("Unexpected model turn");
    }
  }, { github: github.handle });
  await f.run("", [prUrl], { entrypoint: resolve("src/cli/audit.ts") });
  building = false;
  const savedPath = join(f.stateDir, "repos/github.com/acme~demo.sqlite");
  const original = await readFile(savedPath);
  const githubReads = github.requests.length;
  const output = await f.run(`Why is ${prUrl} outstanding?\nWhat did the author say?\nWas it addressed by code or explanation?\nDoes the evidence support the reasoning?\nWhat would satisfy the rubric?\nWhat explanation could suffice?\n/quit\n`);
  assert.match(output, /The access-check finding is outstanding/);
  assert.ok(output.includes(commentUrl(103)));
  assert.match(output, /does not change the recorded verdict/);
  assert.equal(turn, 14);
  assert.equal(github.requests.length, githubReads + 1, "only the explicit additional pinned-file read may contact GitHub");
  assert.equal(github.requests.at(-1), `/github/repos/contributor/fork/contents/src/access.ts?ref=${headSha}`);
  assert.deepEqual(await readFile(savedPath), original, "discussion must not modify the audit database");
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`restart resumes an unfinished turn after ${signal} without resubmitting the input`, { timeout: 20000 }, async (t) => {
    let requests = 0;
    const started = Promise.withResolvers<void>();
    const f = await fixture(t, (body, response) => {
      assert.equal(body.messages.filter((message) => message.role === "user" && message.content === "keep working").length, 1);
      if (++requests === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta: { role: "assistant", content: "Starting" }, finish_reason: null }] })}\n\n`);
        started.resolve();
        // Leave the request unfinished until the agent process stops.
      } else {
        reply(response, [{ role: "assistant", content: "Recovered and finished." }]);
      }
    });
    const first = f.start();
    first.child.stdin.write("keep working\n");
    await started.promise;
    if (signal === "SIGKILL") {
      const competing = f.start();
      competing.child.stdin.end("/quit\n");
      const rejected = await competing.done;
      assert.equal(rejected.code, 1, rejected.stderr);
      assert.match(rejected.stderr, /Database is already in use/);
      assert.equal(requests, 1, "a competing chat must not resume the pending turn");
    }
    first.child.kill(signal);
    const stopped = await first.done;
    if (signal === "SIGTERM") assert.equal(stopped.code, 0, stopped.stderr);
    const resumed = f.start();
    resumed.child.stdin.end("/quit\n");
    const output = await resumed.done;
    assert.equal(output.code, 0, output.stderr);
    assert.ok(output.stdout.includes("Recovered and finished."));
    if (signal === "SIGKILL") assert.match(output.stderr, /Retry 1: The host stopped while the model was answering/);
    assert.equal(requests, 2);
  });
}

test("directory-local chat databases are ignored and left untouched", { timeout: 20000 }, async (t) => {
  const prompts: (string | undefined)[][] = [];
  const f = await fixture(t, (body, response) => {
    prompts.push(body.messages.filter((message) => message.role === "user").map((message) => message.content));
    reply(response, [{ role: "assistant", content: "Done." }]);
  });
  await f.run("old conversation\n/quit\n");
  const directory = join(f.stateDir, "chats");
  const databases = (await readdir(directory)).filter((file) => file.endsWith(".sqlite"));
  assert.equal(databases.length, 1);
  const legacyDirectory = join(f.cwd, ".pi-durable");
  await mkdir(legacyDirectory);
  const legacy = join(legacyDirectory, "agent.sqlite");
  await rename(join(directory, databases[0]!), legacy);
  const original = await readFile(legacy);
  await f.run("new conversation\n/quit\n");
  assert.deepEqual(prompts, [["old conversation"], ["new conversation"]], "the chat must start fresh, not import directory-local history");
  assert.deepEqual(await readFile(legacy), original);
});
