import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { DeferredHandle, Models } from "@earendil-works/pi-ai";
import { GenerationTask, ProviderDoc, type ConversationId, type GenerationCheckpoint, type Harness } from "@earendil-works/pi-durable";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Preserve the synchronous stream interface while waiting for permission to make a provider request. */
class AdmittedStream extends AssistantMessageEventStream {
  #source: Promise<AssistantMessageEventStream>;

  constructor(source: Promise<AssistantMessageEventStream>) {
    super();
    this.#source = source;
  }

  override async *[Symbol.asyncIterator]() {
    yield* await this.#source;
  }

  override async result() {
    return (await this.#source).result();
  }
}

/** Durable resumes the whole session. Gate external work by each conversation's persisted provider identity. */
export function createAuditExecutionGate(models: Models) {
  const attached = Promise.withResolvers<Harness>();
  const allowed = new Set<string>();
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  async function wait(sessionId: string | undefined, context: Context): Promise<void> {
    if (!sessionId) throw new Error("Audit provider session identity is missing");
    if (allowed.has(sessionId)) return;
    let pending = waiting.get(sessionId);
    if (!pending) {
      pending = Promise.withResolvers<void>();
      waiting.set(sessionId, pending);
    }
    await awaitWithContext(pending.promise, context);
  }
  // Durable 1.0.3 polls omit sessionId. Resolve the owning conversation from saved
  // generation checkpoints without changing the provider's opaque deferred handle.
  async function waitDeferred(handle: DeferredHandle, context: Context): Promise<void> {
    const harness = await awaitWithContext(attached.promise, context);
    const owners = new Set<ConversationId>();
    for (const { record } of (await harness.inspect(context)).tasks) {
      if (record.kind !== GenerationTask.definition.name || record.version !== GenerationTask.definition.version
        || record.state.status === "terminal" || record.state.status === "completing") continue;
      const checkpoint = record.state.checkpoint as GenerationCheckpoint;
      if (checkpoint.phase === "poll" && checkpoint.handle.provider === handle.provider
        && checkpoint.handle.modelId === handle.modelId && checkpoint.handle.api === handle.api
        && checkpoint.handle.id === handle.id) owners.add(record.conversationId);
    }
    if (owners.size !== 1) throw new Error("Deferred audit response has no unique owning conversation");
    const provider = await harness.snapshot(ProviderDoc, [...owners][0]!, context);
    await wait(provider?.sessionId, context);
  }
  // Generation uses streams, compaction uses completeSimple, and recovered deferred work uses fetchDeferred.
  // Other model/auth/config methods retain the original runtime and its receiver. Deferred cancellation
  // stays ungated so --force can cancel saved work without admitting another provider request.
  const streams = new Set(["stream", "streamSimple", "streamDeferred"]);
  const completions = new Set(["complete", "completeSimple", "fetchDeferred"]);
  const deferred = new Set(["streamDeferred", "fetchDeferred"]);
  const gatedModels = new Proxy(models, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (typeof property === "string" && (streams.has(property) || completions.has(property))) {
        return (...args: unknown[]) => {
          const options = args[2] as { sessionId?: string; signal?: AbortSignal } | undefined;
          const context = options?.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
          const permission = deferred.has(property) && !options?.sessionId
            ? waitDeferred(args[1] as DeferredHandle, context) : wait(options?.sessionId, context);
          const admitted = permission.then(() => Reflect.apply(value, target, args));
          return streams.has(property) ? new AdmittedStream(admitted as Promise<AssistantMessageEventStream>) : admitted;
        };
      }
      return value.bind(target);
    },
  });
  return {
    models: gatedModels,
    attach(harness: Harness): void { attached.resolve(harness); },
    wait,
    allow(sessionId: string): void {
      allowed.add(sessionId);
      waiting.get(sessionId)?.resolve();
      waiting.delete(sessionId);
    },
  };
}
