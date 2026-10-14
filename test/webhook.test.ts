import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { classifyDelivery, verifySignature } from "../webhook.ts";

const secret = "It's a Secret to Everybody";
const sign = (body: string | Uint8Array, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

test("accepts a signature over the exact raw body", () => {
  const body = '{"zen":"Keep it logically awesome."}';
  assert.equal(verifySignature(secret, body, sign(body)), true);
  assert.equal(verifySignature(secret, Buffer.from(body), sign(body)), true);
});

test("rejects signatures that do not match the body and secret", () => {
  const body = '{"action":"review_requested"}';
  assert.equal(verifySignature(secret, `${body} `, sign(body)), false, "a changed body must not verify");
  assert.equal(verifySignature(secret, body, sign(body, "another secret")), false);
});

for (const [name, header] of [
  ["a missing header", undefined],
  ["an empty header", ""],
  ["a header without the algorithm prefix", sign("x").slice("sha256=".length)],
  ["the legacy sha1 algorithm", `sha1=${createHmac("sha1", secret).update("x").digest("hex")}`],
  ["a truncated digest", sign("x").slice(0, -2)],
  ["a digest with extra bytes", `${sign("x")}00`],
  ["a non-hex digest", `sha256=${"z".repeat(64)}`],
] as [string, string | undefined][]) {
  test(`rejects ${name}`, () => {
    assert.equal(verifySignature(secret, "x", header), false);
  });
}

test("refuses to verify with an empty secret", () => {
  assert.throws(() => verifySignature("", "x", sign("x", "")), /secret is required/);
});

const url = "https://github.com/owner/repo/pull/42";
const pull = (extra: object = {}) => ({ html_url: url, requested_reviewers: [], ...extra });
const requested = (reviewer: object | undefined, extra: object = {}) => ({
  action: "review_requested", pull_request: pull(extra), ...(reviewer ? { requested_reviewer: reviewer } : {}),
});

test("answers a ping without auditing", () => {
  assert.deepEqual(classifyDelivery("ping", { zen: "Keep it logically awesome.", hook_id: 1 }, "me"), { kind: "pong" });
});

test("audits a review request for the reviewer", () => {
  assert.deepEqual(classifyDelivery("pull_request", requested({ login: "me" }), "me"),
    { kind: "audit", url, reason: "review requested" });
});

test("matches the reviewer's login case-insensitively", () => {
  assert.equal(classifyDelivery("pull_request", requested({ login: "Octo-Cat" }), "octo-cat").kind, "audit");
  assert.equal(classifyDelivery("pull_request", requested({ login: "octo-cat" }), "Octo-Cat").kind, "audit");
});

test("ignores a review request for another user", () => {
  assert.deepEqual(classifyDelivery("pull_request", requested({ login: "someone-else" }), "me"),
    { kind: "ignore", reason: "review not requested from this user" });
});

test("ignores a team review request, even if the reviewer is a member", () => {
  const delivery = { action: "review_requested", requested_team: { slug: "core" }, pull_request: pull({ requested_reviewers: [{ login: "me" }] }) };
  assert.equal(classifyDelivery("pull_request", delivery, "me").kind, "ignore");
});

test("audits a draft that becomes ready while the reviewer is requested", () => {
  const ready = { action: "ready_for_review", pull_request: pull({ requested_reviewers: [{ login: "other" }, { login: "ME" }] }) };
  assert.deepEqual(classifyDelivery("pull_request", ready, "me"),
    { kind: "audit", url, reason: "ready for review while requested" });
});

test("ignores a ready draft that is not waiting on the reviewer", () => {
  for (const requested_reviewers of [[], [{ login: "other" }], undefined]) {
    const ready = { action: "ready_for_review", pull_request: pull({ requested_reviewers }) };
    assert.equal(classifyDelivery("pull_request", ready, "me").kind, "ignore");
  }
});

test("ignores pull request actions that do not request a review", () => {
  for (const action of ["opened", "synchronize", "review_request_removed", "closed", "converted_to_draft", undefined]) {
    const delivery = { action, requested_reviewer: { login: "me" }, pull_request: pull({ requested_reviewers: [{ login: "me" }] }) };
    assert.deepEqual(classifyDelivery("pull_request", delivery, "me"),
      { kind: "ignore", reason: "pull request action does not request a review" });
  }
});

test("ignores events other than pull_request and ping", () => {
  for (const event of ["issue_comment", "pull_request_review", "push", "", undefined]) {
    assert.deepEqual(classifyDelivery(event, requested({ login: "me" }), "me"),
      { kind: "ignore", reason: "not a pull_request event" });
  }
});

test("ignores malformed payloads without throwing", () => {
  for (const payload of [null, undefined, "text", 42, [], {}, { action: "review_requested" },
    { action: "review_requested", pull_request: "x" }, { action: "review_requested", pull_request: [] }]) {
    assert.deepEqual(classifyDelivery("pull_request", payload, "me"),
      { kind: "ignore", reason: "malformed pull_request payload" });
  }
  for (const reviewer of [null, "me", 7, [], {}, { login: 7 }]) {
    assert.equal(classifyDelivery("pull_request", { action: "review_requested", requested_reviewer: reviewer, pull_request: pull() }, "me").kind, "ignore");
  }
});

test("ignores a pull request without a usable GitHub PR URL", () => {
  for (const html_url of [undefined, null, 42]) {
    assert.deepEqual(classifyDelivery("pull_request", requested({ login: "me" }, { html_url }), "me"),
      { kind: "ignore", reason: "pull request has no URL" });
  }
  for (const html_url of ["", "not a url", "http://github.com/owner/repo/pull/42", "https://example.com/owner/repo/pull/42",
    "https://github.com/owner/repo/issues/42", "https://github.com/owner/repo/pull/0", "https://github.com/owner/repo/pull/42?x=1"]) {
    assert.deepEqual(classifyDelivery("pull_request", requested({ login: "me" }, { html_url }), "me"),
      { kind: "ignore", reason: "pull request URL is not a supported GitHub PR URL" }, String(html_url));
  }
});

test("normalises the audited URL like a CLI target", () => {
  const delivery = classifyDelivery("pull_request", requested({ login: "me" }, { html_url: `${url}/` }), "me");
  assert.deepEqual(delivery, { kind: "audit", url, reason: "review requested" });
});

test("requires a reviewer login", () => {
  assert.throws(() => classifyDelivery("pull_request", requested({ login: "me" }), ""), /reviewer login is required/);
});
