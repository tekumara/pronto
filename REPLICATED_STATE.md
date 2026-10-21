# Experimental replicated state

Use `pronto serve --replicated-state` to test term-isolated SQLite replication with stock Litestream and S3-compatible storage. This is an experimental durability and ownership protocol, not production hard fencing.

The flag defaults to off. Without it, serve, one-shot audits and chat keep their existing local state behaviour. They do not validate replica configuration, call S3, poll a lease or start Litestream. There is no automatic migration from an existing local database into replicated mode.

## Enable the experiment

Create the bucket separately. Use a new, dedicated base prefix and an absolute local state directory. Install an official Litestream executable in a location you control and verify its release checksum. Pronto does not require a specific version or verify its provenance or binary hash. Standbys do not execute the binary.

For a disposable RustFS instance on localhost:

```bash
export PRONTO_REPLICA_URL=s3://pronto-test/pronto-experiment
export PRONTO_S3_ENDPOINT=http://127.0.0.1:9000
export PRONTO_S3_PATH_STYLE=true
export AWS_REGION=us-east-1
export PRONTO_STATE_DIR="$HOME/.local/state/pronto-replicated"
export PRONTO_LITESTREAM_BIN=/absolute/path/to/litestream
# Supply AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY through your environment.
# Supply AWS_SESSION_TOKEN too when using temporary credentials.
# Supply the usual GitHub token, model credentials and PRONTO_WEBHOOK_SECRET.
node --experimental-strip-types audit.ts serve --replicated-state --port 8080
```

Do not commit the local state directory, credentials or generated Litestream logs. Omit `--apply` to preview new verdicts. Previously authorised publications still recover, as they do in local mode.

Configuration has one source of truth:

| Variable | Meaning |
| --- | --- |
| `PRONTO_REPLICA_URL` | Required `s3://bucket/non-empty-prefix`; no credentials, query, escapes or relative segments |
| `AWS_REGION` | Required region; `AWS_DEFAULT_REGION` is accepted when `AWS_REGION` is unset |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Required environment credentials shared by the SDK and Litestream |
| `AWS_SESSION_TOKEN` | Session token for temporary environment credentials |
| `PRONTO_S3_ENDPOINT` | Optional HTTP or HTTPS origin, without credentials, path or query; omit for AWS S3 |
| `PRONTO_S3_PATH_STYLE` | Optional `true` or `false`; defaults to true with a custom endpoint, otherwise false |
| `PRONTO_STATE_DIR` | Absolute local state base; otherwise the existing XDG state directory is used |
| `PRONTO_LITESTREAM_BIN` | Required absolute path to a Litestream executable |

This first implementation deliberately requires environment credentials. Unset `AWS_PROFILE` and `AWS_DEFAULT_PROFILE`; flagged mode rejects them so the SDK and Litestream cannot select different credential sources. It does not refresh expiring credentials or support profiles, role discovery or per-term credential vending. Credential expiry makes operations fail closed. The SDK, restore commands and dynamic replica URLs all use the same region, endpoint and addressing style. No credential is embedded in a URL or generated config.

Missing or invalid environment configuration, or a missing executable, fails startup. An incompatible Litestream executable or a storage error leaves the process unready; neither switches it into local-only operation. A missing bucket is an error, not an invitation to create infrastructure.

## Health and admission

- `GET /healthz` reports process liveness, including on standbys
- `GET /readyz` returns 200 only for an owned, ready term; otherwise 503
- application requests return 503 while standby, bootstrapping, stopping or uncertain

There is no request forwarding, redirect, discovery address or proxy-header protocol. Send requests only to a ready process using your own deployment arrangement. Both health paths are reserved from `--webhook-path`.

A standby does not create an auditor, open repository databases, start Litestream or resume tasks. It polls the control record once a second. An owner renews every 5 seconds with a 30-second lease and a conservative 5-second local margin. Ownership changes at the successful conditional control write, not when another process decides that a clock has expired. Deployment clocks must be synchronised. These constants are intentionally not a configurable election framework.

## Ownership and recovery

The base contains one persistent `control.json` record. It combines revision, unique owner term, expiry, phase and the last complete recovery prefix. Initial acquisition uses `If-None-Match: *`. Renewal, acquisition, promotion and release use `If-Match` on that same object. Ordinary operation never deletes it.

Each incarnation has:

- a new UUID term and never-reused `terms/<term>` replica prefix
- a captured local root at `$PRONTO_STATE_DIR/terms/<term>`
- a private, unique Unix control socket and Litestream child
- a cancellation signal and term-bound durability operations

Local `.lock` files prevent accidental local concurrency. They are not distributed fencing. The runtime never changes `PRONTO_STATE_DIR` between terms. Old callbacks retain the old root, socket and prefix.

After acquisition, the owner lists the previous complete prefix. It discovers all durable repository databases, including repositories absent from local configuration. It chooses fixed LTX endpoint TXIDs, restores each database into fresh local state and checks SQLite integrity. Invalid remote paths, inventory errors and failed restores block promotion. Unlike local recovery, replicated recovery cannot skip a bad database and continue.

The owner then starts a socket-only Litestream daemon, registers every restored database in the new prefix and stages auditor recovery without execution. It flushes all databases to create an independent baseline. Only a successful conditional promotion changes the complete recovery pointer to the new prefix. Only then does the runtime enable admissions and resume tasks. An explicitly fresh deployment has a null source and no databases to restore.

If B fails during bootstrap, C recovers from the last complete A prefix, not B's partial output. A child failure ends the whole term. The runtime never restarts or resets that child against the same prefix. Failed and retired local directories and remote prefixes are retained; automatic garbage collection is not implemented.

Stock Litestream runs with `retention.enabled: false` and automatic recovery/reset disabled. Local cache cleanup still runs. Do not configure cloud age-based deletion of referenced history.

## Durability barriers

Every 202 outcome, including duplicate and coalesced deliveries, follows this order:

1. Commit admission and delivery deduplication to the captured SQLite database.
2. Register a newly opened repository database, if needed, and wait for successful remote sync.
3. Perform a fresh control GET confirming the same unique term, ready phase and complete prefix.
4. Return 202 only while local readiness remains valid.

Registration happens when the auditor opens the repository, before acknowledging its first admission. `sync(wait=true)` accepts stock successful `synced` and `no_change` responses. It checks HTTP status and a nonzero remote position. It does not compare sampled local and remote TXIDs: concurrent commits can advance the local sample during a successful sync.

A running harness can dispatch a task before the HTTP barrier finishes. A separate worker-side barrier confirms its committed intake/running intent before external audit work. The publisher also confirms its committed `attempted=true` marker and current ownership before sending the GitHub review POST. Ordinary internal Durable checkpoints are not each synchronously replicated.

A timeout or non-success response means durability is unconfirmed. It does not roll back SQLite. A failed delivery may have committed locally or uploaded remotely. GitHub does not automatically redeliver failed webhooks. Arrange explicit redelivery or durable ingress if deliveries must survive unavailability. The persisted queue and publication reconciliation retain their existing roles.

If takeover precedes the post-upload GET, an old-prefix upload cannot produce a successful acknowledgement. If the GET confirmed ownership before takeover, a delayed 202 can still be valid. The successor acquires before selecting source endpoints, so it includes that already-uploaded operation.

Any ownership uncertainty immediately disables readiness, aborts work and stops the child. Shutdown closes owned storage and conditionally releases ownership while retaining recovery information. There is no required final flush: acknowledged durability does not depend on a graceful exit. Control writes are not blindly retried with a new ETag. A lost write response ends the local term; cleanup can release only its own unique term after a fresh read.

## Run the RustFS integration tests

Ordinary `npm test` and `npm run check` need no Docker, storage service or tool downloads. The explicit integration command requires a Unix host, `mise` on `PATH`, the tools configured in `mise.toml`, and `pgrep`. Install the tools once, then run the tests:

```bash
mise install
npm run test:replicated
```

Missing prerequisites fail the command. Important tests are not silently skipped. The runner resolves both executables with `mise which` and passes Litestream's absolute path to Pronto. `mise.toml` selects the latest Litestream release without an exact-version pin. It starts RustFS on a randomly selected localhost port, with random credentials and a temporary data directory. It never uses Docker or reuses an existing object service. On exit it stops the test process group, then RustFS, and removes only its temporary RustFS data.

Logs stream directly to the terminal. Use shell redirection or CI log capture to retain them. The runner does not create an evidence directory, record binary hashes or write service identities and duplicate log files. To retain individual application-process logs, set `PRONTO_INTEGRATION_ARTIFACTS` to an existing absolute directory before running the tests.

The tests exercise actual RustFS conditional requests and stock Litestream. They use signed HTTP responses, independent restored SQLite contents and integrity checks as oracles. A fault proxy delays or fails real requests; it does not implement storage semantics. GitHub and the model remain external HTTP fixtures, so tests do not post actual reviews or call paid models.

The suite covers competing contenders, standby inactivity, fresh repository enrollment and restored deduplication, live compaction/fixed restores, independent baselines, interrupted bootstrap, source restore refusal, both handoff acknowledgement races, worker gating, parent crash with lease expiry, child death, ambiguous renewal and publication intent before POST. Local focused tests cover parsing, configuration refusal, path validation and HTTP admission gating.

Development verification used the following Darwin arm64 Litestream release. This is a record of the tested binary, not a version requirement:

```text
version: 0.5.17
source: ccd326c175b583b5e82893a6078f06dcef5fba3f
binary SHA-256: 205b4c315d61a7f5709c4ab9001084eadfa8c9d36e1c198f9887417c2d88bb73
```

## Limits and deployment requirements

Do not interpret local RustFS results as AWS consistency, IAM or production approval.

This protocol does not stop arbitrary paused stale SQLite execution or GitHub requests already in flight. It does not guarantee exactly-once publication. An abruptly killed parent can leave its old-prefix Litestream process alive until your process supervisor stops it. Term isolation prevents adopting its incarnation, not arbitrary execution outside the runtime.

Prefix isolation is a naming rule, not permission enforcement. Stock Litestream uploads finalized LTX objects unconditionally. A broad credential can overwrite or delete old source history. The integration runner uses broad disposable credentials; that is not an IAM isolation test.

A production deployment needs independently enforced term write isolation, deletion protection, never-reused prefixes, strongly consistent GET/LIST, atomic conditional writes and unchanged retained source history. Do not deploy lifecycle deletion on referenced data. Do not delete or recreate `control.json`, replace a database inside a live term, run Litestream reset, or reuse a retired prefix. The application does not provision or verify those external permissions.

This first implementation does not provide per-term credential vending, automatic garbage collection, warm standbys, routing, cloud provisioning, cross-database transactions or a general election/plugin system. Large-database recovery, broad partitions/crash matrices, clock skew and production storage permissions need further testing.

## Upstream references

- [RustFS releases](https://github.com/rustfs/rustfs/releases)
- [Litestream v0.5.17 source](https://github.com/benbjohnson/litestream/tree/ccd326c175b583b5e82893a6078f06dcef5fba3f)
- [Litestream sync reference](https://litestream.io/reference/sync/)
- [Litestream restore reference](https://litestream.io/reference/restore/)
