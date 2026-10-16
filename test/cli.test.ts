import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { fixture, gitCheckout, noDatabaseMigration, tool } from "./fixtures.ts";

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
  assert.match(stdout, /pronto serve \[options\] starts a webhook server/);
  assert.match(stdout, /--approve-migrations.*default: false/);
});

const prUrl = "https://github.com/acme/demo/pull/7";

const headSha = "a".repeat(40);
const review = (login: string, state: string, commit = headSha) => ({
  id: Math.floor(Math.random() * 1e9), user: { login }, body: "", state, commit_id: commit, html_url: `${prUrl}#pullrequestreview-1`,
});

async function selectionFixture(t: TestContext, labels: string[] = [], reviews: object[] = [], draft = false,
  discovery?: { head: string; url?: string; status?: number; defaultBranch?: string; state?: string }) {
  return fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { databaseMigration: noDatabaseMigration, assessments: [] });
  }, {
    entrypoint: resolve("audit.ts"),
    github: async (request, response) => {
      assert.equal(request.method, request.url === "/github/graphql" ? "POST" : "GET");
      const path = request.url!.split("?")[0];
      let data: unknown;
      if (/^\/github\/repos\/acme\/demo\/pulls\/[678]$/.test(path)) {
        data = { html_url: discovery?.url ?? `https://github.com/acme/demo/pull/${path.split("/").at(-1)}`, title: "Selected PR", body: "", merged: false, draft, labels: labels.map((name) => ({ name })), changed_files: 0,
          head: { sha: "a".repeat(40), repo: { full_name: "acme/demo" } },
          base: { sha: "b".repeat(40), repo: { full_name: "acme/demo" } } };
      } else if (path === "/github/graphql") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { variables } = JSON.parse(Buffer.concat(chunks).toString());
        if (variables.headRefName !== undefined) {
          assert.ok(discovery, "Unexpected PR discovery request");
          assert.equal(variables.owner, "acme");
          assert.equal(variables.repo, "demo");
          if (discovery.status) {
            response.writeHead(discovery.status).end("Discovery unavailable");
            return;
          }
          const [owner, branch] = discovery.head.includes(":") ? discovery.head.split(":") : [null, discovery.head];
          const candidate = { url: discovery.url ?? prUrl, state: discovery.state ?? "OPEN", headRefName: branch,
            isCrossRepository: !!owner, headRepositoryOwner: { login: owner ?? "acme" } };
          data = { data: { repository: { defaultBranchRef: { name: discovery.defaultBranch ?? "main" }, pullRequests: { nodes: [
            { ...candidate, url: "https://github.com/acme/demo/pull/6", state: "CLOSED" },
            { ...candidate, url: "https://github.com/acme/demo/pull/8", isCrossRepository: true, headRepositoryOwner: { login: "someone-else" } },
            candidate,
          ].filter((pr) => pr.headRefName === variables.headRefName) } } } };
        } else {
          data = { data: { repository: { pullRequest: { reviewThreads: {
            nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
          } } } } };
        }
      } else {
        assert.match(path, /^\/github\/repos\/acme\/demo\/(?:pulls\/[678]\/(?:comments|reviews|files)|issues\/[678]\/comments)$/);
        data = path.endsWith("/reviews") ? reviews : [];
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    },
  });
}


for (const { name, args, head = "feature/pr-inference", commands = [], repository = "", checkout = true, state = "OPEN", expectedUrl = prUrl } of [
  { name: "current branch", args: [] },
  { name: "current branch with flags only", args: ["--force", "--approve", "--approve-migrations"] },
  { name: "explicit branch and model", args: ["feature/pr-inference", "local/test", "--force"] },
  { name: "fork branch", args: ["contributor:feature/pr-inference"], head: "contributor:feature/pr-inference" },
  { name: "branch containing shell metacharacters", args: ["feature/with;$value"], head: "feature/with;$value" },
  { name: "PR number", args: ["7"] },
  { name: "prefixed PR number", args: ["#7"] },
  { name: "PR tracking ref", args: [], head: "unrelated", commands: [["config", "branch.feature/pr-inference.merge", "refs/pull/7/head"]] },
  { name: "renamed upstream branch", args: [], head: "remote-feature", commands: [
    ["config", "branch.feature/pr-inference.remote", "origin"],
    ["config", "branch.feature/pr-inference.merge", "refs/heads/remote-feature"], ["config", "push.default", "upstream"],
  ] },
  { name: "resolved push ref", args: [], head: "remote-feature", commands: [
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"],
    ["update-ref", "refs/remotes/origin/remote-feature", "HEAD"],
    ["config", "branch.feature/pr-inference.remote", "origin"],
    ["config", "remote.origin.push", "refs/heads/feature/pr-inference:refs/heads/remote-feature"],
  ] },
  { name: "fork with an upstream base", args: [], head: "contributor:feature/pr-inference", commands: [
    ["remote", "set-url", "origin", "https://github.com/contributor/demo.git"],
    ["remote", "add", "upstream", "ssh://git@github.com/acme/demo.git"],
    ["config", "branch.feature/pr-inference.remote", "origin"],
  ] },
  { name: "branch pushRemote before remote pushDefault", args: [], head: "contributor:feature/pr-inference", commands: [
    ["remote", "add", "fork", "https://github.com/contributor/demo.git"],
    ["config", "remote.pushDefault", "origin"], ["config", "branch.feature/pr-inference.pushRemote", "fork"],
  ] },
  { name: "remote pushDefault before tracking remote", args: [], head: "contributor:feature/pr-inference", commands: [
    ["remote", "add", "fork", "https://github.com/contributor/demo.git"],
    ["config", "branch.feature/pr-inference.remote", "origin"], ["config", "remote.pushDefault", "fork"],
  ] },
  { name: "local pushRemote falls back to the tracking remote", args: [], head: "contributor:feature/pr-inference", commands: [
    ["remote", "add", "fork", "https://github.com/contributor/demo.git"],
    ["config", "branch.feature/pr-inference.pushRemote", "."], ["config", "branch.feature/pr-inference.remote", "fork"],
  ] },
  { name: "URL-valued pushRemote", args: [], head: "contributor:feature/pr-inference", commands: [
    ["config", "branch.feature/pr-inference.pushRemote", "git@github.com:contributor/demo.git"],
  ] },
  { name: "explicit branch without inheriting the current branch's fork owner", args: ["feature/pr-inference"], commands: [
    ["remote", "add", "fork", "https://github.com/contributor/demo.git"], ["config", "branch.feature/pr-inference.pushRemote", "fork"],
  ] },
  { name: "github remote before origin", args: ["7"], commands: [
    ["remote", "set-url", "origin", "https://github.com/contributor/demo.git"], ["remote", "add", "github", "https://github.com/acme/demo.git"],
  ] },
  { name: "newest matching closed PR without an open PR", args: ["feature/pr-inference"], state: "CLOSED", expectedUrl: "https://github.com/acme/demo/pull/6" },
  { name: "configured default repository", args: ["7"], commands: [
    ["remote", "add", "upstream", "https://github.com/someone-else/demo.git"], ["config", "remote.origin.gh-resolved", "base"],
  ] },
  { name: "configured repository without its own remote", args: ["7"], commands: [
    ["remote", "set-url", "origin", "https://github.com/contributor/demo.git"], ["config", "remote.origin.gh-resolved", "acme/demo"],
  ] },
  { name: "GH_REPO number without a checkout", args: ["7"], repository: "acme/demo", checkout: false },
  { name: "GH_REPO branch without a checkout", args: ["feature/pr-inference"], repository: "github.com/acme/demo", checkout: false },
]) {
  test(`CLI resolves ${name} without gh`, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t, [], [], false, { head, state });
    const env = checkout ? await gitCheckout(f.cwd, commands) : { PATH: f.cwd, GH_HOST: "" };
    const output = await f.run("", args, { env: { ...env, GH_REPO: repository } });
    assert.match(output, /PR title: Selected PR/);
    assert.ok(output.includes(expectedUrl), "the report must audit the selected PR");
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

for (const { name, args = [] as string[], head = "unrelated", commands = [], discovery = {}, message } of [
  { name: "no matching PR", message: /No pull requests found for branch "feature\/pr-inference"/ },
  { name: "closed PR on the default branch", args: ["main"], head: "main", discovery: { state: "CLOSED" }, message: /No pull requests found for branch "main"/ },
  { name: "detached HEAD", commands: [
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial"],
    ["checkout", "--detach"],
  ], message: /not on any branch.*detached HEAD/ },
  { name: "no GitHub remotes", commands: [["remote", "remove", "origin"]], message: /No GitHub remote found/ },
  { name: "unsupported remote host", commands: [["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]], message: /No GitHub remote found/ },
  { name: "GitHub lookup failure", head: "feature/pr-inference", discovery: { status: 401 }, message: /GitHub request failed \(401\)/ },
  { name: "invalid URL returned by GitHub", head: "feature/pr-inference", discovery: { url: "https://github.com/acme/demo/issues/7" }, message: /Expected a GitHub PR URL/ },
  { name: "unsafe PR number", args: ["9007199254740992"], message: /positive, safe PR number/ },
]) {
  test(`CLI stops before model or audit storage for ${name}`, { timeout: 20_000 }, async (t) => {
    const f = await selectionFixture(t, [], [], false, { head, ...discovery });
    const env = await gitCheckout(f.cwd, commands);
    const { child, done } = f.start(args, { env });
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
  });
}

for (const { name, args, message } of [
  { name: "missing git", args: [], message: /Git is required.*GitHub PR URL/ },
  { name: "malformed explicit URL", args: ["https://github.com/acme/demo/issues/7"], message: /Expected a GitHub PR URL/ },
  { name: "missing skip label", args: [prUrl, "--skip"], message: /--skip requires a non-empty label/ },
  { name: "empty skip label", args: [prUrl, "--skip", ""], message: /--skip requires a non-empty label/ },
  { name: "blank inline skip label", args: [prUrl, "--skip=  "], message: /--skip requires a non-empty label/ },
  { name: "an option instead of a skip label", args: [prUrl, "--skip", "--force"], message: /--skip requires a non-empty label/ },
  { name: "an invalid --skip-approved value", args: [prUrl, "--skip-approved=maybe"], message: /--skip-approved must be true or false/ },
  { name: "a repeated --skip-approved", args: [prUrl, "--skip-approved", "--skip-approved=false"], message: /--skip-approved can be supplied only once/ },
  { name: "an invalid --skip-drafts value", args: [prUrl, "--skip-drafts=maybe"], message: /--skip-drafts must be true or false/ },
  { name: "a repeated --skip-drafts", args: [prUrl, "--skip-drafts", "--skip-drafts=false"], message: /--skip-drafts can be supplied only once/ },
  { name: "missing batch target", args: ["--pr"], message: /--pr requires a non-empty target/ },
  { name: "blank batch target", args: ["--pr=  "], message: /--pr requires a non-empty target/ },
  { name: "an option instead of a batch target", args: ["--pr", "--force"], message: /--pr requires a non-empty target/ },
  { name: "a malformed URL later in a batch", args: ["--pr", prUrl, "--pr", "https://github.com/acme/demo/issues/8"], message: /Expected a GitHub PR URL/ },
  { name: "mixed positional and batch PR targets", args: ["--pr", prUrl, "8"], message: /Use --pr for every target/ },
  { name: "duplicate canonical PR targets", args: ["--pr", prUrl, "--pr", "https://github.com/ACME/demo/pull/7/"], message: /Duplicate PR target/ },
]) {
  test(`CLI stops before model or audit storage for ${name}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, () => assert.fail("Selection failures must not reach the model"), {
      entrypoint: resolve("audit.ts"),
      github: () => assert.fail("Selection failures must not fetch audit evidence"),
    });
    const { child, done } = f.start(args, { env: { PATH: f.cwd } });
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
  });
}
