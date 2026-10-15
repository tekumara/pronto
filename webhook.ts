import { createHmac, timingSafeEqual } from "node:crypto";
import { isAuditComment, parseReviewTarget } from "./reviews.ts";

export type Delivery =
  | { kind: "pong" }
  | { kind: "audit"; url: string; reason: string }
  | { kind: "ignore"; reason: string };

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

function loginOf(value: unknown): string | undefined {
  const login = object(value)?.login;
  return typeof login === "string" ? login.toLowerCase() : undefined;
}

/** Formats only bounded metadata for logs, never comment bodies or the full payload. */
export function formatDeliveryContext(event: string | undefined, payload: unknown): string {
  // The event header is unsigned. Payload strings also need bounds and a plain shape, including [bot] login suffixes.
  const token = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 100
    && !/[^\w[\]-]/.test(value) ? value : "-";
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
  const fields = [
    `event=${token(event)}`, `action=${token(body?.action)}`, `pr=${pr}`,
    `sender=${token(object(body?.sender)?.login)}`,
  ];
  if (body?.requested_reviewer !== undefined) fields.push(`requested_reviewer=${token(object(body.requested_reviewer)?.login)}`);
  if (body?.requested_team !== undefined) fields.push(`requested_team=${token(object(body.requested_team)?.slug)}`);
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
 * requests, requested drafts becoming ready, and new or edited PR comments mentioning that user.
 * Marked audit output is ignored so Pronto does not start audits in response to its own verdicts.
 *
 * The event header is not covered by the signature and the payload is unbounded, so reasons are fixed strings.
 */
export function classifyDelivery(event: string | undefined, payload: unknown, login: string): Delivery {
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
  if (isComment) {
    const isReview = event === "pull_request_review";
    if (body.action !== (isReview ? "submitted" : "created") && body.action !== "edited") return ignore("comment action does not request an audit");
    const comment = object(isReview ? body.review : body.comment);
    if (typeof comment?.body !== "string") return ignore("comment has no body");
    if (isReview && comment.state === "pending") return ignore("review has not been submitted");
    if (isAuditComment(comment.body)) return ignore("Pronto audit output");
    if (!mentionsLogin(comment.body, me)) return ignore("comment does not mention this user");
    reason = "mentioned in a pull request comment";
  } else if (body.action === "review_requested") {
    // A team request has `requested_team` instead of `requested_reviewer`, so it never matches.
    if (loginOf(body.requested_reviewer) !== me) return ignore("review not requested from this user");
    reason = "review requested";
  } else if (body.action === "ready_for_review") {
    // A request made on a draft was skipped then, and becoming ready does not change the reviewer list, so check who is requested.
    const requested: unknown[] = Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers : [];
    if (!requested.some((reviewer) => loginOf(reviewer) === me)) return ignore("pull request is ready but this user is not a requested reviewer");
    reason = "ready for review while requested";
  } else {
    return ignore("pull request action does not request a review");
  }
  if (typeof pull.html_url !== "string") return ignore("pull request has no URL");
  try {
    return { kind: "audit", url: parseReviewTarget(pull.html_url).url, reason };
  } catch {
    return ignore("pull request URL is not a supported GitHub PR URL");
  }
}
