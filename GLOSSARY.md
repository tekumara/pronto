# Pronto

Pronto assesses pull request review findings and submits audit verdicts to GitHub.

## Language

**Submitted audit review**:
A GitHub pull request review that Pronto has successfully submitted, containing its audit verdict and an optional approval. It describes a completed submission, not the review's current content or approval state.
_Avoid_: Review publication, posted audit review

**Webhook delivery**:
One signed request from GitHub reporting activity on a pull request, such as a review request or a comment mentioning the reviewer account.
_Avoid_: webhook event, trigger

**Reviewer account**:
The GitHub user the token belongs to. It receives review requests and mentions, and Pronto submits audit reviews as it.
_Avoid_: bot, viewer
