// Starts mise-managed tools with terminal logs and disposable local storage.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = execFileSync("mise", ["which", "litestream"], { encoding: "utf8" }).trim();
const rustfsBinary = execFileSync("mise", ["which", "rustfs"], { encoding: "utf8" }).trim();
const access = `pronto-${randomBytes(8).toString("hex")}`;
const secret = randomBytes(24).toString("hex");
let rustfsProcess, rustfsDone, rustfsError, testProcess, testDone, interrupted;

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function interrupt(signal) {
  interrupted ??= signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  signalGroup(testProcess, signal); // The finally block stops RustFS after the tests.
}
const onSIGINT = () => interrupt("SIGINT");
const onSIGTERM = () => interrupt("SIGTERM");
process.on("SIGINT", onSIGINT);
process.on("SIGTERM", onSIGTERM);

async function availablePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function stopGroup(child, done) {
  if (!done) return;
  signalGroup(child, "SIGTERM");
  await Promise.race([done, delay(500)]);
  signalGroup(child, "SIGKILL");
  await done;
}

const directory = mkdtempSync(join(tmpdir(), "pronto-rustfs-data-"));
try {
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const env = { ...process.env, RUSTFS_ACCESS_KEY: access, RUSTFS_SECRET_KEY: secret,
    RUSTFS_CONSOLE_ENABLE: "false", RUSTFS_OBS_LOGGER_LEVEL: "error" };
  delete env.RUSTFS_VOLUMES;
  delete env.RUSTFS_ACCESS_KEY_FILE;
  delete env.RUSTFS_SECRET_KEY_FILE;
  rustfsProcess = spawn(rustfsBinary, ["server", "--address", `127.0.0.1:${port}`, directory], {
    env, detached: true, stdio: ["ignore", process.stderr, process.stderr],
  });
  rustfsProcess.on("error", (error) => { rustfsError = error; });
  rustfsDone = new Promise((resolve) => rustfsProcess.once("close", resolve));

  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    if (rustfsError) throw new Error("Could not start rustfs", { cause: rustfsError });
    if (rustfsProcess.exitCode !== null || rustfsProcess.signalCode !== null) {
      throw new Error(`rustfs exited before becoming healthy (code=${rustfsProcess.exitCode}, signal=${rustfsProcess.signalCode})`);
    }
    try { if ((await fetch(`${endpoint}/health`)).ok) { healthy = true; break; } } catch {}
    await delay(200);
  }
  if (!healthy) throw new Error("RustFS did not become healthy on localhost");

  testProcess = spawn(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", "test/integration/replicated.test.ts"], {
    env: { ...process.env, PRONTO_LITESTREAM_BIN: binary, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret,
      AWS_SESSION_TOKEN: "", AWS_PROFILE: "", AWS_DEFAULT_PROFILE: "", PRONTO_S3_ENDPOINT: endpoint, PRONTO_S3_PATH_STYLE: "true" },
    detached: true, stdio: "inherit",
  });
  testDone = new Promise((resolve) => testProcess.once("close", (code) => resolve(code ?? 1)));
  const code = await testDone;
  if (!interrupted) process.exitCode = code;
} finally {
  process.off("SIGINT", onSIGINT);
  process.off("SIGTERM", onSIGTERM);
  await stopGroup(testProcess, testDone);
  await stopGroup(rustfsProcess, rustfsDone);
  rmSync(directory, { recursive: true, force: true });
}
