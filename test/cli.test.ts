import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { parseArgs, promisify } from "node:util";
import { fixture, noDatabaseMigration, tool } from "./fixtures.ts";

const exec = promisify(execFile);

test("npm link exposes pronto from source outside the checkout", { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = join(directory, "global");
  const source = resolve(".");
  await exec("npm", ["link", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: source,
    env: { ...process.env, npm_config_prefix: prefix, npm_config_cache: join(directory, "cache") },
  });
  assert.equal(await realpath(join(prefix, "lib", "node_modules", "pronto")), await realpath(source),
    "global installation must link to this checkout, not a copied package");
  const { stdout } = await exec(join(prefix, "bin", "pronto"), ["--help"], { cwd: directory });
  assert.match(stdout, /^Usage: pronto /m);
  assert.match(stdout, /--skip <label>/);
  assert.match(stdout, /--approve-migrations.*default: false/);
});

const prUrl = "https://github.com/acme/demo/pull/7";

async function selectionFixture(t: TestContext, labels: string[] = []) {
  return fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });
  }, {
    entrypoint: resolve("audit.ts"),
    github: (request, response) => {
      assert.equal(request.method, request.url === "/github/graphql" ? "POST" : "GET");
      const path = request.url!.split("?")[0];
      let data: unknown;
      if (path === "/github/user") {
        data = { login: "auditor" };
      } else if (path === "/github/repos/acme/demo/pulls/7") {
        data = { title: "Selected PR", body: "", merged: false, labels: labels.map((name) => ({ name })), changed_files: 0,
          head: { sha: "a".repeat(40), repo: { full_name: "acme/demo" } },
          base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } };
      } else if (path === "/github/graphql") {
        data = { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } };
      } else {
        assert.match(path, /^\/github\/repos\/acme\/demo\/(?:pulls\/7\/(?:comments|reviews|files)|issues\/7\/comments)$/);
        data = [];
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    },
  });
}

for (const { name, args, selector } of [
  { name: "current branch", args: [], selector: undefined },
  { name: "current branch with flags only", args: ["--force", "--approve", "--approve-migrations", "--sticky=false"], selector: undefined },
  { name: "explicit branch and model", args: ["feature/pr-inference", "local/test", "--force"], selector: "feature/pr-inference" },
  { name: "fork branch", args: ["contributor:feature/pr-inference"], selector: "contributor:feature/pr-inference" },
  { name: "branch containing shell metacharacters", args: ["feature/with;$value"], selector: "feature/with;$value" },
  { name: "PR number", args: ["7"], selector: "7" },
  { name: "prefixed PR number", args: ["#7"], selector: "#7" },
]) {
  test(`CLI resolves ${name} through gh`, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t);
    const receipt = join(f.cwd, "gh-call.json");
    await writeFile(join(f.cwd, "gh"), `#!${process.execPath}\n
      const { writeFileSync } = require("node:fs");
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
      process.stdout.write(${JSON.stringify(`${prUrl}\n`)});
    `, { mode: 0o700 });
    const output = await f.run("", args, { env: { PATH: `${f.cwd}${delimiter}${process.env.PATH}` } });
    assert.match(output, /PR title: Selected PR/);
    assert.ok(output.includes(prUrl), "the report must audit the URL selected by gh");
    const call = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(await realpath(call.cwd), await realpath(f.cwd), "selection must use the caller's checkout, not Pronto's source checkout");
    const { positionals } = parseArgs({ args: call.args, allowPositionals: true,
      options: { json: { type: "string" }, jq: { type: "string" } } });
    assert.deepEqual(positionals, ["pr", "view", ...(selector ? [selector] : [])],
      "omitted selectors must stay omitted so gh can use branch tracking and push configuration");
  });
}

for (const { name, labels, args } of [
  { name: "an explicit PR URL works without gh or a Git checkout", labels: [], args: [prUrl, "local/test"] },
  { name: "CLI audits when no skip label matches exactly", labels: ["skip-audit"],
    args: ["--skip", "skip", prUrl, "local/test", "--skip=other"] },
  { name: "CLI audits an unlabelled PR when skip labels are provided", labels: [],
    args: [prUrl, "--skip", "skip-audit", "--skip=other"] },
  { name: "CLI audits a labelled PR when --skip is omitted", labels: ["skip-audit"], args: [prUrl] },
]) {
  test(name, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t, labels);
    const output = await f.run("", args, { env: { PATH: f.cwd } });
    assert.match(output, /PR title: Selected PR/);
    assert.match(output, /Verdict:/);
    assert.doesNotMatch(output, /Skipping/);
    assert.ok(output.includes(prUrl));
  });
}

for (const { name, args, gh, message } of [
  { name: "no matching PR", args: [], gh: 'process.stderr.write("no pull requests found for branch \\"feature\\"\\n"); process.exit(1);', message: /no pull requests found for branch "feature"/ },
  { name: "detached HEAD", args: [], gh: 'process.stderr.write("could not determine current branch: not on any branch\\n"); process.exit(1);', message: /not on any branch/ },
  { name: "missing gh", args: [], gh: undefined, message: /gh.*required.*GitHub PR URL/ },
  { name: "invalid gh result", args: [], gh: 'process.stdout.write("https://github.com/acme/demo/issues/7\\n");', message: /Expected a GitHub PR URL/ },
  { name: "malformed explicit URL", args: ["https://github.com/acme/demo/issues/7"], gh: 'process.stderr.write("unexpected gh invocation"); process.exit(1);', message: /Expected a GitHub PR URL/ },
  { name: "missing skip label", args: [prUrl, "--skip"], gh: undefined, message: /--skip requires a non-empty label/ },
  { name: "empty skip label", args: [prUrl, "--skip", ""], gh: undefined, message: /--skip requires a non-empty label/ },
  { name: "blank inline skip label", args: [prUrl, "--skip=  "], gh: undefined, message: /--skip requires a non-empty label/ },
  { name: "an option instead of a skip label", args: [prUrl, "--skip", "--force"], gh: undefined, message: /--skip requires a non-empty label/ },
]) {
  test(`CLI stops before model or audit storage for ${name}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, () => assert.fail("Selection failures must not reach the model"), {
      entrypoint: resolve("audit.ts"),
      github: () => assert.fail("Selection failures must not fetch audit evidence"),
    });
    if (gh) await writeFile(join(f.cwd, "gh"), `#!${process.execPath}\n${gh}\n`, { mode: 0o700 });
    const { child, done } = f.start(args, { env: { PATH: f.cwd } });
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
  });
}
