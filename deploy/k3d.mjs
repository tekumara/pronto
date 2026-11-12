#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
process.chdir(root);
process.umask(0o077);
export const cluster = "pronto-local";
export const state = join(root, ".k3d");
export const kubeconfig = join(state, "kubeconfig");
export const storageNamespace = "pronto-storage";
export const liveNamespace = "pronto";
mkdirSync(state, { recursive: true, mode: 0o700 });
const chart = join(root, "deploy/helm/pronto");
const ownership = join(state, "cluster-owner.json");

function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return sourceFiles(join(directory, entry.name), path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }).sort();
}
export function run(binary, args, { input, inherit = false, timeout = 240_000 } = {}) {
  return execFileSync(binary === "docker" ? "docker" : "mise", binary === "docker" ? args : ["exec", "--", binary, ...args], {
    cwd: root, env: { ...process.env, KUBECONFIG: kubeconfig }, input,
    encoding: "utf8", stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], timeout, maxBuffer: 20 * 1024 * 1024,
  })?.trim() ?? "";
}
export const k = (args, options) => run("kubectl", ["--kubeconfig", kubeconfig, "--context", `k3d-${cluster}`, ...args], options);
export const json = (args) => JSON.parse(k([...args, "-o", "json"]));
export const apply = (manifest) => k(["apply", "--server-side", "--field-manager=pronto-local", "-f", "-"], { input: JSON.stringify(manifest) });
export function secret(namespace, name, values) {
  const data = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString("base64")]));
  apply({ apiVersion: "v1", kind: "Secret", metadata: { name, namespace }, type: "Opaque", data });
}
export function namespace(name) { apply({ apiVersion: "v1", kind: "Namespace", metadata: { name } }); }
export function requireCluster() {
  assert.ok(existsSync(ownership) && existsSync(kubeconfig), "Run: mise exec -- node deploy/k3d.mjs up");
  assert.equal(JSON.parse(readFileSync(ownership)).root, root, "Cluster belongs to a different checkout");
  assert.equal(k(["config", "current-context"]), `k3d-${cluster}`);
}
function image() { return JSON.parse(readFileSync(join(state, "image.json"))).image; }
export function copyStorageSecret(namespace) {
  const creds = JSON.parse(readFileSync(join(state, "storage.json")));
  secret(namespace, "pronto-s3", { AWS_ACCESS_KEY_ID: creds.accessKey, AWS_SECRET_ACCESS_KEY: creds.secretKey });
}
export function installApp(namespace, release, prefix, { enabled = true, verification = false, model = "" } = {}) {
  run("helm", ["upgrade", "--install", release, chart, "--namespace", namespace,
    "--kubeconfig", kubeconfig, "--kube-context", `k3d-${cluster}`,
    // Owner-only readiness deliberately cannot satisfy Helm's all-ready waiter.
    "--wait=hookOnly", "--timeout", "180s",
    "--set-string", `image.repository=${image().split(":")[0]}`,
    "--set-string", `image.tag=${image().split(":")[1]}`,
    "--set-string", `replica.prefix=${prefix}`,
    "--set", `enabled=${enabled}`,
    "--set-literal", `model=${model}`,
    ...(verification ? ["--set-string", "verificationConfigMap=pronto-verification"] : []),
  ], { inherit: true });
}
export function podStates(namespace, release) {
  return json(["-n", namespace, "get", "pods", "-l", `app.kubernetes.io/name=pronto,app.kubernetes.io/instance=${release}`]).items.map((pod) => {
    let health = 0, ready = 0;
    if (pod.status.phase === "Running" && !pod.metadata.deletionTimestamp) {
      try {
        ({ health, ready } = JSON.parse(k(["-n", namespace, "exec", pod.metadata.name, "-c", "pronto", "--", "node", "-e",
          "Promise.all(['/healthz','/readyz'].map(p=>fetch('http://127.0.0.1:8080'+p,{signal:AbortSignal.timeout(2000)}).then(r=>r.status))).then(([health,ready])=>console.log(JSON.stringify({health,ready})))"], { timeout: 8_000 })));
      } catch { /* A starting or killed container is not healthy. */ }
    }
    return { name: pod.metadata.name, uid: pod.metadata.uid, node: pod.spec.nodeName, controller: pod.metadata.ownerReferences[0].name,
      phase: pod.status.phase, health, ready, restarts: pod.status.containerStatuses?.find((s) => s.name === "pronto")?.restartCount ?? 0 };
  });
}
export async function until(check, message, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(1_000); }
  throw new Error(`Timed out: ${message}`);
}
export async function healthy(namespace, release, count = 2, timeout = 90_000) {
  return until(() => {
    const pods = podStates(namespace, release);
    assert.ok(pods.filter((p) => p.ready === 200).length <= 1, "Multiple ready owners");
    return pods.length === count && pods.every((p) => p.health === 200) && pods.filter((p) => p.ready === 200).length === 1 ? pods : false;
  }, "one owner and live standbys", timeout);
}
export function endpoints(namespace, release) {
  return json(["-n", namespace, "get", "endpointslices", "-l", `kubernetes.io/service-name=${release}`]).items.flatMap((slice) =>
    slice.endpoints.filter((e) => e.conditions.ready && !e.conditions.terminating).map((e) => e.targetRef.name));
}
export async function assertRouting(namespace, release, owner) {
  await until(() => {
    const targets = endpoints(namespace, release);
    return targets.length === 1 && targets[0] === owner;
  }, "Service selects only the ready owner", 20_000);
}
async function up() {
  run("docker", ["info"], { timeout: 15_000 });
  const clusters = JSON.parse(run("k3d", ["cluster", "list", "-o", "json"]));
  if (clusters.some((c) => c.name === cluster)) {
    assert.ok(existsSync(ownership), `Refusing to adopt existing cluster ${cluster}`);
    assert.equal(JSON.parse(readFileSync(ownership)).root, root);
  } else {
    run("k3d", ["cluster", "create", cluster, "--servers", "1", "--agents", "1",
      "--image", "rancher/k3s:v1.34.5-k3s1@sha256:998f4db28a13143ada759690b554c5d8c1814ac03f77c1bdd78bbd73875a1379",
      "--api-port", "127.0.0.1:0", "--servers-memory", "2g", "--agents-memory", "3g",
      "--k3s-arg", "--disable=traefik,servicelb,metrics-server@server:0",
      "--kubeconfig-update-default=false", "--kubeconfig-switch-context=false", "--timeout", "180s"], { inherit: true });
    writeFileSync(ownership, JSON.stringify({ cluster, root, created: new Date().toISOString() }, null, 2));
  }
  writeFileSync(kubeconfig, run("k3d", ["kubeconfig", "get", cluster]), { mode: 0o600 });
  chmodSync(kubeconfig, 0o600);
  // k3d records port 0 literally in kubeconfig when Docker chooses the port.
  // Resolve the actual loopback mapping rather than changing the user's config.
  const lb = JSON.parse(run("docker", ["inspect", `k3d-${cluster}-serverlb`]))[0];
  const binding = lb.NetworkSettings.Ports["6443/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1", "Kubernetes API must remain loopback-only");
  k(["config", "set-cluster", `k3d-${cluster}`, `--server=https://127.0.0.1:${binding.HostPort}`]);
  requireCluster();
  k(["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=120s"], { inherit: true });
  const hash = createHash("sha256");
  for (const file of ["Dockerfile", "package.json", "package-lock.json", ...sourceFiles(join(root, "src"), "src"), "deploy/container/bucket.mjs"]) {
    hash.update(file); hash.update(readFileSync(file));
  }
  const built = `pronto:k3d-${hash.digest("hex").slice(0, 12)}`;
  run("docker", ["build", "--provenance=false", "--tag", built, "."], { inherit: true, timeout: 600_000 });
  writeFileSync(join(state, "image.json"), JSON.stringify({ image: built }, null, 2));
  // Export just the local platform. Docker's containerd image store can retain
  // multi-arch indexes without all blobs; k3d's default save then fails silently.
  const arch = run("docker", ["info", "--format", "{{.Architecture}}"]);
  const platform = arch === "aarch64" || arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const archive = join(state, "pronto-image.tar");
  run("docker", ["image", "save", "--platform", platform, "--output", archive, built], { timeout: 180_000 });
  run("k3d", ["image", "import", "--cluster", cluster, archive], { inherit: true, timeout: 300_000 });
  for (const node of [`k3d-${cluster}-server-0`, `k3d-${cluster}-agent-0`]) {
    run("docker", ["exec", node, "crictl", "inspecti", `docker.io/library/${built}`]);
  }
  namespace(storageNamespace); namespace(liveNamespace);
  const storagePath = join(state, "storage.json");
  if (!existsSync(storagePath)) writeFileSync(storagePath, JSON.stringify({ accessKey: `pronto-${randomBytes(8).toString("hex")}`, secretKey: randomBytes(32).toString("hex") }));
  const creds = JSON.parse(readFileSync(storagePath));
  secret(storageNamespace, "rustfs-credentials", { RUSTFS_ACCESS_KEY: creds.accessKey, RUSTFS_SECRET_KEY: creds.secretKey });
  copyStorageSecret(liveNamespace);
  run("helm", ["pull", "rustfs", "--repo", "https://charts.rustfs.com", "--version", "1.0.3", "--destination", state]);
  const rustfsChart = join(state, "rustfs-1.0.3.tgz");
  assert.equal(createHash("sha256").update(readFileSync(rustfsChart)).digest("hex"),
    "4d3474e1bd33c9071a2aad44273384dd374476a6ad65b134f2728a432ea22850", "Upstream RustFS chart archive changed");
  run("helm", ["upgrade", "--install", "rustfs", rustfsChart,
    "--namespace", storageNamespace, "--kubeconfig", kubeconfig, "--kube-context", `k3d-${cluster}`,
    "--values", "deploy/rustfs-values.yaml", "--wait", "--timeout", "180s"], { inherit: true });
  let hasCredentials = false;
  try { k(["-n", liveNamespace, "get", "secret", "pronto-app", "pronto-pi", "-o", "name"]); hasCredentials = true; } catch { /* Explicit credential setup is still required. */ }
  const applicationFile = join(state, "application.json");
  const model = hasCredentials && existsSync(applicationFile) ? JSON.parse(readFileSync(applicationFile)).model : "";
  installApp(liveNamespace, "pronto", "live", { enabled: hasCredentials, model });
  if (hasCredentials) console.log(JSON.stringify(await healthy(liveNamespace, "pronto"), null, 2));
  else console.log("RustFS is ready. Live Pronto is disabled until you run: bash deploy/credentials.sh");
}
async function credentials() {
  requireCluster();
  const previousPods = podStates(liveNamespace, "pronto");
  const path = join(state, "credentials.env");
  assert.ok(existsSync(path), "Run: bash deploy/credentials.sh (do not paste credentials into chat)");
  assert.equal((await import("node:fs")).statSync(path).mode & 0o077, 0, "credentials.env must have mode 600");
  const env = Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
    const index = line.indexOf("="); assert.ok(index > 0, "Invalid credentials.env line"); return [line.slice(0, index), line.slice(index + 1)];
  }));
  for (const name of ["GITHUB_TOKEN", "MODEL_PROVIDER", "MODEL_ID"]) assert.ok(env[name], `${name} is required`);
  assert.match(env.MODEL_PROVIDER, /^[a-z0-9-]+$/);
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "pronto-k3d-setup" }, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "GitHub rejected the supplied token");
  const viewer = await response.json();
  const provider = env.MODEL_PROVIDER;
  let auth, models = { providers: {} };
  if (env.PI_CONFIG_DIR) {
    // Read only this explicitly supplied profile and selected provider.
    auth = { [provider]: JSON.parse(readFileSync(join(env.PI_CONFIG_DIR, "auth.json")))[provider] };
    assert.ok(auth[provider], "Selected provider has no credential in the supplied profile");
    const modelsPath = join(env.PI_CONFIG_DIR, "models.json");
    if (existsSync(modelsPath)) {
      const config = JSON.parse(readFileSync(modelsPath));
      if (config.providers?.[provider]) models.providers[provider] = config.providers[provider];
    }
  } else {
    assert.ok(env.MODEL_API_KEY, "MODEL_API_KEY or PI_CONFIG_DIR is required");
    auth = { [provider]: { type: "api_key", key: env.MODEL_API_KEY } };
  }
  const webhookFile = join(state, "webhook-secret");
  if (!existsSync(webhookFile)) writeFileSync(webhookFile, randomBytes(32).toString("hex"));
  secret(liveNamespace, "pronto-app", { GITHUB_TOKEN: env.GITHUB_TOKEN, PRONTO_WEBHOOK_SECRET: readFileSync(webhookFile, "utf8") });
  secret(liveNamespace, "pronto-pi", { "auth.json": JSON.stringify(auth), "models.json": JSON.stringify(models),
    "settings.json": JSON.stringify({ defaultProvider: provider, defaultModel: env.MODEL_ID }) });
  const model = `${provider}/${env.MODEL_ID}`;
  writeFileSync(join(state, "application.json"), JSON.stringify({ model }));
  installApp(liveNamespace, "pronto", "live", { model });
  // OnDelete deliberately requires explicit replacement to pick up rotated secrets.
  for (const pod of [...previousPods.filter((p) => p.ready !== 200), ...previousPods.filter((p) => p.ready === 200)]) {
    k(["-n", liveNamespace, "delete", "pod", pod.name, "--wait=true"], { inherit: true });
    await until(() => podStates(liveNamespace, "pronto").some((p) => p.name === pod.name && p.uid !== pod.uid && p.health === 200), "replacement pod live");
  }
  const ready = await healthy(liveNamespace, "pronto");
  await assertRouting(liveNamespace, "pronto", ready.find((p) => p.ready === 200).name);
  console.log(JSON.stringify({ githubLogin: viewer.login, model: `${provider}/${env.MODEL_ID}`, pods: ready, webhookSecretFile: webhookFile }, null, 2));
  console.log("No model inference or real webhook was sent. Publication is disabled.");
}
async function main() {
  switch (process.argv[2]) {
    case "up": return up();
    case "credentials": return credentials();
    case "verify": requireCluster(); return (await import("./verify-k3d.mjs")).verify();
    case "verify-stateless": requireCluster(); return (await import("./verify-stateless-k3d.mjs")).verifyStateless();
    case "status":
      requireCluster();
      k(["get", "pods,pvc,services", "--all-namespaces"], { inherit: true });
      run("helm", ["list", "--all-namespaces", "--kubeconfig", kubeconfig], { inherit: true }); return;
    case "down":
      requireCluster();
      assert.ok(process.argv.includes("--confirm-delete"), "This deletes RustFS data. Re-run down --confirm-delete only if intended.");
      run("k3d", ["cluster", "delete", cluster], { inherit: true });
      console.log("Cluster deleted. Local credential files remain in .k3d; remove them explicitly when no longer needed."); return;
    default: throw new Error("Usage: mise exec -- node deploy/k3d.mjs up|credentials|verify|verify-stateless|status|down [--confirm-delete]");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not print child stdin, environments, or Secret manifests.
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  });
}
