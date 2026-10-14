import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { fixture, noDatabaseMigration, tool } from "./fixtures.ts";
import { deliver, reviewRequested, webhookSecret } from "./webhook-fixtures.ts";

const prUrl = "https://github.com/acme/demo/pull/7";
const headSha = "a".repeat(40);
const env = { PRONTO_WEBHOOK_SECRET: webhookSecret };

/** Simulated GitHub for one PR. The token's user is "Me", to show that logins match case-insensitively. */
function github(user: (response: ServerResponse) => void = (response) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ login: "Me" }))) {
  const reviews: { event: string; body: string; commit_id: string }[] = [];
  const requests: string[] = [];
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url!.split("?")[0]!;
    requests.push(`${request.method} ${path}`);
    const json = (value: unknown): void => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
    if (request.method === "POST" && path === "/github/repos/acme/demo/pulls/7/reviews") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      reviews.push(JSON.parse(Buffer.concat(chunks).toString()));
      return json({ html_url: `${prUrl}#pullrequestreview-${reviews.length}` });
    }
    assert.equal(request.method, path === "/github/graphql" ? "POST" : "GET");
    if (path === "/github/user") return user(response);
    if (path === "/github/graphql") {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (path === "/github/repos/acme/demo/pulls/7") {
      return json({ title: "Served PR", body: "", merged: false, draft: false, labels: [], changed_files: 0,
        head: { sha: headSha, repo: { full_name: "acme/demo" } }, base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } });
    }
    assert.match(path, /^\/github\/repos\/acme\/demo\/(?:pulls\/7\/(?:comments|reviews|files)|issues\/7\/comments)$/);
    json([]);
  };
  return { handler, reviews, requests };
}

const assess = (response: ServerResponse) => tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });

/** Collects a child's output and resolves when a pattern appears in it. */
function watchOutput(child: ChildProcessWithoutNullStreams) {
  let output = "";
  const waiters: { pattern: RegExp; resolve(match: RegExpMatchArray): void }[] = [];
  child.stdout.on("data", (data) => {
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

test("serve audits a requested review, submits one verdict, ignores other requests and stops cleanly", { timeout: 40_000 }, async (t) => {
  const gh = github();
  let modelCalls = 0;
  const f = await fixture(t, (_body, response) => { modelCalls++; assess(response); }, { entrypoint: resolve("audit.ts"), github: gh.handler });
  const run = f.start(["serve", "--port", "0", "--apply"], { env });
  const out = watchOutput(run.child);
  const [, port] = await out.until(/Listening on http:\/\/127\.0\.0\.1:(\d+)\/webhook/);
  const base = `http://127.0.0.1:${port}`;
  assert.match(out.output, /Reviewing as Me with local\/test(?! · previews only)/);

  assert.equal((await deliver(base, "{}", { event: "ping" })).status, 200);
  const accepted = await deliver(base, reviewRequested("me", prUrl));
  assert.equal(accepted.status, 202);
  assert.equal(((await accepted.json()) as { status: string }).status, "queued");
  await out.until(/\[acme\/demo#7\] \[audit\] Verdict comment posted to the PR: /);
  assert.equal(gh.reviews.length, 1);
  assert.equal(gh.reviews[0]!.event, "COMMENT");
  assert.equal(gh.reviews[0]!.commit_id, headSha);
  assert.match(gh.reviews[0]!.body, /Review audit/);

  // A repeat request reuses the assessment and does not post the same verdict again.
  const repeat = await deliver(base, reviewRequested("me", prUrl));
  assert.equal(repeat.status, 202);
  await out.until(/\[acme\/demo#7\] \[audit\] Reusing saved assessment/);
  await out.until(/Comment skipped: matching verdict review recorded locally/);
  assert.equal(gh.reviews.length, 1);
  assert.equal(modelCalls, 1);

  const other = await deliver(base, reviewRequested("someone-else", prUrl));
  assert.equal(other.status, 204);
  await out.until(/ignored: review not requested from this user/);

  run.child.kill("SIGTERM");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Received SIGTERM; stopping/);
  assert.equal(gh.reviews.length, 1);
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
  assert.match(result.stdout, /\[serve\] Audit interrupted: https:\/\/github\.com\/acme\/demo\/pull\/7\./);
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
  assert.match(output, /--force and --pr are not supported/);
});
