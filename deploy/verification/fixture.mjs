import { createServer } from "node:http";

// Only GitHub/model HTTP boundaries are fixtures. All storage is real.
// The draft PR must be skipped without model inference or review publication.
const stats = { githubReads: 0, modelCalls: 0, publicationAttempts: 0, unexpected: [] };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (path === "/stats") return reply(200, stats);
  if (path === "/v1/chat/completions") { stats.modelCalls++; return reply(500, { error: "Unexpected model call" }); }
  if (req.method === "POST") { stats.publicationAttempts++; return reply(500, { error: "Publication forbidden" }); }
  if (req.headers.authorization !== "Bearer verification-only") return reply(401, { error: "Invalid fixture token" });
  if (path === "/github/user") { stats.githubReads++; return reply(200, { login: "verification-bot" }); }
  if (/^\/github\/repos\/pronto\/verification\/pulls\/7$/.test(path)) {
    stats.githubReads++;
    return reply(200, { title: "Local recovery verification", body: "", merged: false, draft: true, labels: [], changed_files: 0,
      head: { sha: "a".repeat(40), repo: { full_name: "pronto/verification" } },
      base: { sha: "b".repeat(40), repo: { full_name: "pronto/verification" } } });
  }
  stats.unexpected.push(`${req.method} ${path}`);
  return reply(500, { error: "Unexpected fixture request" });
});
server.listen(8081, "0.0.0.0");
process.on("SIGTERM", () => server.close());
