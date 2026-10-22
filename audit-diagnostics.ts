import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

/** Keep diagnostic lines bounded and strip terminal controls. */
function diagnosticText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 4_000);
}

/** Format transport errors, retry events and the final failure consistently for one audit. */
export function createAuditDiagnostics(output: (message: string) => void) {
  return {
    text: diagnosticText,
    warn: (message: string) => output(diagnosticText(message)),
  };
}
export type AuditDiagnostics = ReturnType<typeof createAuditDiagnostics>;

function failureDetails(error: unknown): string {
  const pending = [error];
  const seen = new Set<unknown>();
  const details: string[] = [];
  while (pending.length && seen.size < 10) {
    const failure = pending.shift();
    if (seen.has(failure)) continue;
    seen.add(failure);
    if (!(failure instanceof Error)) {
      details.push(String(failure));
      continue;
    }
    const fields = failure as unknown as Record<string, unknown>;
    const metadata = ["code", "syscall", "hostname", "address", "port"]
      .flatMap((key) => {
        const value = fields[key];
        return typeof value === "string" || typeof value === "number" ? [`${key}=${value}`] : [];
      });
    details.push(`${failure.name}: ${failure.message}${metadata.length ? ` (${metadata.join(", ")})` : ""}`);
    if (failure.cause !== undefined) pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 10));
  }
  return details.join("; caused by: ");
}

// These HTTP adapters support a custom fetch. Google rejects it; Bedrock uses a different transport.
const fetchApis = new Set(["openai-completions", "openai-responses", "azure-openai-responses",
  "openai-codex-responses", "anthropic-messages", "mistral-conversations", "pi-messages"]);
const responseHeaders = ["request-id", "x-request-id", "x-amzn-requestid", "x-amz-request-id", "cf-ray",
  "retry-after", "retry-after-ms", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"];

/** Capture transport causes before the SDK reduces them to e.g. "Connection error." Never consume the response body. */
export function modelDiagnosticOptions(model: Model<Api>, options: StreamOptions | undefined, diagnostics: AuditDiagnostics): StreamOptions | undefined {
  if (!fetchApis.has(model.api)) return options;
  const fetcher = options?.fetch ?? globalThis.fetch;
  return { ...options, fetch: async (input, init) => {
    const started = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const context = () => `${model.provider}/${model.id} api=${model.api} ${method} ${url} elapsedMs=${Date.now() - started}`;
    let response: Response;
    try {
      response = await fetcher(input, init);
    } catch (error) {
      diagnostics.warn(`Model transport error: ${context()} aborted=${init?.signal?.aborted ?? (input instanceof Request && input.signal.aborted)} ${failureDetails(error)}`);
      throw error;
    }
    if (!response.ok) {
      const metadata = responseHeaders.flatMap((key) => {
        const value = response.headers.get(key);
        return value === null ? [] : [`${key}=${value}`];
      });
      diagnostics.warn(`Model HTTP error: ${context()} status=${response.status} ${response.statusText} ${metadata.join(" ")}`);
    }
    return response;
  } };
}
