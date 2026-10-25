# Recorded leader-election checks

The 22 October 2026 run completed all 11 Quint/TLC checks. The combined
WithinMargin model explored 12,690,979 distinct states with no invariant violation
and an empty queue. This is bounded model-checking evidence under the
[model's assumptions](README.md#bounds-and-assumptions), not proof of the application.

Real RustFS/Litestream replays confirmed overlapping readiness from excessive
stable skew and from clock adjustments. Fresh stale-owner admission was rejected.
A late successful renewal did not revive authority. No production code changed.

## Completed model checks

| Configuration | Step | Invariant | Distinct states | Search depth | Outcome |
| --- | --- | --- | ---: | ---: | --- |
| Synchronized | leaseStep | safety | 126,706 | 30 | No violation, empty queue |
| WithinMargin | leaseStep | safety | 139,861 | 30 | No violation, empty queue |
| WithinMargin | controlStep | safety | 19,425 | 37 | No violation, empty queue |
| WithinMargin | step | safety | 12,690,979 | 44 | No violation, empty queue |
| ExcessSkew | leaseStep | protocolSafety | 180,429 | 30 | No violation, empty queue |
| ExcessSkew | leaseStep | singleReady | 109,682 | 21 | Expected overlap counterexample |
| ForwardJump | leaseStep | singleReady | 138,453 | 22 | Expected overlap counterexample |
| BackwardJump | leaseStep | singleReady | 161,614 | 24 | Expected overlap counterexample |
| NoCAS | leaseStep | protocolSafety | 136 | 7 | Expected stale-CAS mutation failure |
| LateRenewal | leaseStep | protocolSafety | 6,381 | 13 | Expected revival mutation failure |
| CachedConfirmation | step | protocolSafety | 175,285 | 18 | Expected stale-observation mutation failure |

Counterexample runs stop at the first failure and leave queued states; they are
not exhaustive searches. The runner parsed each trace and checked its named
cause. Both clock-jump traces include a change after a term became ready.
Search depth is reported by TLC, not an imposed execution-depth limit.

TLC uses fingerprints rather than retaining full state values for identity.
For the combined run, it reported collision-risk estimates of `3.1E-5`
(calculated optimistic) and `4.7E-5` (actual-fingerprint estimate). The full log
records its randomly chosen fingerprint polynomial and seed. These checks do not
remove that limitation or independently prove the abstraction faithful.

The 10 deterministic Quint scenarios and 1,000 seeded 50-step simulations also
passed. Simulation is supplementary, not exhaustive evidence.

## Implementation checks

| Command | Result |
| --- | --- |
| `mise exec -- npm run check` | Passed |
| `mise exec -- npm test` | 359 passed, none failed or skipped |
| `mise exec -- npm run test:replicated` | 22 passed, none failed or skipped, including 5 new clock/deadline replays |
| `mise exec -- npm run test:protocol` | Existing bounded safety, graph correspondence and conditional-liveness checks passed |
| `mise run quint:check` | All required safe checks, counterexamples and mutation controls passed |
| `git diff --check` | Passed |

The overlap replays assert the observed current limitation. They are not a claim
that an exclusive-readiness repair has been implemented. The regression against
late-response revival asserts the existing fail-closed behaviour.

## Tool identity and model inputs

The execution used Quint 0.33.0 through mise, Apalache 0.62.1 with its bundled TLC,
Temurin 21.0.12+8, Node 26.12.1, Litestream 0.5.17 and RustFS 1.0.3 on macOS arm64.
TLC used one worker, a 2 GB heap and a 16 MB stack. Tool versions and the measured
backend digest are evidence of this execution, not independent release signatures.

```text
Apalache backend jar SHA-256:
880c0b2b72354816f12e9a9755829f2907071e9a181ffea1937954c23d54739d

LeaseElection.qnt SHA-256:
30181ef1efbbeb2d15dfbabaa50289c40557ab72e8005d46e2fe4603a7ac008c

Scenarios.qnt SHA-256:
7fa23f1933056de1a7166534c942221151d2112c9135c6b27d42f8f94e4fdfa2

Unchanged primary-runtime.ts SHA-256:
629f329ad587593b7d748afead3c2df7effc698d9369ee3047bbc9af8a933ee8
```

The successful execution's raw logs, input hashes, results and JSON traces are
in the session-local directory below. It is temporary evidence, not a portable
repository dependency. Run `mise run quint:check` to generate a new evidence set.

```text
/var/folders/d8/ksz8jtjs71dg8nf53mpw9jk00000gp/T/pronto-quint-f41gzs5s
```

The implementation test logs from this session are in
`/tmp/pronto-quint-unit-final.log` and
`/tmp/pronto-quint-integration-final.log`. The existing protocol check output is
in `/tmp/pronto-existing-protocol-final.log`.
