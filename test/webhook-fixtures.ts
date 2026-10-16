import { createHmac, randomUUID } from "node:crypto";

export const webhookSecret = "It's a Secret to Everybody";
export const pullUrl = "https://github.com/owner/repo/pull/42";
export const sign = (body: string, key = webhookSecret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

/** A pull_request delivery body asking `login` to review `url`. */
export const reviewRequested = (login = "me", url = pullUrl, requester = "author") => JSON.stringify({
  action: "review_requested", sender: { login: requester }, requested_reviewer: { login }, pull_request: { html_url: url, requested_reviewers: [{ login }] },
});

/** Posts a delivery as GitHub would. A null id or signature leaves that header out. */
export function deliver(base: string, body: string, { event = "pull_request", id = randomUUID() as string | null, signature = sign(body) as string | null, path = "/webhook" } = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-GitHub-Event": event,
      ...(id ? { "X-GitHub-Delivery": id } : {}), ...(signature ? { "X-Hub-Signature-256": signature } : {}),
    },
    body,
  });
}
