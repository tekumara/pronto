import { bool, compile, int, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { readAudit, type AuditSelection } from "./audit-reader.ts";
import { parseReviewTarget, readGithubFile } from "../github/reviews.ts";

const referencePrefix = "audit.v1:";
const referenceValue = compile(obj({
  prUrl: str({ minLength: 1, maxLength: 2048 }),
  auditId: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  snapshotId: str({ minLength: 1, maxLength: 256 }),
}));

// A self-contained URI is easier for agents to retain than base64 JSON. It is still an opaque identifier, not authority.
function encodeReference(selection: Extract<AuditSelection, { kind: "audit" }>): string {
  const url = new URL(selection.prUrl);
  url.hash = new URLSearchParams({ audit: String(selection.auditId), snapshot: selection.snapshotId }).toString();
  return referencePrefix + url.href;
}

function decodeReference(value: string): Extract<AuditSelection, { kind: "audit" }> {
  try {
    if (!value.startsWith(referencePrefix) || value.length > 4096) throw new Error("Invalid reference format.");
    const url = new URL(value.slice(referencePrefix.length));
    const fields = new URLSearchParams(url.hash.slice(1));
    url.hash = "";
    const fieldsValue = { prUrl: url.href, auditId: Number(fields.get("audit")), snapshotId: fields.get("snapshot") };
    if (!referenceValue.check(fieldsValue)) throw new Error("Invalid reference fields.");
    const selection: Extract<AuditSelection, { kind: "audit" }> = { kind: "audit", ...fieldsValue };
    parseReviewTarget(selection.prUrl);
    if (encodeReference(selection) !== value) throw new Error("Noncanonical reference.");
    return selection;
  } catch {
    throw new Error("Invalid auditRef. Use the exact reference returned by read_audit.");
  }
}

function samePr(left: string, right: string) {
  const a = parseReviewTarget(left);
  const b = parseReviewTarget(right);
  return a.pr === b.pr && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
    && new URL(a.url).origin === new URL(b.url).origin;
}

export const savedAuditTool = {
  name: "read_audit",
  description: "Read saved Pronto audit evidence or skipped attempts. The default summary includes each finding's status, reason, evidence and source URL; findings includes the full saved sources. For a particular source, use section=findings with its commentKey. Other sections provide discussion, patches, original rubric, saved code excerpts or skip history (attempts). Initially supply prUrl. Assessment results return auditRef; retain it and pass it on follow-ups, including to read_github_file. Skipped attempts return skipId; pass it with prUrl to select that skip. MCP connections have no selection state; terminal chat keeps its selection when omitted. Never guess a positive auditId or skipId. Use latest=true with prUrl and without auditRef or skipId only when asked to switch. Output content is a character slice of section JSON; follow nextOffset with the same selection, section and commentKey to retrieve complete explanations. This never runs or changes audits. See the pronto-audit-discussion skill for evidence-based reasoning.",
  parameters: obj({
    prUrl: opt(str({ maxLength: 2048, description: "GitHub PR URL; required for an initial lookup without auditRef." })),
    auditRef: opt(str({ maxLength: 4096, description: "Exact opaque reference returned by read_audit. Use on follow-ups; never invent or edit it." })),
    auditId: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "0 (default) keeps the terminal selection or selects the latest initially. A positive ID must come from the user or a tool." })),
    skipId: opt(str({ minLength: 1, maxLength: 256, description: "Exact skipId returned by read_audit; supply with prUrl to retrieve that skipped attempt." })),
    latest: opt(bool({ description: "Explicitly select the latest attempt; supply prUrl and omit auditRef, skipId and a positive auditId." })),
    section: opt(oneOf(["summary", "findings", "discussion", "files", "instructions", "code", "attempts"])),
    commentKey: opt(str({ maxLength: 128, description: "Narrow findings or discussion to a source key returned by summary, such as inline:101." })),
    offset: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Character offset in this section's JSON, starting at 0." })),
    limit: opt(int({ minimum: 1, maximum: 16_000, description: "Characters to return (default 8000)." })),
  }),
  outputLimits: { maxBytes: 150_000, maxLines: 2_000 },
};
export type SavedAuditArguments = Static<typeof savedAuditTool.parameters>;
type LegacyAuditSelection = { prUrl: string; auditId: number; snapshotId: string };
function normalizeSelection(value?: AuditSelection | LegacyAuditSelection | null): AuditSelection | undefined {
  if (!value) return undefined;
  if ("kind" in value) return value;
  return { kind: "audit", ...value };
}

/** Shared retrieval interface; only the terminal adapter supplies an implicit selection. */
export function readSavedAuditPage(args: SavedAuditArguments, current?: AuditSelection | null, root?: string) {
  const explicit = args.auditRef?.trim() ? decodeReference(args.auditRef.trim()) : undefined;
  const currentSelection = normalizeSelection(current);
  const requestedSkipId = args.skipId?.trim() || undefined;
  const prUrl = args.prUrl?.trim() || explicit?.prUrl || currentSelection?.prUrl;
  const auditId = args.auditId || undefined;
  if (!prUrl) throw new Error("Provide a GitHub PR URL or a saved audit/skip reference to select an existing attempt.");
  if (args.latest && auditId !== undefined) throw new Error("Use auditId or latest=true, not both.");
  if (requestedSkipId && (explicit || auditId !== undefined || args.latest)) throw new Error("Use skipId alone with prUrl to select a skipped attempt.");
  if (explicit && (args.latest || requestedSkipId || (auditId !== undefined && auditId !== explicit.auditId) || !samePr(prUrl, explicit.prUrl))) {
    throw new Error("Use auditRef alone for the selected attempt; omit it when selecting a different attempt.");
  }
  const selection = explicit ?? (!requestedSkipId && currentSelection && samePr(prUrl, currentSelection.prUrl) && auditId === undefined && !args.latest ? currentSelection : undefined);
  const skipId = requestedSkipId ?? (selection?.kind === "skip" ? selection.skipId : undefined);
  const selectedAuditId = selection?.kind === "audit" ? selection.auditId : auditId;
  const commentKey = args.commentKey?.trim() || undefined;
  const saved = readAudit({ prUrl, auditId: selectedAuditId, skipId, section: args.section, commentKey }, root);
  const content = JSON.stringify(saved.data);
  const offset = args.offset ?? 0;
  const end = Math.min(content.length, offset + (args.limit ?? 8_000));
  if (offset >= content.length) throw new Error(`Offset exceeds section length (${content.length} characters).`);
  if (saved.kind === "skip") {
    if (selection?.kind === "audit") throw new Error("The selected audit reference does not identify a skipped attempt.");
    const selected: AuditSelection = { kind: "skip", prUrl: saved.audit.prUrl, skipId: saved.skip.attemptId };
    const page = { skipId: selected.skipId, audit: saved.audit, section: args.section ?? "summary", commentKey: null,
      offset, totalChars: content.length, nextOffset: end < content.length ? end : null, content: content.slice(offset, end) };
    if (Buffer.byteLength(JSON.stringify(page)) > savedAuditTool.outputLimits.maxBytes) throw new Error("Saved skipped-attempt metadata exceeds the retrieval byte limit.");
    return { selection: selected, page };
  }
  if (selection?.kind === "skip") throw new Error("The selected skip reference does not identify an audit.");
  if (selection?.kind === "audit" && saved.audit.snapshotId !== selection.snapshotId) {
    throw new Error("The selected audit's evidence identity changed. Select an attempt explicitly.");
  }
  const selected: AuditSelection = { kind: "audit", prUrl: saved.audit.prUrl, auditId: saved.audit.auditId, snapshotId: saved.audit.snapshotId };
  const page = { auditRef: encodeReference(selected), audit: saved.audit, section: args.section ?? "summary", commentKey: commentKey ?? null,
    offset, totalChars: content.length, nextOffset: end < content.length ? end : null, content: content.slice(offset, end) };
  if (Buffer.byteLength(JSON.stringify(page)) > savedAuditTool.outputLimits.maxBytes) throw new Error("Saved audit metadata exceeds the retrieval byte limit.");
  return { selection: selected, page };
}

export const pinnedFileTool = {
  name: "read_github_file",
  description: "Additional code inspection at a saved audit's pinned head or base commit. Pass the auditRef returned by read_audit; terminal chat can also use its remembered selection. Read saved code excerpts with read_audit(section='code') first. No moving branches, arbitrary URLs, local files or model-supplied repositories/commits. The numbered lines and pinned URL are additional inspection, not evidence the original auditor necessarily saw.",
  parameters: obj({
    auditRef: opt(str({ maxLength: 4096, description: "Exact reference returned by read_audit; required over stateless MCP." })),
    path: str({ minLength: 1, maxLength: 2048 }), revision: oneOf(["head", "base"]),
    offset: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })), limit: opt(int({ minimum: 1, maximum: 300 })),
  }),
  outputLimits: { maxBytes: 100_000, maxLines: 2_000 },
};
export type PinnedFileArguments = Static<typeof pinnedFileTool.parameters>;

export async function readPinnedAuditFile(args: PinnedFileArguments, current?: AuditSelection | null, root?: string, signal?: AbortSignal) {
  const selection = args.auditRef?.trim() ? decodeReference(args.auditRef.trim()) : normalizeSelection(current);
  if (!selection) throw new Error("Use read_audit to select an existing audit, then pass its auditRef before reading code.");
  if (selection.kind === "skip") throw new Error("Skipped attempts have no pinned audit code to read.");
  const saved = readAudit({ prUrl: selection.prUrl, auditId: selection.auditId }, root);
  if (saved.kind !== "audit" || saved.audit.snapshotId !== selection.snapshotId) throw new Error("The selected audit's evidence identity changed. Select an attempt explicitly.");
  const code = { auditRef: encodeReference(selection), auditId: selection.auditId,
    provenance: "Additional pinned-code inspection for this discussion, not saved audit evidence.",
    ...await readGithubFile(saved.snapshot, args.path, args.revision, args.offset ?? 1, args.limit ?? 200, signal) };
  if (Buffer.byteLength(JSON.stringify(code)) > pinnedFileTool.outputLimits.maxBytes) {
    throw new Error("Pinned code excerpt exceeds the retrieval byte limit. Request a smaller line range; a single oversized line is unavailable.");
  }
  return code;
}
