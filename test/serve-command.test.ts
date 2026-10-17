import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { fixture, noDatabaseMigration, reply, tool } from "./fixtures.ts";
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
  const state = { merged: false };
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
      return json({ title: "Served PR", body: "", merged: state.merged, draft: false, labels: [], changed_files: 0,
        head: { sha: headSha, repo: { full_name: "acme/demo" } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } });
    }
    assert.ok([`${pull}/comments`, `${pull}/reviews`, `${pull}/files`, `${repository}/issues/${number}/comments`].includes(path), path);
    json(path === `${repository}/issues/${number}/comments` ? comments : []);
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
      entrypoint: resolve("audit.ts"),
      modelCost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      github: async (request, response) => {
        // Hold the first GitHub fetch until preparation is visible, not just logged after the fetch.
        if (request.url === "/github/repos/acme/demo/pulls/7") await preparationLogged.promise;
        await gh.handler(request, response);
      },
    });
    const run = f.start(["serve", "--port", "0", "--apply", ...(verbose ? ["--verbose"] : [])], { env });
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
    assert.match(out.output, /Queued · mentioned in a pull request comment[^\n]*\n[^\n]*Preparing · fetching GitHub evidence/);
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
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Already submitted · 0 addressed · 0 outstanding · 0 uncertain · 0 not actionable · \d+\.\ds · est\. \$0(?:\n|$)/);
    assert.equal(gh.reviews.length, 1);
    assert.equal(modelCalls, 1);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Queued · mentioned in a pull request comment · requester=maintainer/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+(Queued|Re-run queued) · review requested · requester=alice/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Started · 0 comments/);
    assert.match(out.output, /INFO\s+acme\/demo#7\s+Completed · 0 addressed · 0 outstanding · 0 uncertain · 0 not actionable · \d+\.\ds · est\. \$0\.02/);
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
      assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO|DEBUG)\s+(serve|webhook|acme\/demo#7)\s+\S/,
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
    const f = await fixture(t, (_body, response) => tool(response, "report_review_assessment", {
      databaseMigration: migration ? { status: "migration", reason: "Adds a database column." } : noDatabaseMigration,
      assessments: [{ commentKey: "comment:1", findings: statuses.map((status) => ({
        summary: `A ${status} finding`, status, reason: "Assessment supplied by the model fixture.", awaiting: "reviewer", evidence: [evidence],
      })) }],
    }), { entrypoint: resolve("audit.ts"), github: gh.handler });
    const run = f.start(["serve", "--port", "0", "--approve", ...(apply ? ["--apply"] : []), ...(verbose ? ["--verbose"] : [])], { env });
    const out = watchOutput(run.child);
    const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
    assert.equal((await deliver(`http://127.0.0.1:${port}`, reviewRequested("me", prUrl))).status, 202);
    await out.until(new RegExp(`INFO\\s+acme/demo#7\\s+${outcome}`));
    run.child.kill("SIGTERM");
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gh.reviews.length, apply ? 1 : 0);
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
      entrypoint: resolve("audit.ts"),
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
    const f = await fixture(t, model.respond, { entrypoint: resolve("audit.ts"), github: gh.handler });
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
    }, { entrypoint: resolve("audit.ts"), github: gh.handler });
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
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts"), github: gh.handler });
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

test("serve checks a resumed PR again, so one merged in the meantime is skipped", { timeout: 40_000 }, async (t) => {
  const gh = github();
  const model = hangingModel();
  const f = await fixture(t, model.respond, { entrypoint: resolve("audit.ts"), github: gh.handler });
  await interruptedServe(f, model, "SIGKILL", ["--apply"]);
  gh.state.merged = true;
  const second = f.start(["serve", "--port", "0", "--apply"], { env });
  const out = watchOutput(second.child);
  await out.until(/INFO\s+acme\/demo#7\s+Recovering audit/);
  await out.until(/INFO\s+acme\/demo#7\s+Skipped · PR has already been merged\./);
  second.child.kill("SIGTERM");
  assert.equal((await second.done).code, 0);
  assert.equal(model.calls.count, 1, "a merged PR must not resume model work");
  assert.equal(gh.reviews.length, 0);
});

test("serve does not hold repository databases that have nothing to resume", { timeout: 40_000 }, async (t) => {
  const gh = github();
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts"), github: gh.handler });
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
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts"), github: gh.handler });
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
  }, { entrypoint: resolve("audit.ts"), github: gh.handler });
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
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts"), github: gh.handler });
  const result = await f.start(["serve", "--port", "0"], { env: { PRONTO_WEBHOOK_SECRET: "" } }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PRONTO_WEBHOOK_SECRET is required/);
  assert.doesNotMatch(result.stdout, /Listening/);
  assert.deepEqual(gh.requests, [], "nothing should reach GitHub before the configuration is valid");
});

test("serve refuses to start when GitHub rejects the token", { timeout: 20_000 }, async (t) => {
  const gh = github((response) => response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" })));
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts"), github: gh.handler });
  const result = await f.start(["serve", "--port", "0"], { env }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GitHub request failed \(401\)/);
  assert.doesNotMatch(result.stdout, /Listening/);
});

test("serve rejects unsupported options before any credentials are used", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts") });
  const result = await f.start(["serve", "--force"], { env }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--force is not supported by pronto serve/);
});

test("serve prints its usage without a secret or token", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, (_body, response) => assess(response), { entrypoint: resolve("audit.ts") });
  const output = await f.run("", ["serve", "--help"], { env: { PRONTO_WEBHOOK_SECRET: "" } });
  assert.match(output, /^Usage: pronto serve /m);
  assert.match(output, /PRONTO_WEBHOOK_SECRET must be set/);
  assert.match(output, /--concurrency <n>.*default: 4/);
  assert.match(output, /--verbose includes ignored deliveries/);
  assert.match(output, /--force and --pr are not supported/);
});
