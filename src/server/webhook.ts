import { createHmac, timingSafeEqual } from "node:crypto";
import { isAuditComment, parseReviewTarget } from "../github/reviews.ts";

export type Delivery =
  | { kind: "pong" }
  | { kind: "audit"; url: string; reason: string; requester: string; firstReady?: true }
  | { kind: "ignore"; reason: string };

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

function loginOf(value: unknown): string | undefined {
  const login = object(value)?.login;
  return typeof login === "string" ? login.toLowerCase() : undefined;
}

/** Payload metadata needs bounds and a plain shape, including [bot] login suffixes. */
function logToken(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 100
    && !/[^\w[\]-]/.test(value) ? value : "-";
}

/** Formats only bounded metadata for logs, never comment bodies or the full payload. */
export function formatDeliveryContext(event: string | undefined, payload: unknown): string {
  const body = object(payload);
  const pull = event === "issue_comment" ? object(object(body?.issue)?.pull_request) : object(body?.pull_request);
  let pr = "-";
  if (typeof pull?.html_url === "string" && pull.html_url.length <= 512) {
    try {
      pr = parseReviewTarget(pull.html_url).url;
    } catch {
      // Do not log unsupported URLs, which could include credentials or other private text.
    }
  }
  const fields = [`pr=${pr}`, `sender=${logToken(object(body?.sender)?.login)}`];
  if (body?.requested_reviewer !== undefined) fields.push(`requested_reviewer=${logToken(object(body.requested_reviewer)?.login)}`);
  if (body?.requested_team !== undefined) fields.push(`requested_team=${logToken(object(body.requested_team)?.slug)}`);
  return fields.join(" ");
}

const observedActions: Record<string, ReadonlySet<string>> = {
  pull_request: new Set(["opened", "ready_for_review", "review_requested", "review_request_removed", "synchronize", "closed", "reopened"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  pull_request_review_thread: new Set(["resolved", "unresolved"]),
};

function logId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  return undefined;
}

function logSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f\d]{40}$/i.test(value) ? value : undefined;
}

/** Bounded webhook metadata for debugging; never includes review or comment bodies. */
export function formatWebhookObservation(event: string | undefined, payload: unknown): string | undefined {
  const body = object(payload);
  const action = body?.action;
  const actions = event && Object.hasOwn(observedActions, event) ? observedActions[event] : undefined;
  if (!event || !body || typeof action !== "string" || !actions?.has(action)) return undefined;

  const fields = [`event=${logToken(event)}`, `action=${logToken(action)}`, formatDeliveryContext(event, payload)];
  const pull = object(body.pull_request);
  const headSha = logSha(object(pull?.head)?.sha);
  if (headSha) fields.push(`head_sha=${headSha}`);
  if (typeof pull?.merged === "boolean") fields.push(`merged=${pull.merged}`);

  const review = object(body.review);
  const comment = object(body.comment);
  const thread = object(body.thread);
  const reviewer = object(review?.user)?.login ?? object(comment?.user)?.login;
  if (reviewer !== undefined) fields.push(`reviewer=${logToken(reviewer)}`);
  const commentId = logId(comment?.id);
  if (commentId) fields.push(`comment_id=${commentId}`);
  const reviewId = logId(review?.id ?? comment?.pull_request_review_id);
  if (reviewId) fields.push(`review_id=${reviewId}`);
  if (typeof review?.state === "string") fields.push(`review_state=${logToken(review.state)}`);
  const reviewCommit = logSha(review?.commit_id);
  if (reviewCommit) fields.push(`review_commit=${reviewCommit}`);
  const replyTo = logId(comment?.in_reply_to_id);
  if (replyTo) fields.push(`in_reply_to=${replyTo}`);
  const threadId = logId(thread?.id);
  if (threadId) fields.push(`thread_id=${threadId}`);
  if (typeof thread?.is_resolved === "boolean") fields.push(`resolved=${thread.is_resolved}`);
  return fields.join(" ");
}

function mentionsLogin(body: string, login: string): boolean {
  // Match a whole @login, not an email address, a longer login or an @org/team mention.
  for (const [, mentioned] of body.matchAll(/(?:^|[^\w@])@([\w-]+)(?![\w/-])/g)) {
    if (mentioned!.toLowerCase() === login) return true;
  }
  return false;
}

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body: parsed JSON would not reproduce the signed bytes. */
export function verifySignature(secret: string, body: string | Uint8Array, header: string | undefined): boolean {
  // An empty secret makes every signature forgeable, so it is a configuration error rather than a failed check.
  if (!secret) throw new Error("A webhook secret is required to verify signatures.");
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(body).digest(), Buffer.from(match[1]!, "hex"));
}

/**
 * Decides what a verified delivery means for `login`, the GitHub user Pronto reviews as. Audits start for review
 * requests, requested drafts becoming ready, configured first-ready events and new or edited PR comments mentioning that user.
 * Marked audit output is ignored so Pronto does not start audits in response to its own verdicts.
 *
 * The event header is not covered by the signature and the payload is unbounded, so reasons are fixed strings.
 */
export function classifyDelivery(event: string | undefined, payload: unknown, login: string, { auditOnReady = false }: { auditOnReady?: boolean } = {}): Delivery {
  if (!login) throw new Error("The reviewer login is required to classify deliveries.");
  const ignore = (reason: string): Delivery => ({ kind: "ignore", reason });
  if (event === "ping") return { kind: "pong" };
  const isComment = event === "issue_comment" || event === "pull_request_review_comment" || event === "pull_request_review";
  if (event !== "pull_request" && !isComment) return ignore("not a supported event");
  const body = object(payload);
  const pull = event === "issue_comment" ? object(object(body?.issue)?.pull_request) : object(body?.pull_request);
  if (!body || !pull) return ignore(isComment ? "comment is not on a pull request" : "malformed pull_request payload");
  const me = login.toLowerCase();
  let reason: string;
  let firstReady = false;
  if (isComment) {
    const isReview = event === "pull_request_review";
    if (body.action !== (isReview ? "submitted" : "created") && body.action !== "edited") return ignore("comment action does not request an audit");
    const comment = object(isReview ? body.review : body.comment);
    if (typeof comment?.body !== "string") return ignore("comment has no body");
    if (isReview && comment.state === "pending") return ignore("review has not been submitted");
    if (isAuditComment(comment.body)) return ignore("Pronto audit output");
    if (!mentionsLogin(comment.body, me)) return ignore("comment does not mention this user");
    reason = "mentioned in a pull request comment";
  } else if (body.action === "opened" && auditOnReady && pull.draft === false) {
    reason = "first ready for review";
    firstReady = true;
  } else if (body.action === "review_requested") {
    // A team request has `requested_team` instead of `requested_reviewer`, so it never matches.
    if (loginOf(body.requested_reviewer) !== me) return ignore("review not requested from this user");
    reason = "review requested";
  } else if (body.action === "ready_for_review") {
    if (auditOnReady) {
      reason = "first ready for review";
      firstReady = true;
    } else {
      // A request made on a draft was skipped then, and becoming ready does not change the reviewer list, so check who is requested.
      const requested: unknown[] = Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers : [];
      if (!requested.some((reviewer) => loginOf(reviewer) === me)) return ignore("pull request is ready but this user is not a requested reviewer");
      reason = "ready for review while requested";
    }
  } else {
    return ignore("pull request action does not request a review");
  }
  if (typeof pull.html_url !== "string") return ignore("pull request has no URL");
  try {
    return { kind: "audit", url: parseReviewTarget(pull.html_url).url, reason, requester: logToken(object(body.sender)?.login), ...(firstReady ? { firstReady: true as const } : {}) };
  } catch {
    return ignore("pull request URL is not a supported GitHub PR URL");
  }
}
