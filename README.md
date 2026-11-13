# Pronto

Pronto helps reduce pull request (PR) cycle time by showing what review feedback has been addressed, what still needs attention, and who should act next. One-shot CLI and MCP audits post a verdict review by default, approving eligible PRs and commenting when approval is blocked. Pass `--apply=false` (or `apply: false` through MCP) to preview instead, or `--approve=false` (`approve: false`) to post a comment rather than an approval. Webhook audits started by `pronto serve` remain preview-only unless `--apply` is set at startup. See the [approval conditions and safeguards](#approval-conditions-and-safeguards).

## Summon it from GitHub

You can ask Pronto to check a pull request in either of 2 ways:

- request a review from Pronto in the pull request’s Reviewers list
- @mention Pronto’s GitHub account in a comment on the pull request

## Find out what is left

Pronto checks feedback from teammates and review bots such as GitHub Copilot, SonarQube etc. It reads the discussion alongside the changed code, then reports:

- which findings appear addressed
- which findings are outstanding or unclear
- who needs to act next and what they should do

“Addressed” can mean a code fix, a supported explanation, or an accepted scope decision. It does not always mean the requested change was made.

You can reply to Pronto’s findings with explanations or context. The next time you @mention Pronto or request a review from it, it reads your replies and considers them as evidence.

## Example review comment

A shortened example, using placeholder names and links:

> ## Review audit · Changes needed
>
> 3 addressed · 1 outstanding · 0 uncertain · 2 not-actionable
>
> ### Changes needed: Missing access check
>
> Raised by: Copilot · Awaiting: @author
>
> Next step: Check the user’s role before granting access.
>
> [Original review finding](https://github.com/owner/repo/pull/42#discussion_r101)

The full review also includes expandable sections with reasoning, evidence and audit context.

## When Pronto skips a PR

Pronto skips the audit when:

- the PR has already been merged
- the PR is a draft, unless auditing drafts is enabled
- the PR has a label configured to skip audits
- the PR changes more than 10,000 lines, counting additions and deletions after configured file exclusions
- the PR’s latest commit already has a reviewer’s approval, unless auditing approved PRs is enabled

Pronto logs skips without posting or previewing a review by default. Add `--report-skips` to report a skip; one-shot CLI and MCP audits post that review by default, while `--apply=false` previews it. In webhook mode, posting also requires `--apply` at startup. If the skip is caused by your authenticated GitHub account's approval of the current commit, Pronto only logs it, even with `--report-skips`. A skip never approves the PR or calls the model. Repeating the same reason at the same commit does not post another review when a local receipt exists.

## Approval conditions and safeguards

One-shot CLI and MCP audits select approval by default; webhook audits do not unless `pronto serve` is configured with `--approve`. An approval requires:

- explicit permission to approve and post reviews
- no outstanding or uncertain findings in Pronto’s assessment
- an assessment that rules out a database migration

You can explicitly allow uncertain findings or migration approvals. Outstanding findings still block approval.

These safeguards rely on the AI’s assessment of the review feedback and migration status. Pronto does not check whether CI or tests have passed, and approval is not proof that the code is correct.

The goal is less time chasing review feedback and waiting for another review round—not replacing tests or a full code review.

## Discuss a saved audit

External agents can read and run audits and use the discussion skill through an authenticated MCP endpoint. Calling `run_audit` publishes a review by default; set `apply: false` to preview. The token grants this write access as well as read access, and the agent retains the selected audit reference. See [MCP setup](MCP.md) for HTTPS, credentials and a runnable client.

## Technical guide

See the [technical guide](GUIDE.md) for setup, usage, audit behaviour and development details.

Serve also has an opt-in `--replicated-state` experiment using stock Litestream and S3-compatible storage. It defaults to off. See [replicated state setup and safety limits](REPLICATED_STATE.md), including the real RustFS integration command. It is not production hard fencing.

For a local Kubernetes deployment, see [replicated Pronto and RustFS on k3d with Helm](deploy/README.md). Host tools are managed with mise.
