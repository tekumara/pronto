import { SERVE_USAGE } from "./audit-options.ts";
import { createAuditor, type AuditOptions } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { auditLabel, createServeLogger } from "./logging.ts";
import { fetchViewerLogin } from "./reviews.ts";
import { createWebhookServer } from "./serve.ts";
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
  console.log("--verbose includes ignored deliveries, delivery IDs, tool calls, cache changes and full reports.");
  console.log("--replicated-state enables experimental term-isolated S3 state (default: off). Requires PRONTO_REPLICA_URL, PRONTO_LITESTREAM_BIN, AWS_REGION and AWS credentials. See REPLICATED_STATE.md. GET /readyz reports admission readiness; /healthz is liveness.");
  console.log("The audit flags apply to every audit and work as they do for pronto. --force and --pr are not supported. Without --apply, new audits only log previews. Previously authorised publications can still recover.");
}

export async function runServe(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return printServeHelp();
  const { requested, port, host, concurrency, path, verbose, replicatedState, skipLabels, skipDrafts, skipApproved, exclude, approve, allowUncertain, approveMigrations, apply } = parseServeOptions(args);
  // Do not even load the S3 SDK or inspect replica configuration in ordinary serve.
  const replica = replicatedState ? await import("./s3-control.ts").then(({ replicaConfig }) => replicaConfig()) : undefined;
  const secret = process.env.PRONTO_WEBHOOK_SECRET;
  if (!secret) throw new Error("PRONTO_WEBHOOK_SECRET is required: set it to the secret configured on the GitHub webhook.");
  // Resolve credentials before listening, so a missing token or model fails at startup rather than on the first delivery.
  const login = await fetchViewerLogin();
  const { models, model } = await createModelRuntime(process.cwd(), requested);
  const options: AuditOptions = { model: { provider: model.provider, modelId: model.id }, skipLabels, skipDrafts, skipApproved, exclude, approve, allowUncertain, approveMigrations, apply };
  const log = createServeLogger({ verbose });
  if (replica) {
    const { createPrimaryRuntime } = await import("./primary-runtime.ts");
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
  let stopping = false;
  const server = createWebhookServer({ secret, login, enqueue: async (url, id) => {
    if (stopping) return "closed";
    const outcome = await auditor.enqueue(url, id);
    return stopping ? "closed" : outcome;
  }, path, log });
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
    log("info", "serve", `Reviewing as ${login} with ${model.provider}/${model.id}${options.apply ? "" : " · new audits: previews only, add --apply to submit reviews; saved publications still recover"}`);
    log("info", "serve", `Listening on http://${host}:${address.port}${path} · up to ${concurrency} audits at once`);
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
    await server.close();
    // Closing interrupts task invocations, not their persisted intents (including waiting work and reruns).
    await auditor.close();
  }
}
