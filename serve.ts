import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Enqueued } from "./audit-queue.ts";
import { auditLabel, createServeLogger, type Log } from "./logging.ts";
import { classifyDelivery, formatDeliveryContext, verifySignature } from "./webhook.ts";

export const DEFAULT_WEBHOOK_PATH = "/webhook";
// GitHub caps payloads at 25 MB, but a pull_request event is a small fraction of that.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RECENT_DELIVERIES = 1000;

export type WebhookServerOptions = {
  /** Shared secret configured on the GitHub webhook. */
  secret: string;
  /** GitHub user Pronto reviews as: review requests and PR comment mentions of them start audits. */
  login: string;
  /** Hands a verified PR URL to the audit queue. */
  enqueue: (url: string) => Enqueued;
  path?: string;
  maxBodyBytes?: number;
  log?: Log;
};

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Resolves null when the body exceeds `limit`. Reads by hand: leaving a `for await` loop would destroy the socket before the 413. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.removeAllListeners("data");
        return resolve(null);
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => reject(new Error("Request closed before the body ended")));
  });
}

function send(res: ServerResponse, status: number, body?: object, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...headers }).end(json);
}

/** Receives GitHub webhook deliveries. It answers before any audit runs, since GitHub gives up on a slow response. */
export function createWebhookServer({ secret, login, enqueue, path = DEFAULT_WEBHOOK_PATH, maxBodyBytes = MAX_BODY_BYTES, log = createServeLogger() }: WebhookServerOptions) {
  if (!secret) throw new Error("A webhook secret is required.");
  if (!login) throw new Error("The reviewer login is required.");
  // GitHub redelivers with the same ID. Only a verified audit request is remembered, and only once it was accepted.
  const recent = new Set<string>();
  const remember = (id: string) => {
    recent.add(id);
    if (recent.size > RECENT_DELIVERIES) recent.delete(recent.values().next().value!);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return send(res, 400, { error: "malformed request target" });
    }
    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, { status: "ok" });
    if (pathname !== path) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    const body = await readBody(req, maxBodyBytes);
    if (!body) return send(res, 413, { error: "payload too large" }, { Connection: "close" });
    // The ID comes from an unsigned header, so it is only logged and remembered in a plain shape.
    const id = header(req, "x-github-delivery")?.match(/^[\w-]{1,64}$/)?.[0];
    const detail = `delivery=${id ?? "-"}`;
    if (!verifySignature(secret, body, header(req, "x-hub-signature-256"))) {
      log("warn", "webhook", "Rejected: missing or invalid signature", detail);
      return send(res, 401, { error: "invalid signature" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      log("warn", "webhook", "Rejected: payload is not JSON", detail);
      return send(res, 400, { error: "payload is not JSON; set the webhook content type to application/json" });
    }
    const event = header(req, "x-github-event");
    const delivery = classifyDelivery(event, payload, login);
    if (delivery.kind === "pong") return send(res, 200, { status: "pong" });
    if (delivery.kind === "ignore") {
      log("debug", "webhook", `Ignored: ${delivery.reason} (${formatDeliveryContext(event, payload)})`, detail);
      return send(res, 204);
    }
    if (id && recent.has(id)) {
      log("debug", auditLabel(delivery.url), "Duplicate delivery", detail);
      return send(res, 202, { status: "duplicate" });
    }
    const outcome = enqueue(delivery.url);
    if (outcome === "closed") {
      log("warn", auditLabel(delivery.url), "Not accepted · shutting down", detail);
      return send(res, 503, { status: outcome });
    }
    if (id) remember(id);
    const status = { queued: "Queued", rerun: "Re-run queued", coalesced: "Coalesced" }[outcome];
    log(outcome === "coalesced" ? "debug" : "info", auditLabel(delivery.url), `${status} · ${delivery.reason} · requester=${delivery.requester}`, detail);
    return send(res, 202, { status: outcome });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log("error", "webhook", `Request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: "internal error" });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  return {
    listen(port: number, host: string): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    /** Stops accepting connections and waits for requests in flight. */
    close(): Promise<void> {
      return new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 5_000);
        // Not listening yet reports an error, but there is nothing to wait for either way.
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
      });
    },
  };
}
