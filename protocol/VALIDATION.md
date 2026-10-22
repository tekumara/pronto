# Protocol validation report

The common TLA+ and original Python models agree on complete normalized reachable
state and successor sets within their finite bounds. Real RustFS scenarios check
selected implementation obligations. This is bounded safety evidence, not
production approval or a proof of the TypeScript implementation.

This report records the original safety validation. Later [conditional liveness
checks](LIVENESS.md) add explicit assumptions and expected waiting cycles without
changing the original safety specification. `npm run test:protocol` now runs both
gates; the original results below concern `check.py` only.

## Base and working tree

- exact base and HEAD when validation ran: `f5fd8a505b35ce720773ec9cc466d63f14af0a32`
- ancestor check: `git merge-base --is-ancestor f5fd8a5 HEAD` returned 0 before editing
- no merge, cherry-pick or source-worktree edit was needed
- the supplied parent-history lookup returned “session was not found or is not available”
- validation starts from raw Python, committed TypeScript and integration tests, not that unavailable history
- no commit, push, pull request, new worktree or additional agent was created during validation; committing was authorized by a later user request

Changed files are `package.json`, `REPLICATED_STATE.md`,
`test/integration/replicated.test.ts`, and the new `protocol/` directory:

- `PrefixProtocol.tla`: common and detailed safety models
- `common-{postcheck,naive,precheck}-2.cfg`, `common-postcheck-3.cfg`: common checks
- `lifecycle-postcheck-{2,3}.cfg`, `lifecycle-early-promote-2.cfg`: detailed checks
- `check.py`: pinned-tool runner, original-checker runs, graph comparison and trace replay
- `schedules.json`: shared executable admission schedules
- `oracle/check_protocol.py`, `oracle/README.md`: preserved originals
- `README.md`, `VALIDATION.md`, `evidence.json`: explanation and compact evidence

There is no production TypeScript change. Model/tooling changes and test coverage
do not change the delivered protocol. No jar, Java runtime, state graph or test
credential belongs in the repository.

## Commands and tool identity

```bash
mise install java
export PRONTO_PROTOCOL_CACHE=/tmp/pronto-protocol-cache
export PRONTO_LITESTREAM_BIN=/tmp/pronto-litestream-validation.yliWyM/bin/litestream
mise exec java -- npm run test:protocol
npm run check
npm test
npm run test:replicated
git diff --check
```

The environment used Node v26.12.0 and Python 3.15.0. `/usr/bin/java -version`
initially failed because no runtime was installed. An isolated official Temurin
21.0.12.1+1 JRE was downloaded into `/tmp/pronto-tla-tools`, without global changes.
Its `OpenJDK21U-jre_aarch64_mac_hotspot_21.0.12.1_1.tar.gz` SHA-256 matched the
Adoptium metadata: `dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84`.
The protocol npm scripts invoke Python directly. For these recorded runs, mise
supplied the project-pinned Temurin 21 through `JAVA_HOME`; the checker no longer
needs a separate Java path override.
The pinned v1.8.0 TLC jar identified itself as
`TLC2 Version 2026.10.20.183001 (rev: d2e1472)`. Its SHA-256 and official published
SHA-1 matched those in [the reproduction instructions](README.md).

Litestream was stock v0.5.17, executable SHA-256
`205b4c315d61a7f5709c4ab9001084eadfa8c9d36e1c198f9887417c2d88bb73`.
The runner pulled RustFS 1.0.3 at
`rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b`.
It created its own localhost container, credentials, buckets and anonymous volume,
then removed its container and volume and reaped its test descendants. It did not
contact AWS or validate IAM. RustFS was not replaced with MinIO.

## Finite checks and executable correspondence

Every safety model below has 2 or 3 unique terms, one operation per term and one
renewal per term. Detailed mode adds at most one release, one acquisition attempt per new term,
separate responses and a fixed selection step. Failed attempts consume terms.
One acquisition contender is in flight at a time. There is no depth cap or
fairness assumption. No arbitrary-history safety or liveness claim follows.

The unchanged original checker produced:

| Mode | Terms | States visited | Transitions examined | Result |
| --- | ---: | ---: | ---: | --- |
| naive | 2 | 111 | 199 | lost acknowledged A |
| precheck | 2 | 207 | 365 | lost acknowledged A |
| postcheck | 2 | 234 | 443 | completed, safe |
| postcheck | 3 | 5,340 | 13,205 | completed, safe |
| fenced | 2 | 1,707 | 3,389 | completed, safe alternative design |
| fenced | 3 | 80,291 | 215,807 | completed, safe alternative design |
| blind-retry | 2 | 416 | 744 | committed history replaced `[0] -> []` |

The unsafe original runs stop at the first counterexample, so their counts are
not full-graph sizes. `retention` independently reproduced the unrestorable TXID 2
example after replacing ranges 1–1 and 2–2 with 1–3 and deleting their inputs.
These three extra modes do not describe delivered Pronto's prefix protocol.

The complete normalized TLC/Python graphs agree exactly:

| Common model | Terms | Reachable states | Unique directed successor edges |
| --- | ---: | ---: | ---: |
| postcheck | 2 | 234 | 443 |
| postcheck | 3 | 5,340 | 13,205 |
| naive, safety invariant omitted only for graph export | 2 | 204 | 414 |
| precheck, safety invariant omitted only for graph export | 2 | 378 | 776 |

The comparison checks actual normalized states and each state's successor set,
not just the table. It fails if a transition is removed. TLC's unsafe JSON traces
are executable through the original Python transition relation. The gate checks
that their final violation is missing acknowledged history, and that successor
source selection preceded the old upload. For `precheck`, ownership observation
also precedes upload. The Python oracle was not edited or instrumented.

The separate safety runs retain every invariant. `naive` and `precheck` each fail
`AckRecoverable` with exit 12. Their TLC visited counts differ slightly from the
Python early-stop counts because traversal/violation reporting order differs.
The complete graph comparison, rather than early-stop count equality, checks
semantic consistency. `early-promote` separately fails `CompleteBaseline` at a
successful promotion CAS, with no complete version in the new prefix.

Final TLC runs produced:

| Safety run | Generated state visits | Distinct states | Queue remaining | Outcome |
| --- | ---: | ---: | ---: | --- |
| common postcheck, 2 terms | 602 | 234 | 0 | completed |
| common postcheck, 3 terms | 18,290 | 5,340 | 0 | completed |
| detailed postcheck, 2 terms | 77,848 | 28,967 | 0 | completed, depth 32 |
| detailed postcheck, 3 terms | 30,348,999 | 7,964,147 | 0 | completed, depth 52 |
| common naive, 2 terms | 285 | 113 | 27 | expected `AckRecoverable` counterexample |
| common precheck, 2 terms | 517 | 209 | 45 | expected `AckRecoverable` counterexample |
| detailed early promotion, 2 terms | 1,132 | 550 | 240 | expected `CompleteBaseline` counterexample |

The final detailed 3-term run took 4 minutes 9 seconds. TLC reported fingerprint
collision estimates of `9.7E-6` (optimistic) and `1.8E-6` (actual fingerprints).
Compact statistics, completion flags, full short counterexample states and input
hashes are preserved in `evidence.json`. “Generated” is TLC's number of state-generation
visits, including duplicate successor generation. It is not the unique-edge count
above. For the detailed model we report this TLC generation count, not a claimed
unique-edge total from a huge exported graph. All safe final runs must have an
empty work queue. Expected counterexamples intentionally stop with work remaining.

The exact graph relation applies only to common mode. It is not a labelled
bisimulation or temporal-refinement proof. Detailed mode and TypeScript add or
exclude behaviours, as listed below. TLC stores 64-bit state fingerprints, so its
completed detailed exploration still has a reported collision risk. The common
graphs additionally agree with Python's exact state-key exploration. No such
independent full-graph comparison was done for detailed mode.

## Mapping actions to the implementation

| Abstract obligation | Concrete owner and boundary | Observable evidence |
| --- | --- | --- |
| opt-in only | `serve-command.ts:runServe`, lazy replicated imports | ordinary configuration and serve tests; ordinary suite needs no Java, Docker or replica setup |
| revision-bound acquisition, preserved source | `primary-runtime.ts:attempt`, `S3Control.read/write` using `ControlHead.etag` | competing initialization and stale `If-Match` RustFS test; standby inactivity and expiry takeover |
| unique local term and remote prefix | `attempt` UUID, captured `Term`, new root and child | parent crash leaves old child isolated; child death creates a fresh independently recoverable prefix |
| acquire before selection | `attempt` uses `acquired.record.recovery`, then `S3Control.inventory` | delayed confirmed delivery restores after successor startup; interrupted bootstrap retains the old source |
| fixed selected endpoint | inventory returns `{relative, txid}`; `Litestream.restore` uses `-txid` and full integrity check | real writes and compaction continue while restoring a fixed older endpoint; missing endpoints and source GET denial fail |
| complete independent baseline before promotion | restore every plan entry, start/enrol all, `auditor.recover`, `child.flush`, then `mutate(term,true)` | new-prefix restore works with source-prefix GETs denied; partial two-repository baseline cannot promote |
| local commit | `webhook-queue.ts:admit` commits queue and dedup state; `auditor.ts:enqueue` | 202 admission and dedup survive independent successor recovery |
| remote upload then strong ownership observation | `primary-runtime.ts:confirm`: `child.sync(relative)` then fresh `storage.read()` | actual LTX traffic precedes control GET; held-upload schedule returns 503 with no GitHub evidence dispatch |
| delayed acknowledgement | `confirm` accepts its successful observation; `serve.ts:handle` checks local readiness and emits 202 | holding an already-successful GET response across takeover still gives 202; successor recognizes the delivery as duplicate |
| worker dispatch barrier | `auditor.ts` supplies `beforeDispatch`; `webhook-queue.ts:Work.dispatch` commits running intent before invoking it | both first admission and an already-running repository reject new unconfirmed work before evidence fetches |
| publication-intent durability | `publication.ts:publicationTask` commits `attempted=true`, invokes `beforePublish`, then POSTs | at the actual GitHub fixture POST boundary, independent remote restore contains `attempted=true`; failed barrier has a real local marker but zero POSTs |
| serialized renewal and promotion | `primary-runtime.ts:serialize/mutate`; `S3Control` has `maxAttempts:1` | same-owner revision-conflict tests observe one real 412, no rebased write, readiness loss and child retirement |
| ambiguous successful control response | `mutate` loses term rather than refreshing the ETag | real promotion PUT commits with 200 but response is destroyed; term ends and new complete pointer survives; existing renewal ambiguity test also aborts active work |
| release is a new conditional operation | `cleanup` stops work, awaits serial mutations, freshly reads and checks its unique owner before release | stale cleanup cannot release a successor; failed promotion retains source; ambiguous promotion retains the newly committed complete prefix |

The model uses the actual control fields `revision`, `owner`, `expires`, `phase`
and `recovery`. There is no production `committedHead` or published TXID field.
Fixed TXIDs belong to the restore plan, not the control record. A matching unique
revision abstracts the complete record and its ETag snapshot. This is why using
current control fields in an abstract successful CAS is legitimate only when its
captured revision still matches. A blind refresh would invalidate that mapping.

`schedules.json` drives the two real admission transport scenarios and is executed
through both common models. Commit timing, child IPC and cleanup add concrete
steps not represented by the fixture. Ownership replacement uses a real S3 CAS;
a foreign bootstrap owner is later released to let the real successor acquire.
Those additional acquisition/release steps preserve the source, but the full
concrete execution is not graph-compared. The other table rows combine actual
integration observations with manual owner inspection. They do not verify every
TypeScript interleaving.

## Test outcomes and authoring gate

Fresh validation passed:

| Command | Outcome |
| --- | --- |
| `npm run check` | passed |
| `npm test` | 359 passed, 0 failed, 0 skipped; 82.74 seconds |
| `npm run test:replicated` | 16 passed, 0 failed, 0 skipped; 90.44 seconds test time |
| `npm run test:protocol` | passed, exit 0; 11 TLC invocations including 3 expected failures |
| `git diff --check` | passed |

Full command logs are under `/tmp/pronto-final-validation`. Full protocol logs and
DOT graphs are under
`/var/folders/d8/ksz8jtjs71dg8nf53mpw9jk00000gp/T/pronto-protocol-_l5q56dk`.
RustFS identity, service/process logs and control fault observations are under
`/var/folders/d8/ksz8jtjs71dg8nf53mpw9jk00000gp/T/pronto-rustfs-integration-op1HWz`.
The compact repository evidence does not depend on those temporary paths surviving.

The existing 13 real-storage tests were retained. The two admission races now
share the executable model schedule fixture, without duplicating their contract
at another layer. Three table-driven cases add previously missing promotion
conflict, ambiguous promotion and same-owner renewal conflict coverage.

Their independent contract is fail-closed control mutation without stale rebasing.
The credible regression is catching a 412 or lost response, re-reading control and
retrying. The conflict fixture changes only the revision under the same owner,
so such a blind retry could actually succeed. Successful requests reach RustFS;
the proxy does not implement expected CAS semantics. The ambiguous case verifies
that RustFS really committed the promotion before destroying its response. These
tests also independently restore the pre-fault delivery through the next owner.
No production-only test seam, source-grep assertion or storage fake was added.

## Mismatches and model corrections

No production defect was found in the exercised contracts. No production repair
or protocol change was made. The following differences remain explicit:

1. Python makes selection/restore atomic. Production freezes endpoint plans before
   restoring individual files. Detailed TLA+ splits these steps; common mode keeps
   the original semantics for an honest graph comparison.
2. Python makes renewal atomic and lets a stale failed promotion prepare again.
   A trace `prepare promotion; renew; stale CAS; prepare promotion` is admitted by
   Python but excluded by production serialization/fail-closed term loss. The
   original checker is an overapproximation here, not a literal TypeScript model.
3. Python prefix modes omit control response loss, fresh-read cleanup and separate
   acquisition GET/CAS. Detailed TLA+ models those. A successful promotion can be
   authoritative before the local process learns it succeeded. A lost response
   stops the local term, but cleanup must retain that new complete prefix.
4. Both abstract models have one log, not independently paginated repositories or
   LTX objects. The two-repository partial-bootstrap test checks a concrete missing
   obligation, not multi-database atomicity or every inventory race.
5. Actual expiry checks and cancellation reject some acknowledgements that the
   abstract model still permits after earlier confirmation. That is safe
   overapproximation for recoverability, not stale-execution fencing.
6. The common prefix tuple's second coordinate is always 1 and its history means
   “latest at selection”. The committed-head variants interpret it differently.
   Combining those meanings would model the wrong delivered protocol.

A model bug was found during final field-by-field review: detailed acquisition
from an idle record preserved `expires=0`. Production acquisition grants a new
lease. A separate `ControlShape` check reproduced the failure after release and
reacquisition, before any application operation. The fix makes acquisition,
renewal and promotion set abstract `expires=1`, and strengthens `TypeOK` to require
idle-owner/idle-phase/zero-expiry agreement. The pre-fix short trace is preserved
under `model_corrections` in `evidence.json`. It is a model bookkeeping defect,
not a Python or implementation defect; acknowledgement safety does not depend
on the omitted clock guard. Final detailed counts use the corrected model.

The runner also rejects unsupported command-line arguments and checks that its
model/config/oracle inputs did not change during exploration. The unsupported
`--terms 4` invocation was observed to fail with exit 1, not run default bounds.

During development, a 180-second detailed exploration was interrupted. It was not
counted as a pass. An obsolete run was later stopped after adding split acquisition
and stronger type/observed-head checks. Final completed runs replace that evidence.
The runner initially treated TLC's `Error: The behavior up to this point is:` trace
header as an unexpected second error. It now requires exactly the invariant error
and that known header, while still rejecting every other error. No oracle or
safety property was weakened to get agreement.

## Storage assumptions and qualifications

The models build in strong GET/LIST/CAS, complete atomic uploads, retained unchanged
history and independent baselines. Those are assumptions, not theorem conclusions.
RustFS tests provide actual conditional-write and restore evidence for examples.
They do not establish AWS consistency, IAM behaviour, every sync race or every
restore chain. Live-compaction coverage retains source objects; it does not prove
that external deletion or overwrites are safe.

Stock Litestream uses unconditional PUTs. Delivered Pronto has no per-term
credential vending and does not enforce source-object immutability. Deployment
still needs independently enforced term write isolation, deletion protection,
retention, clock discipline, large-history and broad fault-matrix qualification.
The original proposal's scoped-credential requirement is not implemented evidence.

One operation per term and 3 finite terms cannot establish arbitrary-history
safety. Atomic aggregate baselines cannot establish cross-database atomicity.
Arbitrary stale local SQLite execution and GitHub requests already in flight are
not fenced. No liveness follows under arbitrary partitions or pauses.

No production approval, storage IAM fencing, exactly-once GitHub effects or proof
of TypeScript correctness follows from this work.
