import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord";
import { runAudits } from "./auditor.ts";
import { parseAuditOptions } from "./audit-options.ts";
import { createModelRuntime } from "./model.ts";
import { openStateHarness } from "./state.ts";
import { AssistantEntry, ConversationTranscript, createRegistry, LiveDoc, ToolResultEntry, type ConversationView, type LiveState } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const CHAT_COMMANDS = `Type a task to chat, or use a command:
  /audit <PR URL>  Audit a pull request (preview by default)
  /help            Show commands and audit options
  /quit            Exit

Ctrl+C saves unfinished work for restart.`;

const CHAT_HELP = `${CHAT_COMMANDS}

Audit targets
  /audit <PR URL>
  /audit --pr <PR URL> --pr <PR URL> ...

Audit options
  --skip <label>          Skip PRs with this label (repeatable)
  --skip-drafts=false     Include draft PRs (skipped by default)
  --skip-approved=false   Include PRs already approved at the current head
  --exclude <path>        Exclude a repository-relative path or glob (repeatable)
  --force                 Restart the audit and bypass cached assessments

Posting reviews (preview only unless you use --apply)
  --apply                 Post the verdict review to GitHub
  --approve               Approve eligible PRs (requires --apply)
  --allow-uncertain       Allow --approve with uncertain findings
  --approve-migrations    Allow --approve for migrations or unknown migration status

Drafts and PRs approved at the current head are skipped by default.
Chat targets must be GitHub PR URLs. Labels and paths cannot contain spaces.`;

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
  let stream: WatchHandle<ConversationView> | undefined;
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
    console.log(`Pi Durable\n  Model  ${agent.model!.provider}/${agent.model!.modelId}\n  Cwd    ${cwd}\n\n${CHAT_COMMANDS}\n`);

    // The conversation view replaces the former event stream: live partials are in pi.live,
    // while completed assistant and tool messages are transcript entries.
    const printed = new Map<number, number>();
    const printBlock = (block: { type: string; text?: string }, index: number) => {
      if (block.type !== "text" || typeof block.text !== "string") return;
      process.stdout.write(block.text.slice(printed.get(index) ?? 0));
      printed.set(index, block.text.length);
    };
    stream = await root.watch(context);
    const transcript = new ConversationTranscript((query, limit, ctx) => root.entries(query, limit, undefined, ctx));
    let lastEntryId = stream.value.entries.at(-1)?.id ?? 0;
    let runTask = (stream.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.run?.taskId;
    const seenTools = new Set<string>();
    let lastRetry: string | undefined;
    let lastFailure: string | undefined;
    const renderView = async (view: ConversationView) => {
      const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
      if (live?.run?.taskId !== undefined && live.run.taskId !== runTask) {
        runTask = live.run.taskId;
        printed.clear();
        seenTools.clear();
      }
      const assistantContent = view.entries.flatMap((entry) => entry.model ?? []).flatMap((message) =>
        message.role === "assistant" ? message.content : []);
      const runningTools = [
        ...(live?.tools ?? []).flatMap((slot) => {
          if (slot.status !== "running") return [];
          const call = assistantContent.find((block) => block.type === "toolCall" && block.id === slot.callId);
          return [{ callId: slot.callId, name: slot.name, args: call?.type === "toolCall" ? call.arguments : {} }];
        }),
        ...(live?.nestedTools ?? []).filter((slot) => slot.status === "running").map((slot) => ({
          callId: slot.callId, name: slot.name, args: slot.arguments,
        })),
      ];
      for (const tool of runningTools) {
        if (seenTools.has(tool.callId)) continue;
        seenTools.add(tool.callId);
        console.log(`[${tool.name}] ${tool.args.path ?? tool.args.command ?? ""}`);
      }
      const retry = live?.generation?.retry;
      if (retry) {
        const key = `${live?.generation?.attempt}:${retry.at}:${retry.error}`;
        if (key !== lastRetry) {
          lastRetry = key;
          console.error(`Retry ${live?.generation?.attempt}: ${retry.error}`);
        }
      }
      const failure = live?.runFailure;
      if (failure) {
        const key = `${failure.taskId}:${failure.reason}:${failure.detail ?? ""}`;
        if (key !== lastFailure) {
          lastFailure = key;
          console.error(failure.detail ?? `Run ended without an answer: ${failure.reason}`);
        }
      }
      live?.generation?.message?.content.forEach(printBlock);

      let full = transcript.merge(view);
      let gap = full.items.find((item) => item.kind === "gap");
      while (gap) {
        full = await transcript.fillGap(gap, context);
        gap = full.items.find((item) => item.kind === "gap");
      }
      for (const item of full.items) {
        if (item.kind !== "entry" || item.entry.id <= lastEntryId) continue;
        const entry = item.entry;
        if (AssistantEntry.is(entry)) {
          const message = entry.model?.[0];
          if (message?.role === "assistant") {
            message.content.forEach(printBlock);
            console.log();
            if (message.errorMessage) console.error(message.errorMessage);
            printed.clear();
          }
        } else if (ToolResultEntry.is(entry)) {
          const message = entry.model?.[0];
          if (message?.role === "toolResult" && message.isError) {
            console.error(message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"));
          }
        }
        lastEntryId = entry.id;
      }
    };
    await renderView(stream.value);
    stream.start(async (call) => {
      if (call.kind === "value") await renderView(call.value);
    });
    harness.resume();
    await root.waitForIdle(context);
    if (process.stdin.isTTY && !closing) rl.prompt();
    for await (const line of lines) {
      const content = line.trim();
      if (content === "/quit") break;
      if (content === "/help") {
        console.log(`\n${CHAT_HELP}\n`);
      } else if (/^\/audit(?:\s|$)/.test(content)) {
        try {
          const { selectors: urls, skipLabels, skipDrafts, skipApproved, exclude, force, approve, allowUncertain, approveMigrations, apply } = parseAuditOptions(content.slice("/audit".length).trim().split(/\s+/).filter(Boolean), "chat");
          await runAudits(urls, { models, model: agent.model!, skipLabels, skipDrafts, skipApproved, exclude, force, approve, allowUncertain, approveMigrations, apply });
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
