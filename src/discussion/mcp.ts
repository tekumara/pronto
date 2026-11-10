import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { auditSkillMarkdown } from "./audit-skill.ts";
import { pinnedFileTool, readPinnedAuditFile, readSavedAuditPage, savedAuditTool, type PinnedFileArguments, type SavedAuditArguments } from "./audit-tools.ts";
import { stateDirectory } from "../state.ts";
import { createServeLogger, type Log } from "../logging.ts";
import { runAuditTool, type RunAuditArguments, type createMcpAuditRunner } from "./run-audit.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_SERVER_NAME = "pronto-audits";
const MAX_REQUEST_BYTES = 64 * 1024;
const skillUri = "skill://pronto-audit-discussion/SKILL.md";

/** The canonical URL is configuration, never inferred from untrusted forwarded headers. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

function mcpPublicUrl(value: string): URL {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if ((!secure && !localHttp) || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new Error("The MCP public URL must be HTTPS, or HTTP on localhost/loopback, with an endpoint path, no credentials, query or fragment.");
  }
  return url;
}

function send(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store", ...headers }).end(json);
}

async function logMcpToolCall<T>(log: Log, name: string, call: () => Promise<T>): Promise<T> {
  const label = `${MCP_SERVER_NAME}/${name}`;
  const started = performance.now();
  log("debug", "mcp", `${label} started`);
  try {
    const result = await call();
    const failed = typeof result === "object" && result !== null && "isError" in result && result.isError === true;
    log("debug", "mcp", `${label} ${failed ? "failed" : "completed"}`, `duration=${(performance.now() - started).toFixed(1)}ms`);
    return result;
  } catch (error) {
    log("debug", "mcp", `${label} failed`, `duration=${(performance.now() - started).toFixed(1)}ms`);
    throw error;
  }
}

/** Mounted on serve's HTTP listener; each request is authenticated independently. */
export async function createAuditMcpEndpoint({ token, publicUrl, root = stateDirectory(), allowedOrigins = [], runAudit, log = createServeLogger() }: {
  token: string; publicUrl: string; root?: string; allowedOrigins?: string[]; log?: Log;
  runAudit: ReturnType<typeof createMcpAuditRunner>;
}) {
  if (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token)) {
    throw new Error("PRONTO_MCP_TOKEN must be a dedicated bearer token of at least 32 characters. Generate one with openssl rand -hex 32.");
  }
  const publicEndpoint = mcpPublicUrl(publicUrl);
  const origins = new Set([publicEndpoint.origin]);
  for (const value of allowedOrigins) {
    const origin = new URL(value);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new Error("Each allowed MCP origin must be an HTTPS origin without a path, credentials, query or fragment.");
    }
    origins.add(origin.origin);
  }
  const expectedTokenHash = createHash("sha256").update(token).digest();
  const skills = await SkillsExtension.load(memorySkillFiles({ "pronto-audit-discussion/SKILL.md": auditSkillMarkdown }), { strict: true });
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      instructions: `Pronto audit execution and evidence. Load ${skillUri} through the skills extension or resources/read before discussing an audit. Retain the auditRef returned by read_audit; every request is independent.`,
    });
    skills.attach(mcp);
    mcp.registerTool(savedAuditTool.name, {
      description: savedAuditTool.description,
      inputSchema: fromJsonSchema<SavedAuditArguments>(savedAuditTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => logMcpToolCall(log, savedAuditTool.name, async () => {
      const { page } = readSavedAuditPage(args, undefined, root);
      return { content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page };
    }));
    mcp.registerTool(pinnedFileTool.name, {
      description: pinnedFileTool.description,
      inputSchema: fromJsonSchema<PinnedFileArguments>(pinnedFileTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => logMcpToolCall(log, pinnedFileTool.name, async () => {
      const code = await readPinnedAuditFile(args, undefined, root, ctx.mcpReq.signal);
      return { content: [{ type: "text", text: JSON.stringify(code) }], structuredContent: code };
    }));
    mcp.registerTool(runAuditTool.name, {
      description: runAuditTool.description,
      inputSchema: fromJsonSchema<RunAuditArguments>(runAuditTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, ctx) => logMcpToolCall(log, runAuditTool.name, async () => {
      const result = await runAudit(args, ctx.mcpReq.signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result,
        isError: result.results.some((item) => item.status === "failed") };
    }));
    return mcp;
  }, { legacy: "reject", responseMode: "json", maxRequestBodySize: MAX_REQUEST_BYTES });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_REQUEST_BYTES,
    onerror: () => console.error("Pronto MCP: HTTP request failed.") });
  // Public Host is preserved by Caddy. Loopback hosts allow local diagnostics; never use X-Forwarded-Host.
  const validHost = hostHeaderValidation([publicEndpoint.hostname, "localhost", "127.0.0.1", "[::1]"]);
  let stopping = false;
  let closed: Promise<void> | undefined;
  async function serveRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.rawHeaders.length > 128) return send(res, 431, { error: "Too many headers." }, { Connection: "close" });
    if (!validHost(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== "string" || !origins.has(origin))) {
      return send(res, 403, { error: "Origin is not allowed." });
    }
    // Dedicated manually provisioned tokens, not a pretend OAuth issuer or forwarded GitHub credentials.
    const auth = typeof req.headers.authorization === "string" ? /^Bearer ([A-Za-z0-9._~+/=-]{1,514})$/i.exec(req.headers.authorization) : null;
    const suppliedHash = createHash("sha256").update(auth?.[1] ?? "").digest();
    if (!auth || !timingSafeEqual(suppliedHash, expectedTokenHash)) {
      return send(res, 401, { error: "A valid Pronto MCP bearer token is required." }, { "WWW-Authenticate": "Bearer realm=\"pronto\"", Connection: "close" });
    }
    if (stopping) return send(res, 503, { error: "Server is shutting down." });
    // Match the configured path exactly. Query-string credentials and alternate routing are not accepted.
    if (req.url !== publicEndpoint.pathname) return send(res, 404, { error: "Not found." });
    if (req.method !== "POST") return send(res, 405, { error: "Only stateless MCP POST requests are supported." }, { Allow: "POST" });
    await nodeHandler(req, res);
  }
  return {
    path: publicEndpoint.pathname,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        await serveRequest(req, res);
      } catch {
        console.error("Pronto MCP: HTTP request failed.");
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: "Internal error." });
      }
    },
    close(): Promise<void> {
      stopping = true;
      return closed ??= Promise.resolve(handler.close());
    },
  };
}

export type AuditMcpEndpoint = Awaited<ReturnType<typeof createAuditMcpEndpoint>>;
