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

## Not verified

No real GitHub/model credentials were supplied or copied from the host. Live authentication, model inference, repository access and OAuth refresh were not exercised. The credential wizard was checked statically, not run interactively by the agent.

The cluster check uses a draft-PR HTTP fixture to avoid model charges and real reviews. It proves Kubernetes lifecycle, routing and storage recovery for that delivery. It does not prove production fencing, AWS or IAM behaviour, exactly-once publication, node-loss recovery, or survival of k3d cluster deletion.
