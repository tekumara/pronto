import { parseAuditOptions, SERVE_USAGE } from "./audit-options.ts";
import { DEFAULT_WEBHOOK_PATH } from "./serve.ts";

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_CONCURRENCY = 4;

const valueFlags = ["--port", "--host", "--concurrency", "--webhook-path"];

/** Serve-only flags, then the audit flags that apply to every audit the server runs. */
export function parseServeOptions(args: string[]) {
  let verbose = false;
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--verbose") {
      if (verbose) throw new Error(`--verbose can be supplied only once\n${SERVE_USAGE}`);
      verbose = true;
      continue;
    }
    const flag = valueFlags.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (!flag) { rest.push(arg); continue; }
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
    if (!value?.trim() || (arg === flag && value.startsWith("-"))) throw new Error(`${flag} requires a value\n${SERVE_USAGE}`);
    if (values.has(flag)) throw new Error(`${flag} can be supplied only once\n${SERVE_USAGE}`);
    values.set(flag, value);
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
  if (!/^\/[^\s?#]*$/.test(path) || path === "/healthz") {
    throw new Error(`--webhook-path must start with / and cannot contain spaces, ? or #, and /healthz is reserved for health checks\n${SERVE_USAGE}`);
  }
  return { ...parseAuditOptions(rest, "serve"), port, host: values.get("--host") ?? DEFAULT_HOST, concurrency, path, verbose };
}
