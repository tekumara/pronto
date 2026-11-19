# Pronto

Pronto checks whether review feedback on a GitHub pull request (PR) has been addressed. It compares feedback from teammates and review bots with the changed code, then reports what still needs attention and who should act next.

## Run an audit

You can run an audit in 3 ways:

- from the [command line](GUIDE.md#quick-start): run `pronto` with the PR URL
- from GitHub after [setting up the webhook](GUIDE.md#serve-mode): request a review from Pronto’s reviewer account or @mention that account in a PR comment
- from an [MCP client](MCP.md#run-an-audit): call `run_audit` with the PR URL

To try the command line without submitting a new review, use `--apply=false`:

```sh
pronto --apply=false https://github.com/owner/repo/pull/42
```

## What an audit reports

Pronto assigns each finding a status:

- addressed: a fix, a supported explanation or an accepted decision about scope answers the finding
- outstanding: the finding still needs action
- uncertain: Pronto does not have enough evidence to tell whether the finding is addressed
- not actionable: the comment does not raise an issue to resolve

For findings that need attention, Pronto says who should act and what to do next.

### Example GitHub review

In this shortened example, “Awaiting” names who should act and “Next step” says what to do:

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

If you have more context, reply to the finding on GitHub. Pronto considers your reply as evidence the next time it audits the PR.

## Discuss a saved audit

Use Pronto’s [terminal chat](GUIDE.md#optional-audit-discussion-chat) or [connect another agent through MCP](MCP.md). For example, ask why a finding is still outstanding or what evidence would address it. Discussion does not rerun the audit or change its verdict.

An MCP client [keeps the reference to the selected audit](MCP.md#keep-the-selected-audit-stable) for follow-up questions. The MCP token also lets clients run audits and submit reviews using the server’s GitHub credentials.

## Approval conditions and safeguards

### Review submission defaults

When Pronto submits a verdict to GitHub, it sends one review: an approval if enabled and the PR qualifies, otherwise a comment.

| How you run the audit | Default | Preview only | Submit comments only |
| --- | --- | --- | --- |
| Command line | Submit and approve if eligible | `--apply=false` | `--approve=false` |
| MCP | Submit and approve if eligible | `apply: false` | `approve: false` |
| GitHub webhook | Preview only | No flags needed | `pronto serve --apply` |

To let webhook audits approve eligible PRs, start `pronto serve --apply --approve`.

### What blocks approval

By default, Pronto does not approve if its assessment:

- finds outstanding feedback
- cannot tell whether a finding has been addressed
- cannot rule out a database migration

You can [allow uncertain findings or bypass the migration check](GUIDE.md#approve-clean-audits). Outstanding findings always block approval.

Before submitting an approval, Pronto checks that the PR’s head and base commits still match the audit. GitHub requires permission to submit reviews and does not let authors approve their own PRs.

Approval reflects Pronto’s assessment of the review feedback. Pronto does not check whether CI or tests passed, and its approval does not replace a full code review.

## When Pronto skips a PR

Pronto skips the audit if the PR:

- has already been merged
- is a draft, unless you enable draft audits
- has a label you configured Pronto to skip
- changes more than 10,000 lines, counting additions and deletions after configured file exclusions
- already has a reviewer’s approval on the current commit, unless you enable audits of approved PRs

Pronto logs and saves the reason for every skip without calling the model. To also get a GitHub comment or a preview of it, set `--report-skips` on the CLI or `reportSkips: true` in MCP. Skip comments follow the same submission settings as verdict reviews and never approve the PR.

If Pronto skips because its own reviewer account already approved the current commit, it does not preview or submit a comment, even when skip reporting is enabled. Pronto also does not submit a duplicate skip comment if it has a local receipt for the same reason and commit.

## Further documentation

- [Technical guide](GUIDE.md): installation, audit options, storage and development
- [Experimental replicated state](REPLICATED_STATE.md): opt-in S3-compatible storage, RustFS integration tests and safety limits
- [Local Kubernetes deployment](deploy/README.md): run replicated Pronto and RustFS on k3d with Helm
