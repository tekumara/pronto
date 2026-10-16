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
    { kind: "audit", url, reason: "review requested", requester: "-" });
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
    { kind: "audit", url, reason: "ready for review while requested", requester: "-" });
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

const commentEvents = ["issue_comment", "pull_request_review_comment", "pull_request_review"] as const;

function commented(event: typeof commentEvents[number], text: unknown, extra: object = {}) {
  return {
    action: event === "pull_request_review" ? "submitted" : "created",
    ...(event === "issue_comment" ? { issue: { html_url: url, pull_request: { html_url: url } } } : { pull_request: pull() }),
    [event === "pull_request_review" ? "review" : "comment"]: { body: text, user: { login: "author" }, state: "commented" },
    ...extra,
  };
}

for (const event of commentEvents) {
  test(`audits new and edited ${event} mentions`, () => {
    for (const action of [event === "pull_request_review" ? "submitted" : "created", "edited"]) {
      assert.deepEqual(classifyDelivery(event, commented(event, "Please review, @ME.", { action }), "Me"),
        { kind: "audit", url, reason: "mentioned in a pull request comment", requester: "-" });
    }
  });

  test(`ignores ${event} deletions and unrelated actions even with a mention`, () => {
    for (const action of ["deleted", "dismissed", "pinned", "unpinned", undefined]) {
      assert.equal(classifyDelivery(event, commented(event, "@me", { action }), "me").kind, "ignore", String(action));
    }
  });

  test(`ignores malformed ${event} payloads without throwing`, () => {
    for (const payload of [null, undefined, "text", [], {},
      commented(event, "@me", { issue: null, pull_request: null }),
      ...[null, "@me", [], { body: 42 }].map((value) => commented(event, "@me", { comment: value, review: value })),
    ]) {
      assert.equal(classifyDelivery(event, payload, "me").kind, "ignore");
    }
  });

  test(`ignores Pronto audit output in ${event} even when it mentions the reviewer`, () => {
    assert.equal(classifyDelivery(event, commented(event, "Awaiting @me\n\n<!-- pronto:review-audit -->\n"), "me").kind, "ignore");
  });

  test(`requires a supported GitHub PR URL for ${event} mentions`, () => {
    for (const html_url of [undefined, 42, "https://example.com/owner/repo/pull/42", "https://github.com/owner/repo/issues/42"]) {
      const target = event === "issue_comment" ? { issue: { html_url: url, pull_request: { html_url } } } : { pull_request: pull({ html_url }) };
      assert.equal(classifyDelivery(event, commented(event, "@me", target), "me").kind, "ignore", String(html_url));
    }
  });
}

test("matches whole mentions, not other users, emails or team mentions", () => {
  for (const text of ["@octo-cat", "Thanks, @OCTO-CAT!", "@other @octo-cat\nplease review", "(@octo-cat)"]) {
    assert.equal(classifyDelivery("issue_comment", commented("issue_comment", text), "Octo-Cat").kind, "audit", text);
  }
  for (const text of ["", "octo-cat", "@other", "@octo-catfish", "@octo-cat-bot", "@octo-cat_name", "@org/octo-cat",
    "@octo-cat/team", "mail@octo-cat.com", "@@octo-cat", null, undefined, 42]) {
    assert.equal(classifyDelivery("issue_comment", commented("issue_comment", text), "Octo-Cat").kind, "ignore", String(text));
  }
});

test("ignores mentions on ordinary issues, even if their URL resembles a PR", () => {
  const payload = commented("issue_comment", "@me", { issue: { html_url: url } });
  assert.equal(classifyDelivery("issue_comment", payload, "me").kind, "ignore");
});

test("audits mentions in inline replies", () => {
  const payload = commented("pull_request_review_comment", "@me", { comment: { body: "@me", in_reply_to_id: 123 } });
  assert.equal(classifyDelivery("pull_request_review_comment", payload, "me").kind, "audit");
});

test("ignores mentions in pending review summaries", () => {
  const payload = commented("pull_request_review", "@me", { review: { body: "@me", state: "pending" }, action: "edited" });
  assert.equal(classifyDelivery("pull_request_review", payload, "me").kind, "ignore");
});

test("ignores unsupported events", () => {
  for (const event of ["pull_request_review_thread", "commit_comment", "issues", "push", "", undefined]) {
    assert.deepEqual(classifyDelivery(event, requested({ login: "me" }), "me"),
      { kind: "ignore", reason: "not a supported event" });
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
  assert.deepEqual(delivery, { kind: "audit", url, reason: "review requested", requester: "-" });
});

test("requires a reviewer login", () => {
  assert.throws(() => classifyDelivery("pull_request", requested({ login: "me" }), ""), /reviewer login is required/);
});
