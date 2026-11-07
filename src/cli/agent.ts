import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord";
import { AuditDiscussion } from "../discussion/audit-chat.ts";
import { auditChatInstructions } from "../discussion/audit-skill.ts";
import { createModelRuntime } from "../model.ts";
import { openStateHarness } from "../state.ts";
import { AssistantEntry, ConversationTranscript, createRegistry, LiveDoc, ToolResultEntry, type ConversationView, type LiveState } from "@earendil-works/pi-durable";

const CHAT_COMMANDS = `Ask about a saved audit by PR URL, then ask follow-up questions.
  /help  Show examples and available tools
  /quit  Exit

Ctrl+C saves unfinished discussion for restart.`;

const CHAT_HELP = `${CHAT_COMMANDS}

Examples
  Why is https://github.com/owner/repo/pull/42 still outstanding?
  What did the author say about these findings?
  Was this addressed by code, an explanation or reported testing?
  Does the cited evidence support the auditor's reasoning?
  What would satisfy the rubric?
  What truthful explanation could address the concern?

Tools
  read_audit        Read saved findings, discussion, patches, rubric and code excerpts
  read_github_file  Inspect additional code at the selected audit's pinned commits

Chat keeps the selected attempt across questions and restarts.
Ask explicitly to switch to the latest attempt or a particular audit ID.
Chat cannot run audits, change findings, post reviews or run shell commands.
Use pronto <PR URL> in a separate terminal to run an audit.`;

async function main() {
  const context = BACKGROUND_CONTEXT;
  const cwd = process.cwd();
  // Reuse Pi's credential store, OAuth refresh, and custom model configuration.
  const { models, model, available } = await createModelRuntime(cwd, process.argv[2]);

  const registry = createRegistry();
  registry.install(AuditDiscussion);
  const harness = await openStateHarness({ kind: "chat", cwd }, {
    models,
    registry,
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
      instructions: auditChatInstructions,
      extensions: [AuditDiscussion],
    } });
    // Also replace the old coding instructions/tool filters in existing chat histories before resuming work.
    await root.configure({
      instructions: auditChatInstructions, extensions: [AuditDiscussion], tools: AuditDiscussion.tools,
      modelTools: AuditDiscussion.tools,
      ...(process.argv[2] ? { model: { provider: model.provider, modelId: model.id } } : {}),
    }, context);
    const agent = await root.agent(context);
    if (!available.some((m) => m.provider === agent.model?.provider && m.id === agent.model?.modelId)) {
      throw new Error("The saved model is unavailable. Run npm start -- provider/model-id to select another.");
    }
    console.log(`Pronto · audit chat\n  Model  ${agent.model!.provider}/${agent.model!.modelId}\n  Cwd    ${cwd}\n\n${CHAT_COMMANDS}\n`);

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
        console.log(`[${tool.name}] ${tool.args.prUrl ?? tool.args.path ?? ""}`);
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
      } else if (content.startsWith("/")) {
        console.error("Chat only reads existing audits. Ask a question with a PR URL, or type /help. Use pronto <PR URL> in a separate terminal to run an audit.");
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
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
