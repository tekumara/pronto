# Pronto

A durable PR review auditor built on Pi Durable.

Check whether human and bot review findings on a GitHub pull request have been addressed by code changes or supported explanations. The auditor compares review discussions with code at pinned commits and reports which findings are addressed, outstanding, uncertain or not actionable.

Audits are read-only by default. When you provide a PR URL, you do not need a local checkout. Pi Durable saves the evidence and assessment in SQLite, resumes interrupted audits and reuses assessments when the evidence is unchanged. Add `--apply` to post the verdict comment; add `--approve` as well to submit an approval when the verdict allows it. Without `--apply`, Pronto previews the comment and any selected approval.

For ongoing coding tasks, an [optional interactive chat](#optional-interactive-chat) is also available.

## Quick start

You need Node.js 22.19 or newer and an existing Pi login. If needed, run `pi` and use `/login` first.

Authenticate with `gh auth login`, `GITHUB_TOKEN`, or `GH_TOKEN`. Your GitHub token needs read access to the target PR and its code, including a fork's head repository.

```sh
npm install --ignore-scripts
npm link --ignore-scripts
pronto https://github.com/owner/repo/pull/42
```

Run `npm link --ignore-scripts` from this repository to install the global `pronto` command as a symlink to the source. Changes here take effect immediately, with no build or reinstall. You can run `pronto` from any directory. Audits share history and cached assessments through your [user state directory](#credentials-and-audit-storage). Run `npm unlink --global pronto` to remove the link.

From a Git checkout, omit the target to audit the current branch's PR. You can also select a PR by branch name or number:

```sh
pronto
pronto --apply
pronto feature/my-change
pronto 42
```

These forms require the GitHub CLI (`gh`). Pronto runs `gh pr view` in your current directory, using the same repository, PR tracking ref, push configuration and fork selection rules as [gh's PR finder](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/pr/shared/finder.go). If selection fails, the command exits before starting an audit. An explicit PR URL does not require `gh` when you provide a token.

You can also run the CLI without a global link using `npm run audit -- [<number> | <branch> | <GitHub PR URL>]` from this repository.

The auditor uses your saved Pi default model, or the first available model if there is no usable default. Choose a specific model by adding `provider/model-id` after an explicit target:

```sh
pronto https://github.com/owner/repo/pull/42 provider/model-id
```

A single positional argument is always a PR target, so branch names such as `feature/my-change` are not mistaken for models. Use a provider and model listed by Pi's `/model` command. The one-shot CLI is in [`audit.ts`](audit.ts).

## How the audit works

The controller fetches evidence before asking the model to assess it:

- PR title and description, all inline comments and replies, general PR comments, and non-empty human and bot review summaries
- actual inline-thread resolution and outdated state through paginated GitHub GraphQL queries
- changed files and available patches, plus the head and base commit SHAs

Answered and resolved findings remain in scope. Boilerplate is included for the agent to classify rather than discarded by a filter. The audit stops if the changed-file list is incomplete or the head or base SHA changes during fetching. Comments can still change during the fetch window; the report records that window and is not a live-state guarantee.

Pronto omits its own marked output from any account before saving evidence. This includes PR comments, inline comments and replies, and marked submitted review bodies. A standalone `<!-- pronto:review-audit -->` marker at the end identifies this output. Excluded comments are not archived separately, sent to the model or included in the evidence fingerprint. Ordinary discussion from the same accounts, quoted or embedded markers, and unmarked older reports remain in scope.

The model can read remote text files at those pinned commits, including the fork head. It cannot execute shell commands, access local files, edit code, post comments, or resolve threads. It does not fetch check results, workflow runs or logs. Inaccessible code needed to verify a fix leads to `uncertain`, not a guessed fix. Specific reports of external testing can count as reported evidence under the policy below.

The terminal report lists each comment and its findings as `addressed`, `outstanding`, `uncertain`, or `not-actionable`, with explanations and evidence links. GitHub thread resolution is reported separately. A resolved thread or a reply claiming a fix is not proof that the code addresses the finding. The host checks comment coverage and evidence references before printing a verdict. Assessment of the findings remains the model's judgement.

The audit checks whether existing review findings have been addressed. It is not a general code review or proof that the PR is correct.

### What addressed means

`addressed` can mean a code fix, an adequate explanation or specific reported testing. A reasonable scope or trade-off decision can address a finding without implementing the requested change.

A supported scope decision explains the PR's current purpose or audience, its remaining behaviour and relevant mitigations, and why the trade-off is reasonable. The auditor checks factual claims against the pinned code and discussion. Follow-up work can be explicitly deferred, but the current rationale must stand on its own. A future fix is not a current fix.

For example, a setup PR for first-time users can explain that re-runs overwrite active configuration, preserve backups, and leave smart merging to follow-up work. If the code supports those claims and the scope rationale adequately addresses the concern, the finding can be `addressed` through explanation. This does not mean configuration now merges. The finding's reason must identify the explanation and describe the remaining limitation and deferred work.

Bare acknowledgements, unsupported excuses and unexplained promises to fix later do not qualify. An unresolved substantive contradiction or concern outside the rationale remains `outstanding`. Insufficient evidence leads to `uncertain`. An adequate explanation does not establish reviewer agreement or GitHub thread resolution.

### Reported testing and deployment evidence

The auditor accepts specific reports of external testing, deployment or operator verification in the PR description or human discussion. Reports must identify what was exercised, the relevant environment and implementation, and observed outcomes that address the finding. Run or log links strengthen a report but are not mandatory.

For example, a report can describe held-lock failure with rollout skipped, recovery and a successful deployment of the final implementation. Operator confirmation that diagnostics are visible and a region warning is gone can address those verification concerns.

The auditor checks consistency with available code and discussion. It does not mark a finding `uncertain` solely because it cannot open external results. When reported testing addresses a finding, the reason identifies that basis and states that the results were not independently inspected. The evidence cites the PR URL or the human comment or reply containing the report.

Claims such as “fixed”, “tests passed” or “everything passed” are not enough. Contradictions remain `outstanding`; reports that do not establish the relevant outcome can remain `uncertain`. This policy does not replace code inspection for claimed fixes to accessible code.

Reported testing counts as `addressed` for approval eligibility. This relies on the author's or human commenter's account; it does not establish that Pronto checked CI.

## Optional GitHub comments and approvals

### Post a verdict comment

Add `--apply` to post a compact audit comment. It shows the verdict, finding counts, and each outstanding or uncertain finding with its next step and original review link. Reasoning, evidence links and audit metadata sit in collapsed GitHub Markdown sections:

```sh
pronto --apply https://github.com/owner/repo/pull/42
```

Example comment:

```markdown
## Review audit · Changes needed

4 addressed · 1 outstanding · 1 uncertain

### Changes needed: Missing access check

Next step: Check the user's role before granting access.

[Original review finding](https://github.com/owner/repo/pull/42#discussion_r101)

### Needs verification: Undefined access policy

Next step: Confirm which roles should have access.

[Original review finding](https://github.com/owner/repo/pull/42#issuecomment-202)

<details>
<summary>Reasoning and evidence</summary>

### Changes needed: Missing access check

The current code still grants access without checking the user's role.

Evidence:
- https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/src/access.ts#L1-L3

### Needs verification: Undefined access policy

The discussion does not specify which roles should have access, so the intended behaviour cannot be verified.

Evidence:
- https://github.com/owner/repo/pull/42#issuecomment-202

</details>

<details>
<summary>Audit context</summary>

- PR: [owner/repo#42](https://github.com/owner/repo/pull/42)
- audited head: `0123456789abcdef0123456789abcdef01234567`
- evidence fetched: 2026-06-01T12:00:00.000Z to 2026-06-01T12:00:03.000Z
- inline threads: 3/5 resolved (0 unknown)
- other findings: 2 not actionable

Addressed includes code fixes and supported explanations or scope decisions, not necessarily the requested code change.

PR-level comments and review summaries have no thread-resolution state.

This audit checks review findings, not overall PR correctness.

</details>

<!-- pronto:review-audit -->
```

The headline is “Changes needed” when findings remain outstanding, or “Verification needed” when only uncertainty remains. With neither, it says “All actionable findings addressed” if there is at least one addressed finding, or “No actionable findings identified” otherwise.

Outstanding findings appear before uncertain findings. Only their reasoning and evidence appear in the first collapsed section. If there are none, that section is omitted. Audit context remains available, including the audited head, fetch window, thread-resolution counts, non-actionable count and meaning of `addressed`. Saved assessments without a specific next step use a generic action for their status. The terminal report retains explanations and evidence for all findings.

The verdict comment is previewed by default. With `--apply`, Pronto posts it. `--apply` can appear before or after the target or CLI model argument, and you can combine it with `--force`. Your GitHub token needs permission to create and edit PR comments.

Comments are sticky by default (`--sticky=true`). Each invocation with `--apply` updates the latest audit comment posted by your authenticated GitHub account, or creates one if none exists. Other accounts' comments and your unrelated comments are left unchanged. Audit comments include a hidden marker on their final line. Sticky updates recognise this marker, not the heading; unmarked older reports are left unchanged.

To create a new comment every time, set `--sticky=false`:

```sh
pronto --apply --sticky=false https://github.com/owner/repo/pull/42
```

You can also write `--sticky false`. A bare `--sticky`, `--sticky true` or `--sticky=true` enables sticky updates. The flag only controls whether the verdict comment is updated or newly created; it does not change approval behaviour. If several audit comments already exist, only the latest created one is updated; older comments remain.

With `--apply`, the host posts or updates only after a complete, validated assessment, including a cache hit. It looks up live comments even when the assessment uses a saved snapshot. The model remains read-only. Marked Pronto comments and approval reviews without a body do not invalidate the evidence cache. Changes to other PR discussion still do.

GitHub writes are not replayed by Durable, and the flags do not persist across invocations. If a write fails, the CLI exits 1 but retains the completed assessment. A failed update does not fall back to creating a new comment. After an interruption or ambiguous network failure, check the PR before retrying. Concurrent first-time posts can still create duplicates.

### Approve when findings are addressed

Add `--apply --approve` to post the verdict comment and submit a GitHub approval review. By default, approval requires the verdict "All actionable findings appear addressed":

```sh
pronto --apply --approve https://github.com/owner/repo/pull/42
```

`--approve` defaults to false. Without `--apply`, it previews the approval decision without submitting a review. By default, approval requires at least one `addressed` finding and no `outstanding` or `uncertain` findings. Audits with only `not-actionable` findings, or no findings, skip approval. Supported explanations, scope decisions and specific reported testing count as `addressed` for this rule; approval does not imply every requested code change was implemented or CI was independently checked. A skipped approval is not an operational failure.

Add `--allow-uncertain` to permit approval with uncertain findings, provided there are no outstanding findings:

```sh
pronto --apply --approve --allow-uncertain https://github.com/owner/repo/pull/42
```

`--allow-uncertain` defaults to false and does not persist across invocations. It still requires `--approve`, and `--apply` to submit a review. Audits with only uncertain findings can qualify. Audits with no actionable findings still skip approval. The flag does not change finding statuses or the report: uncertain findings remain visible under “Verification needed”.

With `--apply`, the host submits the approval after a complete, validated assessment, including a cache hit. It rechecks the PR's head and base SHAs before approving and stops if either differs from the saved snapshot. The review is pinned to the audited head SHA and has no body. The full audit report remains in the PR comment, so approval does not duplicate it. Approval assesses the supplied review findings, not the PR's overall correctness or CI status.

With `--apply --approve`, the host posts the comment first, then submits the approval if eligible. Your GitHub token needs permission to submit PR reviews. GitHub does not allow authors to approve their own PRs.

Approvals are not replayed by Durable, and the flag does not persist across invocations. Approval errors exit 1 but retain the completed assessment. A comment already posted by `--apply` remains if approval fails. Check the PR before retrying after an interruption or ambiguous network failure.

### Preview comments and approvals

Audits run in dry-run mode by default. They show the exact comment body without writing to GitHub. Add `--approve` to preview whether the verdict permits approval:

```sh
pronto --approve https://github.com/owner/repo/pull/42
```

The normal report is followed by a labelled comment preview and the planned actions. With sticky comments enabled, the preview looks up the latest matching audit comment and reports whether it would be updated or created. For an addressed verdict with no existing audit comment, the action preview looks like this:

```text
[audit:dry-run] Comment would be posted.
[audit:dry-run] PR would be approved at 0123456789abcdef0123456789abcdef01234567
```

Outstanding findings and audits with no actionable findings always skip approval. Uncertain findings also skip approval unless you add `--allow-uncertain`. An eligible approval still checks the current head and base SHAs; changed commits stop the preview with an error.

To perform the selected actions, add `--apply`:

```sh
pronto --apply --approve https://github.com/owner/repo/pull/42
```

`--apply` defaults to false. When supplied, it posts or updates the verdict comment; with `--approve`, it also submits an approval if eligible. Without `--apply`, no comments or reviews are created or updated. The flag does not persist across invocations; every invocation that writes must include it.

With no action flags, the default preview shows the comment body and says it would be posted if you add `--apply`. A preview does not test GitHub write permissions or reviewer restrictions. The former `--dry-run` flag has been removed; omit `--apply` to preview.

The audit otherwise runs normally: it fetches evidence, may call the model, saves its assessment and uses the cache. Dry-run mode prevents GitHub writes, not local storage writes or model requests. You can combine previews with `--force` to reassess fresh evidence.

## Assessment caching and restart

A normal invocation follows this flow:

```text
Open Durable storage
          ↓
Unfinished audit?
    ├─ yes → Resume its saved snapshot and submission
    └─ no  → Fetch current evidence and compute fingerprint
                         ↓
                 Match latest successful assessment?
                   ├─ yes → Record recheck and print saved report
                   └─ no  → Save new snapshot and conversation
                                      ↓
                              Run the agent and validate assessment
                                      ↓
                              Commit completion and cache publication
                                      ↓
                              Print report
```

`--force`, or a saved restart intent, overrides this flow. It cancels any unfinished attempt, fetches fresh evidence and skips cache lookup.

After interruption, run the same PR audit from the same directory to resume its saved snapshot and model. If an older unfinished snapshot contains marked Pronto output, resuming stops before model execution. Use `--force` to start with fresh, filtered evidence. Historical snapshots and transcripts remain unchanged.

After completion, the auditor fetches current evidence and compares it with the latest successful assessment. It reuses that assessment when the evidence and assessment policy match. A cache hit makes no model requests. The terminal shows when the assessment was saved and when the evidence was rechecked.

The fingerprint includes:

- head and base SHAs and repository identities
- comment, reply and review text, metadata and thread state
- PR title, description, changed files and patches
- model ID, API, endpoint, token limits and sampling settings
- auditor version, thinking level, prompts and tool schemas

Snapshot IDs, fetch times and collection order do not affect the fingerprint. Matching assessments do not expire. Only the latest successful assessment is eligible for reuse, although older conversations remain stored. Success means a complete, validated report, even if findings remain outstanding or uncertain. Failed attempts do not replace the cache.

To request a new assessment, use `--force`:

```sh
pronto --force https://github.com/owner/repo/pull/42
```

The flag can appear before or after the URL or CLI model argument. It bypasses the cache. If an audit is unfinished, it cancels that attempt and starts again with fresh evidence. The controller saves its restart intent and selected model before cancelling or fetching. Once saved, they survive interruption before the new snapshot is admitted. Once that snapshot is saved, a normal invocation resumes the new attempt. Repeating `--force` deliberately restarts again.

Use `--force` after a temporary evidence-access failure, when revisiting a time-sensitive finding, or when a model alias changes behind its ID.

Cache pointers, fingerprints and recheck receipts live in Durable storage. Completion and cache publication share one transaction. If the process dies before printing a completed report, the next invocation can reuse it after checking the evidence. Terminal output is not exactly-once delivery.

Existing controller documents migrate without deleting their history. Assessments created before caching are not automatically eligible for reuse. If an unfinished audit resumes under a changed assessment policy, it can finish but cannot publish a mixed-policy cache entry. A successful but uncacheable assessment clears the cache slot rather than falling back to an older success. When changing tool behaviour, validation rules or dependency defaults, bump `AUDITOR_VERSION` in `auditor.ts`. Prompt and tool-schema changes invalidate the cache automatically.

Pronto rejects concurrent audits of the same PR in the same state directory, even when launched from different working directories.

The one-shot CLI exits 0 when it produces a complete report, even if findings remain outstanding. Operational failures or an incomplete assessment exit 1. The report is not a CI pass/fail signal.

## Credentials and audit storage

The auditor reuses Pi's `ModelRuntime` for credentials, OAuth refresh, and custom models. It reads the normal `~/.pi/agent` directory, or the directory set by `PI_CODING_AGENT_DIR`. It does not copy tokens into this repo. Pi extensions, skills, MCP servers, and its full system prompt are not loaded.

`agent-reviews` 1.1.0 is a pinned npm dependency, imported directly; its CLI is not launched. Its authentication and proxy helpers may invoke `gh` or `curl`. `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL` support enterprise and API-compatible endpoints.

Pronto stores databases outside your working directory. It chooses the state directory in this order:

1. `PRONTO_STATE_DIR`, if set to a non-empty absolute path.
2. `$XDG_STATE_HOME/pronto`, if `XDG_STATE_HOME` is a non-empty absolute path.
3. `~/.local/state/pronto`.

An empty override uses the next option. A relative `PRONTO_STATE_DIR` is rejected; a relative `XDG_STATE_HOME` is ignored. Pi credentials stay in their existing location.

For a custom installation or isolated test run, set:

```sh
export PRONTO_STATE_DIR="$HOME/pronto-state"
```

The state directory contains:

```text
pronto/
├── audits/
│   └── <target-hash>.sqlite
└── chats/
    └── <cwd-hash>.sqlite
```

Each PR has one audit database, shared across working directories and both entry points. Its key includes the GitHub origin, owner, repository and PR number. Chat databases are separate, keyed by the canonical absolute working directory. Symlink aliases share a chat; different worktrees do not. Both filenames use the first 20 hexadecimal characters of a SHA-256 hash.

No separate JSON or Markdown report file is written. Evidence is saved in a Durable document and as a submitted conversation input. Remote file reads become tool results. The structured assessment is also retained in the session.

Each database has a separate `<filename>.lock` file. Pronto holds an exclusive SQLite lock there until the harness closes. The operating system releases ownership after a crash, so restarts need no stale-lock cleanup. Lock files remain on disk; do not delete them while Pronto is running. Different databases can be used concurrently.

Private review text and code are sent to your selected model provider and saved locally. New state directories use permissions `0700`; new database files use `0600`. Keep the state directory private and out of version control. SQLite protects against process crashes, but the newest commits can be lost on power failure.

See [Audit database contents](DATABASE.md#audit-database-contents) for the saved evidence, reports, execution state and read-only inspection commands.

Pronto ignores existing directory-local `.pi-durable/` databases and leaves them untouched. Only the configured state directory supplies history and recovery state. If no database exists there, Pronto starts a new session. Keep any old `.pi-durable/` directory out of version control.

## Optional interactive chat

The repository also includes a plain terminal coding chat in [`agent.ts`](agent.ts). It uses Pi Durable for conversation history, tool calls and recovery. There is no full-screen TUI, server, or subagent system.

After installing dependencies and logging in to Pi, start it with:

```sh
npm start
```

The chat uses your saved Pi default model, or the first available model if there is no usable default. The selected model is shown at startup. Choose a specific model with:

```sh
npm start -- provider/model-id
```

A model argument also changes the model of an existing conversation. Type a task at `you>`. Answers stream as plain text. Tool calls show their name and file path or command. Enter `/quit` to exit.

You can invoke the same PR auditor from chat:

```text
/audit https://github.com/owner/repo/pull/42
```

The command supports the same `--force`, `--sticky`, `--approve`, `--allow-uncertain`, and `--apply` flags described above. Chat audits also preview by default and require `--apply` to post the verdict comment or submit an approval. Chat audits use the chat's model and separate audit storage. They do not replace the coding conversation or its tools.

To use the coding chat in another project, run the script from that directory:

```sh
cd /path/to/project
node --experimental-strip-types /path/to/pronto/agent.ts
```

### Chat tools and safety

Unlike the read-only auditor, the chat installs Pi Durable's built-in `read`, `write`, `edit`, and `bash` tools. They run directly on your machine as your user, with no sandbox or approval prompts. Use the chat only with projects and tasks you trust.

The chat uses the same Pi credential setup as the auditor. Pi extensions, skills, MCP servers, and its full system prompt are not loaded. A short coding instruction tells the model to inspect the project and follow `AGENTS.md` when present.

### Chat persistence and recovery

The coding chat has one conversation per canonical working directory in `<state-directory>/chats/<cwd-hash>.sqlite`. Restart the same command to continue it. Conversation history and the selected model survive restarts.

Ctrl+C or SIGTERM closes the harness without cancelling its unfinished work. On the next launch, `harness.resume()` continues it before accepting another task. An interrupted model request is retried. Interrupted tools rerun only when Pi Durable declares them replay-safe; writes and shell commands are not blindly repeated.

Pronto rejects a second chat process for the same working directory and state directory. Audits use separate databases, so they do not lock the coding conversation.

To start a fresh conversation, stop the chat and move or delete its `<cwd-hash>.sqlite` file and SQLite sidecars (`-wal` and `-shm`). Keep the state directory's `audits/` subdirectory to retain saved audits. The chat database contains your prompts, model responses and tool results, so keep it private.

## Development checks

```sh
npm run check
npm test
```

The tests verify that `npm link` exposes the source-backed `pronto` command from another directory. They use local simulated model and GitHub endpoints with temporary credentials. Audit tests cover both entry points, paginated evidence, fork-head code reads, blocked shell calls, report coverage and citations, inconsistent evidence, and restart recovery. They also cover opt-in verdict comments and approvals, sticky updates and opting out, default dry-run previews and per-invocation `--apply` consent for GitHub writes, skipped approvals, commit changes before approval, posting failures, cache reuse and invalidation, no expiry, failed reassessment, forced restarts, crashes during fetching and before printing, and controller-schema migration. Chat tests exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. Storage tests cover path precedence, private permissions, shared audit history, isolated chats, process locks and ignoring directory-local databases. Tests use temporary state directories and do not contact a real model provider or GitHub. Supplied model verdicts test report rendering, validation and action rules, not the model's ability to judge whether a scope explanation is adequate.

Pi Durable is experimental. Dependencies are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
