// Cluster-boundary authoring gate:
// Protect the independent Kubernetes Service/EndpointSlice contract for a
// stateless two-replica Deployment during single-pod replacement. The existing
// k3d verifier covers Pronto's StatefulSet owner and RustFS failures, not ordinary
// stateless Deployment routing. No production seam is added; request failures are
// measured and reported, not used as the test's pass condition. A configurable
// client interval can reveal sub-100ms transition failures; fetch cause chains
// are retained to diagnose transport errors without production seams.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply, json, k, kubeconfig, namespace, requireCluster, run, state } from "./k3d.mjs";

const ns = "pronto-stateless-baseline";
const serviceName = "stateless-baseline";
const serverDeploymentName = "stateless-baseline-server";
const probeDeploymentName = "stateless-baseline-client";
const scriptsConfigMap = "stateless-baseline-scripts";
const ownershipLabel = "pronto-stateless-baseline";
const ownerLabels = { "app.kubernetes.io/part-of": ownershipLabel, "app.kubernetes.io/managed-by": "pronto-k3d-verifier" };
const serverLabels = { ...ownerLabels, "app.kubernetes.io/name": ownershipLabel, "app.kubernetes.io/component": "server" };
const clientLabels = { ...ownerLabels, "app.kubernetes.io/name": ownershipLabel, "app.kubernetes.io/component": "client" };
const serverSelector = "app.kubernetes.io/name=pronto-stateless-baseline,app.kubernetes.io/component=server";
const clientSelector = "app.kubernetes.io/name=pronto-stateless-baseline,app.kubernetes.io/component=client";
const image = JSON.parse(readFileSync(join(state, "image.json"), "utf8")).image;
const probeIntervalMs = Number(process.env.PRONTO_K3D_PROBE_INTERVAL_MS ?? "100");
assert.ok(Number.isInteger(probeIntervalMs) && probeIntervalMs >= 1 && probeIntervalMs <= 1_000,
  "PRONTO_K3D_PROBE_INTERVAL_MS must be an integer from 1 to 1000");

function ensureOwnedNamespace() {
  let existing;
  try { existing = json(["get", "namespace", ns]); }
  catch (error) {
    if (!String(error.stderr ?? error.message).includes("NotFound")) throw error;
  }
  if (existing) {
    assert.equal(existing.metadata.labels?.["pronto-local-test"], "true", `Refusing to adopt unrelated namespace ${ns}`);
    assert.equal(existing.metadata.labels?.[ownershipLabel], "true", `Refusing to adopt unrelated namespace ${ns}`);
  } else {
    namespace(ns);
  }
  k(["label", "namespace", ns, "pronto-local-test=true", `${ownershipLabel}=true`, "--overwrite"]);
}

function snapshot() {
  const resources = json(["-n", ns, "get", "deployments,pods,endpointslices"]).items;
  const deployment = resources.find((item) => item.kind === "Deployment" && item.metadata.name === serverDeploymentName);
  const pods = resources.filter((item) => item.kind === "Pod" && item.metadata.labels?.["app.kubernetes.io/component"] === "server"
    && item.metadata.labels?.["app.kubernetes.io/name"] === ownershipLabel).map((pod) => ({
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    node: pod.spec.nodeName,
    phase: pod.status.phase,
    deletingAt: pod.metadata.deletionTimestamp ?? null,
    ready: pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false,
    image: pod.spec.containers.find((container) => container.name === "server")?.image ?? null,
  }));
  const endpoints = resources.filter((item) => item.kind === "EndpointSlice"
    && item.metadata.labels?.["kubernetes.io/service-name"] === serviceName).flatMap((slice) =>
    (slice.endpoints ?? []).map((endpoint) => ({
      slice: slice.metadata.name,
      pod: endpoint.targetRef?.name ?? null,
      podUid: endpoint.targetRef?.uid ?? null,
      ready: endpoint.conditions?.ready ?? null,
      serving: endpoint.conditions?.serving ?? null,
      terminating: endpoint.conditions?.terminating ?? null,
      addresses: endpoint.addresses,
    })));
  return {
    deployment: deployment ? {
      name: deployment.metadata.name,
      generation: deployment.metadata.generation,
      observedGeneration: deployment.status?.observedGeneration ?? null,
      desiredReplicas: deployment.spec.replicas,
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      availableReplicas: deployment.status?.availableReplicas ?? 0,
      updatedReplicas: deployment.status?.updatedReplicas ?? 0,
    } : null,
    pods,
    endpoints,
  };
}

function hasTwoReadyReplicas(current) {
  if (!current.deployment || current.deployment.desiredReplicas !== 2
    || current.deployment.readyReplicas !== 2 || current.deployment.availableReplicas !== 2
    || current.pods.length !== 2 || current.pods.some((pod) => !pod.ready || pod.deletingAt)) return false;
  const podUids = new Set(current.pods.map((pod) => pod.uid));
  const readyEndpointUids = current.endpoints.filter((endpoint) => endpoint.ready === true && !endpoint.terminating)
    .map((endpoint) => endpoint.podUid);
  return readyEndpointUids.length === 2 && new Set(readyEndpointUids).size === 2
    && readyEndpointUids.every((uid) => podUids.has(uid));
}

function makeProbeControl(pod, action) {
  const method = action === "status" ? "GET" : "POST";
  const script = `const response=await fetch(${JSON.stringify(`http://127.0.0.1:8081/${action}`)},{method:${JSON.stringify(method)}});const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));console.log(JSON.stringify(result));`;
  return JSON.parse(k(["-n", ns, "exec", pod, "-c", "probe", "--", "node", "--input-type=module", "-e", script]));
}

async function waitFor(message, check, { timeoutMs = 90_000, intervalMs = 250, onChange } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature;
  while (Date.now() < deadline) {
    const value = check();
    const signature = JSON.stringify(value);
    if (signature !== previousSignature) {
      previousSignature = signature;
      onChange?.(value);
    }
    if (value && value.done) return value.result;
    await delay(intervalMs);
  }
  throw new Error(`Timed out: ${message}`);
}

function metrics(report, restartRequestedAt, replacementReadyAt, survivorUid, replacementUid) {
  const restartMs = Date.parse(restartRequestedAt);
  const attempts = report.samples.filter((sample) => Date.parse(sample.startedAt) >= restartMs);
  const failures = attempts.filter((sample) => !sample.success);
  const firstFailureIndex = attempts.findIndex((sample) => !sample.success);
  const firstFailure = firstFailureIndex < 0 ? null : attempts[firstFailureIndex];
  const priorSuccess = firstFailure
    ? [...report.samples].reverse().find((sample) => sample.success && Date.parse(sample.completedAt) <= Date.parse(firstFailure.startedAt)) ?? null
    : null;
  const recovery = firstFailure ? attempts.slice(firstFailureIndex + 1).find((sample) => sample.success) ?? null : null;
  const successTimes = report.samples.filter((sample) => sample.success).map((sample) => Date.parse(sample.completedAt));
  let maxSuccessGapMs = 0;
  for (let index = 1; index < successTimes.length; index++) {
    maxSuccessGapMs = Math.max(maxSuccessGapMs, successTimes[index] - successTimes[index - 1]);
  }
  const failuresByKind = {};
  for (const sample of failures) {
    const kind = sample.status === null ? (sample.error?.startsWith("TimeoutError:") ? "timeout" : "transport-error") : `http-${sample.status}`;
    failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
  }
  const responsesByPod = {};
  for (const sample of attempts.filter((item) => item.success)) {
    const pod = sample.responder ?? "unknown";
    responsesByPod[pod] = (responsesByPod[pod] ?? 0) + 1;
  }
  const readyAt = Date.parse(replacementReadyAt);
  return {
    endpoint: report.endpoint,
    connectionPolicy: report.connectionPolicy,
    intervalMs: report.intervalMs,
    timeoutMs: report.timeoutMs,
    windowStartedAt: restartRequestedAt,
    windowEndedAt: report.stoppedAt ?? null,
    attempts: attempts.length,
    successes: attempts.length - failures.length,
    failures: failures.length,
    failureRatePct: attempts.length ? Math.round((failures.length / attempts.length) * 10_000) / 100 : 0,
    noFailuresObserved: failures.length === 0,
    failuresByKind,
    firstFailureAt: firstFailure?.completedAt ?? null,
    firstFailureStartedAt: firstFailure?.startedAt ?? null,
    firstFailureStatus: firstFailure?.status ?? null,
    firstFailureError: firstFailure?.error ?? null,
    firstFailureDetails: firstFailure?.errorDetails ?? null,
    lastSuccessBeforeFailureAt: priorSuccess?.completedAt ?? null,
    firstRecoveryAt: recovery?.completedAt ?? null,
    clientObservedGapMs: firstFailure ? (priorSuccess && recovery
      ? Date.parse(recovery.completedAt) - Date.parse(priorSuccess.completedAt) : null) : 0,
    maxSuccessGapMs,
    responsesByPod,
    survivorResponsesBeforeReplacementReady: attempts.filter((sample) => sample.success
      && sample.responderUid === survivorUid && Date.parse(sample.completedAt) <= readyAt).length,
    replacementResponsesAfterReady: attempts.filter((sample) => sample.success
      && sample.responderUid === replacementUid && Date.parse(sample.completedAt) >= readyAt).length,
  };
}

export async function verifyStateless() {
  requireCluster();
  assert.equal(json(["-n", "pronto", "get", "pods"]).items.length, 0,
    "Refusing to run alongside live Pronto; use the isolated stateless baseline only when live Pronto is disabled.");
  run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  for (const node of ["server-0", "agent-0"]) {
    run("docker", ["exec", `k3d-pronto-local-${node}`, "crictl", "inspecti", `docker.io/library/${image}`]);
  }

  const directory = join(state, "evidence", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(directory, { recursive: true });
  const observations = [];
  const record = (step, details = {}) => {
    const entry = { step, at: new Date().toISOString(), ...details };
    observations.push(entry);
    writeFileSync(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify(entry));
    return entry;
  };
  let clientPod;
  let probeStarted = false;
  let probeReport;
  let passed = false;
  try {
    ensureOwnedNamespace();
    k(["-n", ns, "delete", `deployment/${serverDeploymentName}`, `deployment/${probeDeploymentName}`,
      `service/${serviceName}`, `configmap/${scriptsConfigMap}`, "--ignore-not-found=true", "--wait=true"]);
    const scripts = Object.fromEntries(["stateless-server.mjs", "stateless-probe.mjs"].map((file) =>
      [file, readFileSync(join("deploy/verification", file), "utf8")]));
    apply({ apiVersion: "v1", kind: "ConfigMap", metadata: { namespace: ns, name: scriptsConfigMap, labels: ownerLabels }, data: scripts });
    apply({ apiVersion: "v1", kind: "Service", metadata: { namespace: ns, name: serviceName, labels: ownerLabels }, spec: {
      type: "ClusterIP", selector: serverLabels, ports: [{ name: "http", port: 8080, targetPort: 8080 }],
    } });
    apply({ apiVersion: "apps/v1", kind: "Deployment", metadata: { namespace: ns, name: serverDeploymentName, labels: serverLabels }, spec: {
      replicas: 2,
      strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: serverLabels },
      template: { metadata: { labels: serverLabels }, spec: {
        containers: [{ name: "server", image, imagePullPolicy: "Never", command: ["node", "/opt/pronto-verification/stateless-server.mjs"],
          ports: [{ name: "http", containerPort: 8080 }],
          env: [
            { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
            { name: "POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
          ],
          readinessProbe: { httpGet: { path: "/readyz", port: "http" }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 2 },
          livenessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 3 },
          volumeMounts: [{ name: "scripts", mountPath: "/opt/pronto-verification", readOnly: true }],
        }],
        volumes: [{ name: "scripts", configMap: { name: scriptsConfigMap } }],
      } },
    } });
    apply({ apiVersion: "apps/v1", kind: "Deployment", metadata: { namespace: ns, name: probeDeploymentName, labels: clientLabels }, spec: {
      replicas: 1,
      selector: { matchLabels: clientLabels },
      template: { metadata: { labels: clientLabels }, spec: {
        containers: [{ name: "probe", image, imagePullPolicy: "Never", command: ["node", "/opt/pronto-verification/stateless-probe.mjs"],
          env: [
            { name: "TARGET_URL", value: `http://${serviceName}:8080/probe` },
            { name: "PROBE_INTERVAL_MS", value: String(probeIntervalMs) },
          ],
          ports: [{ name: "control", containerPort: 8081 }],
          readinessProbe: { httpGet: { path: "/healthz", port: "control" }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 3 },
          livenessProbe: { httpGet: { path: "/healthz", port: "control" }, periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 3 },
          volumeMounts: [{ name: "scripts", mountPath: "/opt/pronto-verification", readOnly: true }],
        }],
        volumes: [{ name: "scripts", configMap: { name: scriptsConfigMap } }],
      } },
    } });
    const claimList = json(["-n", ns, "get", "pvc"]).items;
    const spec = json(["-n", ns, "get", "deployment", serverDeploymentName]).spec.template.spec;
    assert.equal(claimList.length, 0, "Stateless baseline must not create persistent volume claims");
    assert.ok(spec.volumes.every((volume) => !volume.persistentVolumeClaim), "Stateless server must not mount persistent storage");
    record("resources-applied", { namespace: ns, image, replicas: 2, service: serviceName,
      storage: "none", persistenceClaims: claimList.length, clientPolicy: "fresh HTTP connection per request",
      probeIntervalMs, probeTimeoutMs: 1_000 });

    let lastSnapshotSignature;
    const observe = (phase, current) => {
      const signature = JSON.stringify(current);
      if (signature !== lastSnapshotSignature) {
        lastSnapshotSignature = signature;
        record("kubernetes-state-change", { phase, snapshot: current });
      }
    };
    const initial = await waitFor("two ready stateless replicas and two Service endpoints", () => {
      const current = snapshot();
      observe("initial-deployment", current);
      return hasTwoReadyReplicas(current) ? { done: true, result: current } : false;
    }, { timeoutMs: 90_000, intervalMs: 500 });
    const initialPods = [...initial.pods].sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(new Set(initialPods.map((pod) => pod.uid)).size, 2);
    record("baseline-ready", { deployment: initial.deployment, pods: initialPods, readyEndpoints: initial.endpoints });

    clientPod = await waitFor("stateless probe client pod Ready", () => {
      const pod = json(["-n", ns, "get", "pods", "-l", clientSelector]).items.find((item) =>
        item.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"));
      return pod ? { done: true, result: pod.metadata.name } : false;
    }, { timeoutMs: 60_000, intervalMs: 500 });
    record("probe-client-ready", { pod: clientPod });
    makeProbeControl(clientPod, "start");
    probeStarted = true;
    const baselineReport = await waitFor("20 consecutive stateless Service probe successes", () => {
      const current = makeProbeControl(clientPod, "status");
      return current.consecutiveBaselineSuccesses >= 20 ? { done: true, result: current } : false;
    }, { timeoutMs: 30_000, intervalMs: 300 });
    const armed = makeProbeControl(clientPod, "arm");
    record("baseline-probe-stable", { pod: clientPod, baselineSuccesses: baselineReport.baselineSuccesses,
      consecutiveBaselineSuccesses: armed.consecutiveBaselineSuccesses, armedAt: armed.armedAt,
      intervalMs: armed.intervalMs, timeoutMs: armed.timeoutMs });

    const [target, survivor] = initialPods;
    try { writeFileSync(join(directory, `before-delete-${target.name}.log`), k(["-n", ns, "logs", target.name, "-c", "server"])); } catch {}
    const restartEvent = record("single-pod-restart-requested", { pod: target.name, uid: target.uid,
      survivor: survivor.name, survivorUid: survivor.uid, method: "graceful kubectl delete pod; Deployment creates replacement" });
    k(["-n", ns, "delete", "pod", target.name, "--wait=false"]);
    record("pod-deletion-accepted", { pod: target.name, uid: target.uid, restartRequestedAt: restartEvent.at });

    const beforeRecovery = await waitFor("Deployment replaces one pod and restores two ready Service endpoints", () => {
      const current = snapshot();
      observe("single-pod-replacement", current);
      const replacement = current.pods.find((pod) => pod.uid !== survivor.uid && pod.uid !== target.uid);
      const restored = hasTwoReadyReplicas(current) && current.pods.some((pod) => pod.uid === survivor.uid)
        && replacement && !current.pods.some((pod) => pod.uid === target.uid);
      return restored ? { done: true, result: { snapshot: current, replacement } } : false;
    }, { timeoutMs: 90_000, intervalMs: 250 });
    const replacementReady = record("two-replicas-restored", {
      oldPod: target,
      survivor: currentPod(beforeRecovery.snapshot, survivor.uid),
      replacement: beforeRecovery.replacement,
      deployment: beforeRecovery.snapshot.deployment,
      readyEndpoints: beforeRecovery.snapshot.endpoints.filter((endpoint) => endpoint.ready === true && !endpoint.terminating),
    });

    for (let second = 1; second <= 10; second++) {
      await delay(1_000);
      const stable = snapshot();
      observe("post-recovery-stability", stable);
      assert.ok(hasTwoReadyReplicas(stable), `Two ready replicas/endpoints did not remain available for ${second} seconds after replacement`);
    }
    record("post-recovery-stable", { seconds: 10, deployment: snapshot().deployment });
    probeReport = makeProbeControl(clientPod, "stop");
    probeStarted = false;
    probeReport.stoppedAt = new Date().toISOString();
    const measured = metrics(probeReport, restartEvent.at, replacementReady.at, survivor.uid, beforeRecovery.replacement.uid);
    writeFileSync(join(directory, "probe-report.json"), JSON.stringify({ ...probeReport, metrics: measured }, null, 2));
    writeFileSync(join(directory, "requests.jsonl"), probeReport.samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    record("stateless-client-results", measured);

    try {
      writeFileSync(join(directory, `replacement-${beforeRecovery.replacement.name}.log`),
        k(["-n", ns, "logs", beforeRecovery.replacement.name, "-c", "server"]));
    } catch {}
    const final = snapshot();
    assert.ok(hasTwoReadyReplicas(final));
    assert.equal(final.pods.find((pod) => pod.uid === survivor.uid)?.uid, survivor.uid, "The non-restarted replica must retain its Pod UID");
    assert.ok(!final.pods.some((pod) => pod.uid === target.uid), "The deleted Pod UID must not return");
    assert.equal(final.pods.find((pod) => pod.uid === beforeRecovery.replacement.uid)?.uid, beforeRecovery.replacement.uid);
    record("passed", { namespace: ns, initialPodUids: initialPods.map((pod) => pod.uid), final: final,
      client: measured, evidenceDirectory: directory,
      note: "Test completion asserts one-pod replacement and restored routing; request failures, if any, are reported as data." });
    passed = true;
    return { directory, metrics: measured };
  } catch (error) {
    record("failed", { message: error.message });
    throw error;
  } finally {
    if (probeStarted && clientPod) {
      try {
        probeReport = makeProbeControl(clientPod, "stop");
        writeFileSync(join(directory, "probe-report.json"), JSON.stringify(probeReport, null, 2));
        writeFileSync(join(directory, "requests.jsonl"), probeReport.samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
      } catch {}
    }
    try {
      const events = json(["-n", ns, "get", "events", "-o", "json"]).items;
      writeFileSync(join(directory, "events.json"), JSON.stringify(events, null, 2));
      writeFileSync(join(directory, "events.txt"), k(["-n", ns, "get", "events", "--sort-by=.lastTimestamp"]));
      for (const pod of json(["-n", ns, "get", "pods", "-l", serverSelector]).items) {
        try { writeFileSync(join(directory, `${pod.metadata.name}.log`), k(["-n", ns, "logs", pod.metadata.name, "-c", "server"])); } catch {}
      }
      if (clientPod) {
        try { writeFileSync(join(directory, "probe-client.log"), k(["-n", ns, "logs", clientPod, "-c", "probe"])); } catch {}
      }
    } catch {}
    record("artifacts", { directory, namespaceRetained: true, passed });
    console.log(`Stateless baseline artifacts: ${directory}`);
  }
}

function currentPod(current, uid) {
  return current.pods.find((pod) => pod.uid === uid) ?? null;
}
