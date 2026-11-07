import { createHash } from "node:crypto";
import type { ReviewSnapshot } from "../github/reviews.ts";

// These hashes are persisted for cache identity and submitted-review deduplication.
// Changing canonicalization or evidence normalization changes compatibility with saved work.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedEvidence(snapshot: ReviewSnapshot) {
  const { id: _id, startedAt: _startedAt, fetchedAt: _fetchedAt, ...evidence } = snapshot;
  return { ...evidence,
    comments: evidence.comments.map((comment) => ({ ...comment,
      replies: [...comment.replies].sort((a, b) => compare(a.url, b.url)),
    })).sort((a, b) => compare(a.key, b.key)),
    files: [...evidence.files].sort((a, b) => compare(a.path, b.path)),
  };
}

export function evidenceFingerprint(snapshot: ReviewSnapshot, policy: string): string {
  return digest({ policy, evidence: normalizedEvidence(snapshot) });
}

// Compare the same normalized input we hash, without printing comment bodies or patches.
function changedFields(previous: object, current: object): string[] {
  const before = previous as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  return Object.keys({ ...before, ...after }).sort(compare)
    .filter((key) => !(key in before) || !(key in after) || canonical(before[key]) !== canonical(after[key]));
}

function collectionChanges<T extends object>(previous: T[], current: T[], key: (item: T) => string,
  label: (key: string) => string): string[] {
  const before = new Map(previous.map((item) => [key(item), item]));
  const after = new Map(current.map((item) => [key(item), item]));
  return [...new Set([...before.keys(), ...after.keys()])].sort(compare).flatMap((id) => {
    const old = before.get(id);
    const next = after.get(id);
    if (!old) return [`${label(id)} added`];
    if (!next) return [`${label(id)} removed`];
    const fields = changedFields(old, next);
    return fields.length ? [`${label(id)} changed (${fields.join(", ")})`] : [];
  });
}

export function evidenceChanges(previous: ReviewSnapshot, current: ReviewSnapshot): string[] {
  const { comments: oldComments, files: oldFiles, ...before } = normalizedEvidence(previous);
  const { comments, files, ...after } = normalizedEvidence(current);
  return [
    ...changedFields(before, after).map((field) => `${field} changed`),
    ...collectionChanges(oldComments, comments, (comment) => comment.key, (key) => key),
    ...collectionChanges(oldFiles, files, (file) => file.path, (path) => `file ${JSON.stringify(path)}`),
  ];
}
