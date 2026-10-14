import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runAudits } from "./auditor.ts";
import { parseAuditOptions } from "./audit-options.ts";
import { createModelRuntime } from "./model.ts";
import { openStateHarness } from "./state.ts";
import { createRegistry, watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

async function main() {
  const context = BACKGROUND_CONTEXT;
  const cwd = process.cwd();
  // Reuse Pi's credential store, OAuth refresh, and custom model configuration.
  const { models, model, available } = await createModelRuntime(cwd, process.argv[2]);

  const registry = createRegistry();
  registry.install(CodingTools);
  const env = new NodeExecutionEnv({ cwd });
  const harness = await openStateHarness({ kind: "chat", cwd }, {
    models,
    registry,
    env: () => env,
    settings: { toolExecution: "sequential" },
    onReport: (error) => console.error(error),
  }, context);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  // Attach before resuming so piped input is not lost while recovered work runs.
  const lines = rl[Symbol.asyncIterator]();
  let closing = false;
  const quit = () => {
    closing = true;
    rl.close();
    // Close preserves unfinished work; abort would cancel it permanently.
    void harness.close(context).catch((error) => console.error(error));
  };
  rl.on("SIGINT", quit);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
  try {
    const root = await harness.root(context, { agent: {
      model: { provider: model.provider, modelId: model.id },
      cwd,
      instructions: "You are a concise coding agent. Inspect the project before changing it. Use read, write, edit, and bash to complete the user's task. Check your changes. Follow project instructions in AGENTS.md when present.",
    } });
    // root() only uses its agent argument when creating the conversation.
    if (process.argv[2]) {
      await root.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    }
    const agent = await root.agent(context);
    if (!available.some((m) => m.provider === agent.model?.provider && m.id === agent.model?.modelId)) {
      throw new Error("The saved model is unavailable. Run npm start -- provider/model-id to select another.");
    }
    console.log(`Pi Durable · ${agent.model!.provider}/${agent.model!.modelId}\n${cwd}\n/audit [--skip <label>]... [--skip-approved[=true|false]] [--force] [--sticky[=true|false]] [--approve] [--allow-uncertain] [--approve-migrations] [--apply] <PR URL> or --pr <PR URL>... to audit · /quit to exit · Ctrl+C saves unfinished work for restart\n`);

    // Events contain both partial deltas and authoritative final messages.
    const printed = new Map<number, number>();
    const printBlock = (block: AssistantMessage["content"][number], index: number) => {
      if (block.type !== "text") return;
      process.stdout.write(block.text.slice(printed.get(index) ?? 0));
      printed.set(index, block.text.length);
    };
    stream = await watchEvents(harness, root.id, context);
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === "message_start" && event.message.role === "assistant") {
          printed.clear();
          event.message.content.forEach(printBlock);
        } else if (event.type === "message_update") {
          for (const change of event.changes) {
            if (change.type === "text_delta") {
              process.stdout.write(change.delta);
              printed.set(change.contentIndex, (printed.get(change.contentIndex) ?? 0) + change.delta.length);
            } else if ("block" in change) {
              printBlock(change.block, change.contentIndex);
            } else if (change.type === "message") {
              change.message.content.forEach(printBlock);
            }
          }
        } else if (event.type === "message_end") {
          const message = event.entry.model?.[0];
          if (message?.role === "assistant") {
            message.content.forEach(printBlock);
            console.log();
            if (message.errorMessage) console.error(message.errorMessage);
          } else if (message?.role === "toolResult" && message.isError) {
            console.error(message.content.flatMap((b) => b.type === "text" ? [b.text] : []).join("\n"));
          }
        } else if (event.type === "tool_execution_start") {
          console.log(`[${event.toolName}] ${event.args.path ?? event.args.command ?? ""}`);
        } else if (event.type === "auto_retry_start") {
          console.error(`Retry ${event.attempt}: ${event.errorMessage}`);
        } else if (event.type === "task_failed") {
          console.error(event.message);
        }
      }
    });
    harness.resume();
    await root.waitForIdle(context);
    if (process.stdin.isTTY && !closing) rl.prompt();
    for await (const line of lines) {
      const content = line.trim();
      if (content === "/quit") break;
      if (/^\/audit(?:\s|$)/.test(content)) {
        try {
          const { selectors: urls, skipLabels, skipApproved, force, sticky, approve, allowUncertain, approveMigrations, apply } = parseAuditOptions(content.slice("/audit".length).trim().split(/\s+/).filter(Boolean), "chat");
          await runAudits(urls, { models, model: agent.model!, skipLabels, skipApproved, force, sticky, approve, allowUncertain, approveMigrations, apply });
        } catch (error) {
          console.error(error instanceof Error ? error.message : error);
        }
      } else if (content) {
        const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
        if (settled.status === "unanswered") console.error(`No answer: ${settled.reason}`);
      }
      if (process.stdin.isTTY) rl.prompt();
    }
  } catch (error) {
    if (!closing) throw error;
  } finally {
    rl.close();
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    await harness.close(context);
    await stream?.stop();
    await env.cleanup(context);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
