import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { test, type TestContext } from "node:test";
import type { Enqueued } from "../audit-queue.ts";
import { createWebhookServer, type WebhookServerOptions } from "../serve.ts";
import { deliver, pullUrl as url, reviewRequested, sign, webhookSecret as secret } from "./webhook-fixtures.ts";

async function start(t: TestContext, overrides: Partial<WebhookServerOptions> = {}, outcome: Enqueued = "queued") {
  const logs: string[] = [];
  const enqueued: string[] = [];
  const server = createWebhookServer({
    secret, login: "me", log: (message) => logs.push(message), ...overrides,
    enqueue: overrides.enqueue ?? ((target) => { enqueued.push(target); return outcome; }),
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
  assert.match(logs[0]!, /rejected: missing or invalid signature/);
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
  assert.match(logs.join("\n"), /ignored: review not requested from this user/);
  assert.match(logs.join("\n"), /ignored: not a supported event/);
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
    assert.equal(logs.at(-1), `[webhook ${id}] ignored: ${reason} (${context})`);
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
    assert.equal(logs.at(-1), `[webhook ${id}] ignored: not a supported event (pr=- sender=- requested_reviewer=- requested_team=-)`);
  }
  for (const payload of [null, [], { action: 42, pull_request: "malformed", sender: { login: {} } }]) {
    const id = randomUUID();
    assert.equal((await deliver(base, JSON.stringify(payload), { id })).status, 204);
    assert.equal(logs.at(-1), `[webhook ${id}] ignored: malformed pull_request payload (pr=- sender=-)`);
  }
  assert.deepEqual(enqueued, []);
});

test("accepts a review request for the reviewer and hands the PR to the queue", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const id = randomUUID();
  const response = await deliver(base, reviewRequested(), { id });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "queued" });
  assert.deepEqual(enqueued, [url]);
  assert.deepEqual(logs, [`[webhook ${id}] queued: ${url} (review requested)`]);
});

test("reports how the queue handled the request", async (t) => {
  for (const outcome of ["rerun", "coalesced"] as const) {
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

test("drops a redelivery of the same delivery ID but not a new delivery for the same PR", async (t) => {
  const { base, enqueued, logs } = await start(t);
  const id = randomUUID();
  assert.equal((await deliver(base, reviewRequested(), { id })).status, 202);
  const again = await deliver(base, reviewRequested(), { id });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: "duplicate" });
  assert.deepEqual(enqueued, [url]);
  assert.match(logs.at(-1)!, /duplicate delivery/);
  assert.equal((await deliver(base, reviewRequested(), { id: randomUUID() })).status, 202);
  assert.deepEqual(enqueued, [url, url], "a second request is the queue's to coalesce");
});

test("does not remember a delivery that was not accepted", async (t) => {
  let closed = true;
  const enqueued: string[] = [];
  const { base } = await start(t, { enqueue: (target) => { enqueued.push(target); return closed ? "closed" : "queued"; } });
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
  assert.doesNotMatch(logs.join("\n"), /not valid|xxxx/, "unsigned header text must not reach the log");
  assert.match(logs[0]!, /^\[webhook -\] queued:/);
});

test("forgets the oldest delivery IDs once the recent window is full", async (t) => {
  const { base, enqueued } = await start(t);
  const ids = Array.from({ length: 1001 }, () => randomUUID());
  for (let i = 0; i < ids.length; i += 100) await Promise.all(ids.slice(i, i + 100).map((id) => deliver(base, reviewRequested(), { id })));
  assert.equal(enqueued.length, 1001);
  assert.deepEqual(await (await deliver(base, reviewRequested(), { id: ids.at(-1)! })).json(), { status: "duplicate" });
  assert.deepEqual(await (await deliver(base, reviewRequested(), { id: ids[0]! })).json(), { status: "queued" }, "the oldest ID was evicted");
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

test("answers 500 and keeps serving when the queue throws", async (t) => {
  let fail = true;
  const { base, logs } = await start(t, { enqueue: () => { if (fail) throw new Error("queue exploded"); return "queued"; } });
  assert.equal((await deliver(base, reviewRequested())).status, 500);
  assert.match(logs.at(-1)!, /error: queue exploded/);
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
  assert.throws(() => createWebhookServer({ secret: "", login: "me", enqueue: () => "queued" }), /secret is required/);
  assert.throws(() => createWebhookServer({ secret, login: "", enqueue: () => "queued" }), /login is required/);
});
