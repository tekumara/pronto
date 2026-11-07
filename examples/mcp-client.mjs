// Run from this checkout after npm install --ignore-scripts.
// PRONTO_MCP_URL and PRONTO_MCP_TOKEN are supplied by the operator, not command arguments.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";

const { PRONTO_MCP_URL: url, PRONTO_MCP_TOKEN: token } = process.env;
const prUrl = process.argv[2];
if (!url || !token || !prUrl) throw new Error("Set PRONTO_MCP_URL and PRONTO_MCP_TOKEN, then run node examples/mcp-client.mjs <GitHub PR URL>.");
const client = new Client({ name: "pronto-example", version: "1.0.0" }, {
  versionNegotiation: { mode: { pin: "2026-07-28" } }, supportedProtocolVersions: ["2026-07-28"],
});
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });

async function read(args) {
  const result = await client.callTool({ name: "read_audit", arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}

async function section(auditRef, name) {
  let content = "";
  let offset = 0;
  do {
    const page = await read({ auditRef, section: name, offset, limit: 16000 });
    if (page.auditRef !== auditRef) throw new Error("Audit reference changed during retrieval.");
    content += page.content;
    offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(content);
}

try {
  await client.connect(transport); // Modern server/discover, never initialize or a protocol session.
  const tools = await client.listTools();
  const skills = new SkillsClient(client);
  const catalog = await skills.list();
  const entry = catalog.skills.find((entry) => entry.frontmatter.name === "pronto-audit-discussion");
  if (!entry) throw new Error("The audit discussion skill is unavailable.");
  const skill = await skills.read(entry); // Fetches resources/read and verifies advertised SHA-256 digests and sizes.
  if (!skill.verified || !skill.body) throw new Error("The audit discussion skill could not be verified.");
  console.log(JSON.stringify({ protocol: client.getProtocolEra(), tools: tools.tools.map((tool) => tool.name), skill: entry.frontmatter.name, verified: skill.verified }));
  // An agent host must actually load this body as guidance; discovery alone does not activate it.
  console.log(skill.body);
  const saved = await read({ prUrl });
  console.log(JSON.stringify({ auditRef: saved.auditRef, audit: saved.audit, summary: await section(saved.auditRef, "summary"), findings: await section(saved.auditRef, "findings") }, null, 2));
} finally {
  await client.close();
}
