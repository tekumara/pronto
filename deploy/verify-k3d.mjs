// Cluster-boundary authoring gate:
// Protect real Service routing, probes, process containment, isolated pod state,
// crash takeover and PVC survival. Local integration tests cannot exercise
// kubelet/controller/EndpointSlice regressions. No production seam is added.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply, assertRouting, copyStorageSecret, endpoints, healthy, installApp, json, k, kubeconfig, namespace,
  podStates, run, secret, state, storageNamespace, until } from "./k3d.mjs";

const ns = "pronto-verification", release = "pronto-verify";
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
  let stoppedController = false, stoppedStorage = false;
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
    assert.deepEqual(json(["-n", storageNamespace, "get", "pvc"]).items.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, volume: p.spec.volumeName })), claims);
    record("deduplicated-after-storage-restart", probe(finalOwner.name, "deliver", delivery, "duplicate"));
    record("independent-restore-after-storage-restart", probe(finalOwner.name, "snapshot", delivery));
    const stats = probe(finalOwner.name, "stats");
    assert.ok(stats.githubReads > 0);
    assert.equal(stats.modelCalls, 0);
    assert.equal(stats.publicationAttempts, 0);
    assert.deepEqual(stats.unexpected, []);
    record("passed", { pods: final, claims, fixture: stats, evidenceDirectory: directory });
  } catch (error) {
    record("failed", { message: error.message });
    throw error;
  } finally {
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
