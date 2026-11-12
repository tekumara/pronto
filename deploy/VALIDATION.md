# Local deployment validation

Validated on 22 October 2026 using Docker on an arm64 Mac. The cluster remains a local experiment, not production approval.

## Environment

| Component | Version |
| --- | --- |
| Node.js, host and Pronto container | 24.13.0 |
| k3d | 5.9.0 |
| Actual k3s nodes | v1.34.5+k3s1 |
| kubectl | 1.34.12 |
| Helm | 4.2.4 |
| Stock Litestream in Pronto | 0.5.17 |
| RustFS image and official Helm chart | 1.0.3 |
| Pronto image | `pronto:k3d-cd0d5c34cd45` |

Host tools use mise. Container images are pinned in `Dockerfile`, `deploy/k3d.mjs` and `deploy/rustfs-values.yaml`. The official RustFS chart archive SHA-256 is checked before installation.

## Checks and results

`mise exec -- node deploy/k3d.mjs up` completed, including a repeat run against the same cluster. The existing default kubectl context remained unchanged. RustFS was healthy with its 2 GiB PVC. The live Pronto release remained disabled because no user credentials had been supplied.

`mise exec -- node deploy/k3d.mjs verify` passed against real in-cluster RustFS and stock Litestream:

- 2 Pronto pods were live, with exactly one ready owner and one serving endpoint
- the standby had no term directories or Litestream process and did not restart during the 35-second stability check
- a signed webhook sent through the Service returned HTTP 202
- the verifier restored a database copy from remote storage, found the webhook's delivery record and confirmed SQLite reported no integrity problems
- containerd delivered SIGKILL and recorded owner exit code 137
- the original standby took over in 28,704 milliseconds, after the killed owner's lease expiry
- the successor used a new term prefix and returned `duplicate` for the acknowledged delivery
- stopping RustFS left both Pronto processes live but unready, removed all serving endpoints and caused a signed direct delivery to return 503
- replacing RustFS retained the same PVC and backing volume; remote restore and delivery deduplication still passed
- the selected Pi credential file was a writable, regular mode-600 file, not a symlink into the read-only Secret mount
- external fixtures recorded 5 GitHub reads, zero model calls, zero publication attempts and zero unexpected requests

The accepted run's detailed observations, application logs and Kubernetes events are under:

```text
.k3d/evidence/2026-10-22T12-03-59.945Z/
```

Those artifacts are local and ignored by Git. An earlier smoke run was not accepted as crash evidence: killing namespace PID 1 from inside the container did not establish an abrupt exit. The final verifier instead signals containerd from the parent namespace and requires exit code 137 plus lease-expiry timing.

Additional checks passed:

- `mise exec -- npm test`: 359 passed, zero failures or skipped tests
- `mise exec -- npm run check`
- Helm lint for the ordinary and verification configurations
- Kubernetes server-side dry runs of rendered Pronto and RustFS manifests
- Node.js syntax checks, `bash -n`, and ShellCheck with the shared wizard template's unused colour warning excluded
- `git diff --check`

## Client-observed downtime samples

An earlier complete two-pod run on 7 November 2026 used an independent in-cluster client sending the same signed webhook through the ClusterIP Service every 100 ms, with a 1-second request timeout and Node fetch's default connection pooling. The client-observed gap is the time between its last HTTP 202 response before failures and its first HTTP 202 response after recovery.

| Fault | Client-observed success gap | Failed probes | Related measurement |
| --- | ---: | ---: | --- |
| Kill the owner pod | 30,221 ms | 48 | Successor takeover and Service routing: 30,146 ms |
| Stop RustFS | 25,823 ms | 247 | Both Pronto pods stayed live but unready; Service had no ready endpoints |

These are sampled measurements from one local run, not an SLO or zero-downtime guarantee. The probe exercises the in-cluster Service, not an external ingress or public webhook client. The full request timeline is in the ignored local artifact `.k3d/evidence/2026-11-07T11-10-50.131Z/observations.json`.

## Fresh-connection sample and rolling upgrade

A later verifier run on 7 November sets `Connection: close` on each synthetic request. A follow-up diagnostic had shown that a pooled HTTP connection can remain pinned to a former owner after it becomes an unready standby, even when a fresh connection through the Service reaches the new owner. The results below measure new TCP connections per request; persistent-connection behavior is not covered. The probe interval is a 100 ms target with a 1-second request timeout, so slow or timed-out requests delay the next attempt.

| Scenario | Client-observed gap | Failed probes | Attempts |
| --- | ---: | ---: | ---: |
| Kill the owner pod | 26,897 ms | 41 | 45 |
| Stop RustFS | 28,367 ms | 47 | 49 |
| Replace the standby image | No failures observed | 0 | 56 |
| Gracefully replace the owner image | 1,208 ms | 2 | 6 |

The verifier passed. It updated StatefulSet templates using `OnDelete`, replaced the standby first without changing the owner or losing a client success, then gracefully replaced the owner. Both pods ended on the candidate tag; the candidate and baseline tags referenced the same image digest, so this validates pod replacement and routing, not compatibility between different binaries. There were zero model calls, publication attempts or unexpected fixture requests, and the RustFS PVC identity was unchanged. Evidence is in `.k3d/evidence/2026-11-07T22-26-32.116Z/observations.json` (local and ignored by Git).

## Stateless Deployment baseline

`mise exec -- node deploy/k3d.mjs verify-stateless` passed twice on 8 November 2026 against the local k3d cluster. Each run deployed a two-replica stateless HTTP fixture behind a ClusterIP Service, established 20 consecutive baseline successes, then gracefully deleted one Pod and let its Deployment replace it. The fixture used no persistent storage, ownership protocol, or RustFS dependency. Both runs restored two ready Service endpoints in about 2 seconds and held them for the following 10 seconds.

| Trial | Deletion to two ready endpoints | Attempts | Successes | Failures | Max gap between successful responses |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,932 ms | 148 | 147 | 1 transport error | 200 ms |
| 2 | 2,196 ms | 158 | 158 | 0 | 110 ms |

Each trial had 24/24 successful baseline requests before deletion (the test requires at least 20 consecutive successes). In trial 1, the failed request was a `TypeError: fetch failed` during pod deletion. The preceding success was at 05:16:49.515Z and the first subsequent success at 05:16:49.715Z: a 200 ms client-observed gap. The surviving Pod answered 17 requests before the replacement was ready; in trial 2 it answered 21. The replacements then answered 57 and 77 requests, respectively. Across these two final-code runs, 305 of 306 requests succeeded; one run had no observed failures and the other had one. This is a small local sample through the in-cluster ClusterIP, not a guarantee for persistent connections, external ingress, or another application. Evidence is in `.k3d/evidence/2026-11-08T05-16-43.603Z/` and `.k3d/evidence/2026-11-08T05-17-41.365Z/` (local and ignored by Git).

A high-resolution diagnostic rerun used `PRONTO_K3D_PROBE_INTERVAL_MS=5` and retained nested fetch-error details, including socket error code and address when available. The post-deletion measurement window recorded 3,153 requests, all successful; maximum observed gap between successful responses was 14 ms, and the surviving Pod answered 523 requests before the replacement was ready. The replacement restored two ready endpoints 3,316 ms after the deletion request. Because no request failed in this run, it produced no socket-cause details; this does not explain the one failure from the 100 ms trial. Evidence is in `.k3d/evidence/2026-11-08T06-32-54.549Z/`.

A retry at the same 5 ms interval recorded 3,400 successful requests and zero failures, with an 11 ms maximum success gap. The survivor answered 330 requests before the replacement was ready; two ready endpoints were restored 1,771 ms after deletion. No fetch error occurred, so the enhanced cause-chain capture was not exercised. Evidence is in `.k3d/evidence/2026-11-08T06-39-19.948Z/`.

A further retry at a 2 ms target interval recorded 7,740 successful requests and zero failures, with a 12 ms maximum success gap. The survivor answered 1,392 requests before the replacement was ready; two ready endpoints were restored 3,281 ms after deletion. No fetch error occurred, so this run also could not reveal the original socket cause. Evidence is in `.k3d/evidence/2026-11-08T06-49-39.078Z/`.

A later 100 ms retry recorded 141 successful requests and zero failures, with a 111 ms maximum success gap. Two endpoints were restored 1,408 ms after deletion; the survivor answered 10 requests before replacement readiness and the replacement answered 61 afterward. No fetch error occurred. Evidence is in `.k3d/evidence/2026-11-08T07-19-46.196Z/`.

## Not verified

No real GitHub/model credentials were supplied or copied from the host. Live authentication, model inference, repository access and OAuth refresh were not exercised. The credential wizard was checked statically, not run interactively by the agent.

The cluster check uses a draft-PR HTTP fixture to avoid model charges and real reviews. It proves Kubernetes lifecycle, routing and storage recovery for that delivery. It does not prove production fencing, AWS or IAM behaviour, exactly-once publication, node-loss recovery, or survival of k3d cluster deletion.
