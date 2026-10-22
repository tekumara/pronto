import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { replicaConfig } from "../s3-control.ts";
import { repositoryDatabasePath } from "../state.ts";
import { parseServeOptions } from "../serve-options.ts";
import { fixture, tool, noDatabaseMigration } from "./fixtures.ts";
import { webhookSecret } from "./webhook-fixtures.ts";

// Configuration is a public startup contract; malformed input must fail before credentials or state are used.
test("replicated serve is explicit and validates configuration before GitHub/model access", async (t) => {
  assert.equal(parseServeOptions(["--replicated-state"]).replicatedState, true);
  const f = await fixture(t, (_body, response) => tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] }), { entrypoint: resolve("audit.ts") });
  const result = await f.start(["serve", "--replicated-state"], { env: { PRONTO_REPLICA_URL: "", PRONTO_WEBHOOK_SECRET: webhookSecret } }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PRONTO_REPLICA_URL must be/);
  assert.doesNotMatch(result.stdout, /Listening/);
});

test("ordinary serve ignores invalid replicated-state configuration and never starts the configured child", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, () => { throw new Error("No model work expected"); }, {
    entrypoint: resolve("audit.ts"), github: (req, res) => {
      assert.equal(req.url, "/github/user", "no S3 or application calls are expected");
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ login: "me" }));
    },
  });
  const run = f.start(["serve", "--port", "0"], { env: { PRONTO_WEBHOOK_SECRET: webhookSecret,
    PRONTO_REPLICA_URL: "invalid", PRONTO_LITESTREAM_BIN: "/must-not-start", PRONTO_S3_ENDPOINT: "invalid" } });
  let output = "";
  const listening = Promise.withResolvers<void>();
  run.child.stdout.on("data", (data) => { output += data; if (/Listening on/.test(output)) listening.resolve(); });
  await Promise.race([listening.promise, run.done.then((result) => { throw new Error(result.stderr); })]);
  run.child.kill("SIGTERM");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
});

test("replica configuration rejects credentials in URLs, inconsistent transport and unpinned executable paths", () => {
  const base = { PRONTO_REPLICA_URL: "s3://test-bucket/state", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "local-test", AWS_SECRET_ACCESS_KEY: "local-test",
    PRONTO_LITESTREAM_BIN: "/opt/litestream", PRONTO_STATE_DIR: "/private/state" };
  for (const value of ["s3://user:secret@test-bucket/state", "s3://test-bucket/state?region=x", "s3://test-bucket/a/../b", "s3://test-bucket/a//b", "s3://test-bucket/%2e%2e", "file:///tmp/state"]) {
    assert.throws(() => replicaConfig({ ...base, PRONTO_REPLICA_URL: value }), /PRONTO_REPLICA_URL must be/);
  }
  for (const patch of [{ AWS_REGION: "" }, { AWS_SECRET_ACCESS_KEY: "" }, { PRONTO_LITESTREAM_BIN: "litestream" },
    { AWS_PROFILE: "conflicting-profile" }, { AWS_DEFAULT_PROFILE: "conflicting-profile" },
    { PRONTO_S3_ENDPOINT: "http://user:secret@localhost:9000" }, { PRONTO_S3_PATH_STYLE: "yes" }, { PRONTO_STATE_DIR: "relative" }]) {
    assert.throws(() => replicaConfig({ ...base, ...patch }));
  }
});

test("remote repository identities cannot escape the captured root", () => {
  assert.equal(repositoryDatabasePath("/term/A", "repos/github.com/acme~demo.sqlite"), "/term/A/repos/github.com/acme~demo.sqlite");
  assert.equal(repositoryDatabasePath("/term/A", "repos/%5B%3A%3A1%5D/acme~demo.sqlite"), "/term/A/repos/%5B%3A%3A1%5D/acme~demo.sqlite", "encoded enterprise hosts stay literal path components");
  for (const relative of ["../outside.sqlite", "repos/../acme~demo.sqlite", "/repos/github.com/acme~demo.sqlite", "repos/github.com/../../escape.sqlite", "repos/github.com/x~y.sqlite/extra", "repos/github.com/x~y\\evil.sqlite"]) {
    assert.throws(() => repositoryDatabasePath("/term/A", relative), /Invalid repository database path/);
  }
});
