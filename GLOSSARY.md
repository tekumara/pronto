# Pronto

Pronto assesses pull request review findings and submits audit verdicts to GitHub.

## Language

**Submitted audit review**:
A GitHub pull request review that Pronto has successfully submitted, containing its audit verdict and an optional approval. It describes a completed submission, not the review's current content or approval state.
_Avoid_: Review publication, posted audit review

**Webhook delivery**:
One signed request from GitHub reporting an event on a pull request. Only a delivery that requests a review from the reviewer account, or readies a draft that already awaits it, starts an audit.
_Avoid_: webhook event, trigger

**Reviewer account**:
The GitHub user the token belongs to. It receives review requests, and Pronto submits audit reviews as it.
_Avoid_: bot, viewer
