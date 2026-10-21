# Separate-prefix protocol exploration

This is an abstract safety model, not production code or a Litestream/S3 integration test. No Pronto repository files were changed.

## Proposed minimal protocol

Maintain one persistent CAS-protected S3 control object containing the unique owner term, lease expiry, phase and recovery prefix. Acquiring ownership changes the owner and phase to bootstrapping while preserving the recovery prefix. Lease renewal preserves that prefix. Every successful control mutation changes its revision. Never delete/recreate this control object during ordinary release.

Each replication incarnation uses a new, never-reused S3 prefix and local working directory. Scope its write credentials to that prefix. Disable Litestream remote retention and prevent data deletion by its credentials. Do not apply age-based lifecycle deletion to referenced history.

A ready owner acknowledges an application operation only after its SQLite commit, successful Litestream remote sync, and a fresh strongly consistent GET confirming the same unique owner, ready phase and authoritative prefix. Do not cache this GET or perform it before the upload. A check response may precede takeover while the application response follows it; this is safe for durability because the upload preceded both.

A successor acquires ownership before inspecting its recovery source. It then chooses fixed, restorable TXIDs for all relevant databases, restores them, and establishes a complete independent baseline in its new prefix. It CAS-promotes its prefix only if it still owns the bootstrapping term. No Pronto task recovery or request handling starts before promotion. A further takeover during bootstrap preserves the last complete recovery prefix rather than adopting the partial candidate.

The successor must include all previously acknowledged replica databases, including dynamically created repository databases. Discover them from durable remote inventory, not merely local configuration.

## Ordering argument

For an acknowledged old-owner write:

    upload completes < ownership GET returns old owner < takeover CAS < successor reads source

The ownership GET is strongly consistent. With no owner-term reuse, a GET returning the old ready owner must precede the successful takeover CAS. Retained, unchanged source history therefore includes the uploaded operation. If takeover precedes the GET, that request cannot acknowledge success. Checking ownership before uploading does not establish this order.

## Assumptions the model does not establish

- S3 atomic object writes, strongly consistent GET/LIST, and conditional PUT semantics
- proper IAM prefix scoping and denial of data deletion
- finalized source LTX objects remaining unchanged during handoff
- no replicator reset or database replacement inside an existing term prefix
- Litestream upload completion covering the caller's prior SQLite commit
- every baseline and selected TXID having a complete restore chain
- actual command, IPC, restore, checksum and configuration behaviour
- multi-database discovery and any cross-database atomicity

A process restart receives a new term. Do not treat bucket versioning alone as immutability: ordinary GET follows the latest version.

This does not stop stale local SQLite access, background execution or GitHub side effects.

## Checks run

The finite models allow pauses between every transition and takeover at any time. Each term can make one application operation and renew once. The explicit CAS-head variant additionally permits two commit attempts per term and lost commit responses. All state spaces below completed without a depth cap.

| Model | States | Transitions | Result |
| --- | ---: | ---: | --- |
| Upload then acknowledge, 2 terms | 111 | 199 | Counterexample |
| Check ownership before upload, 2 terms | 207 | 365 | Counterexample |
| Check ownership after upload, 2 terms | 234 | 443 | No counterexample |
| Check ownership after upload, 3 terms | 5,340 | 13,205 | No counterexample |
| Explicit CAS committed heads, 3 terms | 80,291 | 215,807 | No counterexample |
| CAS retry without checking term, 2 terms | 416 | 744 | Counterexample |

A separate retention example shows that compacting ranges 1-1 and 2-2 into 1-3 and deleting their inputs destroys the restore point at TXID 2.

Run examples:

```bash
python3 check_protocol.py --mode postcheck --terms 3
python3 check_protocol.py --mode precheck --terms 2
python3 check_protocol.py --mode naive --terms 2
python3 check_protocol.py --mode fenced --terms 3
python3 check_protocol.py --mode blind-retry --terms 2
python3 check_protocol.py --mode retention
```

## Raw material inspected

Litestream commit `f282d0ef6815570235ca09ecbb53e81568acc5e7`:

- `s3/replica_client.go`: upload keys and deletion operations
- `db.go`: `SyncAndWait()` and retention controls
- `store.go`: `SyncDB()` and returned replication position
- `replica.go`: restore planning, inclusive TXID cap and missing-target checks
- `compactor.go`: retention controls
- `cmd/litestream/restore.go`: restore command

Local copies of most inspected files are under `source/`.

References:

- https://litestream.io/reference/sync/
- https://litestream.io/reference/restore/
- https://litestream.io/reference/config/#retention
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel

Before production, run real fault-injection checks against the pinned Litestream binary and the chosen S3 implementation. In particular, pause an old owner at each point around upload, ownership confirmation, source selection and promotion, then verify that every acknowledged operation survives an actual restore.
