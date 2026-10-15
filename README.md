# Pronto

A durable PR review auditor built on Pi Durable.

Check whether human and bot review findings on a GitHub pull request have been addressed by code changes or supported explanations. The auditor compares review discussions with code at pinned commits and reports which findings are addressed, outstanding, uncertain or not actionable.

Audits are read-only by default. When you provide a PR URL, you do not need a local checkout. Pi Durable saves the evidence and assessment in SQLite, resumes interrupted audits and reuses assessments when the evidence is unchanged. Add `--apply` to post the verdict as a PR review comment; add `--approve` as well to make that review an approval when the verdict allows it. Without `--apply`, Pronto previews the comment and any selected approval.

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

Already merged PRs are skipped with a message and exit code 0, even with `--force`, `--apply` or `--approve`. Pronto checks live merge status before starting, resuming or reusing an audit. It does not call the model or write to GitHub for merged PRs.

Draft PRs are skipped by default (`--skip-drafts=true`). To audit a draft PR, turn off this check:

```sh
pronto --skip-drafts=false https://github.com/owner/repo/pull/42
```

You can also write `--skip-drafts false`. Pronto checks live draft status after the merged check and before starting, resuming or reusing an audit. A draft skip prints a message and exits with code 0, even with `--force`, `--apply` or `--approve`. It does not fetch review evidence, call the model or write to GitHub. Skipping preserves unfinished work and cached assessments. The flag does not persist across invocations. Other skip rules still apply when you use `--skip-drafts=false`.

Use `--skip <label>` to skip PRs with a matching label. Repeat the flag to provide multiple labels:

```sh
pronto --skip skip-audit --skip "do not review" https://github.com/owner/repo/pull/42
```

You can also write `--skip=skip-audit`. Labels match by full name, ignoring case. Any match skips the audit with a message and exit code 0. Without a match, the audit runs normally. The flag does not persist across invocations.

Pronto checks live labels before starting, resuming or reusing an audit, even with `--force`, `--apply` or `--approve`. It does not fetch review evidence, call the model or write to GitHub when a label matches. Skipping preserves unfinished work and cached assessments.

PRs already approved by any reviewer are skipped by default (`--skip-approved=true`). Pronto checks each reviewer's latest approval, request for changes or dismissal, ignoring comment-only reviews. The PR counts as approved if at least one reviewer's latest decision approves its current head commit. An approval of an earlier commit does not count, so a PR with new commits is audited again. A dismissal or request for changes replaces that reviewer's approval, but does not cancel another reviewer's approval.

```sh
pronto --skip-approved=false https://github.com/owner/repo/pull/42
```

You can also write `--skip-approved false`. Like the label skip, this check runs after the merged, draft and label checks and before starting, resuming or reusing an audit, even with `--force`, `--apply` or `--approve`. Use `--skip-approved=false` to audit an approved PR anyway. A skip prints a message and exits with code 0, without fetching review evidence, calling the model or writing to GitHub, and preserves unfinished work and cached assessments. The check reads the PR's reviews, following pagination. It does not fetch your GitHub login. The flag does not persist across invocations.

PRs that change more than 10,000 lines are also skipped with a message and exit code 0, even with `--force`, `--apply` or `--approve`. Pronto counts additions plus deletions from the PR's live metadata, so the check costs no extra request. It runs before fetching review evidence, calling the model or writing to GitHub.

Use `--exclude <path>` to leave generated or vendored files out of both the size limit and the audit. Repeat the flag for multiple paths, or write `--exclude=<path>`:

```sh
pronto --exclude package-lock.json --exclude 'dist/**' --exclude '**/*.snap' https://github.com/owner/repo/pull/42
```

Paths are relative to the repository root and match case-sensitively. `*` and `?` stay within one directory, `**` crosses directories (`**/*.snap` also matches a root-level `a.snap`), and a path that matches a directory excludes everything under it. So `package-lock.json` matches only the root lockfile; use `**/package-lock.json` for lockfiles at any depth. A renamed file is excluded only if both its old and new paths match, because a move across the boundary still changes reviewable code.

- **Size limit.** The PR's own line totals include excluded files, so when a PR is over the limit and you pass `--exclude`, Pronto reads the per-file line counts and subtracts the excluded files. This costs extra requests only for PRs that are over the limit. On very large PRs GitHub can omit line counts for some files. An excluded file without counts stays in the total, and Pronto says so.
- **Audit.** Excluded files stay in the evidence by path and status, with their patches withheld and an `excluded` marker. The model can therefore still see that a file such as a migration changed, and can read it if it needs to. Review comments are never excluded, including comments on excluded files.
- **Output.** Pronto lists the excluded files, up to 20 with a count of the rest, when it fetches evidence, reuses an assessment or skips the PR. It also says when a pattern matches no changed file. The verdict comment lists them under audit context, so reviewers can see what the audit did not read.
- **Caching.** Exclusions are part of the evidence. Changing `--exclude` refreshes the assessment and the refresh reason names the affected files, while the same exclusions reuse it. Resuming an unfinished audit keeps the exclusions of its saved evidence, so use `--force` to apply different ones.

You can also run the CLI without a global link using `npm run audit -- [<number> | <branch> | <GitHub PR URL>]` from this repository.

The auditor uses your saved Pi default model, or the first available model if there is no usable default. Choose a specific model by adding `provider/model-id` after an explicit target:

```sh
pronto https://github.com/owner/repo/pull/42 provider/model-id
```

Without `--pr`, a single positional argument is always a PR target, so branch names such as `feature/my-change` are not mistaken for models. Use a provider and model listed by Pi's `/model` command. The one-shot CLI is in [`audit.ts`](audit.ts).

## Concurrent audit batches

Use `--pr` once for each target to check several PRs in one process:

```sh
pronto --pr 42 --pr 43
pronto --pr feature/first --pr feature/second
pronto --pr https://github.com/owner/repo/pull/42 \
       --pr https://github.com/owner/repo/pull/43
```

Numbers and branches use the caller's Git checkout. Explicit URLs can select different repositories without a checkout. Pronto resolves and validates all targets before starting the batch. Duplicate PR targets are rejected, including aliases that differ only in repository-name case or a trailing slash.

All selected PRs run concurrently. Each repository has one shared database and harness, with separate state and assessment conversations for each PR. GitHub fetches and model requests overlap; database commits are serialised. Keep batches within your GitHub and model-provider rate limits.

Flags apply to every PR in the batch. With `--pr`, the optional positional argument is the model:

```sh
pronto --pr 42 --pr 43 provider/model-id --apply
```

Progress messages identify the repository and PR number. A failed PR does not stop the others. The CLI waits for all requests and exits 1 if any fail. Findings marked outstanding or uncertain are not operational failures.

Separate CLI processes cannot share a repository database concurrently. Use one batch invocation, run [`pronto serve`](#serve-mode), or share an auditor in your own process.

### Embed concurrent audits

The shared module in [`auditor.ts`](auditor.ts) accepts concurrent requests and keeps repository harnesses open until you close it:

```typescript
import { createAuditor } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";

const { models, model } = await createModelRuntime(process.cwd());
const auditor = createAuditor(models);
const options = { model: { provider: model.provider, modelId: model.id } };
try {
  await Promise.allSettled([
    auditor.audit("https://github.com/owner/repo/pull/42", options),
    auditor.audit("https://github.com/owner/repo/pull/43", options),
  ]);
} finally {
  await auditor.close();
}
```

An overlapping request for the same PR is rejected, including a forced restart. Pass a Chord context as the third `audit()` argument to cancel a caller's fetch or wait. Cancelling a wait does not cancel admitted model work or close another PR's harness. `close()` shuts down the owner and preserves unfinished work for recovery.

## Serve mode

`pronto serve` starts a server for a GitHub webhook. When someone requests your review or mentions you in a PR comment, Pronto runs the usual audit on that PR. It uses the same skips, cache and verdict as the CLI.

```sh
export PRONTO_WEBHOOK_SECRET="$(openssl rand -hex 32)"
pronto serve --apply --approve
```

To set it up:

1. Run the server where GitHub can reach it. It listens on `127.0.0.1:8080` and speaks plain HTTP, so put HTTPS in front of it with a reverse proxy or a tunnel such as smee, cloudflared or ngrok. `--host 0.0.0.0` accepts outside connections.
2. Add a webhook to the repository or organisation. Use the payload URL `https://<host>/webhook`, content type `application/json`, and the same secret as `PRONTO_WEBHOOK_SECRET`. Select the **Pull requests**, **Issue comments**, **Pull request review comments** and **Pull request reviews** events.
3. Authenticate as for the CLI. The token must belong to a user (a personal access token or `gh auth login`), not a GitHub App installation, because that user is who Pronto reviews as.

The server refuses to start without `PRONTO_WEBHOOK_SECRET`, with a token GitHub rejects, or with an unavailable model. It checks all three before listening.

### What starts an audit

- A review requested from the token's user. Logins match ignoring case. Requests for a team or another user are ignored, even if the user belongs to that team.
- A draft that becomes ready for review while the user is already a requested reviewer. Drafts are skipped by default, so a request made on a draft would otherwise be lost.
- A new or edited PR comment, inline comment or reply that mentions the token's user as `@login`. Submitted or edited review summaries also count. Mentions match whole logins, ignoring case. Emails, longer logins and team mentions do not count.

Ordinary issue comments, pending reviews and Pronto's marked audit output do not start audits. Every other delivery is also acknowledged and logged with the reason it was ignored.

Ignored-delivery logs include the event, action, PR URL and sender, plus the requested reviewer or team when present. Missing or unsafe values appear as `-`. Logged values have length limits, and logs omit comment bodies and the full payload.

### Options

`--port <n>` (default `8080`; `0` picks a free port), `--host <address>`, `--concurrency <n>` (default `4`) and `--webhook-path <path>` (default `/webhook`) configure the server. `GET /healthz` reports health. The audit flags (`--skip`, `--skip-drafts`, `--skip-approved`, `--exclude`, `--approve`, `--allow-uncertain`, `--approve-migrations`, `--apply`) and an optional `provider/model-id` are fixed at startup and apply to every audit, as described in the [quick start](#quick-start). Without `--apply`, the server only logs previews.

`--force` and `--pr` are rejected. `--force` would bypass the assessment cache on every delivery. To audit a branch named `serve` from the CLI, write `pronto --pr serve`.

### How deliveries are handled

- **Verification.** The server checks the `X-Hub-Signature-256` signature over the raw body, in constant time, before it reads the payload. Bodies over 5 MiB are refused. GitHub's signature has no timestamp, so a captured delivery can be replayed. A replay only repeats an audit that GitHub reported, and the cache and verdict history stop it posting again.
- **Responses.** The server answers before any audit runs: `202` for an accepted or duplicate request, `204` for an ignored delivery, `401` for a bad signature, `413` for an oversized body and `503` while shutting down. GitHub shows `503` as a failed delivery, so you can redeliver it.
- **Redeliveries.** A delivery ID seen among the last 1000 is dropped.
- **One audit per PR.** A request for a PR that is waiting changes nothing. A request for a PR that is running queues one re-run behind the PRs already waiting, because its evidence may have changed. The re-run reuses the cached assessment when the evidence is unchanged and does not submit the same verdict review again.
- **Concurrency.** At most `--concurrency` audits run at once. The rest wait in order. Each audit makes GitHub and model requests, so keep the limit within your rate limits.
- **Failures.** A failed audit is logged as `[serve] Audit failed for <url>` and does not affect other PRs.

### Stopping and restarting

On startup, the server recovers unfinished audits and each PR's latest failed assessment from saved repository databases. This includes failures saved by earlier versions. Interrupted audits resume their saved snapshot and model. Ctrl+C, SIGTERM and crashes preserve this unfinished work.

An assessment that exhausted model retries (`model_error`), or finished without a complete report, gets a fresh attempt with current evidence and server options. This attempt bypasses any older cached success. Startup queues each failed assessment once; another failure waits for the next restart or review request. Successful, cancelled and superseded attempts are not retried.

Every recovered audit repeats the live checks. A PR that is now merged, a draft, labelled, over the size limit or approved is skipped and keeps its saved work.

If the server stopped after a successful assessment but before it submitted the verdict, request the review again. The saved assessment is reused when the evidence is unchanged. Failed verdict submissions are not retried on startup. Requests that were accepted but had not started are not saved either. The server lists them as it exits, and a crash loses them, so request those reviews again.

A database with nothing to recover is closed at once, so the CLI can still use that repository while the server runs. A database another process holds is skipped with a message, and the server starts anyway. While the server runs it holds the lock on each repository database it has audited or resumed, so a CLI run against one of those repositories fails with "Database is already in use". Stop the server first, or request the review instead.

## How the audit works

The controller fetches evidence before asking the model to assess it:

- PR title and description, all inline comments and replies, general PR comments, and non-empty human and bot review summaries
- actual inline-thread resolution and outdated state through paginated GitHub GraphQL queries
- changed files and available patches, plus the head and base commit SHAs

Answered and resolved findings remain in scope. Boilerplate is included for the agent to classify rather than discarded by a filter. The audit stops if the changed-file list is incomplete or the head or base SHA changes during fetching. Comments can still change during the fetch window; the report records that window and is not a live-state guarantee.

Pronto omits its own marked output from any account before saving evidence. This includes PR comments, inline comments and replies, and marked submitted review bodies. A standalone `<!-- pronto:review-audit -->` marker at the end identifies this output. Excluded comments are not archived separately, sent to the model or included in the evidence fingerprint. Ordinary discussion from the same accounts, quoted or embedded markers, and unmarked older reports remain in scope.

The model can read remote text files at those pinned commits, including the fork head. It cannot execute shell commands, access local files, edit code, post comments, or resolve threads. It does not fetch check results, workflow runs or logs. Inaccessible code needed to verify a fix leads to `uncertain`, not a guessed fix. Specific reports of external testing can count as reported evidence under the policy below.

The terminal report gives each finding its own numbered block as `addressed`, `outstanding`, `uncertain`, or `not-actionable`, with explanations and evidence links. GitHub thread resolution is reported separately. A resolved thread or a reply claiming a fix is not proof that the code addresses the finding. The host checks comment coverage and evidence references before printing a verdict. Assessment of the findings remains the model's judgement.

One comment or review summary can contain multiple findings, so finding counts can exceed source counts. Counts include `not-actionable` items. See [How findings are stored](DATABASE.md#how-findings-are-stored) for the saved structure and source relationships.

The audit checks whether existing review findings have been addressed. It is not a general code review or proof that the PR is correct.

### Finding-first terminal output

The report shows the total findings and sources, followed by one block per finding. Each block repeats its source key, author and URL. Inline findings also show the source thread's resolution and outdated state. Outstanding and uncertain findings retain their `Awaiting` person and `Next step`.

For example, one review summary can produce 2 findings. This shortened report shows both separately:

```text
Findings: 2 across 1 source
1 addressed · 0 outstanding · 0 uncertain · 1 not-actionable

[1] addressed: External key policy remains a deployment prerequisite
    Source: review:303 · reviewer[bot]
    https://github.com/owner/repo/pull/42#pullrequestreview-303
    The author documented the external policy requirement. No key-policy fix or deployment verification is claimed.
    Evidence: https://github.com/owner/repo/pull/42

[2] not-actionable: Change overview and review boilerplate
    Source: review:303 · reviewer[bot]
    https://github.com/owner/repo/pull/42#pullrequestreview-303
    The remaining review summarizes the implementation without requesting another change.
    Evidence: https://github.com/owner/repo/pull/42#pullrequestreview-303
```

Findings appear in saved source order, then in the order within each source's assessment. Numbers are local to the printed report, not persistent finding IDs. Saved assessments use this format without a database migration or another model assessment. The compact GitHub verdict comment remains unchanged.

### What addressed means

`addressed` can mean a code fix, an adequate explanation, an explicit future-work deferral or specific reported testing. A scope or trade-off decision can address a finding without implementing the requested change.

An explicit author decision not to fix a finding because of effort, complexity, likelihood or scope can qualify. A concise reply can be enough when the original finding supplies the context. Risk acceptance is not risk elimination: the auditor does not require a new safeguard, quantified probability or code change merely because a known bug remains possible.

A bot's “blocking” label does not establish a mandatory requirement. Explicit project requirements and unresolved human demands for a fix remain blocking. The auditor reads the full discussion, including later replies that soften a demand or leave the decision to the author.

For example, a bot reports that a transcript can list previews that fail to seed. The author replies, “skipped, don't think this is worth the fixing effort”. If no explicit project requirement or unresolved human demand requires a fix, this counts as `addressed` by an author trade-off decision. The report must still state that the transcript can reference missing previews and no consistency fix was made.

An explicit author reply saying the finding will be addressed in future work counts as a scope decision. The thread can supply the context. No separate rationale, mitigation, deadline or follow-up link is required. A reviewer requesting a change does not itself prohibit deferral. An explicit requirement to fix in this PR or an unresolved human rejection of deferral remains blocking.

For example, a guide claims multi-region support that the current code lacks. The author replies, “will soon be true see #307”. This can count as `addressed` by deferral. The report must state that the guide still overstates current coverage and the multi-region fix is not implemented. The auditor does not need to inspect the linked follow-up to accept the deferral.

The auditor checks factual claims about explanations and claimed fixes against pinned code and discussion. A known bug or documentation inconsistency remaining does not contradict a promise to fix it later. A future fix is not a current fix.

For example, a setup PR for first-time users can explain that re-runs overwrite active configuration, preserve backups, and leave smart merging to follow-up work. If the code supports those claims and the scope rationale adequately addresses the concern, the finding can be `addressed` through explanation. This does not mean configuration now merges. The finding's reason must identify the explanation and describe the remaining limitation and deferred work.

A relevant authoritative documentation link from a human author or maintainer counts as an explanation when offered in response to a finding. The auditor does not require excerpts or mark the finding `uncertain` solely because it cannot inspect the link. It marks the finding `addressed` unless available evidence contradicts the explanation, an explicit requirement remains unmet, or a human objection remains unresolved. The report cites the reply and states that the documentation was not independently inspected; it does not claim runtime verification. Bare acknowledgements, unrelated links and re-review pings do not qualify.

Bare acknowledgements and dismissals without a rationale do not qualify. A contradicted claim about an explanation or current fix remains `outstanding`. So does an unmet mandatory requirement or a concern outside the explanation or deferral. For example, code showing that a failure can occur contradicts “this cannot happen”, but not “this is not worth fixing”. Insufficient evidence leads to `uncertain`. An adequate explanation does not establish reviewer agreement or GitHub thread resolution.

### Reported testing and deployment evidence

The auditor accepts specific reports of external testing, deployment or operator verification in the PR description or human discussion. Reports must identify what was exercised, the relevant environment and implementation, and observed outcomes that address the finding. Run or log links strengthen a report but are not mandatory.

For example, a report can describe held-lock failure with rollout skipped, recovery and a successful deployment of the final implementation. Operator confirmation that diagnostics are visible and a region warning is gone can address those verification concerns.

The auditor checks consistency with available code and discussion. It does not mark a finding `uncertain` solely because it cannot open external results. When reported testing addresses a finding, the reason identifies that basis and states that the results were not independently inspected. The evidence cites the PR URL or the human comment or reply containing the report.

Claims such as “fixed”, “tests passed” or “everything passed” are not enough. Contradictions remain `outstanding`; reports that do not establish the relevant outcome can remain `uncertain`. This policy does not replace code inspection for claimed fixes to accessible code.

Reported testing counts as `addressed` for approval eligibility. This relies on the author's or human commenter's account; it does not establish that Pronto checked CI.

## Optional GitHub comments and approvals

### Post a verdict comment

Add `--apply` to post a compact audit comment as a PR review. It shows the verdict, finding counts, and each outstanding or uncertain finding with who raised it, who acts next, what they need to do, and the original review link. Reasoning, evidence links and audit metadata sit in collapsed GitHub Markdown sections:

```sh
pronto --apply https://github.com/owner/repo/pull/42
```

Example comment:

```markdown
## Review audit · Changes needed

4 addressed · 1 outstanding · 1 uncertain · 2 not-actionable

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

Outstanding findings appear before uncertain findings. Their reasoning and evidence appear in the first collapsed section. When a database migration blocks approval, its explanation appears there under “Database migration assessment”. The visible approval-block line stays short. The section is omitted when there are no pending findings or migration explanations. Audit context remains available, including the audited head, fetch window, thread-resolution counts, non-actionable count and meaning of `addressed`. In the posted comment, only the person who acts next is written as `@login`, and only on the `Awaiting` line, so GitHub notifies them once. The next step is a short imperative saying what to do. The person who raised the finding is never tagged on that basis, bots (`[bot]` accounts and Copilot) are never mentioned, and the terminal report stays plain. Each shows `Raised by` (the comment author, taken from the evidence) and `Awaiting` (the person who must act next). The auditor chooses `Awaiting` from the thread order: the PR author when a reply is missing or does not do what was asked, or when a bot raised the finding; the reviewer who opened the thread when the author's reply hands a decision back. The login must appear in the PR evidence or be `unknown`, and a report without it is rejected. Saved assessments without a specific next step or `Awaiting` use a generic action and `unknown`. The terminal report retains explanations and evidence for all findings.

The verdict comment is previewed by default. With `--apply`, Pronto posts it unless a matching review is recorded in local history. `--apply` can appear before or after the target or CLI model argument, and you can combine it with `--force`. Your GitHub token needs permission to submit PR reviews.

`--apply` checks local records of [submitted audit reviews](GLOSSARY.md#language) in the repository's SQLite database. When the verdict body, review type and audited head match a recorded review, Pronto skips the write and prints its saved URL. Evidence-fetch times and trailing whitespace do not affect the match. This applies to cached assessments and forced refreshes. A preview followed by `--apply` still posts if no matching receipt exists. Changed verdict content or a different head can produce a new review.

A submission receipt is saved only after GitHub returns a successful response with the review URL. Receipts are shared across working directories, CLI and chat, and GitHub accounts using the same state directory. GitHub review history is not used to discover or reconcile submitted audit reviews. Earlier reviews without local receipts, including reviews from another machine or state directory, do not prevent posting. Editing, deleting or dismissing a review on GitHub does not remove its local receipt. `--force` refreshes the assessment, not review submission history.

The review is a `COMMENT` review, or an `APPROVE` review when approval is selected and eligible (see [Approve clean audits](#approve-clean-audits)). A recorded comment review does not prevent a later approval review. A recorded approval prevents another matching approval, even after a later dismissal or request for changes on GitHub. The separate live `--skip-approved` check still skips PRs already approved at their current head; use `--skip-approved=false` to audit them anyway.

Reviews are pinned to the audited head commit. Pronto never edits or replaces an earlier audit review or comment. Audit reviews include a hidden marker on their final line. Pronto uses it to exclude its own output from the evidence it assesses, so it does not invalidate the cache. Audit comments posted by earlier versions as plain PR comments are left as they are. The former `--sticky` flag has been removed; Pronto rejects it as an unknown option.

With `--apply`, the host posts reviews only after a complete, validated assessment. A cache hit can post a review, such as for an assessment first run as a preview. The model remains read-only. Marked Pronto comments and reviews do not invalidate the evidence cache. Changes to other PR discussion still do.

GitHub writes are not replayed by Durable, and the flags do not persist across invocations. A failed request saves no submission receipt, but retains the completed assessment and exits 1. GitHub's write and the local receipt are not one atomic operation. If GitHub accepts a review but its response is lost, or the process stops before saving the receipt, retrying can post a duplicate. A receipt-storage failure also exits 1 and prints the posted review URL. Check the PR before retrying after an interruption or ambiguous failure.

### Approve clean audits

Add `--apply --approve` to submit one GitHub approval review that carries the verdict comment as its body:

```sh
pronto --apply --approve https://github.com/owner/repo/pull/42
```

`--approve` defaults to false. Without `--apply`, it previews the approval decision without submitting a review. By default, approval requires a PR classified as `not-migration`, with no `outstanding` or `uncertain` findings. Audits with only `not-actionable` findings, or no findings, also qualify if the PR is not a database migration. No `addressed` finding is required.

Pronto does not approve database-migration PRs by default. The model classifies the PR using its title, description, changed files and patches, inspecting pinned code as needed. Database schema or data migrations, backfills and database cutovers block approval by default, even when the PR also contains unrelated changes. Migration-framework maintenance, documentation or test fixtures alone do not count as a database migration.

The audit still runs and saves its assessment. With `--apply`, it posts the verdict as a `COMMENT` review unless a matching receipt exists in local history. The terminal report and comment explain why approval is blocked. Finding statuses and the audit verdict remain unchanged. Neither `--allow-uncertain` nor `--force` overrides this approval block.

Approval is also blocked if migration status is `uncertain`, or an older saved report has no migration classification. Use `--force` to request a fresh assessment when classification is missing. Completed assessments from the previous policy are refreshed automatically.

Add `--approve-migrations` to allow approval of database-migration PRs:

```sh
pronto --apply --approve --approve-migrations https://github.com/owner/repo/pull/42
```

`--approve-migrations` defaults to false and does not persist across invocations. It bypasses the migration approval block, including uncertain or missing migration classifications. It still requires `--approve`, and `--apply` to submit a review. Outstanding findings always prevent approval. Uncertain findings still require `--allow-uncertain`.

The model always saves a migration classification. This flag only changes approval eligibility, not the classification, findings or cache. A cache hit uses the saved findings with the current approval options. With `--apply`, it posts only if the resulting verdict body, review type and head do not match a local submission receipt.

Supported explanations, scope decisions, explicit future-work deferrals and specific reported testing can count as `addressed`. Approval does not imply every requested code change was implemented or CI was independently checked. A skipped approval is not an operational failure.

Add `--allow-uncertain` to permit approval with uncertain findings, provided there are no outstanding findings:

```sh
pronto --apply --approve --allow-uncertain https://github.com/owner/repo/pull/42
```

`--allow-uncertain` defaults to false and does not persist across invocations. It still requires `--approve`, and `--apply` to submit a review. Audits with only uncertain findings can qualify. Audits with no actionable findings qualify without this flag. The migration approval block still applies unless you add `--approve-migrations`. The flag does not change finding statuses or the report: uncertain findings remain visible under “Verification needed”.

With `--apply`, the host submits the approval after a complete, validated assessment, including a cache hit. It rechecks the PR's head and base SHAs before approving and stops if either differs from the saved snapshot. The review is pinned to the audited head SHA. Its body is the verdict comment, so the verdict and the approval appear as one review rather than a comment plus a body-less approval. Approval assesses the supplied review findings, not the PR's overall correctness or CI status.

With `--apply --approve`, the host decides eligibility first. An eligible audit selects one `APPROVE` review carrying the verdict. Otherwise it selects a `COMMENT` review, and the terminal explains why approval was skipped. Either review is posted only if no matching receipt exists in local history. Your GitHub token needs permission to submit PR reviews. GitHub does not allow authors to approve their own PRs.

Approvals are not replayed by Durable, and the flag does not persist across invocations. Approval errors exit 1 but retain the completed assessment. Because the verdict is the approval review's body, nothing is posted if that request fails or if the head or base SHA changed. GitHub rejects approval of your own PR, for example. Rerun without `--approve` to post the verdict as a `COMMENT` review. Check the PR before retrying after an interruption or ambiguous network failure.

### Preview comments and approvals

Audits run in dry-run mode by default. They show the exact comment body without writing to GitHub. Add `--approve` to preview whether the verdict permits approval:

```sh
pronto --approve https://github.com/owner/repo/pull/42
```

The normal report is followed by a labelled comment preview and the planned actions. The preview checks local review submission history and says when posting would be skipped. It creates no submission receipt and makes no GitHub duplicate lookup. For an addressed verdict with no recorded approval, the action preview looks like this:

```text
[audit:dry-run] Comment would be posted with the approval review.
[audit:dry-run] PR would be approved at 0123456789abcdef0123456789abcdef01234567
```

Database migrations and uncertain or missing migration classifications skip approval unless you add `--approve-migrations`. Outstanding findings also skip approval. Uncertain findings skip approval unless you add `--allow-uncertain`. Audits with no actionable findings otherwise qualify for approval. An eligible approval still checks the current head and base SHAs; changed commits stop the preview with an error.

To perform the selected actions, add `--apply`:

```sh
pronto --apply --approve https://github.com/owner/repo/pull/42
```

`--apply` defaults to false. When supplied, it posts the verdict unless a matching review is recorded locally; with `--approve`, that review is an approval if eligible. Without `--apply`, no comments or reviews are created. The flag does not persist across invocations; every invocation that writes must include it.

With no action flags, the default preview shows the rendered comment body and the planned comment action. A preview does not test GitHub write permissions or reviewer restrictions. The former `--dry-run` flag has been removed; omit `--apply` to preview.

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

After interruption, select the same PR again using the same state directory to resume its saved snapshot and model. A batch can resume several PRs independently. If an older unfinished snapshot contains marked Pronto output, resuming stops before model execution. Use `--force` to start with fresh, filtered evidence. Historical snapshots and transcripts remain unchanged.

After completion, the auditor fetches current evidence and compares it with the latest successful assessment. It reuses that assessment when the evidence and assessment policy match. A cache hit makes no model requests. With `--apply`, it still posts a new verdict comment. The terminal shows when the assessment was saved and when the evidence was rechecked.

Before refreshing an existing audit, Pronto prints the reasons in the terminal. These identify changed PR fields, added or removed comment keys, changed comment fields, and changed file paths. Comment changes include metadata such as timestamps, replies and thread state, even when the body is unchanged. For example:

```text
[audit] Refreshing audit 2; reasons:
[audit]   - comment:6029796791 changed (updatedAt)
[audit]   - comment:6029929136 removed
[audit]   - comment:6031034805 added
```

Pronto also reports policy changes, `--force`, saved restart intent, and missing or unusable cache state. Policy changes cover the model, inference settings, instructions and tools; the saved policy hash does not identify which changed. Output shows up to 10 reasons and counts any remaining changes. It does not print comment bodies or patches in these diagnostics. First-time audits and cache hits do not print refresh reasons. These messages do not change cache eligibility or add model requests.

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

Cache pointers, fingerprints and recheck receipts live in Durable storage. Each assessment has a durable controller task that submits the saved evidence and publishes its result. Controller completion and cache publication share one transaction. They do not depend on the original caller still waiting. If the process dies before printing a completed report, the next invocation can reuse it after checking the evidence. Terminal output is not exactly-once delivery.

Each PR has its own controller document in the repository database. Old per-PR databases in `audits/` remain untouched and are not imported. Their history, caches and unfinished audits do not participate in the new storage model. If an unfinished audit resumes under a changed assessment policy, it can finish but cannot publish a mixed-policy cache entry. A successful but uncacheable assessment clears the cache slot rather than falling back to an older success. When changing tool behaviour, validation rules or dependency defaults, bump `AUDITOR_VERSION` in `auditor.ts`. Prompt and tool-schema changes invalidate the cache automatically.

Within one shared auditor, Pronto rejects overlapping requests for the same PR but permits requests for other PRs. Across processes, the entire repository database has one owner.

Opening a repository restores Durable task state, but model requests and remote file reads remain paused for unselected PRs. Selecting a PR admits its conversation after live merge-status and label checks. Skipped PRs retain their saved work. Deferred-provider polling follows the same rule and resumes the saved remote job instead of submitting another. PRs already admitted in a running process continue if their caller stops waiting.

The one-shot CLI exits 0 when it produces a complete report, even if findings remain outstanding. Operational failures or an incomplete assessment exit 1. The report is not a CI pass/fail signal.

## Credentials and audit storage

The auditor reuses Pi's `ModelRuntime` for credentials, OAuth refresh, and custom models. It reads the normal `~/.pi/agent` directory, or the directory set by `PI_CODING_AGENT_DIR`. It does not copy tokens into this repo. Pi extensions, skills, MCP servers, and its full system prompt are not loaded.

`agent-reviews` 1.1.0 is a pinned npm dependency, imported directly; its CLI is not launched. Its authentication helper may invoke `gh`. Pronto pins `undici` 8.10.2 directly so HTTP(S) proxy requests stay asynchronous rather than depending on a transitive installation. The proxy helper can fall back to `curl` if proxy setup fails. `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL` support enterprise and API-compatible endpoints.

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
├── repos/
│   ├── <github-host>/
│   │   └── <owner>~<repo>.sqlite
│   └── <old-repo-hash>.sqlite  # earlier hash-named databases, if present
├── audits/                      # old per-PR databases, if present
│   └── <target-hash>.sqlite
└── chats/
    └── <cwd-hash>.sqlite
```

Each repository has one audit database, shared across working directories and both entry points. Its path uses the lower-case GitHub hostname as a directory and the lower-case base-repository owner and name separated by `~`, not the PR number or fork head repository. The hostname is percent-encoded for use as a path component. Each PR has a separate controller document keyed by its PR number. Each assessment attempt still has an independent conversation. Chat databases are separate, keyed by the canonical absolute working directory; symlink aliases share a chat, while different worktrees do not. Chat database filenames use the first 20 hexadecimal characters of a SHA-256 hash.

No separate JSON or Markdown report file is written. Evidence is saved in a Durable document and as a submitted conversation input. Remote file reads become tool results. The structured assessment is also retained in the session.

Each database has a separate `<filename>.lock` file. Pronto holds an exclusive SQLite lock there until the harness closes. The operating system releases ownership after a crash, so restarts need no stale-lock cleanup. Lock files remain on disk; do not delete them while Pronto is running. One process owns each repository database, including a running [`pronto serve`](#serve-mode). PRs within it run concurrently through one harness; a second process targeting any PR in that repo is rejected. Different repository databases can be used by different processes.

Private review text and code are sent to your selected model provider and saved locally. New state directories use permissions `0700`; new database files use `0600`. Keep the state directory private and out of version control. SQLite protects against process crashes, but the newest commits can be lost on power failure.

See [Audit database contents](DATABASE.md#audit-database-contents) for the saved evidence, reports, execution state and read-only inspection commands.

Earlier hash-named repository databases in the root of `repos/`, old per-PR databases in `audits/`, and directory-local `.pi-durable/` databases are left untouched and are not imported. The first audit using the readable repository name starts a fresh database; old databases remain on disk as historical records. Only the configured state directory supplies history and recovery state. If no database exists there, Pronto starts a new session. Keep any old `.pi-durable/` directory out of version control.

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
/audit --pr https://github.com/owner/repo/pull/42 --pr https://github.com/owner/repo/pull/43
```

Chat batch targets must be URLs; branch and number selection are CLI-only. The command supports the same `--pr`, `--skip`, `--skip-drafts`, `--skip-approved`, `--exclude` (paths cannot contain spaces here), `--force`, `--approve`, `--allow-uncertain`, `--approve-migrations`, and `--apply` flags described above. Chat audits also preview by default and require `--apply` to post the verdict comment or submit an approval. Chat audits use the chat's model and separate audit storage. They do not replace the coding conversation or its tools.

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

To start a fresh conversation, stop the chat and move or delete its `<cwd-hash>.sqlite` file and SQLite sidecars (`-wal` and `-shm`). Keep the state directory's `repos/` subdirectory to retain current audits, and `audits/` if you want to retain older per-PR history. The chat database contains your prompts, model responses and tool results, so keep it private.

## Development checks

```sh
npm run check
npm test
```

The tests verify that `npm link` exposes the source-backed `pronto` command from another directory. They use simulated model providers and local GitHub endpoints with temporary credentials. Audit tests cover both entry points, paginated evidence, fork-head code reads, blocked shell calls, report coverage and citations, inconsistent evidence, and restart recovery. They also cover opt-in verdict comments and approvals, a new review on every `--apply` with the verdict merged into the approval, default dry-run previews and per-invocation `--apply` consent for GitHub writes, skipped approvals, commit changes before approval, posting failures, cache reuse and invalidation, no expiry, failed reassessment, forced restarts, crashes during fetching and before printing, and retaining old per-PR databases without importing them. Concurrent audit tests cover CLI and chat batches, per-PR cache isolation, same-PR admission, caller cancellation, batch failures, asynchronous proxy transport, forced restart isolation, repo-wide process locks, deferred job recovery, and recovery after SIGKILL and SIGTERM. Serve tests cover signature verification, delivery filtering, redelivery handling, per-PR queueing and the concurrency cap, option validation, and a real server process that audits a requested review, submits its verdict once, ignores other requests and stops on SIGTERM. They also cover resuming audits that SIGKILL or SIGTERM left unfinished, retrying the latest failed assessment once per startup without reusing an older success, rechecking recovered PRs, closing idle databases and skipping a database another process holds. Chat tests exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. Storage tests cover path precedence, private permissions, shared audit history, isolated chats, process locks and ignoring directory-local databases. Tests use temporary state directories and do not contact a real model provider or GitHub. Supplied model verdicts test report rendering, validation and action rules, not the model's ability to judge whether a scope explanation is adequate.

Pi Durable is experimental. Pi packages are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
