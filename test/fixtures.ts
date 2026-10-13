import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";

export type Request = { model: string; messages: { role: string; content?: string; tool_calls?: unknown[] }[]; tools: { function: { name: string } }[] };
export const noDatabaseMigration = { status: "not-migration", reason: "The PR changes application behaviour, not database schema or data." } as const;
const entrypoint = resolve("agent.ts");
type Launch = { nodeArgs?: string[]; entrypoint?: string; env?: NodeJS.ProcessEnv; cwd?: string };

// External HTTP endpoints are simulated. The CLI, Pi auth, tools, and SQLite are real.
export async function fixture(t: TestContext, respond: (body: Request, response: ServerResponse) => void, options: {
  entrypoint?: string;
  github?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-test-"));
  const agentDir = join(directory, "pi");
  const stateDir = join(directory, "state");
  const cwd = join(directory, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const errors: unknown[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/github")) {
        assert.equal(request.headers.authorization, "Bearer github-key");
        assert.ok(options.github, "Unexpected GitHub request");
        await options.github(request, response);
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer test-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      respond(JSON.parse(Buffer.concat(chunks).toString()), response);
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end("Fixture failed");
    }
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "close");
        child.kill("SIGKILL");
        await exited;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "test" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { local: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: "openai-completions",
    models: [{ id: "test", contextWindow: 128000, maxTokens: 1000 }],
  } } }));

  const start = (args: string[] = [], launch: Launch = {}) => {
    const child = spawn(process.execPath, [...(launch.nodeArgs ?? []), "--experimental-strip-types", launch.entrypoint ?? options.entrypoint ?? entrypoint, ...args], {
      cwd: launch.cwd ?? cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PRONTO_STATE_DIR: stateDir,
        ...(options.github ? {
          GITHUB_TOKEN: "github-key", GH_TOKEN: "", HTTPS_PROXY: "", https_proxy: "",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}/github`,
          GITHUB_GRAPHQL_URL: `http://127.0.0.1:${address.port}/github/graphql`,
        } : {}),
        ...launch.env,
      },
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { child, done };
  };
  const run = async (input: string, args: string[] = [], launch: Launch = {}) => {
    const { child, done } = start(args, launch);
    child.stdin.end(input);
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  return { directory, cwd, agentDir, stateDir, start, run };
}

export function reply(response: ServerResponse, deltas: object[], finish = "stop") {
  if (!response.headersSent) response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of deltas) {
    response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}

let callSequence = 0;
export function tool(response: ServerResponse, name: string, args: object) {
  reply(response, [{ role: "assistant", tool_calls: [{ index: 0, id: `call-${name}-${++callSequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }], "tool_calls");
}

