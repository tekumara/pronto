import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AuditDocument } from "../src/audit/audit-records.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { auditChatInstructions } from "../src/discussion/audit-skill.ts";
import { fixture, tool } from "./fixtures.ts";
import { assessments, auditCheckpointHook, baseSha, codeUrl, commentUrl, githubEvidence, headSha, prUrl } from "./audit-evidence.ts";

const auditEntry = resolve("src/cli/audit.ts");
const publicUrl = "https://audits.example.test/mcp";
const secret = () => randomBytes(32).toString("hex");
const repositoryPath = (stateDir: string) => join(stateDir, "repos/github.com/acme~demo.sqlite");

async function launchMcp(f: Awaited<ReturnType<typeof fixture>>, token: string, origins: string[] = []) {
  const running = f.start([publicUrl, ...origins], {
    entrypoint: resolve("test/mcp-host.ts"), env: { PRONTO_MCP_TOKEN: token, PI_CODING_AGENT_DIR: join(f.directory, "no-model-login") },
  });
  running.child.stdin.end();
  const url = await new Promise<string>((done, reject) => {
    let output = "";
    const onData = (data: Buffer) => {
      output += data;
      const match = /Pronto MCP listening at (http:\/\/[^\s]+)/.exec(output);
      if (match) { running.child.stderr.off("data", onData); done(match[1]!); }
    };
    running.child.stderr.on("data", onData);
    void running.done.then((result) => reject(new Error(`MCP stopped before listening: ${result.stderr}`)));
  });
  return { ...running, url, async stop() {
    running.child.kill("SIGTERM");
    const result = await running.done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stderr.includes(token), "server logs must not disclose its credential");
    return result;
  } };
}

async function connect(t: TestContext, url: string, token: string) {
  const client = new Client({ name: "pronto-contract-client", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } }, supportedProtocolVersions: ["2026-07-28"],
  });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function data(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  const block = result.content[0];
  assert.ok(block?.type === "text");
  const value = JSON.parse(block.text);
  assert.deepEqual(result.structuredContent, value, "structured and textual tool results must represent the same evidence");
  return value;
}

async function section(client: Client, args: Record<string, unknown>) {
  let content = "";
  let offset: number | null = 0;
  let reference = args.auditRef;
  do {
    const page = await data(client, "read_audit", { ...args, ...(reference ? { auditRef: reference } : {}), limit: 6000, offset });
    reference ??= page.auditRef;
    assert.equal(page.auditRef, reference);
    assert.equal(page.offset, content.length);
    assert.ok(page.content.length <= 6000);
    content += page.content;
    offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(content);
}

test("latest MCP client discovers and verifies the canonical skill and retrieves bounded audit sources over HTTP", { timeout: 20000 }, async (t) => {
  const longReply = `Fixed already. ${"The qualification 🔎 matters. ".repeat(1000)} Final limitation.`;
  const github = githubEvidence({ replyBody: longReply });
  let auditTurn = 0;
  const f = await fixture(t, (_body, response) => {
    if (auditTurn++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
    else if (auditTurn === 2) tool(response, "report_review_assessment", assessments());
    else assert.fail("MCP must not start a model or reassess the PR");
  }, { github: (request, response) => {
    if (request.url === `/github/repos/contributor/fork/contents/src/wide.ts?ref=${headSha}`) {
      const content = "x".repeat(120000);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ type: "file", size: content.length, encoding: "base64", content: Buffer.from(content).toString("base64") }));
      return;
    }
    return github.handle(request, response);
  } });
  await f.run("", [prUrl], { entrypoint: auditEntry });
  const original = await readFile(repositoryPath(f.stateDir));
  const reads = github.requests.length;
  const token = secret();
  const server = await launchMcp(f, token);
  const client = await connect(t, server.url, token);
  assert.equal(client.getProtocolEra(), "modern");
  const tools = await client.listTools();
  const summary = await data(client, "read_audit", { prUrl });
  assert.equal(summary.audit.status, "completed");
  assert.equal(summary.audit.headSha, headSha);
  assert.equal(JSON.parse(summary.content).counts.outstanding, 1);
  assert.ok(typeof summary.auditRef === "string" && summary.auditRef.length > 0);
  assert.ok(tools.tools.find((entry) => entry.name === "read_audit")?.annotations?.readOnlyHint);

  const skills = new SkillsClient(client);
  assert.equal(skills.supported, true);
  const { skills: entries } = await skills.list();
  const entry = entries.find((entry) => entry.frontmatter.name === "pronto-audit-discussion");
  assert.ok(entry);
  const manifest = await skills.read(entry);
  assert.equal(manifest.verified, true);
  assert.equal(manifest.body?.trim(), auditChatInstructions, "terminal and MCP must use the same canonical instructions");
  assert.match(manifest.body!, /Retain that exact `auditRef`/);
  await assert.rejects(client.readResource({ uri: "file:///etc/passwd" }), /not found|not registered/i);

  const finding = (await section(client, { auditRef: summary.auditRef, section: "findings", commentKey: "inline:102" }))[0];
  assert.equal(finding.findings[0].reason, "The guard handles a missing user.");
  assert.equal(finding.source.replies[0].url, commentUrl(103));
  assert.equal((await section(client, { auditRef: summary.auditRef, section: "discussion", commentKey: "inline:102" })).replies[0].body, longReply);
  const code = await data(client, "read_audit", { auditRef: summary.auditRef, section: "code" });
  assert.equal(JSON.parse(code.content)[0].result.url, codeUrl);
  const instructions = await data(client, "read_audit", { auditRef: summary.auditRef, section: "instructions", limit: 16000 });
  assert.match(JSON.parse(instructions.content), /explanation\/scope decision/);
  assert.equal(github.requests.length, reads, "saved retrieval and skill discovery must not contact GitHub");

  const inspected = await data(client, "read_github_file", { auditRef: summary.auditRef, path: "src/access.ts", revision: "base", limit: 2 });
  assert.equal(inspected.sha, baseSha);
  assert.equal(inspected.url, `https://github.com/acme/demo/blob/${baseSha}/src/access.ts#L1-L2`);
  assert.match(inspected.provenance, /Additional.*not saved audit evidence/);
  for (const args of [
    { auditRef: summary.auditRef, path: "../seed.txt", revision: "head" },
    { auditRef: summary.auditRef, path: "src/access.ts", revision: "head", repository: "evil/repo", sha: "main" },
    { auditRef: summary.auditRef, path: "src/wide.ts", revision: "head" },
  ]) {
    const rejected = await client.callTool({ name: "read_github_file", arguments: args });
    assert.equal(rejected.isError, true);
    assert.ok(JSON.stringify(rejected).length < 2000);
  }
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), original);
  await assert.rejects(readdir(join(f.stateDir, "chats")), { code: "ENOENT" });
  assert.equal(auditTurn, 2);
  await server.stop();
});

function rpc(method = "server/discover", params: Record<string, unknown> = {}, version = "2026-07-28") {
  const named = params.name ?? params.uri;
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version,
      "Mcp-Method": method, ...(typeof named === "string" ? { "Mcp-Name": named } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "raw-contract-client", version: "1.0.0" },
    } } }),
  };
}

test("MCP requires authorization on every request and enforces the latest HTTP protocol without creating state", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("MCP must not call a model"));
  const token = secret();
  const server = await launchMcp(f, token, ["https://agents.example.test"]);
  const valid = rpc();
  const request = (patch: { headers?: Record<string, string>; body?: string; method?: string; path?: string } = {}) => new Promise<{ status: number; headers: Headers; body: any }>((done, reject) => {
    // Raw HTTP preserves deliberately invalid Host headers; browser-style fetch may silently replace them.
    const req = httpRequest(server.url + (patch.path ?? ""), {
      method: patch.method ?? valid.method, headers: { ...valid.headers, Authorization: `Bearer ${token}`, ...patch.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          done({ status: response.statusCode!, headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(Object.hasOwn(patch, "body") ? patch.body : valid.body);
  });
  const advertised = await request();
  assert.equal(advertised.status, 200);
  assert.deepEqual(advertised.body.result.supportedVersions, ["2026-07-28"]);
  assert.equal(advertised.headers.get("mcp-session-id"), null);
  assert.equal((await request({ headers: { Origin: "https://audits.example.test" } })).status, 200);
  assert.equal((await request({ headers: { Origin: "https://agents.example.test" } })).status, 200);
  const namedControl = await request(rpc("tools/call", { name: "read_audit", arguments: { prUrl } }));
  assert.equal(namedControl.status, 200);
  assert.equal(namedControl.body.result.isError, true, "valid named calls must reach the saved-audit reader");
  const tests: { name: string; patch: { headers?: Record<string, string>; body?: string; method?: string; path?: string }; status: number; code?: number }[] = [
    { name: "missing credential", patch: { headers: { Authorization: "" } }, status: 401 },
    { name: "wrong credential after prior success", patch: { headers: { Authorization: "Bearer invalid" } }, status: 401 },
    { name: "credential in URI is not authentication", patch: { path: "?access_token=" + token, headers: { Authorization: "" } }, status: 401 },
    { name: "query routing is rejected even with auth", patch: { path: "?access_token=" + token }, status: 404 },
    { name: "untrusted origin", patch: { headers: { Origin: "https://evil.example.test" } }, status: 403 },
    { name: "opaque origin", patch: { headers: { Origin: "null" } }, status: 403 },
    { name: "same host on a different port", patch: { headers: { Origin: "https://audits.example.test:444" } }, status: 403 },
    { name: "forwarded headers cannot override Host", patch: { headers: { Host: "evil.example.test", "X-Forwarded-Host": "audits.example.test", "X-Forwarded-Proto": "https" } }, status: 403 },
    { name: "no GET stream", patch: { method: "GET", body: undefined }, status: 405 },
    // Node's HTTP client does not automatically frame a DELETE body.
    { name: "no session DELETE", patch: { method: "DELETE", headers: { "Content-Length": String(Buffer.byteLength(valid.body)) } }, status: 405 },
    { name: "no legacy protocol", patch: rpc("server/discover", {}, "2025-11-25"), status: 400, code: -32022 },
    { name: "no initialize handshake", patch: rpc("initialize"), status: 404, code: -32601 },
    { name: "missing method header", patch: { headers: { "Mcp-Method": "" } }, status: 400, code: -32020 },
    { name: "mismatched method header", patch: { headers: { "Mcp-Method": "tools/list" } }, status: 400, code: -32020 },
    { name: "mismatched version header", patch: { headers: { "MCP-Protocol-Version": "2025-11-25" } }, status: 400 },
    { name: "missing name header", patch: { ...rpc("tools/call", { name: "read_audit", arguments: { prUrl } }), headers: { ...rpc("tools/call").headers, "Mcp-Name": "" } }, status: 400, code: -32020 },
    { name: "mismatched name header", patch: { ...rpc("tools/call", { name: "read_audit", arguments: { prUrl } }), headers: { ...rpc("tools/call").headers, "Mcp-Name": "read_github_file" } }, status: 400, code: -32020 },
    { name: "missing per-request metadata", patch: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }) }, status: 400 },
    { name: "missing client capabilities", patch: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }) }, status: 400 },
    { name: "content type", patch: { headers: { "Content-Type": "text/plain" } }, status: 415 },
    { name: "invalid JSON", patch: { body: "{" }, status: 400 },
    { name: "header count limit", patch: { headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-Extra-${i}`, "x"])) }, status: 431 },
    { name: "request body limit", patch: { body: JSON.stringify({ ...JSON.parse(valid.body), padding: "x".repeat(70000) }) }, status: 413 },
  ];
  for (const test of tests) {
    const rejected = await request(test.patch);
    assert.equal(rejected.status, test.status, test.name + ": " + JSON.stringify(rejected.body));
    if (test.code) assert.equal(rejected.body.error.code, test.code, test.name);
    assert.ok(!JSON.stringify(rejected.body).includes(token), test.name + " must not echo the credential");
  }
  const oldHeaders = await request({ headers: { "Mcp-Session-Id": "invented-session", "Last-Event-ID": "invented-event" } });
  assert.equal(oldHeaders.status, 200, "legacy session headers are ignored, not interpreted");
  assert.equal(oldHeaders.headers.get("mcp-session-id"), null);
  const client = await connect(t, server.url, token);
  const missing = await client.callTool({ name: "read_audit", arguments: { prUrl } });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing), /No saved audit/);
  for (const name of ["bash", "write", "report_review_assessment"]) {
    await assert.rejects(client.callTool({ name, arguments: {} }), new RegExp(`Tool ${name} not found`));
  }
  await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
  await server.stop();
});

test("chunked MCP request bodies are bounded and get a usable rejection", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("An oversized MCP body must not call a model"));
  const token = secret();
  const server = await launchMcp(f, token);
  const valid = rpc();
  const body = JSON.stringify({ ...JSON.parse(valid.body), padding: "x".repeat(70000) });
  const status = await new Promise<number>((done, reject) => {
    const req = httpRequest(server.url, { method: "POST", headers: { ...valid.headers, Authorization: `Bearer ${token}` } }, (response) => {
      response.resume();
      response.on("end", () => done(response.statusCode!));
    });
    req.on("error", reject);
    req.write(body.slice(0, 32768));
    req.end(body.slice(32768));
  });
  assert.equal(status, 413);
  await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
  await server.stop();
});

test("audit references survive newer audits, independent clients and restart, but reject replaced evidence", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  let building = true;
  let turns = 0;
  const f = await fixture(t, (_body, response) => {
    assert.ok(building, "MCP must not reassess the audit");
    if (turns++ % 2 === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
    else {
      const report = assessments();
      if (turns > 2) report.assessments[0]!.findings[0]!.reason = "A newer audit's distinct recorded assessment.";
      tool(response, "report_review_assessment", report);
    }
  }, { github: github.handle });
  await f.run("", [prUrl], { entrypoint: auditEntry });
  building = false;
  const token = secret();
  const firstServer = await launchMcp(f, token);
  const a = await connect(t, firstServer.url, token);
  const first = await data(a, "read_audit", { prUrl });
  const originalFindings = await section(a, { auditRef: first.auditRef, section: "findings" });
  building = true;
  await f.run("", [prUrl, "--force"], { entrypoint: auditEntry });
  building = false;
  const before = await readFile(repositoryPath(f.stateDir));
  const reads = github.requests.length;
  const b = await connect(t, firstServer.url, token);
  const newer = await data(b, "read_audit", { prUrl });
  assert.notEqual(newer.auditRef, first.auditRef);
  assert.notEqual(newer.audit.auditId, first.audit.auditId);
  assert.equal((await section(b, { auditRef: newer.auditRef, section: "findings" }))[0].findings[0].reason, "A newer audit's distinct recorded assessment.");
  assert.deepEqual(await section(a, { auditRef: first.auditRef, section: "findings" }), originalFindings);
  assert.deepEqual(await section(b, { auditRef: first.auditRef, section: "findings" }), originalFindings, "references identify evidence, not a particular connection");
  await a.close();
  await b.close();
  await firstServer.stop();
  const restarted = await launchMcp(f, token);
  const c = await connect(t, restarted.url, token);
  assert.deepEqual(await section(c, { auditRef: first.auditRef, section: "findings" }), originalFindings);
  for (const args of [
    {}, { auditRef: "not-a-reference" }, { auditRef: first.auditRef, latest: true },
    { auditRef: first.auditRef, prUrl: "https://github.com/acme/demo/pull/8" },
  ]) assert.equal((await c.callTool({ name: "read_audit", arguments: args })).isError, true, JSON.stringify(args));
  assert.equal((await c.callTool({ name: "read_github_file", arguments: { path: "src/access.ts", revision: "head" } })).isError, true);
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), before);
  assert.equal(github.requests.length, reads);

  // Change persisted evidence using the real document codec. Old references must never follow the replacement.
  const writer = createSession(await openNodeSqliteStorage(repositoryPath(f.stateDir)));
  try {
    await writer.commit(async (tx) => {
      const audit = await tx.doc(AuditDocument, first.audit.auditId as ConversationId);
      audit.snapshot!.id = "replacement-evidence-identity";
    }, BACKGROUND_CONTEXT);
  } finally { await writer.close(BACKGROUND_CONTEXT); }
  const replaced = await readFile(repositoryPath(f.stateDir));
  for (const name of ["read_audit", "read_github_file"]) {
    const result = await c.callTool({ name, arguments: { auditRef: first.auditRef,
      ...(name === "read_github_file" ? { path: "src/access.ts", revision: "head" } : {}) } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /evidence identity changed/);
  }
  assert.deepEqual(await readFile(repositoryPath(f.stateDir)), replaced);
  assert.equal(github.requests.length, reads);
  await assert.rejects(readdir(join(f.stateDir, "chats")), { code: "ENOENT" });
  await assert.rejects(readdir(join(f.directory, "no-model-login")), { code: "ENOENT" });
  await restarted.stop();
  assert.equal(turns, 4);
});

for (const crash of ["report", "publication"] as const) {
  test(`Mounting and requesting MCP cannot resume a committed ${crash} checkpoint or publish`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let turns = 0;
    const f = await fixture(t, (_body, response) => {
      if (turns++ === 0) tool(response, "read_github_file", { path: "src/access.ts", revision: "head" });
      else if (turns === 2) tool(response, "report_review_assessment", assessments());
      else assert.fail("MCP must not resume an assessment");
    }, { github: github.handle });
    const hook = await auditCheckpointHook(f.directory, crash);
    const audit = f.start([prUrl, ...(crash === "publication" ? ["--apply"] : [])], { entrypoint: auditEntry, nodeArgs: ["--import", hook] });
    audit.child.stdin.end();
    const interrupted = await audit.done;
    assert.equal(interrupted.code, 79, interrupted.stderr);
    const path = repositoryPath(f.stateDir);
    const original = await readFile(path);
    const db = new DatabaseSync(path, { readOnly: true });
    const tasks = db.prepare("SELECT record FROM tasks ORDER BY id").all();
    db.close();
    const reads = github.requests.length;
    const owner = new DatabaseSync(`${path}.lock`);
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const token = secret();
      const server = await launchMcp(f, token);
      const client = await connect(t, server.url, token);
      const saved = await data(client, "read_audit", { prUrl });
      assert.equal(saved.audit.reportAccepted, true);
      assert.equal(saved.audit.status, crash === "report" ? "incomplete" : "completed");
      if (crash === "report") assert.ok(saved.audit.limitations.some((line: string) => line.includes("not a completed successful audit")));
      assert.equal((await section(client, { auditRef: saved.auditRef, section: "findings" })).length, 6);
      await server.stop();
      assert.equal(github.requests.length, reads, "neither mounting the endpoint nor reads may recover a pending review");
      const after = new DatabaseSync(path, { readOnly: true });
      assert.deepEqual(after.prepare("SELECT record FROM tasks ORDER BY id").all(), tasks);
      after.close();
      assert.deepEqual(await readFile(path), original);
      await assert.rejects(readdir(join(f.stateDir, "chats")), { code: "ENOENT" });
    } finally { owner.close(); }
    assert.equal(turns, 2);
  });
}
