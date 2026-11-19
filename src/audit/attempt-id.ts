/** Stable locators for saved audit attempts. These identify records, not evidence authority. */
export const AUDIT_ATTEMPT_ID_PREFIX = "attempt.v1:";
export const AUDIT_REFERENCE_PREFIX = "audit.v1:";

export type AttemptLocator =
  | { kind: "audit"; auditId: number }
  | { kind: "skip"; skipId: string };

export function auditAttemptId(auditId: number): string {
  if (!Number.isSafeInteger(auditId) || auditId < 1) throw new Error("auditId must be a positive integer.");
  return `${AUDIT_ATTEMPT_ID_PREFIX}audit:${auditId}`;
}

export function skipAttemptId(skipId: string): string {
  if (!skipId.trim() || skipId.length > 256) throw new Error("skipId must be a non-empty saved skip attempt ID.");
  return `${AUDIT_ATTEMPT_ID_PREFIX}skip:${encodeURIComponent(skipId)}`;
}

/** Parse the canonical, versioned saved-attempt locator. */
export function decodeAttemptId(value: string): AttemptLocator {
  if (value.length > 1024) throw new Error("attemptId must be a non-empty saved attempt ID.");
  const match = /^attempt\.v1:(audit|skip):(.+)$/.exec(value);
  if (!match) throw new Error("Invalid attemptId. Use the exact ID returned by run_audit or read_audit.");
  if (match[1] === "audit") {
    if (!/^[1-9]\d*$/.test(match[2]!)) throw new Error("Invalid audit attemptId.");
    const auditId = Number(match[2]);
    if (!Number.isSafeInteger(auditId) || auditAttemptId(auditId) !== value) throw new Error("Invalid audit attemptId.");
    return { kind: "audit", auditId };
  }
  let skipId: string;
  try { skipId = decodeURIComponent(match[2]!); }
  catch { throw new Error("Invalid skip attemptId."); }
  if (!skipId.trim() || skipId.length > 256 || skipAttemptId(skipId) !== value) throw new Error("Invalid skip attemptId.");
  return { kind: "skip", skipId };
}

/** Evidence reference for a saved assessment. Skips intentionally have no auditRef. */
export function encodeAuditReference(prUrl: string, auditId: number, snapshotId: string): string {
  if (!Number.isSafeInteger(auditId) || auditId < 1 || prUrl.length > 2048 || !snapshotId || snapshotId.length > 256) {
    throw new Error("Invalid saved audit evidence identity.");
  }
  const url = new URL(prUrl);
  url.hash = new URLSearchParams({ audit: String(auditId), snapshot: snapshotId }).toString();
  return AUDIT_REFERENCE_PREFIX + url.href;
}
