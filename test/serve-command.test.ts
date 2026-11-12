import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fixture, gitCheckout, noDatabaseMigration, reply, tool } from "./fixtures.ts";
import { deliver, reviewRequested, webhookSecret } from "./webhook-fixtures.ts";

const prUrl = "https://github.com/acme/demo/pull/7";
const headSha = "a".repeat(40);
const env = { PRONTO_WEBHOOK_SECRET: webhookSecret };

/** Simulated GitHub for one PR. The token's user is "Me", to show that logins match case-insensitively. */
function github(user: (response: ServerResponse) => void = (response) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ login: "Me" })), comments: object[] = [], target = prUrl) {
  const [, owner, repo, , number] = new URL(target).pathname.split("/");
  const repository = `/github/repos/${owner}/${repo}`;
  const pull = `${repository}/pulls/${number}`;
  const reviews: { event: string; body: string; commit_id: string }[] = [];
  const state = { merged: false, draft: false, labels: [] as string[], files: [] as object[] };
  const requests: string[] = [];
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url!.split("?")[0]!;
    requests.push(`${request.method} ${path}`);
    const json = (value: unknown): void => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
    if (request.method === "POST" && path === `${pull}/reviews`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      reviews.push(JSON.parse(Buffer.concat(chunks).toString()));
      return json({ html_url: `${target}#pullrequestreview-${reviews.length}` });
    }
    assert.equal(request.method, path === "/github/graphql" ? "POST" : "GET");
    if (path === "/github/user") return user(response);
    if (path === "/github/graphql") {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (path === pull) {
      return json({ html_url: target, title: "Served PR", body: "", merged: state.merged, draft: state.draft, labels: state.labels.map((name) => ({ name })), changed_files: state.files.length,
        head: { sha: headSha, repo: { full_name: "acme/demo" } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } });
    }
    assert.ok([`${pull}/comments`, `${pull}/reviews`, `${pull}/files`, `${repository}/issues/${number}/comments`].includes(path), path);
    if (path === `${pull}/files`) return json(state.files);
    json(path === `${pull}/reviews` ? reviews.map((review, index) => ({
      ...review, id: index + 1, user: { login: "Me" }, state: review.event === "APPROVE" ? "APPROVED" : "COMMENTED",
    })) : path === `${repository}/issues/${number}/comments` ? comments : []);
  };
  return { handler, reviews, requests, state };
}

const assess = (response: ServerResponse) => tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });

/** Collects a child's output and resolves when a pattern appears in it. */
function watchOutput(child: ChildProcessWithoutNullStreams, stream: "stdout" | "stderr" = "stdout") {
  let output = "";
  const waiters: { pattern: RegExp; resolve(match: RegExpMatchArray): void }[] = [];
  child[stream].on("data", (data) => {
    output += data;
    for (const waiter of [...waiters]) {
      const match = output.match(waiter.pattern);
      if (match) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(match);
      }
    }
  });
  return {
    get output() { return output; },
    until(pattern: RegExp): Promise<RegExpMatchArray> {
      const match = output.match(pattern);
      return match ? Promise.resolve(match) : new Promise((resolve) => waiters.push({ pattern, resolve }));
    },
  };
}

for (const verbose of [false, true]) {
  test(`serve ${verbose ? "verbose" : "compact"} logs track audits without changing delivery or verdict behaviour`, { timeout: 40_000 }, async (t) => {
    const gh = github();
    let modelCalls = 0;
    const preparationLogged = Promise.withResolvers<void>();
    t.after(() => preparationLogged.resolve());
    const f = await fixture(t, (_body, response) => {
      modelCalls++;
      tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] }, { prompt_tokens: 1000, completion_tokens: 500 });
    }, {
      entrypoint: resolve("src/cli/audit.ts"),
      modelCost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      github: async (request, response) => {
        // Hold the first GitHub fetch until preparation is visible, not just logged after the fetch.
        if (request.url === "/github/repos/acme/demo/pulls/7") await preparationLogged.promise;
        await gh.handler(request, response);
      },
    });
    const mcpToken = randomBytes(32).toString("hex");
    const run = f.start(["serve", "--port", "0", "--apply", ...(verbose ? ["--verbose", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"] : [])], {
      env: { ...env, PRONTO_MCP_TOKEN: mcpToken },
    });
    const out = watchOutput(run.child);
    const errors = watchOutput(run.child, "stderr");
    const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    const base = `http://127.0.0.1:${port}`;
    assert.match(out.output, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO\s+serve\s+Reviewing as Me with local\/test(?! · previews only)/m);

    const ignoredId = "ignored-delivery-id";
    assert.equal((await deliver(base, reviewRequested("someone-else", prUrl), { id: ignoredId })).status, 204);
    assert.equal((await deliver(base, "{}", { signature: null })).status, 401);
    await errors.until(/WARN\s+webhook\s+Rejected: missing or invalid signature/);
    assert.equal((await deliver(base, "{}", { event: "ping" })).status, 200);
    const mention = JSON.stringify({ action: "created", sender: { login: "maintainer" }, comment: { body: "Ready for another look, @me?", user: { login: "author" } },
      issue: { html_url: prUrl, pull_request: { html_url: prUrl } } });
    const accepted = await deliver(base, mention, { event: "issue_comment" });
    assert.equal(accepted.status, 202);
    assert.equal(((await accepted.json()) as { status: string }).status, "queued");
    await out.until(/INFO\s+acme\/demo#7\s+Preparing · fetching GitHub evidence/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Queued · mentioned in a pull request comment/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Triggered by GitHub webhook/);
    assert.doesNotMatch(out.output, /Started ·/);
    assert.equal(modelCalls, 0);
    preparationLogged.resolve();
    await out.until(/INFO\s+acme\/demo#7\s+Review: /);
    assert.equal(gh.reviews.length, 1);
    assert.equal(gh.reviews[0]!.event, "COMMENT");
    assert.equal(gh.reviews[0]!.commit_id, headSha);
    assert.match(gh.reviews[0]!.body, /Review audit/);

    // A repeat request reuses the assessment and does not post the same verdict again.
    const repeat = await deliver(base, reviewRequested("me", prUrl, "alice"));
    assert.equal(repeat.status, 202);
    await out.until(/INFO\s+acme\/demo#7\s+Reusing saved assessment/);
    await out.until(/INFO\s+acme\/demo#7\s+Already submitted/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Already submitted · 0 addressed · 0 outstanding · 0 uncertain · 0 not actionable · \d+\.\ds · US\$0(?:\n|$)/);
    assert.equal(gh.reviews.length, 1);
    assert.equal(modelCalls, 1);
    if (verbose) {
      const reads = gh.requests.length;
      const client = new Client({ name: "combined-serve-client", version: "1" }, {
        versionNegotiation: { mode: { pin: "2026-07-28" } }, supportedProtocolVersions: ["2026-07-28"],
      });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
      }));
      const skills = new SkillsClient(client);
      const entry = (await skills.list()).skills.find((entry) => entry.frontmatter.name === "pronto-audit-discussion");
      assert.ok(entry);
      assert.equal((await skills.read(entry)).verified, true);
      const saved = await client.callTool({ name: "read_audit", arguments: { prUrl } });
      assert.ok(!saved.isError, JSON.stringify(saved));
      const page = saved.structuredContent as { audit: { prUrl: string; headSha: string; status: string }; content: string };
      assert.equal(page.audit.prUrl, prUrl);
      assert.equal(page.audit.headSha, headSha);
      assert.equal(page.audit.status, "completed");
      assert.deepEqual(JSON.parse(page.content).findings, []);
      await out.until(/INFO\s+mcp\s+pronto-audits\/read_audit completed · duration=\d+\.\d+ms/);
      assert.match(out.output, /INFO\s+mcp\s+pronto-audits\/read_audit started/);
      const missing = await client.callTool({ name: "read_audit", arguments: { prUrl: "https:\/\/github.com\/acme\/demo\/pull\/999" } });
      assert.equal(missing.isError, true);
      await out.until(/INFO\s+mcp\s+pronto-audits\/read_audit failed · duration=\d+\.\d+ms/);
      assert.equal(gh.requests.length, reads, "MCP discovery and saved reads must not fetch GitHub or enter the audit lifecycle");
      assert.equal(modelCalls, 1, "sharing the listener must not start another assessment");
      assert.equal((await deliver(base, "{}", { event: "ping", path: "/mcp" })).status, 401, "a valid webhook signature is not an MCP credential");
      const bearerOnly = await fetch(`${base}/webhook`, { method: "POST", headers: { Authorization: `Bearer ${mcpToken}` }, body: "{}" });
      assert.equal(bearerOnly.status, 401, "MCP credentials must not authorise webhook admission");
      assert.equal((await deliver(base, "{}", { event: "ping" })).status, 200, "signed webhooks still work on the same port");
      await client.close();
    } else {
      assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${mcpToken}` }, body: "{}" })).status, 404,
        "configuring a token must not expose MCP without --mcp");
    }
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Queued · mentioned in a pull request comment · requester=maintainer/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+(Queued|Re-run queued) · review requested · requester=alice/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Started · 0 comments/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Completed · 0 addressed · 0 outstanding · 0 uncertain · 0 not actionable · \d+\.\ds · US\$0\.02/);
    if (verbose) {
      assert.match(out.output, /DEBUG\s+webhook\s+Ignored: review not requested from this user.*delivery=ignored-delivery-id/);
      assert.match(out.output, /DEBUG\s+acme\/demo#7\s+report_review_assessment/);
      assert.match(out.output, /PR review audit/);
    } else {
      assert.doesNotMatch(out.output, /DEBUG|Ignored:|ignored-delivery-id|report_review_assessment|PR review audit|Verdict comment preview/);
    }

    run.child.kill("SIGTERM");
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Received SIGTERM; stopping/);
    assert.equal(gh.reviews.length, 1);
    for (const line of result.stdout.trim().split("\n")) {
      assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO|DEBUG)\s+(serve|webhook|mcp|acme\/demo#7)\s+\S/,
        "every line, including multiline reports, needs its own timestamp, level and context");
    }
  });
}

for (const { migration, apply, verbose, outcome } of [
  { migration: false, apply: true, verbose: false, outcome: "Approved" },
  { migration: false, apply: false, verbose: false, outcome: "Preview only · would approve" },
  { migration: true, apply: false, verbose: true, outcome: "Preview only · would comment" },
]) {
  test(`serve logs ${outcome}${migration ? " when migration approval is blocked" : ""}`, { timeout: 20_000 }, async (t) => {
    const evidence = `${prUrl}#issuecomment-1`;
    const gh = github(undefined, [{ id: 1, body: "Please check compatibility and failure handling.", html_url: evidence,
      user: { login: "reviewer" }, created_at: "2026-01-01T00:00:00Z" }]);
    const statuses = migration ? ["addressed", "outstanding", "uncertain", "not-actionable"] : ["addressed", "not-actionable"];
    let modelCalls = 0;
    const f = await fixture(t, (_body, response) => {
      modelCalls++;
      tool(response, "report_review_assessment", {
        databaseMigration: migration ? { status: "migration", reason: "Adds a database column." } : noDatabaseMigration,
        assessments: [{ commentKey: "comment:1", findings: statuses.map((status) => ({
          summary: `A ${status} finding`, status, reason: "Assessment supplied by the model fixture.", awaiting: "reviewer", evidence: [evidence],
        })) }],
      });
    }, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
    const run = f.start(["serve", "--port", "0", "--approve", ...(apply ? ["--apply"] : []), ...(verbose ? ["--verbose"] : [])], { env });
    const out = watchOutput(run.child);
    const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
    await out.until(new RegExp(`INFO\\s+acme/demo#7\\s+${outcome}`));
    if (apply) {
      const mention = JSON.stringify({ action: "created", sender: { login: "author" }, comment: { body: "Another look, @me?", user: { login: "author" } },
        issue: { html_url: prUrl, pull_request: { html_url: prUrl } } });
      assert.equal((await deliver(`http://127.0.0.1:${port}`, mention, { event: "issue_comment" })).status, 202);
      await out.until(/Skipped · PR is already approved/);
      assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
      // The second skip cannot run until the first finishes, so a stray skip POST is observable.
      await out.until(/Skipped · PR is already approved[\s\S]*Skipped · PR is already approved/);
    }
    run.child.kill("SIGTERM");
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.reviews.length, apply ? 1 : 0, "later mentions and review requests must not post skip reviews after approval");
    assert.equal(modelCalls, 1, "an approved head must not be reassessed for later requests");
    if (apply) assert.equal(gh.reviews[0]!.event, "APPROVE");
    else assert.match(result.stdout, /previews only, add --apply to submit reviews/);
    assert.match(result.stdout, migration
      ? /1 addressed · 1 outstanding · 1 uncertain · 1 not actionable/
      : /1 addressed · 0 outstanding · 0 uncertain · 1 not actionable/);
    if (migration) assert.match(result.stdout, /Approval blocked:.*database migration/i);
    if (verbose) assert.match(result.stdout, /DEBUG\s+acme\/demo#7\s+Verdict comment preview:/);
    else assert.doesNotMatch(result.stdout, /Verdict comment preview|PR review audit/);
  });
}

/** A model that hangs on its first request, so the first audit is still unfinished when its server is stopped. */
function hangingModel() {
  const started = Promise.withResolvers<void>();
  const calls = { count: 0 };
  const respond = (_body: unknown, response: ServerResponse) => {
    if (++calls.count === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": pending\n\n");
      started.resolve();
    } else assess(response);
  };
  return { started: started.promise, calls, respond };
}

async function interruptedServe(f: Awaited<ReturnType<typeof fixture>>, model: ReturnType<typeof hangingModel>, signal: "SIGKILL" | "SIGTERM", args: string[] = []) {
  const first = f.start(["serve", "--port", "0", ...args], { env });
  const [, port] = await watchOutput(first.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
  await model.started;
  first.child.kill(signal);
  await first.done;
}

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`serve drains 202-accepted waiting work and deduplicates deliveries after ${signal}`, { timeout: 30_000 }, async (t) => {
    const queuedUrl = "https://github.com/acme/queued/pull/8";
    const siblingUrl = "https://github.com/acme/demo/pull/8";
    const active = github();
    const sibling = github(undefined, [], siblingUrl);
    const waiting = github(undefined, [], queuedUrl);
    const model = hangingModel();
    let restarting = false;
    const checking = Promise.withResolvers<void>();
    let liveChecks = 0;
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const f = await fixture(t, model.respond, {
      entrypoint: resolve("src/cli/audit.ts"),
      github: async (request, response) => {
        if (restarting && /^\/github\/repos\/acme\/demo\/pulls\/[78]$/.test(request.url!)) {
          if (++liveChecks === 2) checking.resolve();
          await release.promise;
        }
        const gh = request.url?.includes("/acme/queued/") ? waiting
          : /\/demo\/(?:pulls|issues)\/8(?:\/|$)/.test(request.url!) ? sibling : active;
        await gh.handler(request, response);
      },
    });
    const first = f.start(["serve", "--port", "0", "--concurrency", "1"], { env });
    const [, port] = await watchOutput(first.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await deliver(base, reviewRequested("me", prUrl))).status, 202);
    await model.started;
    const originalChecks = active.requests.filter((request) => request.endsWith("/pulls/7")).length;
    assert.deepEqual(await (await deliver(base, reviewRequested("me", siblingUrl))).json(), { status: "queued" });
    // Concurrent redeliveries must atomically admit one waiting task, not several executions.
    const id = "durable-waiting-delivery";
    const responses = await Promise.all(Array.from({ length: 8 }, () => deliver(base, reviewRequested("me", queuedUrl), { id })));
    assert.ok(responses.every((response) => response.status === 202));
    const statuses = await Promise.all(responses.map(async (response) => ((await response.json()) as { status: string }).status));
    assert.equal(statuses.filter((status) => status === "queued").length, 1);
    assert.equal(statuses.filter((status) => status === "duplicate").length, 7);
    assert.equal(waiting.requests.length, 0, "202 was returned before this PR began execution");
    assert.deepEqual(await (await deliver(base, reviewRequested("me", prUrl), { id: "rerun" })).json(), { status: "rerun" });
    assert.deepEqual(await (await deliver(base, reviewRequested("me", "https://github.com/ACME/Demo/pull/7/"))).json(), { status: "coalesced" });
    first.child.kill(signal);
    await first.done;

    restarting = true;
    active.state.merged = sibling.state.merged = waiting.state.merged = true;
    const second = f.start(["serve", "--port", "0", "--concurrency", "2"], { env });
    const out = watchOutput(second.child);
    const [, resumedPort] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    const resumedBase = `http://127.0.0.1:${resumedPort}`;
    await checking.promise;
    const cli = f.start([queuedUrl]);
    cli.child.stdin.end();
    const locked = await cli.done;
    assert.equal(locked.code, 1, "recovery must retain a repository with only pending intake work");
    assert.match(locked.stderr, /Database is already in use/);
    assert.equal(liveChecks, 2, "independent PRs in one repository must use both available slots");
    assert.equal(waiting.requests.length, 0, "the global cap still applies across repository databases");
    assert.deepEqual(await (await deliver(resumedBase, reviewRequested("me", queuedUrl), { id })).json(), { status: "duplicate" });
    assert.deepEqual(await (await deliver(resumedBase, reviewRequested("me", queuedUrl))).json(), { status: "coalesced" });
    release.resolve();
    await out.until(/Skipped[\s\S]*Skipped[\s\S]*Skipped[\s\S]*Skipped/);
    const preparing = [...out.output.matchAll(/(acme\/\S+)\s+Preparing/g)].map((match) => match[1]);
    assert.ok(preparing.indexOf("acme/queued#8") < preparing.lastIndexOf("acme/demo#7"), "the saved rerun stays behind other waiting PRs");
    assert.equal(sibling.requests.filter((request) => request.endsWith("/pulls/8")).length, 1, "staging recovery must not readmit a running sibling as a rerun");
    assert.equal(waiting.requests.filter((request) => request.endsWith("/pulls/8")).length, 1);
    assert.equal(active.requests.filter((request) => request.endsWith("/pulls/7")).length, originalChecks + 2, "exactly two executions after restart, retaining the original URL");
    assert.equal(model.calls.count, 1, "live skips must keep resumed model work gated");
    second.child.kill("SIGTERM");
    assert.equal((await second.done).code, 0);
  });

  for (const apply of [true, false]) test(`serve resumes ${apply ? "an applied" : "a preview"} audit after ${signal} without inferring new publication flags`, { timeout: 40_000 }, async (t) => {
    const gh = github();
    const model = hangingModel();
    const f = await fixture(t, model.respond, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
    await interruptedServe(f, model, signal, apply ? ["--apply"] : []);
    assert.equal(gh.reviews.length, 0);

    const second = f.start(["serve", "--port", "0", ...(apply ? [] : ["--apply"])], { env });
    const out = watchOutput(second.child);
    await out.until(/INFO\s+acme\/demo#7\s+Recovering audit/);
    await out.until(/INFO\s+acme\/demo#7\s+Resuming saved snapshot/);
    await out.until(/INFO\s+acme\/demo#7\s+(Review: |Preview only)/);
    assert.equal(gh.reviews.length, apply ? 1 : 0, "startup flags must not change an admitted assessment's publication choices");
    assert.equal(model.calls.count, 2, "the interrupted request is retried, not a new audit");
    second.child.kill("SIGTERM");
    const result = await second.done;
    assert.equal(result.code, 0, result.stderr);
  });
}

for (const failure of ["model error", "missing assessment"] as const) {
  test(`serve retries the latest ${failure} once per startup without falling back to an older success`, { timeout: 40_000 }, async (t) => {
    const gh = github();
    let calls = 0;
    const f = await fixture(t, (_body, response) => {
      calls++;
      if (calls === 1 || calls >= 4) assess(response);
      else if (failure === "model error") {
        response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Model unavailable" } }));
      } else reply(response, [{ role: "assistant", content: "No structured report." }]);
    }, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
    // Keep an older, reusable success: recovery must retry the latest failed attempt, not reuse it.
    await f.run("", [prUrl]);
    const failed = f.start(["--force", "--apply", prUrl]);
    failed.child.stdin.end();
    assert.equal((await failed.done).code, 1);
    assert.equal(calls, 2);

    for (const expectedCalls of [3, 4]) {
      const run = f.start(["serve", "--port", "0", "--apply"], { env });
      const out = watchOutput(run.child);
      const errors = watchOutput(run.child, "stderr");
      const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
      assert.match(out.output, /INFO\s+acme\/demo#7\s+Recovering audit/);
      if (expectedCalls === 3) {
        await errors.until(/ERROR\s+acme\/demo#7\s+Audit failed:/);
        if (failure === "model error") assert.match(errors.output, /WARN\s+acme\/demo#7\s+conversation=\d+ Model HTTP error:.*status=401/);
        assert.doesNotMatch(out.output, /INFO\s+acme\/demo#7\s+(Completed|Approved|Review:)/);
      } else await out.until(/INFO\s+acme\/demo#7\s+Review: /);
      assert.match(out.output, /Retrying failed audit after startup recovery/);
      assert.doesNotMatch(out.output, /--force requested/, "startup recovery must not claim a user requested --force");
      assert.equal(calls, expectedCalls, "each startup admits one fresh assessment, without another webhook");
      assert.equal(gh.reviews.length, expectedCalls === 3 ? 0 : 1);
      run.child.kill("SIGTERM");
      assert.equal((await run.done).code, 0);
    }
    assert.equal(gh.requests.filter((path) => path === "GET /github/repos/acme/demo/pulls/7/comments").length, 4,
      "failed assessments must fetch fresh evidence on recovery");

    const run = f.start(["serve", "--port", "0", "--apply"], { env });
    const out = watchOutput(run.child);
    const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assert.doesNotMatch(out.output, /Recovering audit/,
      "successful and superseded failed attempts must not be recovered");
    run.child.kill("SIGTERM");
    assert.equal((await run.done).code, 0);
    assert.equal(calls, 4);
    assert.equal(gh.reviews.length, 1);
  });
}

test("serve retains a bounded delivery window across restart", { timeout: 30_000 }, async (t) => {
  const gh = github();
  gh.state.merged = true;
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const first = f.start(["serve", "--port", "0"], { env });
  const out = watchOutput(first.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const base = `http://127.0.0.1:${port}`;
  const body = reviewRequested("me", prUrl);
  // Finish an audit before filling the window: deduplication must outlive queue entries too.
  assert.equal((await deliver(base, body, { id: "finished" })).status, 202);
  await out.until(/Skipped · PR has already been merged/);
  for (let i = 0; i < 1000; i += 50) {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, n) => deliver(base, body, { id: `window-${i + n}` })));
    assert.ok(responses.every((response) => response.status === 202));
  }
  first.child.kill("SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = f.start(["serve", "--port", "0"], { env });
  const [, resumedPort] = await watchOutput(second.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const resumed = `http://127.0.0.1:${resumedPort}`;
  assert.deepEqual(await (await deliver(resumed, body, { id: "window-999" })).json(), { status: "duplicate" });
  const oldest = await deliver(resumed, body, { id: "finished" });
  assert.equal(oldest.status, 202);
  assert.notEqual(((await oldest.json()) as { status: string }).status, "duplicate", "only the last 1000 accepted IDs per repository are retained");
  second.child.kill("SIGTERM");
  assert.equal((await second.done).code, 0);
});

for (const { initial, restart, posts } of [
  { initial: ["--apply", "--report-skips"], restart: [], posts: true },
  { initial: ["--apply"], restart: ["--apply", "--report-skips"], posts: false },
  { initial: ["--report-skips"], restart: ["--apply", "--report-skips"], posts: false },
]) {
  test(`serve retains skip reporting choices when a resumed PR was merged (${initial.join(" ") || "defaults"})`, { timeout: 40_000 }, async (t) => {
    const gh = github();
    const model = hangingModel();
    const f = await fixture(t, model.respond, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
    await interruptedServe(f, model, "SIGKILL", initial);
    gh.state.merged = true;
    const second = f.start(["serve", "--port", "0", ...restart], { env });
    const out = watchOutput(second.child);
    await out.until(/INFO\s+acme\/demo#7\s+Recovering audit/);
    await out.until(/INFO\s+acme\/demo#7\s+Skipped · PR has already been merged\./);
    if (posts) await out.until(/INFO\s+acme\/demo#7\s+Review: /);
    second.child.kill("SIGTERM");
    assert.equal((await second.done).code, 0);
    assert.equal(model.calls.count, 1, "a merged PR must not resume model work");
    assert.equal(gh.reviews.length, posts ? 1 : 0, "recovery must retain the original skip-reporting and apply choices");
    if (posts) assert.match(gh.reviews[0]!.body, /PR has already been merged/);
  });
}

test("serve does not hold repository databases that have nothing to resume", { timeout: 40_000 }, async (t) => {
  const gh = github();
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  // A finished audit leaves its repository database with no unfinished work.
  await f.run("", [prUrl]);
  const run = f.start(["serve", "--port", "0"], { env });
  const out = watchOutput(run.child);
  await out.until(/Listening on /);
  assert.doesNotMatch(out.output, /Recovering audit/);
  const cli = await f.run("", [prUrl]);
  assert.match(cli, /Reusing saved assessment/, "the CLI must still be able to open the repository while the server runs");
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 0);
});

test("serve starts and reports a repository database that another process holds", { timeout: 40_000 }, async (t) => {
  const gh = github();
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const first = f.start(["serve", "--port", "0"], { env });
  const firstOut = watchOutput(first.child);
  const [, port] = await firstOut.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
  // Once it has audited the PR, the first server holds the repository's database.
  await firstOut.until(/Preview only · would comment/);

  const second = f.start(["serve", "--port", "0"], { env });
  const [, secondPort] = await watchOutput(second.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const secondBase = `http://127.0.0.1:${secondPort}`;
  const id = "refused-while-locked";
  assert.equal((await deliver(secondBase, reviewRequested("me", prUrl), { id })).status, 503,
    "a database lock failure must not acknowledge an in-memory-only job");
  first.child.kill("SIGTERM");
  assert.equal((await first.done).code, 0);
  assert.deepEqual(await (await deliver(secondBase, reviewRequested("me", prUrl), { id })).json(), { status: "queued" },
    "failed admission must not reserve the delivery ID");
  second.child.kill("SIGTERM");
  const result = await second.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /WARN\s+serve\s+Skipped github\.com\/acme~demo, so its audits are not recovered: .*Database is already in use/);
});

test("serve keeps an interrupted audit's work for a later run to resume", { timeout: 40_000 }, async (t) => {
  const gh = github();
  const started = Promise.withResolvers<void>();
  let modelCalls = 0;
  const f = await fixture(t, (_body, response) => {
    if (++modelCalls === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": pending\n\n");
      started.resolve();
    } else assess(response);
  }, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const run = f.start(["serve", "--port", "0"], { env });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  assert.match(out.output, /previews only, add --apply to submit reviews/);
  assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
  await started.promise;

  run.child.kill("SIGTERM");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /INFO\s+acme\/demo#7\s+Audit interrupted · saved work resumes/);
  assert.equal(gh.reviews.length, 0);

  const resumed = await f.run("", [prUrl]);
  assert.match(resumed, /Resuming saved snapshot/);
  assert.match(resumed, /Verdict:/);
  assert.equal(modelCalls, 2);
});

test("serve refuses to start without a webhook secret", { timeout: 20_000 }, async (t) => {
  const gh = github();
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const result = await f.start(["serve", "--port", "0"], { env: { PRONTO_WEBHOOK_SECRET: "" } }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PRONTO_WEBHOOK_SECRET is required/);
  assert.doesNotMatch(result.stdout, /Listening/);
  assert.deepEqual(gh.requests, [], "nothing should reach GitHub before the configuration is valid");
});

test("serve refuses to start when GitHub rejects the token", { timeout: 20_000 }, async (t) => {
  const gh = github((response) => response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" })));
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const result = await f.start(["serve", "--port", "0"], { env }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GitHub request failed \(401\)/);
  assert.doesNotMatch(result.stdout, /Listening/);
});

test("serve rejects unsupported options before any credentials are used", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts") });
  const result = await f.start(["serve", "--force"], { env }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--force is not supported by pronto serve/);
});

test("serve prints its usage without a secret or token", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("src/cli/audit.ts") });
  const output = await f.run("", ["serve", "--help"], { env: { PRONTO_WEBHOOK_SECRET: "" } });
  assert.match(output, /^Usage: pronto serve /m);
  assert.match(output, /PRONTO_WEBHOOK_SECRET must be set/);
  assert.match(output, /--concurrency <n>.*default: 4/);
  assert.match(output, /--verbose includes ignored deliveries/);
  assert.match(output, /--force and --pr are not supported/);
  assert.match(output, /--mcp exposes audit tools.*same HTTP listener/);
  assert.match(output, /PRONTO_MCP_TOKEN and --mcp-public-url/);
  const obsolete = await f.start(["mcp"], { env: { PRONTO_WEBHOOK_SECRET: "" } }).done;
  assert.equal(obsolete.code, 1);
  assert.match(obsolete.stderr, /Use pronto serve --mcp --mcp-public-url/);
});

test("serve rejects unsafe MCP configuration before credentials, recovery or listening", { timeout: 20_000 }, async (t) => {
  const gh = github();
  const f = await fixture(t, () => assert.fail("Invalid MCP configuration must not call a model"), { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const bearer = randomBytes(32).toString("hex");
  const url = "https://audits.example.test/mcp";
  const cases = [
    { args: [], bearer, error: /--mcp requires --mcp-public-url/ },
    { args: ["--mcp-public-url", url], bearer: "", error: /PRONTO_MCP_TOKEN/ },
    { args: ["--mcp-public-url", url], bearer: "short", error: /at least 32 characters/ },
    { args: ["--mcp-public-url", url], bearer, webhook: bearer, error: /must differ from PRONTO_WEBHOOK_SECRET/ },
    { args: ["--mcp-public-url", "http://audits.example.test/mcp"], bearer, error: /HTTPS.*loopback/ },
    { args: ["--mcp-public-url", "https://audits.example.test/webhook"], bearer, error: /path must differ/ },
    { args: ["--mcp-public-url", "https://audits.example.test/healthz"], bearer, error: /path must differ/ },
    { args: ["--mcp-public-url", "https://audits.example.test/readyz"], bearer, error: /path must differ/ },
    { args: ["--mcp-public-url", url, "--webhook-path", "/mcp"], bearer, error: /path must differ/ },
    { args: ["--mcp-public-url", url, "--mcp-allow-origin", "https://agents.example.test/path"], bearer, error: /HTTPS origin/ },
    { args: ["--mcp-public-url", url, "--replicated-state"], bearer, error: /not yet supported with --replicated-state/ },
    { args: ["--mcp-public-url", url, "--mcp"], bearer, error: /--mcp can be supplied only once/ },
    { args: ["--mcp-public-url", url, "--stdio"], bearer, error: /Unknown audit option/ },
  ];
  for (const check of cases) {
    const result = await f.start(["serve", "--mcp", ...check.args], { env: {
      ...env, PRONTO_WEBHOOK_SECRET: check.webhook ?? webhookSecret, PRONTO_MCP_TOKEN: check.bearer, PI_CODING_AGENT_DIR: `${f.directory}/no-model-login`,
    } }).done;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, check.error);
    assert.doesNotMatch(result.stdout, /Listening/);
    assert.ok(!result.stderr.includes(bearer), "configuration errors must not expose the token");
  }
  const notEnabled = await f.start(["serve", "--mcp-public-url", url], { env }).done;
  assert.equal(notEnabled.code, 1);
  assert.match(notEnabled.stderr, /MCP options require --mcp/);
  assert.deepEqual(gh.requests, [], "no credentials should reach GitHub before MCP configuration is valid");
});

async function auditMcpClient(url: string, token: string) {
  const client = new Client({ name: "audit-contract", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } }, supportedProtocolVersions: ["2026-07-28"],
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function runMcpAudit(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "run_audit", arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent as { apply: boolean; results: ({ prUrl: string; status: string; auditId?: number; cached?: boolean; reason?: string })[] };
}

test("one MCP credential reads and runs audits with CLI defaults, models, skips, cache and apply", { timeout: 30_000 }, async (t) => {
  const gh = github();
  gh.state.draft = true;
  gh.state.labels = ["blocked"];
  gh.state.files = [{ filename: "dist/bundle.js", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }];
  const modelNames: string[] = [];
  const f = await fixture(t, (body, response) => { modelNames.push(body.model); assess(response); },
    { entrypoint: resolve("src/cli/audit.ts"), github: async (request, response) => {
      if (request.url === "/github/graphql") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.variables.headRefName) {
          assert.equal(body.variables.headRefName, "feature/pr-inference");
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { repository: {
            defaultBranchRef: { name: "main" }, pullRequests: { nodes: [{ url: prUrl, state: "OPEN", headRefName: "feature/pr-inference", isCrossRepository: false }] },
          } } }));
          return;
        }
      }
      return gh.handler(request, response);
    } });
  const gitEnv = await gitCheckout(f.cwd);
  const modelPath = join(f.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelPath, "utf8"));
  models.providers.local.models.push({ id: "variant", contextWindow: 128000, maxTokens: 1000 });
  await writeFile(modelPath, JSON.stringify(models));
  const token = randomBytes(32).toString("hex");
  const run = f.start(["serve", "--port", "0", "--apply", "--approve", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"], {
    env: { ...gitEnv, ...env, GH_REPO: "acme/demo", PRONTO_MCP_TOKEN: token },
  });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const url = `http://127.0.0.1:${port}/mcp`;
  const client = await auditMcpClient(url, token);
  t.after(() => client.close());
  const auditTool = (await client.listTools()).tools.find((tool) => tool.name === "run_audit");
  assert.ok(auditTool);
  assert.equal(auditTool.annotations?.readOnlyHint, false);

  const skipped = await runMcpAudit(client, { targets: [prUrl] });
  assert.match(skipped.results[0]!.reason!, /draft/);
  const runAuditStart = await out.until(/INFO\s+mcp\s+pronto-audits\/run_audit started requestId=([0-9a-f-]+)/);
  const requestId = runAuditStart[1]!;
  await out.until(new RegExp(`INFO\\s+mcp\\s+pronto-audits/run_audit completed requestId=${requestId} · duration=\\d+\\.\\d+ms`));
  await out.until(new RegExp(`INFO\\s+acme/demo#7\\s+Triggered by MCP tool run_audit requestId=${requestId}`));
  assert.equal(skipped.apply, false, "webhook --apply must not leak into remote CLI defaults");
  const labelled = await runMcpAudit(client, { targets: [prUrl], skipDrafts: false, skipLabels: ["unused", "BLOCKED"] });
  assert.match(labelled.results[0]!.reason!, /matching skip label/);
  assert.equal(gh.reviews.length, 0);
  assert.deepEqual(modelNames, []);

  const args = { targets: ["7"], model: "local/variant", skipDrafts: false, exclude: ["dist/**"] };
  const first = await runMcpAudit(client, args);
  assert.equal(first.results[0]!.status, "completed");
  assert.equal(first.results[0]!.prUrl, prUrl);
  assert.equal(first.results[0]!.cached, false);
  assert.deepEqual(modelNames, ["variant"]);
  assert.equal(gh.reviews.length, 0);
  const saved = await client.callTool({ name: "read_audit", arguments: { prUrl, auditId: first.results[0]!.auditId } });
  const savedPage = saved.structuredContent as { auditRef: string; audit: { status: string } };
  assert.equal(savedPage.audit.status, "completed");
  await out.until(/INFO\s+mcp\s+pronto-audits\/read_audit completed · duration=\d+\.\d+ms/);
  const rejectedFile = await client.callTool({ name: "read_github_file", arguments: { auditRef: savedPage.auditRef, path: "../seed.txt", revision: "head" } });
  assert.equal(rejectedFile.isError, true);
  await out.until(/INFO\s+mcp\s+pronto-audits\/read_github_file failed · duration=\d+\.\d+ms/);
  const files = await client.callTool({ name: "read_audit", arguments: { prUrl, auditId: first.results[0]!.auditId, section: "files" } });
  const file = JSON.parse((files.structuredContent as { content: string }).content)[0];
  assert.equal(file.excluded, true);
  assert.equal(file.patch, null);
  const cached = await runMcpAudit(client, args);
  assert.equal(cached.results[0]!.cached, true);
  const currentBranch = await runMcpAudit(client, { model: "local/variant", skipDrafts: false, exclude: ["dist/**"] });
  assert.equal(currentBranch.results[0]!.prUrl, prUrl);
  assert.equal(currentBranch.results[0]!.cached, true);
  const forced = await runMcpAudit(client, { ...args, force: true });
  assert.notEqual(forced.results[0]!.auditId, first.results[0]!.auditId);
  assert.deepEqual(modelNames, ["variant", "variant"]);
  await runMcpAudit(client, { ...args, apply: true, approve: true });
  assert.equal(gh.reviews.length, 1);
  assert.equal(gh.reviews[0]!.event, "APPROVE");
  const approved = await runMcpAudit(client, args);
  assert.match(approved.results[0]!.reason!, /already approved/);
  assert.equal((await runMcpAudit(client, { ...args, skipApproved: false })).results[0]!.status, "completed");
  const duplicate = await client.callTool({ name: "run_audit", arguments: { targets: [prUrl, `${prUrl}/`] } });
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate), /Duplicate PR target/);
  const invalidModel = await client.callTool({ name: "run_audit", arguments: { targets: [prUrl], model: "local/missing" } });
  assert.equal(invalidModel.isError, true);
  assert.match(JSON.stringify(invalidModel), /No available model/);
  assert.equal(gh.reviews.length, 1);
  const many = Array.from({ length: 101 }, (_, index) => `unused-${index}`);
  const expanded = await runMcpAudit(client, { ...args, skipApproved: false, skipLabels: many, exclude: many });
  assert.equal(expanded.results[0]!.status, "completed");
  const manyTargets = await client.callTool({ name: "run_audit", arguments: { targets: Array(101).fill(prUrl) } });
  assert.equal(manyTargets.isError, true);
  assert.match(JSON.stringify(manyTargets), /Duplicate PR target/);
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 0);
});

test("MCP skip reporting is opt-in and independent of webhook startup flags", { timeout: 30_000 }, async (t) => {
  const gh = github();
  gh.state.merged = true;
  const f = await fixture(t, () => assert.fail("A skipped PR must not reach the model"),
    { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const token = randomBytes(32).toString("hex");
  const run = f.start(["serve", "--port", "0", "--apply", "--report-skips", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"],
    { env: { ...env, PRONTO_MCP_TOKEN: token } });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const base = `http://127.0.0.1:${port}`;
  const client = await auditMcpClient(`${base}/mcp`, token);
  t.after(() => client.close());
  const args = { targets: [prUrl] };

  for (const options of [{ apply: true }, { apply: true, reportSkips: false }, { reportSkips: true }]) {
    const skipped = await runMcpAudit(client, { ...args, ...options });
    assert.equal(skipped.results[0]!.status, "skipped");
    assert.match(skipped.results[0]!.reason!, /already been merged/);
    assert.equal(gh.reviews.length, 0, "MCP requires both apply and reportSkips despite serve flags");
  }
  await runMcpAudit(client, { ...args, apply: true, reportSkips: true, approve: true });
  assert.equal(gh.reviews.length, 1);
  assert.equal(gh.reviews[0]!.event, "COMMENT");
  assert.match(gh.reviews[0]!.body, /PR has already been merged/);
  await runMcpAudit(client, { ...args, apply: true, reportSkips: true });
  assert.equal(gh.reviews.length, 1, "a matching skip review is not repeated");

  gh.state.merged = false;
  gh.state.draft = true;
  assert.equal((await deliver(base, reviewRequested("me", prUrl))).status, 202);
  await out.until(/Skipped · PR is a draft[\s\S]*Review: /);
  assert.equal(gh.reviews.length, 2, "webhook startup flags enable skip reporting independently");
  assert.equal(gh.reviews[1]!.event, "COMMENT");
  assert.match(gh.reviews[1]!.body, /PR is a draft/);
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 0);
});

test("MCP approval flags preserve migration and uncertain-finding safeguards", { timeout: 30_000 }, async (t) => {
  const evidence = `${prUrl}#issuecomment-1`;
  const gh = github(undefined, [{ id: 1, body: "Please check compatibility.", html_url: evidence,
    user: { login: "reviewer" }, created_at: "2026-01-01T00:00:00Z" }]);
  let calls = 0;
  const f = await fixture(t, (_body, response) => {
    calls++;
    tool(response, "report_review_assessment", { databaseMigration: { status: "migration", reason: "Adds a column." },
      assessments: [{ commentKey: "comment:1", findings: [{ summary: "Compatibility", status: "uncertain", reason: "Needs verification.", awaiting: "reviewer", evidence: [evidence] }] }] });
  }, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const token = randomBytes(32).toString("hex");
  const run = f.start(["serve", "--port", "0", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"],
    { env: { ...env, PRONTO_MCP_TOKEN: token } });
  const [, port] = await watchOutput(run.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const client = await auditMcpClient(`http://127.0.0.1:${port}/mcp`, token);
  t.after(() => client.close());
  const args = { targets: [prUrl], approve: true };
  await runMcpAudit(client, { ...args, allowUncertain: true, approveMigrations: true });
  assert.equal(gh.reviews.length, 0, "approval options alone must not publish");
  await runMcpAudit(client, { ...args, apply: true });
  assert.equal(gh.reviews[0]!.event, "COMMENT");
  await runMcpAudit(client, { ...args, apply: true, allowUncertain: true, approveMigrations: true });
  assert.equal(gh.reviews[1]!.event, "APPROVE");
  assert.equal(calls, 1, "publication choices must not force another assessment");
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 0);
});

test("MCP batches and webhooks share the concurrency limit and serialize the same PR", { timeout: 30_000 }, async (t) => {
  const secondUrl = "https://github.com/acme/demo/pull/8";
  const first = github();
  const second = github(undefined, [], secondUrl);
  const started = Promise.withResolvers<void>();
  let held: ServerResponse | undefined;
  let released = false;
  let secondStartedEarly = false;
  let calls = 0;
  const f = await fixture(t, (_body, response) => {
    calls++;
    if (calls === 1) { held = response; started.resolve(); }
    else assess(response);
  }, { entrypoint: resolve("src/cli/audit.ts"), github: async (request, response) => {
    if (request.url === "/github/repos/acme/demo/pulls/9") { response.writeHead(503).end("Unavailable"); return; }
    if (/\/(?:pulls|issues)\/8(?:\/|\?|$)/.test(request.url!)) {
      if (!released) secondStartedEarly = true;
      return second.handler(request, response);
    }
    return first.handler(request, response);
  } });
  const token = randomBytes(32).toString("hex");
  const run = f.start(["serve", "--port", "0", "--concurrency", "1", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"],
    { env: { ...env, PRONTO_MCP_TOKEN: token } });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const base = `http://127.0.0.1:${port}`;
  const client = await auditMcpClient(`${base}/mcp`, token);
  t.after(() => client.close());
  const batch = runMcpAudit(client, { targets: [prUrl, secondUrl] });
  await started.promise;
  assert.equal((await deliver(base, reviewRequested("me", prUrl))).status, 202);
  // Give an incorrectly unbounded second request time to enter GitHub while PR 7 is held.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(secondStartedEarly, false);
  released = true;
  assess(held!);
  const result = await batch;
  assert.deepEqual(result.results.map((item) => [item.prUrl, item.status]), [[prUrl, "completed"], [secondUrl, "completed"]]);
  await out.until(/acme\/demo#7\s+Reusing saved assessment/);
  assert.equal(calls, 2, "the queued webhook should recheck rather than lose or duplicate the running audit");
  const failedUrl = "https://github.com/acme/demo/pull/9";
  const partial = await client.callTool({ name: "run_audit", arguments: { targets: [prUrl, failedUrl] } });
  assert.equal(partial.isError, true);
  const results = (partial.structuredContent as { results: { prUrl: string; status: string; error?: string }[] }).results;
  assert.deepEqual(results.map(({ prUrl: url, status }) => [url, status]), [[prUrl, "completed"], [failedUrl, "failed"]]);
  assert.match(results[1]!.error!, /GitHub request failed/);
  run.child.kill("SIGTERM");
  const stopped = await run.done;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.doesNotMatch(stopped.stderr, /already in progress/);
});

test("cancelling a queued MCP audit prevents it from starting", { timeout: 30_000 }, async (t) => {
  const secondUrl = "https://github.com/acme/demo/pull/8";
  const first = github();
  const second = github(undefined, [], secondUrl);
  const started = Promise.withResolvers<void>();
  let held: ServerResponse | undefined;
  let calls = 0;
  const f = await fixture(t, (_body, response) => {
    if (++calls === 1) { held = response; started.resolve(); }
    else assess(response);
  }, { entrypoint: resolve("src/cli/audit.ts"), github: (request, response) =>
    /\/(?:pulls|issues)\/8(?:\/|\?|$)/.test(request.url!) ? second.handler(request, response) : first.handler(request, response) });
  const token = randomBytes(32).toString("hex");
  const run = f.start(["serve", "--port", "0", "--concurrency", "1", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"],
    { env: { ...env, PRONTO_MCP_TOKEN: token } });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const client = await auditMcpClient(`http://127.0.0.1:${port}/mcp`, token);
  t.after(() => client.close());
  const controller = new AbortController();
  // The runner schedules the whole batch before the first model call can start.
  const batch = client.callTool({ name: "run_audit", arguments: { targets: [prUrl, secondUrl] } }, { signal: controller.signal }).catch((error) => error);
  await started.promise;
  controller.abort();
  await batch;
  const resumed = runMcpAudit(client, { targets: [prUrl] });
  await out.until(/acme\/demo#7\s+Resuming saved snapshot/);
  assess(held!);
  assert.equal((await resumed).results[0]!.status, "completed");
  assert.deepEqual(second.requests, [], "a cancelled queued request must not fetch PR evidence later");
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 0);
});

test("an interrupted MCP audit is recovered by serve after shutdown", { timeout: 30_000 }, async (t) => {
  const gh = github();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, (_body, response) => {
    if (++calls === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": pending\n\n");
      started.resolve();
    } else assess(response);
  }, { entrypoint: resolve("src/cli/audit.ts"), github: gh.handler });
  const token = randomBytes(32).toString("hex");
  const args = ["serve", "--port", "0", "--mcp", "--mcp-public-url", "https://audits.example.test/mcp"];
  const launch = { env: { ...env, PRONTO_MCP_TOKEN: token } };
  const initial = f.start(args, launch);
  const [, port] = await watchOutput(initial.child).until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const client = await auditMcpClient(`http://127.0.0.1:${port}/mcp`, token);
  t.after(() => client.close());
  const pending = client.callTool({ name: "run_audit", arguments: { targets: [prUrl], apply: true } }).catch(() => undefined);
  await started.promise;
  initial.child.kill("SIGTERM");
  const stopped = await initial.done;
  assert.equal(stopped.code, 0, stopped.stderr);
  await pending;
  const resumed = f.start(args, launch);
  const out = watchOutput(resumed.child);
  await out.until(/acme\/demo#7\s+Review: /);
  assert.equal(calls, 2);
  assert.equal(gh.reviews.length, 1, "saved explicit apply must survive interruption");
  resumed.child.kill("SIGTERM");
  assert.equal((await resumed.done).code, 0);
});
