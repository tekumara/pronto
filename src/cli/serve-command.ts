import { SERVE_USAGE } from "./audit-options.ts";
import { createAuditor, type AuditOptions } from "../audit/auditor.ts";
import { createModelRuntime } from "../model.ts";
import { auditLabel, createServeLogger, type Log } from "../logging.ts";
import { fetchViewerLogin } from "../github/reviews.ts";
import { createWebhookServer } from "../server/serve.ts";
import type { AuditMcpEndpoint } from "../discussion/mcp.ts";
import { createMcpAuditRunner } from "../discussion/run-audit.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_HOST, DEFAULT_PORT, parseServeOptions } from "./serve-options.ts";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

function printServeHelp(): void {
  console.log(SERVE_USAGE);
  console.log("Starts a server for a GitHub webhook. Review requests and PR comment mentions of the token's GitHub user audit that PR. Drafts becoming ready while they are requested also start an audit.");
  console.log("PRONTO_WEBHOOK_SECRET must be set to the secret configured on the webhook. Set the webhook content type to application/json and send Pull requests, Issue comments, Pull request review comments and Pull request reviews events.");
  console.log(`--port <n> sets the port to listen on (default: ${DEFAULT_PORT}; 0 picks a free port).`);
  console.log(`--host <address> sets the address to bind (default: ${DEFAULT_HOST}; use 0.0.0.0 to accept outside connections, behind TLS).`);
  console.log(`--concurrency <n> sets how many audits run at once (default: ${DEFAULT_CONCURRENCY}).`);
  console.log("--webhook-path <path> sets the path that receives deliveries (default: /webhook). GET /healthz reports health.");
  console.log("--verbose includes ignored deliveries, delivery IDs, tool calls, MCP tool names, outcomes and durations, cache changes and full reports.");
  console.log("--mcp exposes audit tools and the discussion skill on the same HTTP listener (default: off). Requires PRONTO_MCP_TOKEN and --mcp-public-url <https-url> (or an HTTP loopback URL for local use); the token can run audits and publish reviews with apply=true. Terminate public HTTPS at a reverse proxy. See MCP.md.");
  console.log("--mcp-allow-origin <https-origin> adds an exact allowed browser origin; repeat for multiple origins. MCP bearer auth is separate from webhook signatures. --mcp cannot yet be combined with --replicated-state.");
  console.log("--replicated-state enables experimental term-isolated S3 state (default: off). Requires PRONTO_REPLICA_URL, PRONTO_LITESTREAM_BIN, AWS_REGION and AWS credentials. See REPLICATED_STATE.md. GET /readyz reports admission readiness; /healthz is liveness.");
  console.log("The audit flags apply to every webhook audit and work as they do for pronto. --force and --pr are not supported. Without --apply, new audits only log previews. Previously authorised publications can still recover.");
}

export async function runServe(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return printServeHelp();
  const options = parseServeOptions(args);
  const log = createServeLogger({ verbose: options.verbose });
  // Validate the MCP authority and credential before GitHub/model setup. No second listener or runtime.
  const mcpOptions = options.mcp;
  let auditRunner: ReturnType<typeof createMcpAuditRunner> | undefined;
  const mcp = mcpOptions ? await import("../discussion/mcp.ts").then(({ createAuditMcpEndpoint }) => createAuditMcpEndpoint({
    publicUrl: mcpOptions.publicUrl, allowedOrigins: mcpOptions.allowedOrigins, log,
    runAudit: (args, signal) => {
      if (!auditRunner) throw new Error("Audit runtime is not ready");
      return auditRunner(args, signal);
    },
    token: process.env.PRONTO_MCP_TOKEN ?? "",
  })) : undefined;
  try {
    await runConfiguredServe(options, mcp, (runner) => { auditRunner = runner; }, log);
  } finally {
    // Also covers failures before the HTTP listener takes ownership. Endpoint close is idempotent.
    await mcp?.close();
  }
}

async function runConfiguredServe(config: ReturnType<typeof parseServeOptions>, mcp: AuditMcpEndpoint | undefined,
  setAuditRunner: (runner: ReturnType<typeof createMcpAuditRunner>) => void, log: Log): Promise<void> {
  const { requested, port, host, concurrency, path, replicatedState, skipLabels, skipDrafts, skipApproved, exclude, approve, allowUncertain, approveMigrations, apply } = config;
  // Do not even load the S3 SDK or inspect replica configuration in ordinary serve.
  const replica = replicatedState ? await import("../replication/s3-control.ts").then(({ replicaConfig }) => replicaConfig()) : undefined;
  const secret = process.env.PRONTO_WEBHOOK_SECRET;
  if (!secret) throw new Error("PRONTO_WEBHOOK_SECRET is required: set it to the secret configured on the GitHub webhook.");
  if (mcp && secret === process.env.PRONTO_MCP_TOKEN) throw new Error("PRONTO_MCP_TOKEN must differ from PRONTO_WEBHOOK_SECRET: MCP clients must not be able to sign webhook deliveries.");
  // Resolve credentials before listening, so a missing token or model fails at startup rather than on the first delivery.
  const login = await fetchViewerLogin();
  const { models, model } = await createModelRuntime(process.cwd(), requested);
  const options: AuditOptions = { model: { provider: model.provider, modelId: model.id }, skipLabels, skipDrafts, skipApproved, exclude, approve, allowUncertain, approveMigrations, apply };
  if (replica) {
    const { createPrimaryRuntime } = await import("../replication/primary-runtime.ts");
    const runtime = await createPrimaryRuntime(replica, { models, audit: options, concurrency, log });
    let stopping = false;
    const server = createWebhookServer({ secret, login, enqueue: (url, id) => runtime.enqueue(url, id),
      ready: () => !stopping && runtime.ready(), path, log });
    const stopped = Promise.withResolvers<NodeJS.Signals>();
    const stop = (signal: NodeJS.Signals) => { stopping = true; stopped.resolve(signal); void runtime.close().catch(() => {}); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const address = await server.listen(port, host);
      log("info", "serve", `Listening on http://${host}:${address.port}${path} · replicated state · standby until owned-ready`);
      await stopped.promise;
    } finally {
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await Promise.all([server.close(), runtime.close()]);
    }
    return;
  }
  const auditor = createAuditor(models, { log, webhooks: { concurrency, options } });
  if (mcp) setAuditRunner(createMcpAuditRunner(auditor, models, process.cwd()));
  let stopping = false;
  const server = createWebhookServer({ secret, login, enqueue: async (url, id) => {
    if (stopping) return "closed";
    const outcome = await auditor.enqueue(url, id);
    return stopping ? "closed" : outcome;
  }, path, log, mcp });
  const stopped = Promise.withResolvers<NodeJS.Signals>();
  const stop = (signal: NodeJS.Signals) => { stopping = true; stopped.resolve(signal); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Before listening, so a delivery cannot race recovery to open the same repository database.
    const { urls: recoverable, skipped } = await auditor.recover();
    for (const { database, error } of skipped) log("warn", "serve", `Skipped ${database}, so its audits are not recovered: ${describe(error)}`);
    if (stopping) return;
    const address = await server.listen(port, host);
    log("info", "serve", `Reviewing as ${login} with ${model.provider}/${model.id}${options.apply ? "" : " · new webhook audits: previews only, add --apply to submit reviews; saved publications still recover"}`);
    log("info", "serve", `Listening on http://${host}:${address.port}${path} · up to ${concurrency} audits at once`);
    if (mcp) log("info", "serve", `MCP at ${config.mcp!.publicUrl} · audit execution enabled`);
    for (const url of recoverable) {
      if (stopping) break;
      log("info", auditLabel(url), "Recovering audit");
    }
    await auditor.resume();
    const signal = await stopped.promise;
    log("info", "serve", `Received ${signal}; stopping`);
  } finally {
    stopping = true;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Interrupt active audits while closing the listener, so long MCP calls do not delay shutdown.
    await Promise.all([server.close(), auditor.close()]);
  }
}
