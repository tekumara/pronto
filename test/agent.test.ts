import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, reply, tool } from "./fixtures.ts";

test("terminal chat starts with a concise banner and keeps audit help local", { timeout: 20000 }, async (t) => {
  let requests = 0;
  const f = await fixture(t, (_body, response) => {
    requests++;
    reply(response, [{ role: "assistant", content: "Unexpected model request." }]);
  });
  const banner = await f.run("/quit\n");
  assert.ok(banner.includes("local/test"));
  assert.ok(banner.includes(f.cwd));
  assert.match(banner, /\/audit <PR URL>/);
  assert.match(banner, /\/help/);
  assert.match(banner, /Ctrl\+C.*unfinished work/);
  assert.doesNotMatch(banner, /--skip|--approve|--exclude/, "audit flags belong in help, not the startup banner");

  const { child, done } = f.start();
  child.stdin.end("/help\n/audit\n/quit\n");
  const help = await done;
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /\/audit --pr <PR URL> --pr <PR URL>/);
  assert.match(help.stdout, /--apply.*GitHub/);
  assert.match(help.stdout, /--approve\s+.*--apply/);
  assert.match(help.stderr, /Usage: \/audit/);
  assert.match(help.stderr, /\/help/);
  assert.doesNotMatch(help.stderr, /--skip/, "invalid audit input should point to help instead of dumping flags");
  assert.equal(requests, 0, "help and invalid audit commands must not call the model");
});

test("terminal chat uses saved Pi credentials, coding tools, and persisted history", { timeout: 20000 }, async (t) => {
  let turn = 0;
  const partial = Promise.withResolvers<ServerResponse>();
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1);
    switch (turn++) {
      case 0:
        assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ["bash", "edit", "read", "write"]);
        assert.equal(latest?.content, "make a greeting");
        tool(response, "read", { path: "seed.txt" });
        break;
      case 1:
        assert.match(latest?.content ?? "", /hello/);
        tool(response, "write", { path: "greeting.txt", content: "hello\n" });
        break;
      case 2:
        tool(response, "edit", { path: "greeting.txt", edits: [{ oldText: "hello", newText: "hello world" }] });
        break;
      case 3:
        tool(response, "bash", { command: "cat greeting.txt" });
        break;
      case 4:
        assert.match(latest?.content ?? "", /hello world/);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: { role: "assistant", content: "Greeting " }, finish_reason: null }] })}\n\n`);
        partial.resolve(response);
        break;
      case 5:
        assert.equal(latest?.content, "what did you do?");
        assert.ok(body.messages.some((message) => message.role === "user" && message.content === "make a greeting"));
        assert.ok(body.messages.some((message) => message.role === "assistant" && message.content === "Greeting ready."));
        reply(response, [{ role: "assistant", content: "I made greeting.txt." }]);
        break;
      default:
        assert.fail("Unexpected model request");
    }
  });
  await writeFile(join(f.cwd, "seed.txt"), "hello\n");
  const first = f.start();
  const streamed = new Promise<void>((done) => {
    let output = "";
    const onData = (data: Buffer) => {
      output += data;
      if (output.includes("Greeting ")) {
        first.child.stdout.off("data", onData);
        done();
      }
    };
    first.child.stdout.on("data", onData);
  });
  first.child.stdin.end("make a greeting\n/quit\n");
  const response = await partial.promise;
  await streamed; // The first text must reach the terminal before the response ends.
  reply(response, [{ content: "ready." }]);
  const result = await first.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(f.cwd, "greeting.txt"), "utf8"), "hello world\n");
  assert.equal(result.stdout.split("Greeting ready.").length - 1, 1, "streamed answer must appear exactly once");
  assert.ok(result.stdout.includes("[bash] cat greeting.txt"));
  // A changed Pi default must not replace or prevent using the saved model.
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "missing", defaultModel: "missing" }));
  const second = await f.run("what did you do?\n/quit\n");
  assert.ok(second.includes("I made greeting.txt."));
  assert.equal(turn, 6);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`restart resumes an unfinished turn after ${signal} without resubmitting the input`, { timeout: 20000 }, async (t) => {
    let requests = 0;
    const started = Promise.withResolvers<void>();
    const f = await fixture(t, (body, response) => {
      assert.equal(body.messages.filter((message) => message.role === "user" && message.content === "keep working").length, 1);
      if (++requests === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta: { role: "assistant", content: "Starting" }, finish_reason: null }] })}\n\n`);
        started.resolve();
        // Leave the request unfinished until the agent process stops.
      } else {
        reply(response, [{ role: "assistant", content: "Recovered and finished." }]);
      }
    });
    const first = f.start();
    first.child.stdin.write("keep working\n");
    await started.promise;
    if (signal === "SIGKILL") {
      const competing = f.start();
      competing.child.stdin.end("/quit\n");
      const rejected = await competing.done;
      assert.equal(rejected.code, 1, rejected.stderr);
      assert.match(rejected.stderr, /Database is already in use/);
      assert.equal(requests, 1, "a competing chat must not resume the pending turn");
    }
    first.child.kill(signal);
    const stopped = await first.done;
    if (signal === "SIGTERM") assert.equal(stopped.code, 0, stopped.stderr);
    const resumed = f.start();
    resumed.child.stdin.end("/quit\n");
    const output = await resumed.done;
    assert.equal(output.code, 0, output.stderr);
    assert.ok(output.stdout.includes("Recovered and finished."));
    if (signal === "SIGKILL") assert.match(output.stderr, /Retry 1: The host stopped while the model was answering/);
    assert.equal(requests, 2);
  });
}

test("directory-local chat databases are ignored and left untouched", { timeout: 20000 }, async (t) => {
  const prompts: (string | undefined)[][] = [];
  const f = await fixture(t, (body, response) => {
    prompts.push(body.messages.filter((message) => message.role === "user").map((message) => message.content));
    reply(response, [{ role: "assistant", content: "Done." }]);
  });
  await f.run("old conversation\n/quit\n");
  const directory = join(f.stateDir, "chats");
  const databases = (await readdir(directory)).filter((file) => file.endsWith(".sqlite"));
  assert.equal(databases.length, 1);
  const legacyDirectory = join(f.cwd, ".pi-durable");
  await mkdir(legacyDirectory);
  const legacy = join(legacyDirectory, "agent.sqlite");
  await rename(join(directory, databases[0]!), legacy);
  const original = await readFile(legacy);
  await f.run("new conversation\n/quit\n");
  assert.deepEqual(prompts, [["old conversation"], ["new conversation"]], "the chat must start fresh, not import directory-local history");
  assert.deepEqual(await readFile(legacy), original);
});
