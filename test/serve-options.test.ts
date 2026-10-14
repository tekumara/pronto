import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServeOptions } from "../serve-options.ts";

test("serve defaults to a local server that only previews", () => {
  assert.deepEqual(parseServeOptions([]), {
    selectors: [], requested: undefined, skipLabels: [], skipDrafts: true, skipApproved: true, exclude: [], force: false,
    approve: false, allowUncertain: false, approveMigrations: false, apply: false,
    port: 8080, host: "127.0.0.1", concurrency: 4, path: "/webhook",
  });
});

test("serve takes its own flags as separate or joined values", () => {
  for (const args of [
    ["--port", "9000", "--host", "0.0.0.0", "--concurrency", "2", "--webhook-path", "/hooks/github"],
    ["--port=9000", "--host=0.0.0.0", "--concurrency=2", "--webhook-path=/hooks/github"],
  ]) {
    assert.deepEqual(
      (({ port, host, concurrency, path }) => ({ port, host, concurrency, path }))(parseServeOptions(args)),
      { port: 9000, host: "0.0.0.0", concurrency: 2, path: "/hooks/github" },
    );
  }
  assert.equal(parseServeOptions(["--port", "0"]).port, 0, "0 picks a free port");
});

test("serve passes the audit flags and model through for every audit", () => {
  const options = parseServeOptions(["--port", "9000", "--skip", "wip", "--skip=do not review", "--skip-drafts=false", "--skip-approved", "false",
    "--exclude", "dist/**", "--approve", "--allow-uncertain", "--approve-migrations", "--apply", "provider/model-id", "--concurrency", "3"]);
  assert.deepEqual(options.skipLabels, ["wip", "do not review"]);
  assert.equal(options.skipDrafts, false);
  assert.equal(options.skipApproved, false);
  assert.deepEqual(options.exclude, ["dist/**"]);
  assert.deepEqual([options.approve, options.allowUncertain, options.approveMigrations, options.apply], [true, true, true, true]);
  assert.equal(options.requested, "provider/model-id");
  assert.equal(options.concurrency, 3);
  assert.deepEqual(options.selectors, []);
});

for (const [args, message] of [
  [["--force"], /--force is not supported by pronto serve.*cache/],
  [["--pr", "42"], /--pr is not supported by pronto serve/],
  [["--pr=42"], /--pr is not supported by pronto serve/],
  [["https://github.com/owner/repo/pull/42"], /takes no PR targets/],
  [["42"], /takes no PR targets/],
  [["provider/model", "extra"], /^Error: Usage: pronto serve/],
  [["--unknown"], /Unknown audit option: --unknown/],
  [["--apply", "--apply"], /--apply can be supplied only once/],
  [["--port"], /--port requires a value/],
  [["--port", "--apply"], /--port requires a value/],
  [["--port="], /--port requires a value/],
  [["--port", "80", "--port", "81"], /--port can be supplied only once/],
  [["--port", "65536"], /--port must be an integer from 0 to 65535/],
  [["--port", "-1"], /--port requires a value/],
  [["--port", "80.5"], /--port must be an integer/],
  [["--port", "http"], /--port must be an integer/],
  [["--concurrency", "0"], /--concurrency must be a positive integer/],
  [["--concurrency", "two"], /--concurrency must be a positive integer/],
  [["--host"], /--host requires a value/],
  [["--webhook-path", "webhook"], /--webhook-path must start with \//],
  [["--webhook-path", "/a b"], /--webhook-path must start with \//],
  [["--webhook-path", "/hook?x=1"], /--webhook-path must start with \//],
  [["--webhook-path", "/healthz"], /\/healthz is reserved/],
  [["--skip"], /--skip requires a non-empty label/],
] as [string[], RegExp][]) {
  test(`serve rejects ${args.join(" ")}`, () => {
    assert.throws(() => parseServeOptions(args), message);
  });
}

test("serve errors show the serve usage", () => {
  try { parseServeOptions(["--port", "x"]); assert.fail("expected an error"); } catch (error) {
    assert.match((error as Error).message, /\nUsage: pronto serve \[--port <n>\]/);
    assert.doesNotMatch((error as Error).message, /--force|--pr /);
  }
});
