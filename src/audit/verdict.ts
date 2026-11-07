import { AUDIT_COMMENT_MARKER, type ReviewSnapshot } from "../github/reviews.ts";
import { stripControlCharacters } from "../logging.ts";
import type { Assessment, MigrationAssessment, ModelCostInfo } from "./audit-records.ts";
import { excludedPaths, MAX_LISTED_FILES } from "./exclusions.ts";
import { digest } from "./fingerprints.ts";
import { publicationChoices, type PublicationChoices, type PublicationIntent } from "./publication.ts";

const snapshotDisclaimer = "This is the agent's assessment of a saved snapshot, not proof of correctness or the PR's current live state.";

function formatCost(usd: string): string {
  return `US$${usd}`;
}

function summarizeFindings(assessments: Assessment[]) {
  const findings = assessments.flatMap((a) => a.findings);
  const counts = Object.fromEntries(["addressed", "outstanding", "uncertain", "not-actionable"].map((status) => [status, findings.filter((f) => f.status === status).length]));
  const approvable = !counts.outstanding && !counts.uncertain;
  const verdict = counts.outstanding || counts.uncertain ? "Not all actionable findings are addressed."
    : counts.addressed ? "All actionable findings appear addressed." : "No actionable findings identified.";
  return { counts, verdict, approvable, total: findings.length };
}

function formatSummary(snapshot: ReviewSnapshot, assessments: Assessment[]): string[] {
  const { counts, verdict, total } = summarizeFindings(assessments);
  const inline = snapshot.comments.filter((c) => c.kind === "inline");
  const resolved = inline.filter((c) => c.thread?.resolved).length;
  const unknown = inline.filter((c) => !c.thread).length;
  return [
    `PR review audit · ${snapshot.target.url}`, `Head: ${snapshot.headSha}`, `Evidence fetched: ${snapshot.startedAt} to ${snapshot.fetchedAt}`,
    `Verdict: ${verdict}`, `Findings: ${total} across ${snapshot.comments.length} ${snapshot.comments.length === 1 ? "source" : "sources"}`,
    `${counts.addressed} addressed · ${counts.outstanding} outstanding · ${counts.uncertain} uncertain · ${counts["not-actionable"]} not-actionable`,
    "Addressed includes code fixes and supported explanations or scope decisions, not necessarily the requested code change.",
    `GitHub: ${resolved}/${inline.length} inline threads resolved (${unknown} unknown). PR-level comments and review summaries have no thread-resolution state.`,
  ];
}

function genericNextStep(status: string): string {
  return status === "outstanding" ? "Address the finding with a code fix or an evidence-supported explanation."
    : "Provide verifiable evidence to assess this finding.";
}
// Bots are never @-mentioned: GitHub would notify them, and mentioning Copilot can start an agent run.
function isBot(login: string): boolean {
  return /\[bot\]$/i.test(login) || login.toLowerCase() === "copilot";
}
function humanLogins(snapshot: ReviewSnapshot): string[] {
  return [...new Set([snapshot.author, ...snapshot.comments.flatMap((c) => [c.author, ...c.replies.map((r) => r.author)])]
    .filter((login) => login !== "unknown" && !isBot(login)))];
}
// Only the Awaiting line mentions anyone, and only the person who must act next. The next step stays plain text.
function ownership(comment: { author: string }, finding: { awaiting?: string }, humans: string[] = []): string {
  const mention = humans.find((login) => login.toLowerCase() === finding.awaiting?.toLowerCase());
  const awaiting = mention ? `@${mention}` : finding.awaiting ?? "unknown";
  return `Raised by: ${comment.author} · Awaiting: ${awaiting}`;
}

type ApprovalBlock = { message: string; reason?: string };
function migrationApprovalBlock(assessment: MigrationAssessment | null | undefined): ApprovalBlock | null {
  if (!assessment) return { message: "database migration status was not assessed. Run again with --force before approving." };
  if (assessment.status === "not-migration") return null;
  return {
    message: assessment.status === "migration" ? "database migration requires human approval."
      : "database migration status is uncertain; human approval is required.",
    reason: assessment.reason,
  };
}

function formatReport(snapshot: ReviewSnapshot, assessments: Assessment[], approvalBlock: ApprovalBlock | null): string {
  const lines = [...formatSummary(snapshot, assessments)];
  if (approvalBlock) {
    lines.push(`Approval blocked: ${approvalBlock.message}`);
    if (approvalBlock.reason) lines.push(`Database migration assessment: ${approvalBlock.reason}`);
  }
  lines.push("");
  const byKey = new Map(assessments.map((a) => [a.commentKey, a]));
  let index = 0;
  for (const comment of snapshot.comments) {
    const thread = !comment.thread ? "resolution unknown"
      : `${comment.thread.resolved ? "resolved" : "open"}${comment.thread.outdated ? ", outdated" : ""}`;
    for (const finding of byKey.get(comment.key)!.findings) {
      lines.push(`[${++index}] ${finding.status}: ${finding.summary}`,
        `    Source: ${comment.key} · ${comment.author}`, `    ${comment.url}`,
        ...(comment.kind === "inline" ? [`    GitHub thread: ${thread}`] : []),
        `    ${finding.reason}`,
        ...(finding.status === "outstanding" || finding.status === "uncertain" ? [`    ${ownership(comment, finding)}`,
          `    Next step: ${finding.nextStep ?? genericNextStep(finding.status)}`] : []),
        ...finding.evidence.map((url) => `    Evidence: ${url}`), "");
    }
  }
  lines.push(snapshotDisclaimer);
  return stripControlCharacters(lines.join("\n"));
}

function formatComment(snapshot: ReviewSnapshot, assessments: Assessment[], approvalBlock: ApprovalBlock | null,
  modelCost: ModelCostInfo): string {
  const { counts } = summarizeFindings(assessments);
  const headline = counts.outstanding ? "Changes needed" : counts.uncertain ? "Verification needed"
    : counts.addressed ? "All actionable findings addressed" : "No actionable findings identified";
  const sections = [
    `## Review audit · ${headline}`,
    `${counts.addressed} addressed · ${counts.outstanding} outstanding · ${counts.uncertain} uncertain · ${counts["not-actionable"]} not-actionable`,
    ...(approvalBlock ? [`Approval blocked: ${approvalBlock.message}`] : []),
  ];
  const byKey = new Map(assessments.map((a) => [a.commentKey, a]));
  const pending = ["outstanding", "uncertain"].flatMap((status) => snapshot.comments.flatMap((comment) =>
    byKey.get(comment.key)!.findings.filter((finding) => finding.status === status).map((finding) => ({ comment, finding }))));
  const details: string[] = [];
  const humans = humanLogins(snapshot);
  for (const { comment, finding } of pending) {
    const label = finding.status === "outstanding" ? "Changes needed" : "Needs verification";
    // Saved assessments may predate nextStep. Keep them readable without inventing a specific remedy.
    sections.push(`### ${label}: ${finding.summary}`, ownership(comment, finding, humans),
      `Next step: ${finding.nextStep ?? genericNextStep(finding.status)}`,
      `[Original review finding](${comment.url})`);
    details.push([
      `### ${label}: ${finding.summary}`, finding.reason,
      `Evidence:\n${finding.evidence.map((url) => `- ${url}`).join("\n")}`,
    ].join("\n\n"));
  }
  if (approvalBlock?.reason) details.push(`### Database migration assessment\n\n${approvalBlock.reason}`);
  if (details.length) sections.push([
    "<details>", "<summary>Reasoning and evidence</summary>", "", details.join("\n\n"), "", "</details>",
  ].join("\n"));
  const excluded = excludedPaths(snapshot);
  const inline = snapshot.comments.filter((c) => c.kind === "inline");
  const resolved = inline.filter((c) => c.thread?.resolved).length;
  const unknown = inline.filter((c) => !c.thread).length;
  sections.push([
    "<details>", "<summary>Audit context</summary>", "",
    `- PR: [${snapshot.target.owner}/${snapshot.target.repo}#${snapshot.target.pr}](${snapshot.target.url})`,
    `- model used: ${modelCost.model ? `\`${modelCost.model.provider}/${modelCost.model.modelId}\`` : "unknown"}`,
    `- audit cost: ${formatCost(modelCost.costUsd)}`,
    `- audited head: \`${snapshot.headSha}\``,
    `- evidence fetched: ${snapshot.startedAt} to ${snapshot.fetchedAt}`,
    `- inline threads: ${resolved}/${inline.length} resolved (${unknown} unknown)`,
    `- other findings: ${counts["not-actionable"]} not actionable`,
    ...(excluded.length ? [`- excluded from review (patches withheld): ${excluded.length} of ${snapshot.files.length} changed files`,
      ...excluded.slice(0, MAX_LISTED_FILES).map((path) => `  - \`${path}\``),
      ...(excluded.length > MAX_LISTED_FILES ? [`  - ${excluded.length - MAX_LISTED_FILES} more files`] : [])] : []), "",
    "Addressed includes code fixes and supported explanations or scope decisions, not necessarily the requested code change.", "",
    "PR-level comments and review summaries have no thread-resolution state.", "",
    "This audit checks review findings, not overall PR correctness.", "", "</details>",
  ].join("\n"), AUDIT_COMMENT_MARKER);
  return stripControlCharacters(sections.join("\n\n"));
}

/** Calculate the review and terminal output from the same assessment and approval choices. */
export function planVerdict({ snapshot, assessments, databaseMigration, choices, modelCost }: {
  snapshot: ReviewSnapshot; assessments: Assessment[]; databaseMigration: MigrationAssessment | null | undefined;
  choices: Partial<PublicationChoices>; modelCost: ModelCostInfo;
}) {
  const normalized = publicationChoices(choices);
  const approvalBlock = normalized.approveMigrations ? null : migrationApprovalBlock(databaseMigration);
  const body = formatComment(snapshot, assessments, approvalBlock, modelCost);
  // Decide approval first: an approval carries the verdict in one review, otherwise it is a comment review.
  let approve = false;
  let skipped: string | null = null;
  if (choices.approve) {
    const { counts, approvable } = summarizeFindings(assessments);
    if (approvalBlock) skipped = approvalBlock.message;
    else if (approvable || (choices.allowUncertain && counts.uncertain > 0 && !counts.outstanding)) approve = true;
    else skipped = "outstanding or uncertain findings remain.";
  }
  const intent = reviewPublication(snapshot, body, approve ? "APPROVE" : "COMMENT", normalized);
  return {
    intent, approve, skipped,
    // Publication is also planned inside durable transactions; render terminal output only for the caller displaying it.
    render() {
      return { report: formatReport(snapshot, assessments, approvalBlock), counts: summarizeFindings(assessments).counts };
    },
  };
}

function reviewPublication(snapshot: Pick<ReviewSnapshot, "target" | "headSha" | "baseSha">, body: string,
  event: PublicationIntent["event"], choices: PublicationChoices): PublicationIntent {
  // Fetch times describe collection, not a change to the verdict. Keep all other content in the match.
  const fingerprint = digest({ headSha: snapshot.headSha, event,
    body: body.trimEnd().replace(/^(- audited head: `[a-f\d]{40}`\n)- evidence fetched: .*\n/im, "$1"),
  });
  // Keep the evidence-exclusion marker last. The publication marker does not participate in its own hash.
  const markedBody = body.replace(AUDIT_COMMENT_MARKER, `<!-- pronto:publication:${fingerprint} -->\n${AUDIT_COMMENT_MARKER}`);
  return { choices, target: snapshot.target, headSha: snapshot.headSha, baseSha: snapshot.baseSha,
    event, body: markedBody, fingerprint };
}

/** Plan a skip review without opening storage or submitting it. */
export function planSkip({ snapshot, reason, choices }: {
  snapshot: Pick<ReviewSnapshot, "target" | "headSha" | "baseSha">; reason: string; choices: Partial<PublicationChoices>;
}): PublicationIntent {
  reason = stripControlCharacters(reason);
  const body = `## Review audit · Skipped\n\n${reason}\n\nNo review findings were assessed.\n\n${AUDIT_COMMENT_MARKER}`;
  return reviewPublication(snapshot, body, "COMMENT", publicationChoices(choices));
}
