# Replicated-state protocol validation

This directory checks bounded safety and conditional liveness of Pronto's opt-in
replicated-state protocol. It does not prove the TypeScript implementation correct
or approve a deployment. See the [safety validation report](VALIDATION.md) and
[conditional liveness checks](LIVENESS.md) for results and assumptions. In particular,
GitHub recovery alone does not retry a terminal failed publication.

## Run the checks

Use Python 3.10 or later and mise. The project pins Temurin Java 21 in
`mise.toml`. `tlc.py` uses `JAVA_HOME`, falling back to `java` on `PATH`; the
protocol npm scripts do not activate mise themselves. Run them from a mise-activated
shell or prefix them with `mise exec java --` to supply the pinned runtime. Mise
installs Java on first use; run `mise install java` to install it ahead of time.
Normal application startup, `npm test` and `npm run check` do not load Java or
download TLC.

```bash
# Optional: choose a dedicated cache for TLC and generated evidence.
export PRONTO_PROTOCOL_CACHE=/absolute/path/to/dedicated/cache
mise exec java -- npm run test:protocol
# Optional shorter run: only the conditional liveness companion.
mise exec java -- npm run test:protocol:liveness

export PRONTO_LITESTREAM_BIN=/absolute/path/to/official/litestream
npm run check
npm test
npm run test:replicated
```

`test:protocol` downloads only the official `tlaplus/tlaplus` v1.8.0 jar, if absent.
The default cache is `~/.cache/pronto-protocol`. It verifies the jar on every run:

```text
URL: https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
SHA-256: 5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2
Official release SHA-1: ed814d7792505bbd141096ae66a0c4c5d878d951
```

The SHA-256 was measured after matching the release's published SHA-1. This pins
bytes; it is not independent release-signature verification. Mise supplies the
project-pinned Temurin runtime from its managed tool directory.

The gate uses breadth-first TLC model checking, one worker, fingerprint polynomial
0 and a 2 GB heap. It does not use simulation, depth caps, state constraints,
symmetry reduction or `-continue`. Each invocation has a 900-second timeout.
In the safety runner, safe runs require exit 0, the completion message and an empty
queue. Unsafe runs require exit 12, exactly the named invariant error and a
machine-readable trace. The [liveness runner](LIVENESS.md) additionally requires
completed temporal checks, named temporal failures and a deadlock control.
Tool errors, unsupported assumptions, timeouts, concurrent input changes and
unexpected outcomes fail the gate. The runner accepts no command-line arguments;
unsupported flags fail rather than silently running different bounds. A counterexample run intentionally stops early; it is not exhaustive.

The gate prints a private temporary evidence directory. It contains tool identity,
input hashes, full logs, short JSON traces, Python results and common DOT graphs.
Do not add jars, runtime binaries or state graphs to Git. Successful TLC runs
remove their working state stores. A killed run may leave its own temporary files.

The flags and formats follow the [official CLI guide](https://github.com/tlaplus/tlaplus/blob/v1.8.0/general/docs/current-tools.md),
the pinned jar's `tlc2.TLC -help`, and the [TLC configuration guide](https://docs.tlapl.us/using:tlc:config_file).
In particular, `-deadlock` disables deadlock checks; it does not enable them.
The original safety configurations use `CHECK_DEADLOCK FALSE` because finite
terminal states and indefinite pauses are allowed. They check safety, not progress
or deadlock freedom. The separate `Liveness.tla` companion adds explicit fairness
and availability assumptions and enables deadlock checks. `npm run test:protocol`
runs both gates; see [the liveness scope and counterexamples](LIVENESS.md).

## State and atomic actions

`PrefixProtocol.tla` has one composite state variable, `s`, with separate parts:

| Part | Meaning |
| --- | --- |
| `control` | Authoritative `revision`, `owner`, `expires`, `phase`, `recovery` |
| `actors[i]` | Per-term local state, observed head, pending conditional operation, selected source and confirmation receipt |
| `actors[i].versions` | Remote complete prefix histories, distinct from `local` and pending operations |
| `acknowledged` | Ghost set of externally acknowledged operations |

Terms and prefixes are unique integers allocated in order, rather than UUIDs.
Revisions are unique increasing integers representing the pair of record revision
and ETag. Equality, not numeric order, authorizes each CAS. No term, prefix or
revision is reused. `-1` means the released owner; prefix 0 starts complete and
empty. `expires=1` abstracts a granted lease and `0` an idle record, not elapsed
wall-clock time. Acquisition, renewal and promotion grant a lease; release clears it.
Takeover is allowed at any moment, a stronger safety adversary than lease expiry.

Actor phases are absent (0), acquired (1), restored (2), seeded (3), locally serving
(4), fixed endpoint selected (5), and acquisition pending or failed (6).
An old actor stays locally serving after another actor acquires control. Its
already-started upload may finish after takeover or even local cancellation.

The common mode (`Detailed=FALSE`) matches the original Python prefix modes:

- `Takeover` atomically acquires while preserving the last complete recovery prefix
- `Restore` atomically selects the latest endpoint and restores it, after acquisition
- `Baseline` establishes a complete independent prefix
- `PreparePromotion` captures a revision; `CAS` conditionally promotes that baseline
- `Commit`, `Upload`, `Observe` and `Acknowledge` are distinct, interleavable actions
- `Renew` is one atomic successful renewal which preserves recovery

`Observe` is the successful strong GET's storage observation, not delivery of
its response. `Acknowledge` has no current-owner guard. A valid observation can
precede takeover while its response and the HTTP 202 arrive later.

The detailed mode adds implementation obligations without changing the protocol:

- `PrepareAcquisition` reads control; its CAS and response are separate steps
- the captured revision must still match for acquisition to succeed
- `Select` freezes the selected endpoint history; `Restore` cannot switch to a newer one
- promotion and renewal share one pending slot and use the locally observed `head`
- control CAS completion and successful or lost response are separate steps
- stale CAS fails closed; a lost successful response stops the local term
- `Lose` abstracts local deadlines, cancellation, child failure and storage errors
- `PrepareRelease` is a new fresh-read operation after term loss, not a rebased retry

There is one acquisition contender in flight at a time. A failed acquisition
consumes its unique term. An ambiguous acquisition can change control without
creating a usable local owner. The detailed model does not enumerate concurrent
acquisition contenders. Real competing initialization and stale `If-Match` are
covered at the RustFS boundary instead.

Each action is atomic at this abstraction. SQLite bytes, IPC, request invocation,
response delivery, per-object uploads and per-repository inventory pagination add
steps below it. Unsuccessful GETs and syncs remove permission through `Lose`;
they do not manufacture a successful confirmation. Unknown local deadlines only
remove permission. The model permits acknowledgements even after local loss if
an earlier observation authorized them. Production's local readiness and abort
checks exclude some of these safe, overapproximated responses.

## Safety properties

`AckRecoverable` states that every acknowledged operation is in the latest
complete history of the authoritative `control.recovery` prefix. It holds during
bootstrap and release, not only when a process is ready. An upload followed by a
successful old-owner observation must precede takeover and later source selection.
The retained source must therefore include that upload. Promotion carries it
into an independent baseline, even if acknowledgement arrives later.

`CompleteBaseline` requires an authoritative prefix to have a complete version.
Ready control must identify its owner's prefix. `BaselineContainsSelected` requires
the baseline to equal the restored local history and, in detailed mode, the fixed
selected history. It cannot substitute an empty or partial baseline.

`MutationUsesObservedHead` requires pending renewals and promotions to use their
term's observed head. `ControlDiscipline` checks reachable edges: revisions cannot
go backwards, unchanged revisions cannot change control, recovery cannot move to
an older term, bootstrapping preserves the previous complete pointer, and clearing
a stale conditional request as a failure cannot mutate control.

These properties are checked consequences of `Init` and `Next` within the stated
bounds. CAS comparison, revision uniqueness, retained histories and complete
atomic upload semantics are rules of the storage model, not proven S3 properties.
`TypeOK` also checks the finite control and local-state domains.

The initial state is an already-ready empty term. It does not model missing-object
initialization or invalid control JSON. Real cold startup and S3 preconditions have
integration coverage. This is not a claim about arbitrary corrupt control states.

## Deliberately unsafe controls

`Mode="naive"` permits acknowledgement after upload without checking ownership.
`Mode="precheck"` checks before upload. Both can acknowledge an operation after a
successor selected an older history. The successor then promotes a baseline
missing the acknowledged operation. The gate replays each TLC trace through the
original Python successor relation and verifies the lost-history cause.

`Mode="early-promote"`, in detailed mode, permits preparing promotion before
baseline upload. Its expected failure is `CompleteBaseline`, at an actual
successful promotion CAS. The gate checks that the newly published prefix has
no complete version. None of these expected failures can pass through syntax,
deadlock, unrelated invariants or storage errors.

## Executable correspondence with Python

`oracle/check_protocol.py` and `oracle/README.md` are unchanged copies from
`/tmp/pronto-prefix-protocol.744wYZ`. The script SHA-256 must remain:

```text
7f4d1337fb39411d96988f4ae3fa332267e4293d6673d82c939cb0f014337374
```

The original README describes a proposal, including scoped credentials. It is
provenance, not authoritative implementation documentation. Delivered Pronto does
not provide per-term credential vending or enforce source immutability.

The gate calls the unmodified original checker first. It then exhaustively builds
its common reachable graph independently of the original stop-on-violation BFS.
TLC dumps its own reachable graph. For unsafe graphs only, a separate run omits
`AckRecoverable` so exploration continues beyond the first bad state. Other
invariants and control-discipline checks remain enabled.

Normalization maps control phase to Python's `ready`, recovery to `(term, 1)`,
acknowledgements to its bit mask, and each actor's phase, source, local history,
versions, pending request, receipt, written, acked and renewed fields directly.
It omits constant unused Python committed-head fields and TLA-only bookkeeping.
The parser rejects unknown or partial DOT/value formats. The gate compares both
the complete normalized vertex set and every source's complete successor set.
It also verifies that deleting an edge makes the correspondence check fail.
The graph relation is explicit `Next`. TLA+'s `[][Next]_vars` additionally permits
implicit stuttering, which Python does not enumerate and the comparison excludes.
No other common-mode steps are hidden or treated as stuttering.

This establishes exact reachable-state and unlabelled successor-set agreement for
the common finite abstraction: 2-term `naive`, `precheck`, `postcheck`, and 3-term
`postcheck`. Duplicate TLC graph edges do not add behaviours. It does not establish
labelled bisimulation, temporal refinement, detailed-mode equivalence, or a proof
about Python, TLC or TypeScript as implementations.

Both common models execute the schedules in `schedules.json`. The RustFS admission
tests consume that same fixture to choose whether to hold an LTX upload or an
already-successful ownership response. They observe 503 without dispatch, or 202
with later restored deduplication. This is an automated schedule correspondence
at those transport boundaries. Other concrete schedules and source mappings in
the report come from integration scenarios and manual inspection, not graph equality.

The original `fenced` and `blind-retry` modes concern an alternative committed-head
protocol. The gate reruns both, including exhaustive 3-term `fenced`, and replays
its stale-publication counterexample. They are not the delivered protocol and are
not added to the main TLA+ model. The independent `retention` warning shows how
compaction to range 1–3 plus deleting inputs can destroy fixed endpoint 2.

## Storage assumptions and remaining limits

The model assumes these properties. Tests provide examples, not universal proofs:

- atomic control CAS and strong GET/LIST, including inventory after acquisition
- unique terms, never-reused prefixes and revisions, with no control deletion or ABA
- unchanged append-only source objects and complete retained restore chains
- successful sync covering commits made before the barrier
- fixed endpoint restore integrity and complete independent baselines
- discovery and re-enrolment of every previously acknowledged repository

Stock Litestream uses unconditional PUTs. Pronto's current credentials can overwrite
source objects; source immutability is not enforced. Retention is disabled in the
child configuration, but external lifecycle deletion and broad credentials remain
risks. The integration runner's disposable RustFS credentials are deliberately
broad. There was no AWS operation, IAM validation or per-term credential vending.

All checks have 2 or 3 unique terms, one application operation and at most one
renewal and release per term. Detailed mode permits unsuccessful acquisitions and
lost successful control responses. Its extra bookkeeping is not synchronized with
the Python atomic-renewal abstraction. Selection and baseline each treat one
aggregate log atomically. Two-repository integration coverage is not a proof of
multi-database atomicity, pagination races or arbitrary repository histories.

We omit arbitrary histories, unbounded retries, byte corruption, overwritten or
deleted source objects, compaction internals, a clock-skew model, every network
failure pattern, independent stale GitHub execution and requests already in flight.
No liveness follows under arbitrary pauses or partitions. No production approval,
storage IAM fencing, exactly-once GitHub effects or proof of TypeScript correctness
follows from these checks.
