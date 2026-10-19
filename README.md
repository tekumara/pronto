# Pronto

Pronto is a GitHub app that helps reduce pull request (PR) cycle time. It makes review follow-up faster by showing what feedback has been dealt with, what still needs attention, and who should act next. When enabled, it can also approve PRs once all actionable review findings appear addressed, subject to the [approval conditions and safeguards](#approval-conditions-and-safeguards).

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

With `--apply`, Pronto posts the skip reason as a comment review on the PR’s current commit. Otherwise, it previews the comment. A skip never approves the PR or calls the model. Repeating the same reason at the same commit does not post another review when a local receipt exists.

## Approval conditions and safeguards

Automatic approval is off by default. By default, an approval requires:

- explicit permission to approve and post reviews
- no outstanding or uncertain findings in Pronto’s assessment
- an assessment that rules out a database migration

You can explicitly allow uncertain findings or migration approvals. Outstanding findings still block approval.

These safeguards rely on the AI’s assessment of the review feedback and migration status. Pronto does not check whether CI or tests have passed, and approval is not proof that the code is correct.

The goal is less time chasing review feedback and waiting for another review round—not replacing tests or a full code review.

## Webhook reliability

In serve mode, Pronto saves accepted audit requests before returning `202`. Waiting work and one queued rerun per PR survive restarts. Delivery deduplication also survives restarts, within the last 1000 accepted delivery IDs per repository.

With `--apply`, Pronto saves verdict and skip-reason publication as durable tasks. Startup resumes pending publications without running the model again, including assessments first published from the cache. Preview-only assessments do not become pending writes when the server restarts with different flags.

GitHub submission and local storage are not one transaction. After an ambiguous POST, Pronto checks remote reviews for the saved author, head, review type, body and fingerprint before retrying. This reduces duplicates but does not guarantee exactly-once publication. See [serve mode recovery and limits](GUIDE.md#stopping-and-restarting).

## Technical guide

See the [technical guide](GUIDE.md) for setup, usage, audit behaviour and development details.
