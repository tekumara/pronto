import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { auditSkillMarkdown } from "./audit-skill.ts";
import { pinnedFileTool, readPinnedAuditFile, readSavedAuditPage, savedAuditTool, type PinnedFileArguments, type SavedAuditArguments } from "./audit-tools.ts";
import { stateDirectory } from "../state.ts";
import { runAuditTool, type RunAuditArguments, type createMcpAuditRunner } from "./run-audit.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const MAX_REQUEST_BYTES = 64 * 1024;
const skillUri = "skill://pronto-audit-discussion/SKILL.md";

/** The public URL is configuration, never inferred from untrusted forwarded headers. */
function mcpPublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new Error("The MCP public URL must be HTTPS with an endpoint path, no credentials, query or fragment.");
  }
  return url;
}

function send(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store", ...headers }).end(json);
}

/** Mounted on serve's HTTP listener; each request is authenticated independently. */
export async function createAuditMcpEndpoint({ token, publicUrl, root = stateDirectory(), allowedOrigins = [], audit }: {
  token: string; publicUrl: string; root?: string; allowedOrigins?: string[];
  audit?: { token: string; run: ReturnType<typeof createMcpAuditRunner> };
}) {
  if (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token)) {
    throw new Error("PRONTO_MCP_TOKEN must be a dedicated bearer token of at least 32 characters. Generate one with openssl rand -hex 32.");
  }
  if (audit && !/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(audit.token)) {
    throw new Error("PRONTO_MCP_AUDIT_TOKEN must be a dedicated bearer token of at least 32 characters. Generate one with openssl rand -hex 32.");
  }
  if (audit && audit.token === token) throw new Error("PRONTO_MCP_AUDIT_TOKEN must differ from PRONTO_MCP_TOKEN.");
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
  const auditTokenHash = audit ? createHash("sha256").update(audit.token).digest() : undefined;
  const skills = await SkillsExtension.load(memorySkillFiles({ "pronto-audit-discussion/SKILL.md": auditSkillMarkdown }), { strict: true });
  const makeHandler = (canAudit: boolean) => createMcpHandler(() => {
    const mcp = new McpServer({ name: "pronto-audits", version: "1.0.0" }, {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      instructions: `${canAudit ? "Pronto audit execution and evidence." : "Read-only Pronto audit evidence."} Load ${skillUri} through the skills extension or resources/read before discussing an audit. Retain the auditRef returned by read_audit; every request is independent.`,
    });
    skills.attach(mcp);
    mcp.registerTool(savedAuditTool.name, {
      description: savedAuditTool.description,
      inputSchema: fromJsonSchema<SavedAuditArguments>(savedAuditTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      const { page } = readSavedAuditPage(args, undefined, root);
      return { content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page };
    });
    mcp.registerTool(pinnedFileTool.name, {
      description: pinnedFileTool.description,
      inputSchema: fromJsonSchema<PinnedFileArguments>(pinnedFileTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => {
      const code = await readPinnedAuditFile(args, undefined, root, ctx.mcpReq.signal);
      return { content: [{ type: "text", text: JSON.stringify(code) }], structuredContent: code };
    });
    if (canAudit && audit) mcp.registerTool(runAuditTool.name, {
      description: runAuditTool.description,
      inputSchema: fromJsonSchema<RunAuditArguments>(runAuditTool.parameters as JsonSchemaType),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, ctx) => {
      const result = await audit.run(args, ctx.mcpReq.signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result,
        isError: result.results.some((item) => item.status === "failed") };
    });
    return mcp;
  }, { legacy: "reject", responseMode: "json", maxRequestBodySize: MAX_REQUEST_BYTES });
  const reader = makeHandler(false);
  const writer = audit ? makeHandler(true) : undefined;
  const nodeOptions = { maxRequestBodySize: MAX_REQUEST_BYTES, onerror: () => console.error("Pronto MCP: HTTP request failed.") };
  const readHandler = toNodeHandler(reader, nodeOptions);
  const writeHandler = writer ? toNodeHandler(writer, nodeOptions) : undefined;
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
    const canRead = timingSafeEqual(suppliedHash, expectedTokenHash);
    const canAudit = !!auditTokenHash && timingSafeEqual(suppliedHash, auditTokenHash);
    if (!auth || (!canRead && !canAudit)) {
      return send(res, 401, { error: "A valid Pronto MCP bearer token is required." }, { "WWW-Authenticate": "Bearer realm=\"pronto\"", Connection: "close" });
    }
    if (stopping) return send(res, 503, { error: "Server is shutting down." });
    // Match the configured path exactly. Query-string credentials and alternate routing are not accepted.
    if (req.url !== publicEndpoint.pathname) return send(res, 404, { error: "Not found." });
    if (req.method !== "POST") return send(res, 405, { error: "Only stateless MCP POST requests are supported." }, { Allow: "POST" });
    await (canAudit ? writeHandler! : readHandler)(req, res);
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
      return closed ??= Promise.all([reader.close(), writer?.close()]).then(() => {});
    },
  };
}

export type AuditMcpEndpoint = Awaited<ReturnType<typeof createAuditMcpEndpoint>>;
