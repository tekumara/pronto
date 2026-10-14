import { createHmac, timingSafeEqual } from "node:crypto";
import { parseReviewTarget } from "./reviews.ts";

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

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body: parsed JSON would not reproduce the signed bytes. */
export function verifySignature(secret: string, body: string | Uint8Array, header: string | undefined): boolean {
  // An empty secret makes every signature forgeable, so it is a configuration error rather than a failed check.
  if (!secret) throw new Error("A webhook secret is required to verify signatures.");
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(body).digest(), Buffer.from(match[1]!, "hex"));
}

/**
 * Decides what a verified delivery means for `login`, the GitHub user Pronto reviews as. Only a review request for that
 * user starts an audit: a request from them directly, or a draft they were already asked to review becoming ready.
 * Requests for a team or another user, and every other event, are ignored.
 *
 * The event header is not covered by the signature and the payload is unbounded, so reasons are fixed strings.
 */
export function classifyDelivery(event: string | undefined, payload: unknown, login: string): Delivery {
  if (!login) throw new Error("The reviewer login is required to classify deliveries.");
  const ignore = (reason: string): Delivery => ({ kind: "ignore", reason });
  if (event === "ping") return { kind: "pong" };
  if (event !== "pull_request") return ignore("not a pull_request event");
  const body = object(payload);
  const pull = object(body?.pull_request);
  if (!body || !pull) return ignore("malformed pull_request payload");
  const me = login.toLowerCase();
  let reason: string;
  if (body.action === "review_requested") {
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
