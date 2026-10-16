import { parseReviewTarget } from "./reviews.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Extra delivery metadata is shown only in verbose output. */
export type Log = (level: LogLevel, scope: string, message: string, detail?: string) => void;

export function auditLabel(url: string): string {
  const { owner, repo, pr } = parseReviewTarget(url);
  return `${owner}/${repo}#${pr}`;
}

/** Line-oriented output stays readable when audits interleave or stdout is piped to a file. */
export function createServeLogger({ verbose = false } = {}): Log {
  const plain = (text: string) => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
  return (level, scope, message, detail) => {
    if (level === "debug" && !verbose) return;
    const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${plain(scope).replaceAll("\n", "").padEnd(28)} `;
    const text = plain(`${message}${verbose && detail ? ` · ${detail}` : ""}`)
      .split("\n").filter((line) => line.trim()).map((line) => `${prefix}${line}`).join("\n");
    if (text) (level === "warn" || level === "error" ? console.error : console.log)(text);
  };
}
