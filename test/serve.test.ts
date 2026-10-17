import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { test, type TestContext } from "node:test";
import type { Enqueued } from "../audit-queue.ts";
import type { Accepted } from "../webhook-queue.ts";
import type { LogLevel } from "../logging.ts";
import { createWebhookServer, type WebhookServerOptions } from "../serve.ts";
import { deliver, pullUrl as url, reviewRequested, sign, webhookSecret as secret } from "./webhook-fixtures.ts";

async function start(t: TestContext, overrides: Partial<WebhookServerOptions> = {}, outcome: Accepted = "queued") {
  const logs: { level: LogLevel; scope: string; message: string; detail?: string }[] = [];
  const enqueued: string[] = [];
  const server = createWebhookServer({
    secret, login: "me", log: (level, scope, message, detail) => logs.push({ level, scope, message, detail }), ...overrides,
    enqueue: overrides.enqueue ?? (async (target) => { enqueued.push(target); return outcome; }),
  });
  const { port } = await server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  return { logs, enqueued, base: `http://127.0.0.1:${port}`, server };
}

test("reports health", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("rejects unknown paths and methods", async (t) => {
  const { base, enqueued } = await start(t);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  assert.equal((await deliver(base, reviewRequested(), { path: "/elsewhere" })).status, 404);
  const get = await fetch(`${base}/webhook`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/healthz`, { method: "POST" })).status, 404);
  assert.deepEqual(enqueued, []);
});

test("serves the webhook at a configured path", async (t) => {
  const { base, enqueued } = await start(t, { path: "/hooks/github" });
  assert.equal((await deliver(base, reviewRequested())).status, 404);
  assert.equal((await deliver(base, reviewRequested(), { path: "/hooks/github?source=github" })).status, 202);
  assert.deepEqual(enqueued, [url]);
});

test("rejects a missing or wrong signature before reading the payload", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const body = reviewRequested();
  for (const signature of [null, "", sign(body, "another secret"), sign(`${body} `), "sha256=abc"]) {
    const response = await deliver(base, body, { signature });
    assert.equal(response.status, 401, String(signature));
  }
  assert.deepEqual(enqueued, []);
  assert.equal(logs.length, 5);
  assert.match(logs[0]!.message, /Rejected: missing or invalid signature/);
});

test("answers a ping and ignores events that do not ask for an audit", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const pong = await deliver(base, ping, { event: "ping" });
  assert.equal(pong.status, 200);
  assert.deepEqual(await pong.json(), { status: "pong" });
  const other = await deliver(base, reviewRequested("someone-else"));
  assert.equal(other.status, 204);
  assert.equal(await other.text(), "");
  assert.equal((await deliver(base, reviewRequested(), { event: "push" })).status, 204);
  assert.deepEqual(enqueued, []);
  assert.match(logs.map((entry) => entry.message).join("\n"), /Ignored: review not requested from this user/);
  assert.match(logs.map((entry) => entry.message).join("\n"), /Ignored: not a supported event/);
});

test("omits event and action from ignored-delivery context", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const pull_request = { html_url: url };
  const sender = { login: "alice" };
  const cases = [
    {
      event: "pull_request", payload: { action: "synchronize", pull_request, sender },
      reason: "pull request action does not request a review",
      context: `pr=${url} sender=alice`,
    },
    {
      event: "pull_request", payload: { action: "review_requested", pull_request, sender, requested_reviewer: { login: "someone-else" } },
      reason: "review not requested from this user",
      context: `pr=${url} sender=alice requested_reviewer=someone-else`,
    },
    {
      event: "pull_request", payload: { action: "review_requested", pull_request, sender, requested_team: { slug: "core" } },
      reason: "review not requested from this user",
      context: `pr=${url} sender=alice requested_team=core`,
    },
    {
      event: "issue_comment", payload: { action: "created", issue: { pull_request }, sender: { login: "helper[bot]" }, comment: { body: "Private discussion without a mention." } },
      reason: "comment does not mention this user",
      context: `pr=${url} sender=helper[bot]`,
    },
  ];
  for (const { event, payload, reason, context } of cases) {
    const id = randomUUID();
    assert.equal((await deliver(base, JSON.stringify(payload), { event, id })).status, 204);
    assert.deepEqual(logs.at(-1), { level: "debug", scope: "webhook", message: `Ignored: ${reason} (${context})`, detail: `delivery=${id}` });
  }
  assert.deepEqual(enqueued, []);
});

test("keeps ignored-delivery metadata bounded and safe, even for malformed payloads", async (t) => {
  const { base, logs, enqueued } = await start(t);
  const injected = "synchronize\n[webhook forged] injected=true\u001b[2J\u202e";
  const oversized = "x".repeat(10_000);
  for (const value of [injected, oversized]) {
    const payload = {
      action: value, sender: { login: value }, requested_reviewer: { login: value }, requested_team: { slug: value },
      pull_request: { html_url: value === oversized ? `https://github.com/owner/${oversized}/pull/42` : `${url}?secret=private` },
      comment: { body: "Private discussion." },
    };
    const id = randomUUID();
    assert.equal((await deliver(base, JSON.stringify(payload), { event: "untrusted event=value", id })).status, 204);
    assert.equal(logs.at(-1)!.message, "Ignored: not a supported event (pr=- sender=- requested_reviewer=- requested_team=-)");
  }
  for (const payload of [null, [], { action: 42, pull_request: "malformed", sender: { login: {} } }]) {
    const id = randomUUID();
    assert.equal((await deliver(base, JSON.stringify(payload), { id })).status, 204);
    assert.equal(logs.at(-1)!.message, "Ignored: malformed pull_request payload (pr=- sender=-)");
  }
  assert.deepEqual(enqueued, []);
});

test("accepts a review request for the reviewer and hands the PR to the queue", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const id = randomUUID();
  const response = await deliver(base, reviewRequested("me", url, "Alice"), { id });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "queued" });
  assert.deepEqual(enqueued, [url]);
  assert.deepEqual(logs, [{ level: "info", scope: "owner/repo#42", message: "Queued · review requested · requester=Alice", detail: `delivery=${id}` }]);
});

test("keeps missing or unsafe requesters out of queued logs without rejecting the audit", async (t) => {
  const { base, enqueued, logs } = await start(t);
  for (const sender of [undefined, null, "alice", {}, { login: 42 }, { login: "" },
    { login: "alice\nforged=true\u001b[2J\u202e" }, { login: "x".repeat(10_000) }]) {
    const payload = { ...JSON.parse(reviewRequested()), sender };
    assert.equal((await deliver(base, JSON.stringify(payload))).status, 202);
    assert.equal(logs.at(-1)!.message, "Queued · review requested · requester=-");
  }
  assert.equal(enqueued.length, 8);
});

test("reports how the queue handled the request", async (t) => {
  for (const outcome of ["rerun", "coalesced", "duplicate"] as const) {
    const { base } = await start(t, {}, outcome);
    assert.deepEqual(await (await deliver(base, reviewRequested())).json(), { status: outcome });
  }
});

test("hands over a draft that became ready while the reviewer was requested", async (t) => {
  const { base, enqueued } = await start(t);
  const ready = JSON.stringify({ action: "ready_for_review", pull_request: { html_url: url, requested_reviewers: [{ login: "me" }] } });
  assert.equal((await deliver(base, ready)).status, 202);
  assert.deepEqual(enqueued, [url]);
});

test("waits for admission and passes the delivery ID to its durable owner", async (t) => {
  const admitted = Promise.withResolvers<Enqueued>();
  const received = Promise.withResolvers<string | undefined>();
  const { base } = await start(t, { enqueue: async (_url, id) => {
    received.resolve(id);
    return admitted.promise;
  } });
  const id = randomUUID();
  let answered = false;
  const response = deliver(base, reviewRequested(), { id }).then((response) => { answered = true; return response; });
  assert.equal(await received.promise, id);
  assert.equal(answered, false, "a pending admission is not a 202 acceptance");
  admitted.resolve("queued");
  assert.equal((await response).status, 202);
});

test("does not answer 202 when shutdown begins during admission", async (t) => {
  const admitted = Promise.withResolvers<Accepted>();
  const received = Promise.withResolvers<void>();
  const { base, server } = await start(t, { enqueue: async () => {
    received.resolve();
    return admitted.promise;
  } });
  const response = deliver(base, reviewRequested());
  await received.promise;
  const closing = server.close();
  admitted.resolve("queued");
  assert.equal((await response).status, 503);
  await closing;
});

test("allows a delivery refused by admission to be retried", async (t) => {
  let closed = true;
  const enqueued: string[] = [];
  const { base } = await start(t, { enqueue: async (target) => { enqueued.push(target); return closed ? "closed" : "queued"; } });
  const id = randomUUID();
  const refused = await deliver(base, reviewRequested(), { id });
  assert.equal(refused.status, 503, "GitHub must see a failure so the delivery can be redelivered");
  closed = false;
  assert.equal((await deliver(base, reviewRequested(), { id })).status, 202);
  assert.equal(enqueued.length, 2);
});

test("does not deduplicate or log delivery IDs that are not plain tokens", async (t) => {
  const { base, enqueued, logs } = await start(t);
  for (const id of ["not valid!", "x".repeat(65), null]) {
    assert.equal((await deliver(base, reviewRequested(), { id })).status, 202);
    assert.equal((await deliver(base, reviewRequested(), { id })).status, 202);
  }
  assert.equal(enqueued.length, 6, "unusable IDs are never deduplicated");
  assert.doesNotMatch(JSON.stringify(logs), /not valid|xxxx/, "unsigned header text must not reach the log");
  assert.equal(logs[0]!.detail, "delivery=-");
});

test("rejects a signed payload that is not JSON", async (t) => {
  const { base, enqueued } = await start(t);
  const form = `payload=${encodeURIComponent(reviewRequested())}`;
  const response = await deliver(base, form);
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /application\/json/);
  assert.deepEqual(enqueued, []);
});

test("rejects a payload over the size limit, declared or streamed", async (t) => {
  const { base, enqueued } = await start(t, { maxBodyBytes: 1000 });
  const body = JSON.stringify({ padding: "a".repeat(2000) });
  assert.equal((await deliver(base, body)).status, 413);
  const streamed = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/webhook`, { method: "POST", headers: { "Transfer-Encoding": "chunked", "X-Hub-Signature-256": sign(body) } },
      (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject);
    req.write(body.slice(0, 1200));
    req.write(body.slice(1200));
    req.end();
  });
  assert.equal(streamed, 413);
  assert.deepEqual(enqueued, []);
  assert.equal((await deliver(base, reviewRequested())).status, 202, "the server keeps serving afterwards");
});

test("answers 503 and keeps serving when durable admission fails", async (t) => {
  let fail = true;
  const { base, logs } = await start(t, { enqueue: async () => { if (fail) throw new Error("queue exploded"); return "queued"; } });
  assert.equal((await deliver(base, reviewRequested())).status, 503);
  assert.match(logs.at(-1)!.message, /Admission failed: queue exploded/);
  fail = false;
  assert.equal((await deliver(base, reviewRequested())).status, 202);
});

test("stops listening on close", async (t) => {
  const { base, server } = await start(t);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  await server.close();
  await assert.rejects(fetch(`${base}/healthz`));
  await server.close();
});

test("requires a secret and a reviewer login", () => {
  assert.throws(() => createWebhookServer({ secret: "", login: "me", enqueue: async () => "queued" }), /secret is required/);
  assert.throws(() => createWebhookServer({ secret, login: "", enqueue: async () => "queued" }), /login is required/);
});
