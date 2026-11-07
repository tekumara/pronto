// Isolated HTTP host for the MCP request contract, without serve's independent startup recovery.
// Uses the same endpoint and listener composition as production; no test-only production hooks.
import { createAuditMcpEndpoint } from "../src/discussion/mcp.ts";
import { createWebhookServer } from "../src/server/serve.ts";

const mcp = await createAuditMcpEndpoint({
  runAudit: async () => { throw new Error("This read-only test host does not run audits"); },
  publicUrl: process.argv[2]!, allowedOrigins: process.argv.slice(3), token: process.env.PRONTO_MCP_TOKEN ?? "",
});
const server = createWebhookServer({
  secret: "fixture-webhook-secret", login: "fixture", mcp,
  enqueue: async () => { throw new Error("MCP requests must never enter webhook admission"); },
});
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const address = await server.listen(0, "127.0.0.1");
  console.error(`Pronto MCP listening at http://127.0.0.1:${address.port}${mcp.path}`);
  await stopped.promise;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await server.close();
}
