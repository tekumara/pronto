# Election and recovery-history analysis with Quint

Pronto can report 2 ready processes if a contender's wall clock leads the lease
writer by more than the 5-second local margin. A 10-second lead reproduces this
in real `serve --replicated-state` processes using RustFS and stock Litestream.
Forward and backward clock adjustments can also produce overlapping readiness.

This is a confirmed implementation limitation outside an unenforced clock
assumption, not evidence of 2 successful concurrent durability acknowledgements.
In the replay, the old process rejects a new webhook with 503 when its fresh
ownership GET observes the successor. No production behaviour was changed.
The bounded Quint model also checks acknowledgement and recovery-baseline safety
during takeover. See the [recorded results and tool identity](VALIDATION.md).

## Run the analysis

Install and run Quint through mise. Quint is pinned to 0.33.0 in the repository's
`mise.toml`; Java uses the existing Temurin 21 selection.

```bash
mise install npm:@informalsystems/quint@0.33.0 java
mise run quint:check
# Equivalent project entry point:
npm run test:quint

# Real implementation replays, including the existing replication scenarios:
mise install
mise exec -- npm run test:replicated

# Ordinary application checks:
mise exec -- npm run check
mise exec -- npm test
```

`quint:check` requires Python 3.10 or later. It runs the actual mise-managed Quint
CLI, not a Python implementation of the election. It typechecks, executes 16
deterministic scenario runs, simulates 1,000 seeded 50-step runs, and checks the
finite models using Quint's TLC backend. The complete check may take several minutes.
Each verification has a 600-second timeout. Timeout, parse failure, unexpected
invariant failure, changed inputs or incomplete exploration fails the command.

The first verification downloads Quint's Apalache 0.62.1 backend distribution.
Quint uses it to compile to TLA+ and run the bundled TLC. This is separate from
the older protocol checks' checksum-pinned TLC 1.8.0. The runner records the actual
backend jar SHA-256, Java version, Quint version, input hashes, full output and
parsed counterexample states in a printed private temporary directory. It does
not claim independent signature verification of the backend download.
Apalache's generated `_apalache-out/` directory is ignored by Git.

### Run a scenario in the REPL

Run Quint from `protocol/quint` so the scenario file and its relative imports resolve:

```bash
cd protocol/quint
mise exec -- quint -r Scenarios.qnt::SynchronizedTests
```

At the REPL prompt, run a scenario such as `acquireA`:

```text
>>> acquireA
```

`Scenarios` needs values for all nine `Cfg*` constants. Do not load it directly
with `-r Scenarios.qnt::Scenarios`, which selects the unconfigured module. Use a
configured wrapper such as `SynchronizedTests`, `RecoveryHistoryTests`,
`ExcessSkewTests` or one of the mutation-test modules.

To set your own values, load the file without selecting a module, then import
`Scenarios` with every configuration value supplied:

```bash
mise exec -- quint -r Scenarios.qnt
```

```text
>>> import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false, CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false, CfgWrongBaseline = false, CfgRebaseMutation = false).*
>>> acquireA
```

For an individual counterexample, use the pinned CLI directly:

```bash
# Expected exit 1, with an invariant counterexample, not a tool error:
mise exec -- quint verify protocol/quint/LeaseElection.qnt \
  --main=ExcessSkew --step=leaseStep --invariant=singleReady \
  --backend=tlc --apalache-version=0.62.1 \
  --tlc-config=protocol/quint/tlc.json --verbosity=3
```

## The implementation contract

This is an S3 lease election, not a voting or quorum protocol. An atomic
conditional write elects a unique owner record. That does not instantly revoke
another process's local authority.

The relevant code is:

| Boundary | Code | What it does |
| --- | --- | --- |
| Acquisition | `primary-runtime.ts`, `attempt()` | GET control; inspect wall-clock expiry; acquire with the observed ETag; create a fresh UUID term |
| Local authority | `primary-runtime.ts`, `live()` and `ready()` | Require no cancellation or shutdown and monotonic time strictly before the local deadline |
| Renewal and promotion | `primary-runtime.ts`, `mutate()` | Serialize writes using the captured head; after PUT, check the old deadline before extending it |
| Bootstrap | `primary-runtime.ts`, `attempt()` | Restore the last complete prefix, sync an independent baseline, then conditionally promote before enabling readiness |
| Durability check | `primary-runtime.ts`, `confirm()` | Sync, then fresh GET, then local deadline and owner/phase/prefix/expiry checks |
| Cleanup | `primary-runtime.ts`, `cleanup()` | Stop work, drain the serialized mutation, fresh-read the same unique owner, then conditionally release without discarding recovery |
| Storage | `s3-control.ts`, `S3Control.read()` and `.write()` | Strong-read assumption; conditional initialization/update; no SDK write retries |
| Admission and dispatch | `auditor.ts`, `enqueue()` and `beforeDispatch` | Confirm durable admission and worker intent before dispatch |
| Publication | `publication.ts`, `publicationTask()` | Commit attempted intent, confirm it, check cancellation, then POST |

The lease is 30,000 ms, the local margin 5,000 ms, and renewal timers run every
5,000 ms. Both acquisition and successful mutation set the local deadline from
the monotonic time captured before the PUT, not from response arrival.

There are 3 different authority questions:

- which unique term occupies the shared control record
- which processes would currently return 200 from `/readyz`
- which operations have passed a fresh remote durability/ownership barrier

Only the first is intrinsically exclusive through CAS. The second depends on
clocks. The third is an observation-based check, not resource-enforced fencing.
A valid observation can precede takeover while its response arrives afterwards.
`Scenarios.qnt`'s `delayedObservationTest` retains that allowed ordering rather than incorrectly
requiring ownership still to match when every response is delivered.

## Counterexample and implementation replay

Take A's initial wall time as `W`. The deterministic model schedule is:

```text
A: read -> prepare acquire -> CAS -> response -> baseline -> prepare promote -> CAS -> response
advance 4 ticks
B: read -> prepare acquire -> CAS -> response -> baseline -> prepare promote -> CAS -> response
```

Each tick is 5,000 ms. The final state is:

| Value | A | B |
| --- | --- | --- |
| Monotonic elapsed time | 20,000 ms | 20,000 ms |
| Wall clock | W + 20,000 ms | W + 30,000 ms |
| Local deadline | 25,000 ms | 45,000 ms |
| Ready response | 200 | 200 |

A's record expires at `W + 30,000`. B therefore passes the expiry test and
successfully acquires and promotes a new term. A remains inside its local
25,000 ms deadline. The shared record still has only one owner: B.

Under stable wall-clock offsets and equal-rate monotonic clocks, a takeover
clock at most 5,000 ms ahead cannot take over before the previous local deadline.
At exactly 5,000 ms, the `>=` local expiry check fences the old process at the
boundary. Any larger lead can create an interval of overlapping readiness if
bootstrap completes within it. The runtime neither measures nor enforces this
clock bound. Clock adjustments after a lease grant also matter; initially
synchronised machines alone do not establish the assumption.

The real-process tests in `test/integration/replicated.test.ts` cover:

| Replay | Observable result |
| --- | --- |
| 5,000 ms stable skew | B remains standby at elapsed 20,000 ms; A is unready at its exact 25,000 ms deadline |
| 10,000 ms stable skew | B takes over at elapsed 20,000 ms while both ready endpoints return 200 |
| B jumps forward 10,000 ms after initially observing an unexpired lease | Both ready endpoints return 200 after B takes over |
| B's clock jumps backwards 10,000 ms before a renewal at elapsed 5,000 ms | Shared expiry becomes W + 25,000 ms; B's local deadline is 30,000 ms; A takes over at 25,000 ms while both remain ready |
| Successful renewal starts at 20,000 ms and its response arrives at the old 25,000 ms deadline | RustFS really commits expiry W + 50,000 ms, but the process ends its term instead of reviving local authority |

For both the static-skew and forward-jump overlap, a new webhook sent to A after
B becomes ready returns 503. A does not fetch GitHub evidence, and its cleanup
does not release B's ownership.

`controlled-clock.mjs` is a test-only Node preload. It supplies wall/monotonic
readings and uses Node's timer-mocking API to delay or deliver renewal interval
callbacks. Atomic file replacement controls the environment between transport
observations. It does not mock S3, CAS, the runtime, SQLite, or Litestream. The
storage service and Litestream children retain real clocks. No production clock
injection API or exported private election helper was added.

The overlap tests are passing characterisations of the current limitation, not
regression tests claiming a repair. A future exclusive-readiness fix must change
those expectations and demonstrate the old implementation fails the stricter
contract. The backward-jump implementation schedule uses a real timer delivery
at elapsed 5,000 ms; the model also permits earlier renewals as an explicit safety
overapproximation.

## Model and checks

`LeaseElection.qnt` keeps shared control separate from each actor's observed
head, conditional request, local deadline, baseline and readiness. It also tracks
a small recovery history through source selection, baseline creation, upload and
acknowledgement.

Acquisition GET, request preparation, CAS and response are separate actions.
Renewal and promotion share one pending slot. A write can complete after local
loss. Conflicts and lost responses do not create local authority. Bootstrap
selects a fixed source history before it builds an independent baseline.

The model uses 2 operation IDs, one per term. It stores each prefix's latest
history as a two-bit membership set. This is enough to check recoverability and
baseline inclusion, but not history ordering or arbitrary operation sequences.

`protocolSafety` includes these properties:

- `ackRecoverable`: each acknowledged operation appears in the history of the prefix named by control
- `completeBaseline`: the recovery pointer names a completed baseline, and ready control names its owner's prefix
- `baselineContainsSelected`: a new baseline matches its fixed restore selection, with an uploaded operation added afterwards
- `mutationUsesObservedHead`: pending renewals and promotions use the term's observed revision
- `controlDiscipline`: revisions change with writes, bootstrapping preserves the recovery pointer, and stale CAS cannot change control
- a ready actor acquired a term and completed its baseline
- a delayed renewal response does not revive expired or cancelled authority
- a successful ownership observation matches owner, phase, prefix and expiry

The model checks control discipline on CAS transitions. Actor IDs are process IDs,
not acquisition-ordered term numbers. It therefore omits the TLA model's numeric
recovery-order check. The acknowledgement and baseline properties check history
preservation instead.

`singleReady` checks whether more than one actor would pass local readiness.
`safety` combines that check with `protocolSafety`.

The runner checks these complete finite graphs and expected counterexamples:

| Configuration | Actions | Required outcome |
| --- | --- | --- |
| WithinMargin, +5,000 ms | `leaseStep`, `controlStep` and `recoveryStep` | All checked safety invariants hold |
| ExcessSkew, +10,000 ms | `leaseStep` and `recoveryStep` | `protocolSafety` holds; `singleReady` has an overlap counterexample |
| ForwardJump and BackwardJump | `leaseStep` | `singleReady` fails after the clock adjustment |
| NoCAS mutation | `leaseStep` | Stale CAS violates `protocolSafety` and `controlDiscipline` |
| LateRenewal mutation | `leaseStep` | A late response violates `protocolSafety` by reviving authority |
| CachedConfirmation mutation | `step` | A stale local belief violates the fresh-observation check |

Deterministic scenarios also check early acknowledgement, early promotion, wrong
baselines and rebased mutations. Each must violate its intended property. These
are unsafe model controls, not findings against production. Safe TLC searches
must finish with an empty queue. Expected counterexamples must fail for the
named invariant. Seeded simulation is supplementary evidence.

`leaseStep` focuses on lease timing and baseline transitions. `controlStep` keeps
time fixed while it checks barriers, loss and cleanup. `recoveryStep` combines
clock ticks, takeover, source selection, baseline creation, upload and delayed
acknowledgement. It omits renewal and cleanup to keep the joint search tractable.
The other projections check those paths separately.

## Bounds and assumptions

These are finite checks, not a proof of the TypeScript implementation:

- 2 unique term incarnations, each attempting acquisition once; contenders can overlap and either can acquire first
- one promotion, at most one renewal, one cleanup release and one barrier per incarnation
- integer time from 0 to 7 ticks, or 0 to 35,000 ms; deadlines and remote expiries can extend beyond that horizon
- wall-clock offsets of zero, +5,000 ms or +10,000 ms; jump variants change B's offset once by +10,000 ms or -10,000 ms
- equal-rate monotonic clocks with no backwards movement or suspend-specific behaviour
- atomic conditional control writes, strongly consistent GET, unique UUIDs/revisions and no control deletion or ABA
- two operation IDs and one operation per term; histories are membership sets, not ordered logs
- successful baseline creation and term-isolated, retained prefixes as in the existing protocol model

The complete search has no execution-depth cap, state constraint, symmetry
reduction or fairness assumption. Only the explicit finite model bounds limit
reachability. TLC deadlock checking is disabled by Quint's backend; terminal
states are allowed, and no deadlock-freedom or liveness claim follows.

The model does not cover arbitrarily many terms, same-process re-entry across
many elections, arbitrary clock rates, every network failure, malformed storage,
SQLite bytes, inventory pagination, Litestream internals, prefix permission
isolation or stale external effects already authorised or in flight. A restart
requires a fresh incarnation, but this model does not independently model
persistent process identity. The real integration suite separately exercises a
parent crash, child death, competing initialization and recovery.

The Quint model now checks bounded acknowledgement and baseline safety with
lease timing. Retain [the TLA+ analysis](../README.md) for its fuller history
model, unsafe protocol variants and conditional liveness checks. Neither model
proves the TypeScript implementation correct or guarantees progress under
arbitrary pauses or storage outages.

## Follow-up decisions

If exclusive readiness is required, specify and enforce the clock assumptions,
including changes between grant and takeover. Alternatively, consider takeover
based on an unchanged control revision observed for a monotonic interval. That
trades failover latency for less dependence on wall-clock agreement.

If exclusive effects are required, checks must be enforced at the protected
resource, not inferred from `/readyz`. The existing fresh ownership barriers are
valuable but do not atomically fence later GitHub effects. Choosing or implementing
such a redesign is outside this analysis.
