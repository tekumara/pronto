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
  assert.match(stdout, /--skip-approved.*default: true/);
  assert.match(stdout, /--skip-drafts.*default: true/);
  assert.match(stdout, /--exclude <path>/);
  assert.match(stdout, /--approve-migrations.*default: false/);
});

const prUrl = "https://github.com/acme/demo/pull/7";

const headSha = "a".repeat(40);
const review = (login: string, state: string, commit = headSha) => ({
  id: Math.floor(Math.random() * 1e9), user: { login }, body: "", state, commit_id: commit, html_url: `${prUrl}#pullrequestreview-1`,
});

async function selectionFixture(t: TestContext, labels: string[] = [], reviews: object[] = [], draft = false) {
  return fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });
  }, {
    entrypoint: resolve("audit.ts"),
    github: (request, response) => {
      assert.equal(request.method, request.url === "/github/graphql" ? "POST" : "GET");
      const path = request.url!.split("?")[0];
      let data: unknown;
      if (path === "/github/repos/acme/demo/pulls/7") {
        data = { title: "Selected PR", body: "", merged: false, draft, labels: labels.map((name) => ({ name })), changed_files: 0,
          head: { sha: "a".repeat(40), repo: { full_name: "acme/demo" } },
          base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } };
      } else if (path === "/github/graphql") {
        data = { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } };
      } else {
        assert.match(path, /^\/github\/repos\/acme\/demo\/(?:pulls\/7\/(?:comments|reviews|files)|issues\/7\/comments)$/);
        data = path.endsWith("/reviews") ? reviews : [];
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    },
  });
}

for (const { name, args, selector } of [
  { name: "current branch", args: [], selector: undefined },
  { name: "current branch with flags only", args: ["--force", "--approve", "--approve-migrations"], selector: undefined },
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

for (const { name, labels, args, draft = false, input = "", entrypoint = resolve("audit.ts") } of [
  { name: "an explicit PR URL works without gh or a Git checkout", labels: [], args: [prUrl, "local/test"] },
  { name: "CLI audits when no skip label matches exactly", labels: ["skip-audit"],
    args: ["--skip", "skip", prUrl, "local/test", "--skip=other"] },
  { name: "CLI audits an unlabelled PR when skip labels are provided", labels: [],
    args: [prUrl, "--skip", "skip-audit", "--skip=other"] },
  { name: "CLI audits a labelled PR when --skip is omitted", labels: ["skip-audit"], args: [prUrl] },
  { name: "CLI audits a draft PR with --skip-drafts=false", labels: [], draft: true,
    args: [prUrl, "--skip-drafts=false"] },
  { name: "CLI audits a draft PR with --skip-drafts false", labels: [], draft: true,
    args: ["--skip-drafts", "false", prUrl] },
  { name: "chat audits a draft PR with --skip-drafts=false", labels: [], draft: true,
    args: [], entrypoint: resolve("agent.ts"), input: `/audit --skip-drafts=false ${prUrl}\n/quit\n` },
]) {
  test(name, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t, labels, [], draft);
    const output = await f.run(input, args, { entrypoint, env: { PATH: f.cwd } });
    assert.match(output, /PR title: Selected PR/);
    assert.match(output, /Verdict:/);
    assert.doesNotMatch(output, /Skipping/);
    assert.ok(output.includes(prUrl));
  });
}

for (const { name, reviews, args, approver } of [
  { name: "an approval of the current head", reviews: [review("auditor", "APPROVED")], args: [], approver: "auditor" },
  { name: "another reviewer's approval, even with --force --apply --approve", reviews: [review("someone-else", "APPROVED")],
    args: ["--force", "--apply", "--approve"], approver: "someone-else" },
  { name: "an approval followed by a comment-only review", reviews: [review("someone-else", "APPROVED"), review("someone-else", "COMMENTED")],
    args: ["--skip-approved=true"], approver: "someone-else" },
  { name: "an approval with --skip-approved=false", reviews: [review("someone-else", "APPROVED")], args: ["--skip-approved=false"], approver: null },
  { name: "an approval with --skip-approved false", reviews: [review("someone-else", "APPROVED")], args: ["--skip-approved", "false"], approver: null },
  { name: "another reviewer's approval", reviews: [review("someone-else", "APPROVED")], args: [], approver: "someone-else" },
  { name: "an approval of an earlier head", reviews: [review("someone-else", "APPROVED", "c".repeat(40))], args: [], approver: null },
  { name: "an approval followed by requested changes", reviews: [review("someone-else", "APPROVED"), review("someone-else", "CHANGES_REQUESTED")],
    args: [], approver: null },
  { name: "requested changes from the approver with different login casing", reviews: [review("reviewer", "APPROVED"), review("Reviewer", "CHANGES_REQUESTED")],
    args: [], approver: null },
  { name: "a dismissed approval", reviews: [review("someone-else", "APPROVED"), review("someone-else", "DISMISSED")], args: [], approver: null },
  { name: "an approval and another reviewer's requested changes", reviews: [review("someone-else", "APPROVED"), review("auditor", "CHANGES_REQUESTED")],
    args: [], approver: "someone-else" },
  { name: "one active approval after another reviewer withdraws theirs", reviews: [review("someone-else", "APPROVED"), review("auditor", "APPROVED"),
    review("auditor", "DISMISSED")], args: [], approver: "someone-else" },
  { name: "all approvals withdrawn", reviews: [review("someone-else", "APPROVED"), review("auditor", "APPROVED"),
    review("someone-else", "CHANGES_REQUESTED"), review("auditor", "DISMISSED")], args: [], approver: null },
  { name: "no reviews", reviews: [], args: [], approver: null },
]) {
  test(`CLI ${approver ? "skips" : "audits"} a PR with ${name}`, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t, [], reviews);
    const output = await f.run("", [prUrl, "local/test", ...args], { env: { PATH: f.cwd } });
    if (approver) {
      assert.ok(output.includes(`[audit] Skipping ${prUrl}: PR is already approved by ${approver} at ${headSha}.`));
      assert.doesNotMatch(output, /PR title:|Verdict:/, "an approved PR must not fetch evidence or reach the model");
    } else {
      assert.match(output, /Verdict:/);
      assert.doesNotMatch(output, /Skipping/);
    }
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
  { name: "an invalid --skip-approved value", args: [prUrl, "--skip-approved=maybe"], gh: undefined, message: /--skip-approved must be true or false/ },
  { name: "a repeated --skip-approved", args: [prUrl, "--skip-approved", "--skip-approved=false"], gh: undefined, message: /--skip-approved can be supplied only once/ },
  { name: "an invalid --skip-drafts value", args: [prUrl, "--skip-drafts=maybe"], gh: undefined, message: /--skip-drafts must be true or false/ },
  { name: "a repeated --skip-drafts", args: [prUrl, "--skip-drafts", "--skip-drafts=false"], gh: undefined, message: /--skip-drafts can be supplied only once/ },
  { name: "missing batch target", args: ["--pr"], gh: undefined, message: /--pr requires a non-empty target/ },
  { name: "blank batch target", args: ["--pr=  "], gh: undefined, message: /--pr requires a non-empty target/ },
  { name: "an option instead of a batch target", args: ["--pr", "--force"], gh: undefined, message: /--pr requires a non-empty target/ },
  { name: "a malformed URL later in a batch", args: ["--pr", prUrl, "--pr", "https://github.com/acme/demo/issues/8"], gh: undefined, message: /Expected a GitHub PR URL/ },
  { name: "mixed positional and batch PR targets", args: ["--pr", prUrl, "8"], gh: undefined, message: /Use --pr for every target/ },
  { name: "duplicate canonical PR targets", args: ["--pr", prUrl, "--pr", "https://github.com/ACME/demo/pull/7/"], gh: undefined, message: /Duplicate PR target/ },
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
