import { parseAuditOptions, SERVE_USAGE } from "./audit-options.ts";
import { DEFAULT_WEBHOOK_PATH } from "../server/serve.ts";

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_CONCURRENCY = 4;

const valueFlags = ["--port", "--host", "--concurrency", "--webhook-path", "--mcp-public-url", "--mcp-allow-origin"];

/** Serve-only flags, then the audit flags that apply to every audit the server runs. */
export function parseServeOptions(args: string[]) {
  let verbose = false;
  let replicatedState = false;
  let mcpEnabled = false;
  const allowedOrigins: string[] = [];
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replicated-state") {
      if (replicatedState) throw new Error(`--replicated-state can be supplied only once\n${SERVE_USAGE}`);
      replicatedState = true;
      continue;
    }
    if (arg === "--mcp") {
      if (mcpEnabled) throw new Error(`--mcp can be supplied only once\n${SERVE_USAGE}`);
      mcpEnabled = true;
      continue;
    }
    if (arg === "--verbose") {
      if (verbose) throw new Error(`--verbose can be supplied only once\n${SERVE_USAGE}`);
      verbose = true;
      continue;
    }
    const flag = valueFlags.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (!flag) { rest.push(arg); continue; }
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
    if (!value?.trim() || (arg === flag && value.startsWith("-"))) throw new Error(`${flag} requires a value\n${SERVE_USAGE}`);
    if (flag === "--mcp-allow-origin") allowedOrigins.push(value);
    else {
      if (values.has(flag)) throw new Error(`${flag} can be supplied only once\n${SERVE_USAGE}`);
      values.set(flag, value);
    }
  }
  const integer = (flag: string, fallback: number, min: number, max: number, description: string) => {
    const value = values.get(flag);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${flag} must be ${description}\n${SERVE_USAGE}`);
    return Number(value);
  };
  const port = integer("--port", DEFAULT_PORT, 0, 65535, "an integer from 0 to 65535");
  const concurrency = integer("--concurrency", DEFAULT_CONCURRENCY, 1, Number.MAX_SAFE_INTEGER, "a positive integer");
  const path = values.get("--webhook-path") ?? DEFAULT_WEBHOOK_PATH;
  if (!/^\/[^\s?#]*$/.test(path) || path === "/healthz" || path === "/readyz") {
    throw new Error(`--webhook-path must start with / and cannot contain spaces, ? or #, and /healthz is reserved for health checks (/readyz is also reserved)\n${SERVE_USAGE}`);
  }
  const publicUrl = values.get("--mcp-public-url");
  if (!mcpEnabled && (publicUrl || allowedOrigins.length)) throw new Error(`MCP options require --mcp\n${SERVE_USAGE}`);
  if (mcpEnabled && !publicUrl) throw new Error(`--mcp requires --mcp-public-url <https-url>\n${SERVE_USAGE}`);
  if (mcpEnabled && replicatedState) throw new Error(`--mcp is not yet supported with --replicated-state: MCP needs the active owner's term-isolated audit source\n${SERVE_USAGE}`);
  const mcp = mcpEnabled ? { publicUrl: publicUrl!, allowedOrigins } : undefined;
  if (mcp) {
    let endpoint: URL;
    try { endpoint = new URL(mcp.publicUrl); }
    catch { throw new Error(`--mcp-public-url must be an absolute HTTPS URL\n${SERVE_USAGE}`); }
    if ([path, "/healthz", "/readyz"].includes(endpoint.pathname)) throw new Error(`The MCP path must differ from the webhook, health and readiness paths\n${SERVE_USAGE}`);
  }
  return { ...parseAuditOptions(rest, "serve"), port, host: values.get("--host") ?? DEFAULT_HOST, concurrency, path, verbose, replicatedState, mcp };
}
