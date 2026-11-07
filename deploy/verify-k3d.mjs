// Cluster-boundary authoring gate:
// Protect real Service routing, probes, process containment, isolated pod state,
// crash takeover, OnDelete image replacement and PVC survival. Local integration
// tests cannot exercise kubelet/controller/EndpointSlice regressions. No production seam is added.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply, assertRouting, cluster, copyStorageSecret, endpoints, healthy, installApp, json, k, kubeconfig, namespace,
  podStates, run, secret, state, storageNamespace, until } from "./k3d.mjs";

const ns = "pronto-verification", release = "pronto-verify";
function clientProbe(pod, action, delivery) {
  const method = action === "status" ? "GET" : "POST";
  const query = delivery ? `?delivery=${encodeURIComponent(delivery)}` : "";
  const url = `http://127.0.0.1:8081/client-probe/${action}${query}`;
  const script = `const response = await fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)}, headers:{"x-client-probe-control":process.env.PRONTO_WEBHOOK_SECRET}}); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); console.log(JSON.stringify(result));`;
  return JSON.parse(k(["-n", ns, "exec", pod, "-c", "fixture", "--", "node", "--input-type=module", "-e", script]));
}
function podImage(podName) {
  const pod = json(["-n", ns, "get", "pod", podName]);
  const container = pod.spec.containers.find((item) => item.name === "pronto");
  const status = pod.status.containerStatuses?.find((item) => item.name === "pronto");
  return { uid: pod.metadata.uid, image: container.image, imageID: status?.imageID ?? null };
}
export async function verify() {
  assert.equal(json(["-n", "pronto", "get", "pods"]).items.length, 0,
    "Storage fault testing disrupts shared RustFS. Run verification before enabling live Pronto.");
  const directory = join(state, "evidence", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(directory, { recursive: true });
  const observations = [];
  const record = (step, details) => {
    const entry = { step, at: new Date().toISOString(), ...details };
    observations.push(entry);
    writeFileSync(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify(entry));
  };
  const probe = (pod, action, ...args) => JSON.parse(k(["-n", ns, "exec", pod, "-c", "pronto", "--",
    "node", "--experimental-strip-types", "/app/verification/probe.mjs", action, ...args]));
  const logs = (pod, name = pod) => {
    try { writeFileSync(join(directory, name + ".log"), k(["-n", ns, "logs", pod, "-c", "pronto"])); } catch {}
  };
  const capturePodLogs = (pod, name) => {
    const child = spawn("mise", ["exec", "--", "kubectl", "--kubeconfig", kubeconfig,
      "--context", `k3d-${cluster}`, "-n", ns, "logs", "--follow", pod, "-c", "pronto"], {
      cwd: process.cwd(), env: { ...process.env, KUBECONFIG: kubeconfig }, detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", stderr = "", spawnError;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { spawnError = error; });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    };
    return {
      get output() { return output; },
      waitFor: (marker, message, timeout = 15_000) => until(() => {
        if (spawnError) throw spawnError;
        if (output.includes(marker)) return true;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Log stream for ${pod} exited before ${message}: ${stderr}`);
        return false;
      }, message, timeout),
      async finish() {
        if (child.exitCode === null && child.signalCode === null) signalGroup("SIGTERM");
        let result = await Promise.race([closed, delay(2_000, undefined, { ref: false }).then(() => null)]);
        if (!result) {
          signalGroup("SIGKILL");
          result = await closed;
        }
        writeFileSync(join(directory, `${name}.log`), output);
        return { ...result, bytes: Buffer.byteLength(output), stderr: stderr.trim() || null, output };
      },
    };
  };
  let stoppedController = false, stoppedStorage = false, clientProbeActive = false, clientPod;
  let oldOwnerLogCapture, newOwnerLogCapture;
  const beginClientProbe = async (delivery, fault) => {
    clientProbe(clientPod, "start", delivery);
    clientProbeActive = true;
    await until(() => clientProbe(clientPod, "status").baselineSuccessAt, `client reaches Service before ${fault}`, 15_000);
    return clientProbe(clientPod, "arm");
  };
  const finishClientProbe = () => {
    const result = clientProbe(clientPod, "finish");
    clientProbeActive = false;
    return result;
  };
  try {
    try {
      const existing = json(["get", "namespace", ns]);
      assert.equal(existing.metadata.labels?.["pronto-local-test"], "true", "Refusing to adopt an unrelated namespace");
    } catch (error) {
      if (!error.stderr?.includes("NotFound")) throw error;
      namespace(ns);
    }
    k(["label", "namespace", ns, "pronto-local-test=true", "--overwrite"]);
    run("helm", ["uninstall", release, "--namespace", ns, "--kubeconfig", kubeconfig, "--ignore-not-found"], { inherit: true });
    k(["-n", ns, "wait", "--for=delete", "pods", "-l", `app.kubernetes.io/instance=${release}`, "--timeout=60s"]);
    copyStorageSecret(ns);
    secret(ns, "pronto-app", { GITHUB_TOKEN: "verification-only", PRONTO_WEBHOOK_SECRET: randomBytes(24).toString("hex"),
      GITHUB_API_URL: `http://${release}-fixture:8081/github`, GITHUB_GRAPHQL_URL: `http://${release}-fixture:8081/github/graphql` });
    secret(ns, "pronto-pi", {
      "auth.json": JSON.stringify({ local: { type: "api_key", key: "verification-only" } }),
      "settings.json": JSON.stringify({ defaultProvider: "local", defaultModel: "verification" }),
      "models.json": JSON.stringify({ providers: { local: { baseUrl: `http://${release}-fixture:8081/v1`, api: "openai-completions",
        models: [{ id: "verification", contextWindow: 128000, maxTokens: 1000 }] } } }),
    });
    apply({ apiVersion: "v1", kind: "ConfigMap", metadata: { namespace: ns, name: "pronto-verification" },
      data: Object.fromEntries(["fixture.mjs", "probe.mjs"].map((file) => [file, readFileSync(join("deploy/verification", file), "utf8")])) });
    installApp(ns, release, `verification/${randomUUID()}`, { verification: true });
    clientPod = await until(() => json(["-n", ns, "get", "pods", "-l", `pronto-fixture=${release}`]).items
      .find((pod) => pod.status.containerStatuses?.some((container) => container.name === "fixture" && container.ready))?.metadata.name,
    "independent client fixture is Ready", 60_000);
    const initial = await healthy(ns, release, 2, 120_000);
    const owner = initial.find((p) => p.ready === 200), standby = initial.find((p) => p.ready === 503);
    await assertRouting(ns, release, owner.name);
    const passive = probe(standby.name, "runtime");
    assert.deepEqual(passive, { terms: [], litestreamPids: [] });
    assert.equal(probe(owner.name, "runtime").litestreamPids.length, 1);
    record("initial", { pods: initial, endpoints: endpoints(ns, release), standby: passive });

    // Cover enough liveness periods to expose /readyz incorrectly used as liveness.
    await delay(35_000);
    const stable = await healthy(ns, release);
    assert.equal(stable.find((p) => p.name === standby.name).restarts, standby.restarts);
    record("standby-stable", { pods: stable });

    const delivery = `k3d-${randomUUID()}`;
    record("acknowledged", probe(owner.name, "deliver", delivery, "queued"));
    const before = probe(owner.name, "snapshot", delivery);
    record("independent-restore-before-crash", before);
    const crashClientStart = await beginClientProbe(delivery, "owner crash");
    record("client-probe-armed-before-crash", { baselineSuccessAt: crashClientStart.baselineSuccessAt,
      intervalMs: crashClientStart.intervalMs, timeoutMs: crashClientStart.timeoutMs });
    logs(owner.name, "crashed-owner");
    const containerId = json(["-n", ns, "get", "pod", owner.name]).status.containerStatuses.find((c) => c.name === "pronto").containerID.split("://")[1];
    const crashedAt = Date.now();
    // Signal from the parent namespace. kill(1, SIGKILL) inside a container can
    // be ignored by its namespace init, accidentally testing graceful deletion.
    run("docker", ["exec", owner.node, "ctr", "--namespace", "k8s.io", "tasks", "kill", "--signal", "SIGKILL", "--all", containerId]);
    const exited = await until(() => {
      const info = JSON.parse(run("docker", ["exec", owner.node, "crictl", "inspect", containerId]));
      return info.status.state === "CONTAINER_EXITED" ? info.status : false;
    }, "containerd confirms owner was killed", 10_000);
    assert.equal(exited.exitCode, 137, "A graceful shutdown is not a crash test");
    record("owner-killed", { exitCode: exited.exitCode, leaseExpires: before.leaseExpires });
    // Hold the crashed contender down so takeover must be by the other pod.
    k(["-n", ns, "scale", "statefulset", owner.controller, "--replicas=0"]);
    stoppedController = owner.controller;
    const survivor = (await healthy(ns, release, 1, 60_000))[0];
    assert.equal(survivor.name, standby.name);
    await assertRouting(ns, release, survivor.name);
    const takeoverMs = Date.now() - crashedAt;
    assert.ok(takeoverMs < 60_000, "Takeover exceeded the cluster test bound");
    assert.ok(takeoverMs >= before.leaseExpires - crashedAt - 1_500, "Takeover occurred before the killed owner\'s lease could expire");
    record("crash-takeover", { takeoverMs, owner: survivor.name, endpoints: endpoints(ns, release) });
    const crashClient = finishClientProbe();
    assert.ok(crashClient.attempts > 0, "Independent client made no requests during owner takeover");
    assert.equal(crashClient.finishTimedOut, false, "Client did not receive a successful response after owner takeover");
    assert.ok(crashClient.firstFailureAt === null || crashClient.firstRecoveryAt,
      "Client requests failed during takeover but never recovered");
    record("crash-client-downtime", crashClient);
    // The old container must be exited or already garbage-collected, never running.
    let oldContainer;
    try { oldContainer = JSON.parse(run("docker", ["exec", owner.node, "crictl", "inspect", containerId])); }
    catch (error) { if (!/not found|NotFound|does not exist/.test(error.stderr ?? error.message)) throw error; }
    if (oldContainer) assert.notEqual(oldContainer.status.state, "CONTAINER_RUNNING");
    record("process-containment", { oldContainerState: oldContainer?.status.state ?? "garbage-collected" });
    record("deduplicated-after-crash", probe(survivor.name, "deliver", delivery, "duplicate"));
    const recovered = probe(survivor.name, "snapshot", delivery);
    assert.notEqual(recovered.owner, before.owner);
    assert.notEqual(recovered.recovery, before.recovery);
    record("independent-restore-after-crash", recovered);
    k(["-n", ns, "scale", "statefulset", owner.controller, "--replicas=1"]);
    stoppedController = false;
    await healthy(ns, release);
    assert.notEqual(podStates(ns, release).find((p) => p.name === owner.name).uid, owner.uid);

    const claims = json(["-n", storageNamespace, "get", "pvc"]).items.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, volume: p.spec.volumeName }));
    assert.ok(claims.length > 0);
    const storageClientStart = await beginClientProbe(delivery, "RustFS outage");
    record("client-probe-armed-before-storage-outage", { baselineSuccessAt: storageClientStart.baselineSuccessAt,
      intervalMs: storageClientStart.intervalMs, timeoutMs: storageClientStart.timeoutMs });
    k(["-n", storageNamespace, "scale", "deployment", "rustfs", "--replicas=0"]);
    stoppedStorage = true;
    await until(() => {
      const pods = podStates(ns, release);
      return pods.length === 2 && pods.every((p) => p.health === 200 && p.ready === 503);
    }, "storage outage closes admission without killing Pronto", 40_000);
    await until(() => endpoints(ns, release).length === 0, "no serving endpoints during storage outage", 15_000);
    record("storage-unavailable", { pods: podStates(ns, release), endpoints: endpoints(ns, release) });
    record("admission-refused-during-outage", probe(podStates(ns, release)[0].name, "refuse", `rejected-${randomUUID()}`));
    k(["-n", storageNamespace, "scale", "deployment", "rustfs", "--replicas=1"]);
    stoppedStorage = false;
    k(["-n", storageNamespace, "rollout", "status", "deployment/rustfs", "--timeout=120s"]);
    const final = await healthy(ns, release, 2, 120_000);
    const finalOwner = final.find((p) => p.ready === 200);
    await assertRouting(ns, release, finalOwner.name);
    const storageClient = finishClientProbe();
    assert.ok(storageClient.attempts > 0, "Independent client made no requests during the RustFS outage");
    assert.equal(storageClient.finishTimedOut, false, "Client did not receive a successful response after the RustFS restart");
    assert.ok(storageClient.firstFailureAt === null || storageClient.firstRecoveryAt,
      "Client requests failed during the RustFS outage but never recovered");
    record("storage-client-downtime", storageClient);
    assert.deepEqual(json(["-n", storageNamespace, "get", "pvc"]).items.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, volume: p.spec.volumeName })), claims);
    record("deduplicated-after-storage-restart", probe(finalOwner.name, "deliver", delivery, "duplicate"));
    record("independent-restore-after-storage-restart", probe(finalOwner.name, "snapshot", delivery));
    // A real StatefulSet OnDelete upgrade changes both templates but leaves the
    // existing pods on the baseline tag until each pod is deliberately replaced.
    const baselineImage = JSON.parse(readFileSync(join(state, "image.json"), "utf8")).image;
    const baselineDigest = run("docker", ["image", "inspect", baselineImage, "--format", "{{.Id}}"]);
    const repository = baselineImage.slice(0, baselineImage.lastIndexOf(":"));
    const candidateTag = `k3d-upgrade-${randomUUID()}`;
    const candidateImage = `${repository}:${candidateTag}`;
    run("docker", ["tag", baselineImage, candidateImage]);
    run("k3d", ["image", "import", "--cluster", cluster, candidateImage], { inherit: true, timeout: 300_000 });
    const candidateDigest = run("docker", ["image", "inspect", candidateImage, "--format", "{{.Id}}"]);
    assert.equal(candidateDigest, baselineDigest, "Upgrade simulation uses the same image bytes under a new immutable tag");
    for (const node of [`k3d-${cluster}-server-0`, `k3d-${cluster}-agent-0`]) {
      run("docker", ["exec", node, "crictl", "inspecti", `docker.io/library/${candidateImage}`]);
    }

    const beforeRollout = await healthy(ns, release, 2);
    const rolloutOwner = beforeRollout.find((pod) => pod.ready === 200);
    const rolloutStandby = beforeRollout.find((pod) => pod.ready === 503);
    assert.ok(rolloutOwner && rolloutStandby, "Expected one ready owner and one unready standby before upgrade");
    await assertRouting(ns, release, rolloutOwner.name);
    assert.ok(beforeRollout.every((pod) => podImage(pod.name).image === baselineImage));
    record("rollout-image-prepared", { baselineImage, candidateImage, imageDigest: baselineDigest,
      note: "Distinct tags, identical image bytes; exercises OnDelete replacement, not binary compatibility." });

    run("helm", ["upgrade", release, "deploy/helm/pronto", "--namespace", ns, "--kubeconfig", kubeconfig,
      "--kube-context", `k3d-${cluster}`, "--reuse-values", "--wait=hookOnly", "--timeout", "180s",
      "--set-string", `image.tag=${candidateTag}`], { inherit: true });
    const updatedStatefulSets = json(["-n", ns, "get", "statefulsets"]).items;
    assert.equal(updatedStatefulSets.length, 2);
    for (const statefulSet of updatedStatefulSets) {
      assert.equal(statefulSet.spec.template.spec.containers.find((item) => item.name === "pronto").image, candidateImage);
    }
    assert.ok((await healthy(ns, release, 2)).every((pod) => podImage(pod.name).image === baselineImage),
      "OnDelete must leave both existing pods on the baseline image until individually replaced");
    record("rollout-templates-updated", { candidateImage, pods: podStates(ns, release) });
    // The verification fixture shares the chart image tag, so Helm also replaces
    // its Deployment. Wait for the new fixture before starting client measurements.
    const oldClientPod = clientPod;
    clientPod = await until(() => json(["-n", ns, "get", "pods", "-l", `pronto-fixture=${release}`]).items
      .find((pod) => pod.spec.containers.find((item) => item.name === "fixture")?.image === candidateImage
        && pod.status.containerStatuses?.some((container) => container.name === "fixture" && container.ready))?.metadata.name,
    "candidate-image client fixture is Ready", 60_000);
    record("rollout-client-fixture-ready", { oldClientPod, clientPod, image: candidateImage });

    const standbyClientStart = await beginClientProbe(delivery, "standby image replacement");
    record("client-probe-armed-before-standby-replacement", { baselineSuccessAt: standbyClientStart.baselineSuccessAt,
      intervalMs: standbyClientStart.intervalMs, timeoutMs: standbyClientStart.timeoutMs });
    logs(rolloutStandby.name, "rollout-old-standby");
    k(["-n", ns, "delete", "pod", rolloutStandby.name, "--wait=true"]);
    const replacedStandby = await until(() => {
      const pod = podStates(ns, release).find((item) => item.name === rolloutStandby.name);
      if (!pod || pod.uid === rolloutStandby.uid || pod.health !== 200 || pod.ready !== 503) return false;
      const image = podImage(pod.name);
      return image.image === candidateImage ? { pod, image } : false;
    }, "new-image standby is live and remains unready", 60_000);
    const afterStandbyReplacement = await healthy(ns, release, 2);
    const ownerAfterStandby = afterStandbyReplacement.find((pod) => pod.ready === 200);
    assert.equal(ownerAfterStandby.name, rolloutOwner.name, "Replacing the standby must not replace the serving owner");
    assert.equal(ownerAfterStandby.uid, rolloutOwner.uid);
    await assertRouting(ns, release, ownerAfterStandby.name);
    const standbyClient = finishClientProbe();
    assert.ok(standbyClient.attempts > 0);
    assert.equal(standbyClient.finishTimedOut, false, "Client did not receive a successful response after standby replacement");
    assert.ok(standbyClient.firstFailureAt === null || standbyClient.firstRecoveryAt,
      "Client requests failed during standby replacement but never recovered");
    record("rollout-standby-replaced", { oldPod: rolloutStandby, newPod: replacedStandby,
      owner: ownerAfterStandby, endpoints: endpoints(ns, release) });
    record("rollout-standby-client-downtime", standbyClient);

    const ownerBeforeReplacement = afterStandbyReplacement.find((pod) => pod.ready === 200);
    const nextOwnerBeforeReplacement = afterStandbyReplacement.find((pod) => pod.ready === 503);
    assert.ok(ownerBeforeReplacement && nextOwnerBeforeReplacement);
    const ownerSnapshotBefore = probe(ownerBeforeReplacement.name, "snapshot", delivery);
    const ownerClientStart = await beginClientProbe(delivery, "owner image replacement");
    record("client-probe-armed-before-owner-replacement", { baselineSuccessAt: ownerClientStart.baselineSuccessAt,
      intervalMs: ownerClientStart.intervalMs, timeoutMs: ownerClientStart.timeoutMs });
    oldOwnerLogCapture = capturePodLogs(ownerBeforeReplacement.name, "rollout-old-owner");
    newOwnerLogCapture = capturePodLogs(nextOwnerBeforeReplacement.name, "rollout-new-owner");
    await Promise.all([
      oldOwnerLogCapture.waitFor(`Ready owner term ${ownerSnapshotBefore.owner}`, "old owner log stream is following"),
      newOwnerLogCapture.waitFor("standby until owned-ready", "standby log stream is following"),
    ]);
    record("rollout-owner-log-followers-ready", { oldOwner: ownerBeforeReplacement.name, oldTerm: ownerSnapshotBefore.owner,
      successor: nextOwnerBeforeReplacement.name, files: ["rollout-old-owner.log", "rollout-new-owner.log"] });
    record("rollout-owner-delete-requested", { pod: ownerBeforeReplacement.name, uid: ownerBeforeReplacement.uid,
      image: podImage(ownerBeforeReplacement.name).image, method: "graceful kubectl delete pod" });
    const ownerDeleteStartedAt = Date.now();
    k(["-n", ns, "delete", "pod", ownerBeforeReplacement.name, "--wait=true"]);
    const afterOwnerReplacement = await healthy(ns, release, 2, 120_000);
    const ownerAfterReplacement = afterOwnerReplacement.find((pod) => pod.ready === 200);
    await assertRouting(ns, release, ownerAfterReplacement.name);
    const ownerClient = finishClientProbe();
    assert.ok(ownerClient.attempts > 0);
    assert.equal(ownerClient.finishTimedOut, false, "Client did not receive a successful response after owner replacement");
    assert.ok(ownerClient.firstFailureAt === null || ownerClient.firstRecoveryAt,
      "Client requests failed during owner replacement but never recovered");
    const ownerSnapshotAfter = probe(ownerAfterReplacement.name, "snapshot", delivery);
    assert.notEqual(ownerSnapshotAfter.owner, ownerSnapshotBefore.owner, "Owner replacement must acquire a new term");
    assert.equal(ownerAfterReplacement.name, nextOwnerBeforeReplacement.name,
      "The existing standby must take over before the deleted owner is recreated");
    await Promise.all([
      oldOwnerLogCapture.waitFor(`Released owner term ${ownerSnapshotBefore.owner}`, "old owner lease release log"),
      newOwnerLogCapture.waitFor(`Ready owner term ${ownerSnapshotAfter.owner}`, "successor ready-owner log"),
    ]);
    assert.ok(newOwnerLogCapture.output.includes(`Acquired owner term ${ownerSnapshotAfter.owner}; bootstrapping (reason=explicit-release)`),
      "The successor log must identify explicit release as the acquisition reason");
    const oldOwnerCapture = await oldOwnerLogCapture.finish();
    oldOwnerLogCapture = undefined;
    const newOwnerCapture = await newOwnerLogCapture.finish();
    newOwnerLogCapture = undefined;
    record("rollout-owner-transition-logs-captured", {
      oldOwner: { pod: ownerBeforeReplacement.name, term: ownerSnapshotBefore.owner, file: "rollout-old-owner.log", bytes: oldOwnerCapture.bytes },
      newOwner: { pod: ownerAfterReplacement.name, term: ownerSnapshotAfter.owner, file: "rollout-new-owner.log", bytes: newOwnerCapture.bytes },
    });
    const upgradedImages = afterOwnerReplacement.map((pod) => podImage(pod.name));
    assert.ok(upgradedImages.every((image) => image.image === candidateImage), "Both pods must run the candidate image tag");
    assert.deepEqual(json(["-n", storageNamespace, "get", "pvc"]).items.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, volume: p.spec.volumeName })), claims);
    record("rollout-owner-replaced", { oldOwner: ownerBeforeReplacement, newOwner: ownerAfterReplacement,
      ownerDeleteStartedAt: new Date(ownerDeleteStartedAt).toISOString(), takeoverMs: Date.now() - ownerDeleteStartedAt,
      images: upgradedImages, endpoints: endpoints(ns, release) });
    record("rollout-owner-client-downtime", ownerClient);
    record("rollout-deduplicated-after-upgrade", probe(ownerAfterReplacement.name, "deliver", delivery, "duplicate"));
    record("independent-restore-after-upgrade", ownerSnapshotAfter);

    const stats = probe(ownerAfterReplacement.name, "stats");
    assert.ok(stats.githubReads > 0);
    assert.equal(stats.modelCalls, 0);
    assert.equal(stats.publicationAttempts, 0);
    assert.deepEqual(stats.unexpected, []);
    record("passed", { pods: afterOwnerReplacement, claims, fixture: stats,
      rollout: { baselineImage, candidateImage, sameImageDigest: baselineDigest === candidateDigest,
        standbyFailures: standbyClient.failures, ownerClientGapMs: ownerClient.clientObservedGapMs,
        ownerFailures: ownerClient.failures }, evidenceDirectory: directory });
  } catch (error) {
    record("failed", { message: error.message });
    throw error;
  } finally {
    // Stop log followers as well as the client monitor if verification fails mid-handoff.
    for (const capture of [oldOwnerLogCapture, newOwnerLogCapture]) {
      if (capture) { try { await capture.finish(); } catch {} }
    }
    if (clientProbeActive && clientPod) { try { clientProbe(clientPod, "stop"); } catch {} }
    // Restore infrastructure even if an assertion fails; never touch live credentials.
    if (stoppedStorage) k(["-n", storageNamespace, "scale", "deployment", "rustfs", "--replicas=1"]);
    if (stoppedController) k(["-n", ns, "scale", "statefulset", stoppedController, "--replicas=1"]);
    try {
      for (const pod of podStates(ns, release)) logs(pod.name);
      writeFileSync(join(directory, "events.txt"), k(["-n", ns, "get", "events", "--sort-by=.lastTimestamp"]));
    } catch {}
    console.log(`Verification artifacts: ${directory}`);
  }
}
