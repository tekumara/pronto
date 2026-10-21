// Explicit integration runner: starts a local rustfs executable from PATH and never reuses an existing service.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:net";

const locatedBinary = spawnSync("/bin/sh", ["-c", "command -v litestream"], { encoding: "utf8" });
if (locatedBinary.error || locatedBinary.status !== 0) throw new Error("test:replicated requires litestream installed and available on PATH", { cause: locatedBinary.error });
const pathEntry = resolve(locatedBinary.stdout.trim());
const pathTarget = realpathSync(pathEntry);
// mise shims point at the mise executable; pass the installed Litestream binary to Pronto.
const binary = basename(pathTarget) === "mise"
  ? realpathSync(execFileSync(pathTarget, ["which", "litestream"], { encoding: "utf8" }).trim())
  : pathTarget;
if (spawnSync("pgrep", ["-P", String(process.pid)]).error) throw new Error("test:replicated requires pgrep for child-process lifecycle assertions");
const version = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
if (!/^v?0\.5\.17(?:\s|$)/.test(version)) throw new Error("test:replicated requires stock Litestream v0.5.17");
const binarySHA256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
console.log(`Litestream ${version} sha256:${binarySHA256}`);
let rustfsVersion;
try { rustfsVersion = execFileSync("rustfs", ["-V"], { encoding: "utf8" }).trim(); }
catch (error) {
  if (error.code === "ENOENT") throw new Error("test:replicated requires rustfs installed and available on PATH", { cause: error });
  throw error;
}
console.log(`Using ${rustfsVersion} from PATH`);

const artifacts = process.env.PRONTO_INTEGRATION_ARTIFACTS || mkdtempSync(join(tmpdir(), "pronto-rustfs-integration-"));
mkdirSync(artifacts, { recursive: true });
const access = `pronto-${randomBytes(8).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
let rustfsDirectory;
let rustfsProcess;
let rustfsDone;
let rustfsClosed;
let rustfsError;
let rustfsOutput = "";
let testProcess;
let testDone;
let testOutput = "";
let interrupted;

function signalTests(signal) {
  if (testProcess?.pid) {
    try { process.kill(-testProcess.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
function signalRustfs(signal) {
  if (rustfsProcess?.pid) {
    try { process.kill(-rustfsProcess.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
const interrupt = (signal) => {
  interrupted ??= signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  signalTests(signal);
  signalRustfs(signal);
};
const onSIGINT = () => interrupt("SIGINT");
const onSIGTERM = () => interrupt("SIGTERM");
process.on("SIGINT", onSIGINT);
process.on("SIGTERM", onSIGTERM);

async function availablePort() {
  const server = createServer();
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
  });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a localhost port for RustFS");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function stopGroup(signal, done, signalGroup) {
  if (!done) return;
  signalGroup(signal);
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 500))]);
  signalGroup("SIGKILL");
  await done;
}

try {
  rustfsDirectory = mkdtempSync(join(tmpdir(), "pronto-rustfs-data-"));
  const dataDirectory = join(rustfsDirectory, "data");
  mkdirSync(dataDirectory);
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const rustfsEnv = {
    ...process.env,
    RUSTFS_ACCESS_KEY: access,
    RUSTFS_SECRET_KEY: secret,
    RUSTFS_CONSOLE_ENABLE: "false",
    RUSTFS_OBS_LOGGER_LEVEL: "error",
  };
  delete rustfsEnv.RUSTFS_VOLUMES;
  delete rustfsEnv.RUSTFS_ACCESS_KEY_FILE;
  delete rustfsEnv.RUSTFS_SECRET_KEY_FILE;
  rustfsProcess = spawn("rustfs", ["server", "--address", `127.0.0.1:${port}`, dataDirectory], {
    env: rustfsEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  rustfsProcess.stdout.on("data", (data) => { rustfsOutput += data; });
  rustfsProcess.stderr.on("data", (data) => { rustfsOutput += data; });
  rustfsProcess.on("error", (error) => { rustfsError = error; });
  rustfsDone = new Promise((resolve) => rustfsProcess.once("close", (code, signal) => {
    rustfsClosed = { code, signal };
    resolve();
  }));

  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    if (rustfsError) throw new Error(`Could not start rustfs from PATH: ${rustfsError.message}`, { cause: rustfsError });
    if (rustfsClosed) throw new Error(`rustfs exited before becoming healthy (code=${rustfsClosed.code}, signal=${rustfsClosed.signal}):\n${rustfsOutput}`);
    try { if ((await fetch(`${endpoint}/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!healthy) throw new Error(`RustFS did not become healthy on localhost:\n${rustfsOutput}`);
  writeFileSync(join(artifacts, "identities.json"), JSON.stringify({ rustfsVersion, endpoint, binary, version, binarySHA256 }, null, 2));
  console.log(`RustFS evidence: ${artifacts}`);

  const child = testProcess = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", "test/integration/replicated.test.ts"], {
    env: { ...process.env, PRONTO_LITESTREAM_BIN: binary, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: "",
      AWS_PROFILE: "", AWS_DEFAULT_PROFILE: "", // Use only this run's disposable RustFS credentials.
      PRONTO_S3_ENDPOINT: endpoint, PRONTO_S3_PATH_STYLE: "true", PRONTO_INTEGRATION_ARTIFACTS: artifacts }, detached: true, stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { process.stdout.write(data); testOutput += data; });
  child.stderr.on("data", (data) => { process.stderr.write(data); testOutput += data; });
  testDone = new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  const code = await testDone;
  writeFileSync(join(artifacts, "tests.log"), testOutput);
  if (!interrupted) process.exitCode = code;
} finally {
  process.off("SIGINT", onSIGINT);
  process.off("SIGTERM", onSIGTERM);
  await stopGroup("SIGTERM", testDone, signalTests);
  await stopGroup("SIGTERM", rustfsDone, signalRustfs);
  if (testOutput) writeFileSync(join(artifacts, "tests.log"), testOutput);
  if (rustfsOutput) writeFileSync(join(artifacts, "rustfs.log"), rustfsOutput);
  if (rustfsDirectory) rmSync(rustfsDirectory, { recursive: true, force: true });
}
