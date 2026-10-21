// Explicit integration runner: downloads only the pinned RustFS image; never uses an existing service.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const image = "rustfs/rustfs@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b"; // 1.0.3 multi-platform manifest
const binary = process.env.PRONTO_LITESTREAM_BIN;
if (!binary || !isAbsolute(binary)) throw new Error("Set PRONTO_LITESTREAM_BIN to an absolute path to stock Litestream v0.5.17 before running test:replicated");
if (spawnSync("pgrep", ["-P", String(process.pid)]).error) throw new Error("test:replicated requires pgrep for child-process lifecycle assertions");
const version = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
if (!/^v?0\.5\.17(?:\s|$)/.test(version)) throw new Error("test:replicated requires stock Litestream v0.5.17");
const binarySHA256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
console.log(`Litestream ${version} sha256:${binarySHA256}`);
try { execFileSync("docker", ["info"], { stdio: "ignore" }); }
catch { throw new Error("test:replicated requires a working Docker Engine. No tests were skipped or validated."); }
execFileSync("docker", ["pull", image], { stdio: "inherit" });
const artifacts = process.env.PRONTO_INTEGRATION_ARTIFACTS || mkdtempSync(join(tmpdir(), "pronto-rustfs-integration-"));
mkdirSync(artifacts, { recursive: true });
const access = `pronto-${randomBytes(8).toString("hex")}`;
const secret = randomBytes(24).toString("hex");
let container;
let testProcess;
const signalTests = (signal) => {
  if (testProcess?.pid) { try { process.kill(-testProcess.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
};
try {
  container = execFileSync("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::9000",
    "-e", `RUSTFS_ACCESS_KEY=${access}`, "-e", `RUSTFS_SECRET_KEY=${secret}`,
    "-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_OBS_LOGGER_LEVEL=error", image, "/data"], { encoding: "utf8" }).trim();
  const mapping = execFileSync("docker", ["port", container, "9000/tcp"], { encoding: "utf8" }).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error(`Unexpected disposable port mapping: ${mapping}`);
  const endpoint = `http://${mapping}`;
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${endpoint}/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!healthy) throw new Error("Pinned RustFS did not become healthy on localhost");
  writeFileSync(join(artifacts, "identities.json"), JSON.stringify({ image, endpoint, binary, version, binarySHA256, container }, null, 2));
  console.log(`RustFS evidence: ${artifacts}`);
  const child = testProcess = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", "test/integration/replicated.test.ts"], {
    env: { ...process.env, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: "",
      AWS_PROFILE: "", AWS_DEFAULT_PROFILE: "", // Use only this fixture's disposable RustFS credentials.
      PRONTO_S3_ENDPOINT: endpoint, PRONTO_S3_PATH_STYLE: "true", PRONTO_INTEGRATION_ARTIFACTS: artifacts }, detached: true, stdio: ["inherit", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { process.stdout.write(data); output += data; });
  child.stderr.on("data", (data) => { process.stderr.write(data); output += data; });
  const interrupt = () => signalTests("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const code = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  writeFileSync(join(artifacts, "tests.log"), output);
  process.exitCode = code;
} finally {
  // All test descendants inherit this runner-owned process group. Reap orphans even after a failing test.
  signalTests("SIGTERM");
  if (testProcess?.pid) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    signalTests("SIGKILL");
  }
  if (container) {
    try {
      writeFileSync(join(artifacts, "rustfs.log"), execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } finally {
      // -v removes only the anonymous /data volume created by this run.
      execFileSync("docker", ["rm", "-fv", container], { stdio: "inherit" });
    }
  }
}
