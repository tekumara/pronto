import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

function endpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`; // No credentials, query parameters or fragments.
  } catch { return "[invalid URL]"; }
}

/** Provider errors are untrusted: keep each log line bounded and strip common credentials and terminal controls. */
function diagnosticText(value: unknown, secrets: Set<string>): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const text = [...secrets].reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), raw);
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, endpoint)
    .replace(/\b(Bearer|Basic)\s+[\w.~+\/=-]+/gi, "$1 [REDACTED]")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|cookie)\b["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 4_000);
}

/** Share redactions across transport errors, retry events and the final failure for one audit. */
export function createAuditDiagnostics(output: (message: string) => void) {
  const secrets = new Set<string>();
  const text = (value: unknown) => diagnosticText(value, secrets);
  return {
    text,
    warn: (message: string) => output(text(message)),
    rememberSecrets(values: string[]): void { for (const value of values) if (value) secrets.add(value); },
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
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    diagnostics.rememberSecrets(["authorization", "x-api-key", "api-key", "cookie"].flatMap((key) => {
      const value = headers.get(key);
      return value ? [value, value.replace(/^(Bearer|Basic)\s+/i, "")] : [];
    }));
    const context = () => `${model.provider}/${model.id} api=${model.api} ${method} ${endpoint(url)} elapsedMs=${Date.now() - started}`;
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
