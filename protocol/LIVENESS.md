# Conditional liveness checks

Readiness, failover and accepted-work progress pass in a bounded recovery model,
under the assumptions below. Publication needs an additional external retry
trigger after a failed GitHub request. GitHub becoming healthy alone is not enough.

These are conditional model results, not a proof of TypeScript liveness. The
original [safety results](VALIDATION.md) are unchanged. No production TypeScript
was changed to make these checks pass.

## Run and reproduce

```bash
# Uses the same pinned TLC jar and Java overrides as the safety gate.
npm run test:protocol:liveness
# Runs both safety/correspondence and liveness gates.
npm run test:protocol
# Separate implementation evidence: stock Litestream and disposable RustFS.
export PRONTO_LITESTREAM_BIN=/absolute/path/to/litestream-v0.5.17
npm run test:replicated
```

Python 3.10 or later and Java 17 through 29 are required for the formal gates.
Ordinary application startup and tests still do not require either tool.

`check_liveness.py` generates each configuration from `liveness.cfg` and a reviewed
matrix in the runner. It prints a private temporary evidence directory containing:

- `toolchain.json`: Java identity and the verified TLC jar identity
- `manifest.json`: hashes of both models, the configuration, runner and shared tool helper
- per-run configurations, logs and full JSON counterexamples or reachability witnesses
- `summary.json`: generated counts, outcomes, action sequences, last states and explicit infinite waiting cycles

This report does not supply expected counts to the runner. There is no manually
assembled JSON oracle. The runner rejects unsupported arguments, wrong error
kinds or causes, incomplete exploration, changed inputs and missing temporal
checks. Each invocation has a 900-second timeout. It checks the final complete
state space with one worker and no symmetry, constraints or depth bounds.

## What is checked

`Liveness.tla` extends `PrefixProtocol.tla`. It uses the existing detailed
acquisition, CAS, response, selection, restore, baseline, promotion and renewal
actions. It does not replace these with a single action that declares success.

It adds an abstract workflow for one accepted webhook and one explicit-apply
publication. The workflow separates worker confirmation, audit completion,
attempt-marker confirmation, GitHub POST, receipt storage and intake completion.
These new stages are a source-based abstraction, not the Python graph-equivalent
model and not a refinement of TypeScript executions.

| Property | Meaning |
| --- | --- |
| `EventuallyReady` | the surviving candidate eventually becomes locally serving and authoritative |
| `FailoverCompletes` | every state without that ready candidate eventually reaches one with it |
| `AcceptedDispatches` | acknowledged operation 0 eventually passes the worker barrier and starts its audit |
| `AcceptedFinishes` | that intake task eventually completes its bookkeeping, including after publication failure |
| `PublicationDelivered` | each represented publication intent eventually has a review accepted by GitHub |

The first 2 properties are equivalent in this stable suffix: the final owner
does not fail again. Completion is not successful review delivery. In particular,
`Work.dispatch` catches an audit error and can complete intake while the failed
publication remains pending.

All normal cases also check the 5 original state invariants, `ControlDiscipline`
and workflow types. The original safety specification still has no fairness.
Only the new `ProgressSpec` adds weak fairness to the individual enabled actions.

## Failure prefixes and assumptions

Both initial states contain an actual acknowledged operation in complete prefix
0 and a crashed owner. Neither already satisfies the new readiness goal:

| Scenario | Failure before the checked suffix |
| --- | --- |
| 2 terms | term 0 acknowledges, then crashes before dispatch; candidate 1 survives |
| 3 terms | the same crash, followed by term 1 acquiring, restoring and crashing before its baseline; candidate 2 survives |

Two separate reachability checks construct these exact protocol states using
unmodified core transitions from the original `Init`. Their seed bookkeeping and
outage flags are not a model of the earlier environment. The availability flags
apply to the recovery suffix, not to the successful uploads in its failure prefix.

The progress assumptions are explicit:

- a final candidate survives, keeps running and has no competing future takeover
- the crashed owner's lease eventually expires and the candidate can observe it
- storage becomes permanently usable, with the original strong GET/LIST/CAS, retained-source and complete-sync assumptions
- control requests succeed without lost responses during the recovery window
- bootstrap requests and renewals finish within the implementation's lease margin
- each continuously enabled scheduler step eventually executes
- evidence acquisition and the model eventually return a finite valid assessment
- GitHub eventually accepts the intended review, including successful preflight, credentials and permissions
- the PR snapshot, author identity and explicit publication choices remain valid
- if publication fails first, another eligible explicit-apply audit eventually re-admits that saved intent

Weak fairness is not a response-time bound. It does not prove the lease-margin
assumption, successful storage responses or eventual model output. Those are
external conditions. There is no elapsed-clock or skew model here. A partition
can prevent progress indefinitely without violating the original safety model.

The last assumption is not an automatic retry feature. `ReadmitPublication`
abstracts an external request reaching `enqueuePublication`, which can replace a
failed task. Startup `recoverPublications` is another real retry trigger, but a
process restart and its new term are not modelled by that action. The integration
case uses a new webhook in the same healthy term.

## Results and negative controls

The checked recovery suffix is small by design. Each all-fair scenario completed
with 305 generated visits, 148 distinct states and an empty queue. These counts
are not the much larger unrestricted 3-term safety graph.

All 5 progress properties pass in both scenarios. With no retry trigger, the
other 4 still pass: ready service and completed intake do not imply publication.

Each removed assumption is checked separately with all the others retained.
TLC must find the named temporal violation and an infinite stuttering tail. The
runner checks the final state's cause, not merely a nonzero exit code:

| Removed assumption | Required counterexample |
| --- | --- |
| scheduler fairness | failover stalls despite storage recovery and expiry |
| old-lease clock progress | failover waits forever for expiry |
| eventual storage recovery | failover waits forever for storage |
| finite audit return | a dispatched audit remains running forever |
| eventual GitHub acceptance | intake finishes but the publication remains failed |
| external publication retry trigger | GitHub recovers and intake finishes, but the terminal failed publisher never runs again |

The last counterexample is:

```text
restore accepted work -> become ready -> dispatch -> finish assessment
-> commit attempted marker -> confirm marker -> GitHub POST fails
-> GitHub becomes healthy -> intake finishes
-> failed publication waits forever, with no new request
```

A separate witness reaches failed POST, external re-admission, successful POST
and saved receipt. This prevents the passing publication result from covering
only the path where no request ever fails. Checkpoint witnesses also prevent
invented initial recovery states from passing unnoticed.

The new configurations enable `CHECK_DEADLOCK TRUE`. No structural deadlock was
found in the checked projection. A deliberately removed dispatch transition must
produce a deadlock with a ready owner and undispatched accepted work. Completed
intake, including a terminal publication awaiting external input, has an explicit
quiescent self-loop. This is not a claim about all mutexes, external hangs or
unrestricted executions. The temporal controls catch waiting that a structural
deadlock check alone cannot catch.

The companion gate makes 13 TLC invocations: 3 completed positive checks,
6 expected temporal failures, one expected deadlock and 3 reachability witnesses.
An expected counterexample is not a safety or liveness pass for that configuration.

## Implementation correspondence

| Model boundary | Production owner |
| --- | --- |
| acquisition through ready promotion | `primary-runtime.ts:attempt`, `serialize`, `mutate` |
| fixed recovery and independent baseline | `S3Control.inventory`, `Litestream.restore`, `sync`, `flush` |
| accepted-work recovery and worker barrier | `createWebhookQueue.recover`, `Work.dispatch`, `auditor.ts:resume`, `beforeDispatch` |
| attempt marker then remote confirmation | `publication.ts:publicationTask`, `beforePublish`, `primary-runtime.ts:confirm` |
| terminal failed publication | `publicationTask` catch branch: saved `failed=true`, terminal failed outcome |
| external retry | `enqueuePublication`, startup `recoverPublications`; not a timer |

The RustFS suite includes “GitHub recovery alone leaves failed publication pending;
a new webhook retries it in the same term”. It uses real HTTP and real replicated
SQLite state. A 503 POST leaves a saved attempted/failed intent. GitHub then heals.
A successful real lease renewal occurs, readiness stays 200 and no POST retries.
A new delivery ID triggers successful publication from the saved assessment,
without changing the owner or requesting another model result.

That is a bounded observation of the implementation, not proof that no future
retry can ever occur. The infinite counterexample comes from the model and the
source's terminal-task/no-timer behavior. Existing ordinary tests separately cover
startup retry and lost-response reconciliation. The new test adds the distinct
live-primary boundary rather than repeating those startup cases.

## Validation of this change

| Command | Result |
| --- | --- |
| `npm run test:protocol` | passed: 11 original safety invocations and 13 companion invocations, including their expected failures |
| `npm run check` | passed |
| `npm test` | 359 passed, none skipped |
| `npm run test:replicated` | 17 passed, none skipped; stock Litestream v0.5.17 and RustFS 1.0.3 |
| `git diff --check` | passed |

Both runners rejected unsupported command-line arguments. The shared tool helper
also rejected a deliberately corrupted cached jar before launching Java.

## Limits

These checks do not establish fairness of the actual scheduler, prove an LLM
terminates, guarantee GitHub availability, or prove arbitrary repeated failovers.
There is one accepted operation, one renewal per term and one final surviving
candidate. Ongoing real lease maintenance remains an assumption; the single
represented renewal does not verify an arbitrarily long audit's renewals.
Workflow storage effects are abstract confirmation steps; the model
does not add their bytes to the original prefix history or prove their recovery
across another crash. Multi-repository scheduling, unbounded retries, changed PR
heads, stale actors, ambiguous GitHub responses and receipt reconciliation are
not explored by this companion model.

There is no exactly-once GitHub guarantee, production approval or TypeScript
correctness proof. The unchanged safety and storage limitations still apply.

For temporal operators and weak fairness, see
[Lamport's liveness tutorial](https://lamport.azurewebsites.net/tla/tutorial/session9.html).
The [TLC configuration reference](https://docs.tlapl.us/using:tlc:config_file)
describes `PROPERTIES` and `CHECK_DEADLOCK`.
