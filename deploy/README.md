# Local replicated Pronto on k3d

Run 2 Pronto contenders and RustFS in a local k3d cluster. Only one Pronto pod owns the replicated state and receives Service traffic. New reviews are preview-only: the chart does not pass `--apply` or `--approve`.

This is an experimental deployment, not production high availability. RustFS is a single instance with persistent storage. The 2 Kubernetes nodes share one Docker host.

## Set up the cluster

You need an existing, running Docker-compatible daemon. The setup does not install or replace it. Use mise for new host tools:

```sh
mise install
mise exec -- node deploy/k3d.mjs up
```

Setup creates:

- a `pronto-local` cluster with one k3s server and one agent
- a dedicated `.k3d/kubeconfig`, without changing your default context
- RustFS from the official Helm chart, version 1.0.3, in `pronto-storage`
- a 2 GiB `local-path` PVC for RustFS data
- a `pronto` bucket, created by a Helm hook before the application starts
- a `pronto` Helm release with the application disabled until you supply credentials

The Kubernetes API binds to loopback. Application and storage Services are ClusterIP only. There is no public ingress, tunnel or installed GitHub webhook.

## Verify recovery before adding live credentials

```sh
mise exec -- node deploy/k3d.mjs verify
```

This uses the same Pronto image and Helm chart in `pronto-verification`, with a fresh S3 prefix for each run. GitHub and model HTTP endpoints are fixtures. SQLite, ownership, stock Litestream, RustFS, Kubernetes probes and Service routing are real.

The check:

1. Requires 2 live contenders, exactly one ready owner and only that owner in the Service's ready endpoints.
2. Checks that the standby has no term-local database or Litestream process, and remains live without restarting for 35 seconds.
3. Sends a signed webhook through the Kubernetes Service and requires HTTP 202.
4. Independently restores remote SQLite state at a fixed LTX endpoint, checks integrity and finds the acknowledged delivery receipt.
5. Sends SIGKILL through containerd, requires owner exit code 137, holds that contender down, and requires the original standby to take over after lease expiry and within 60 seconds.
6. Checks that the old container is not running, the successor uses a new term prefix, and redelivery returns `duplicate`.
7. Restores the crashed contender, then stops RustFS. Both Pronto pods must remain live, become unready and leave the serving endpoints. A signed delivery must receive 503.
8. Replaces the RustFS pod, checks that its PVC identity remains unchanged, and repeats the restore and deduplication checks.
9. Requires zero model calls and zero review publication attempts.

The webhook targets a fixture draft PR, so no inference is needed. Existing local integration tests cover the audit/model path separately.

Verification refuses to run while live Pronto pods exist: stopping shared RustFS would disrupt them. It restores scaled-down controllers on failure and leaves the test namespace for diagnosis. Logs and observations go under `.k3d/evidence/`. Retained test prefixes are not deleted.

## Supply credentials and start live Pronto

Do not paste credentials into chat. Run the interactive wizard yourself:

```sh
bash deploy/credentials.sh
```

It walks through 4 stages:

1. A GitHub user token with read access to the selected repositories' contents and pull requests.
2. The exact model provider and model ID.
3. A model API key from that provider.
4. Confirmation before importing the credentials into local Kubernetes Secrets and starting Pronto.

The wizard stores values in the ignored, mode-600 `.k3d/credentials.env`. The importer checks GitHub authentication. It passes the chosen model explicitly, so an unavailable model fails startup instead of selecting another model. It does not make a model inference request, validate model billing access or send a real webhook.

For an OAuth or custom-provider profile, create `.k3d/credentials.env` yourself with mode 600:

```text
GITHUB_TOKEN=<user token>
MODEL_PROVIDER=<provider ID>
MODEL_ID=<model ID>
PI_CONFIG_DIR=<absolute path to an explicitly supplied Pi profile>
```

Then run:

```sh
mise exec -- node deploy/k3d.mjs credentials
```

The importer reads only the selected provider's credential and provider configuration from that directory. It does not copy other provider credentials or your default host profile implicitly. A custom configuration must be self-contained: host commands, environment references and paths do not become available in the container. Each pod gets a writable, private copy of the profile so provider authentication can maintain its own local cache. OAuth refreshes are not written back to the Kubernetes Secret; reimport renewed credentials when necessary.

For an API key, use `MODEL_API_KEY` instead of `PI_CONFIG_DIR`. Values are literal, unquoted `KEY=value` lines, not shell commands. Kubernetes Secrets are local cluster credentials, not an encrypted external secret store. Protect the Docker host and `.k3d` directory.

After successful import, `.k3d/webhook-secret` contains the generated signing secret. No reviews are posted unless the deployment configuration is deliberately changed. Do not reuse a prefix containing previously authorised publications: Pronto can recover those even without `--apply`.

## Access and inspect Pronto

```sh
mise exec -- node deploy/k3d.mjs status
mise exec -- kubectl --kubeconfig .k3d/kubeconfig -n pronto port-forward service/pronto 8080:8080
```

Then use `http://127.0.0.1:8080/healthz`, `/readyz` and `/webhook`. Port-forward binds to loopback by default. It attaches to a selected pod, not a continuously reselected Service backend. Restart port-forward after failover. The in-cluster Service is the failover-aware endpoint tested by the verifier.

Useful diagnostics:

```sh
mise exec -- kubectl --kubeconfig .k3d/kubeconfig -n pronto get pods
mise exec -- kubectl --kubeconfig .k3d/kubeconfig -n pronto get endpointslices -l kubernetes.io/service-name=pronto
mise exec -- kubectl --kubeconfig .k3d/kubeconfig -n pronto logs pronto-0-0 -c pronto
mise exec -- kubectl --kubeconfig .k3d/kubeconfig -n pronto get events --sort-by=.lastTimestamp
```

Expect one ready pod and one live but unready pod. `/healthz` is liveness; `/readyz` is admission readiness. The standby's 503 response must not trigger a restart.

## Helm readiness and upgrades

Pronto runs as 2 independent singleton StatefulSets. Their update strategy is `OnDelete`. This avoids Kubernetes rolling updates waiting forever for a standby to become ready. Local SQLite is an isolated `emptyDir`, not a shared volume; replaced pods recover from RustFS.

The setup uses Helm 4's `--wait=hookOnly` for Pronto. Ordinary `helm --wait`, all-ready rollout checks and automatic rollback-on-readiness are not appropriate: standbys are intentionally unready. Helm success alone is not acceptance. The setup and credential importer check application health, single ownership and ready Service endpoints separately.

Re-run `up` after changing the application or chart. If live pods already exist, `OnDelete` leaves them on their current image until you replace them. Delete the standby first and wait for `/healthz` on its replacement. Then delete the owner, wait for takeover and confirm exactly one ready endpoint. Do not use `kubectl rollout status` as the Pronto acceptance check. The credential importer performs this replacement sequence when rotating secrets.

There is no zero-downtime failover guarantee. Takeover waits for lease expiry after a crash. Requests can fail during transitions, and GitHub does not automatically retry failed webhook deliveries.

## Remove the deployment

Remove only the disposable verification release when you no longer need its running pods:

```sh
mise exec -- helm uninstall pronto-verify -n pronto-verification --kubeconfig .k3d/kubeconfig
mise exec -- kubectl --kubeconfig .k3d/kubeconfig delete namespace pronto-verification
```

To delete the whole local cluster and its RustFS data:

```sh
mise exec -- node deploy/k3d.mjs down --confirm-delete
```

This does not remove unrelated clusters or change your default context. Local files remain in `.k3d`, including credentials and the image archive. Remove that directory explicitly when you no longer need it. Deleting the k3d cluster loses its local-path data; the PVC test proves pod replacement, not survival of cluster deletion or node loss.

## Recorded validation

See the [observed local validation results](VALIDATION.md) for the tested versions, crash timing, storage checks and remaining limits.

## Safety limits

The existing [replicated-state limits](../REPLICATED_STATE.md#limits-and-deployment-requirements) still apply. This setup does not add hard fencing, per-term permissions, deletion protection, exactly-once publication, clock-skew tolerance or storage redundancy. S3 credentials have broad access to this disposable RustFS instance. Referenced history and `control.json` must not be deleted or reset. Local state and retained term prefixes have no automatic garbage collection.
