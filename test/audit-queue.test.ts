import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { createAuditQueue } from "../audit-queue.ts";

const pr = (number: number, repo = "repo") => `https://github.com/owner/${repo}/pull/${number}`;

/** An audit that runs until the test settles it, recording who is running. */
function controlledAudit() {
  const started: string[] = [];
  const running: { url: string; resolve(): void; reject(error: Error): void }[] = [];
  let peak = 0;
  return {
    started,
    audit: (url: string) => new Promise<void>((resolve, reject) => {
      started.push(url);
      running.push({ url, resolve, reject });
      peak = Math.max(peak, running.length);
    }),
    get peak() { return peak; },
    get running() { return running.map(({ url }) => url); },
    async finish(url: string) {
      const index = running.findIndex((job) => job.url === url);
      assert.notEqual(index, -1, `${url} is not running`);
      running.splice(index, 1)[0]!.resolve();
      await tick();
    },
    async fail(url: string, error: Error) {
      const index = running.findIndex((job) => job.url === url);
      assert.notEqual(index, -1, `${url} is not running`);
      running.splice(index, 1)[0]!.reject(error);
      await tick();
    },
  };
}

test("starts a new request at once and reports failures without stopping the queue", async () => {
  const control = controlledAudit();
  const failures: [string, unknown][] = [];
  const queue = createAuditQueue({ concurrency: 2, audit: control.audit, onError: (url, error) => failures.push([url, error]) });
  assert.equal(queue.enqueue(pr(1)), "queued");
  assert.equal(queue.enqueue(pr(2)), "queued");
  await tick();
  assert.deepEqual(control.running, [pr(1), pr(2)]);
  const failure = new Error("model unavailable");
  await control.fail(pr(1), failure);
  assert.deepEqual(failures, [[pr(1), failure]]);
  await control.finish(pr(2));
  await queue.idle();
  // A failed PR frees its slot and can be audited again.
  assert.equal(queue.enqueue(pr(1)), "queued");
  await tick();
  assert.deepEqual(control.running, [pr(1)]);
});

test("treats an audit that throws before awaiting as a failed audit", async () => {
  const failures: unknown[] = [];
  const started: string[] = [];
  const queue = createAuditQueue({
    concurrency: 1,
    audit: (url) => { started.push(url); throw new Error("synchronous"); },
    onError: (_url, error) => failures.push((error as Error).message),
  });
  queue.enqueue(pr(1));
  queue.enqueue(pr(2));
  await queue.idle();
  assert.deepEqual(started, [pr(1), pr(2)]);
  assert.deepEqual(failures, ["synchronous", "synchronous"]);
});

test("never runs more audits than the concurrency cap and starts them in order", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 2, audit: control.audit });
  for (let number = 1; number <= 5; number++) queue.enqueue(pr(number));
  await tick();
  assert.deepEqual(control.running, [pr(1), pr(2)]);
  await control.finish(pr(2));
  assert.deepEqual(control.running, [pr(1), pr(3)]);
  await control.finish(pr(1));
  await control.finish(pr(3));
  assert.deepEqual(control.running, [pr(4), pr(5)]);
  await control.finish(pr(4));
  await control.finish(pr(5));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1), pr(2), pr(3), pr(4), pr(5)]);
  assert.equal(control.peak, 2);
});

test("coalesces a request for a PR that is already waiting", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit });
  queue.enqueue(pr(1));
  assert.equal(queue.enqueue(pr(2)), "queued");
  assert.equal(queue.enqueue(pr(2)), "coalesced");
  await control.finish(pr(1));
  await control.finish(pr(2));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1), pr(2)]);
});

test("queues a single re-run for a PR requested while it is running", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 2, audit: control.audit });
  queue.enqueue(pr(1));
  await tick();
  assert.equal(queue.enqueue(pr(1)), "rerun");
  assert.equal(queue.enqueue(pr(1)), "coalesced");
  assert.deepEqual(control.running, [pr(1)], "the same PR must never overlap itself");
  await control.finish(pr(1));
  assert.deepEqual(control.running, [pr(1)]);
  await control.finish(pr(1));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1), pr(1)]);
  // Once it settles, a new request starts fresh.
  assert.equal(queue.enqueue(pr(1)), "queued");
});

test("runs a re-run behind PRs that were already waiting", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit });
  queue.enqueue(pr(1));
  queue.enqueue(pr(2));
  queue.enqueue(pr(1));
  await control.finish(pr(1));
  await control.finish(pr(2));
  await control.finish(pr(1));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1), pr(2), pr(1)]);
});

test("re-runs a PR whose first audit failed", async () => {
  const control = controlledAudit();
  const failures: string[] = [];
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit, onError: (url) => failures.push(url) });
  queue.enqueue(pr(1));
  await tick();
  queue.enqueue(pr(1));
  await control.fail(pr(1), new Error("rate limited"));
  assert.deepEqual(control.running, [pr(1)]);
  await control.finish(pr(1));
  await queue.idle();
  assert.deepEqual(failures, [pr(1)]);
});

test("identifies a PR by repository and number, not by URL spelling", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit });
  queue.enqueue(pr(1));
  await tick();
  assert.equal(queue.enqueue("https://github.com/OWNER/Repo/pull/1/"), "rerun");
  assert.equal(queue.enqueue(pr(1, "other")), "queued", "another repository's PR 1 is a different PR");
  assert.equal(queue.enqueue(pr(2)), "queued");
  // The re-run goes behind the PRs that were already waiting.
  await control.finish(pr(1));
  await control.finish(pr(1, "other"));
  await control.finish(pr(2));
  await control.finish(pr(1));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1), pr(1, "other"), pr(2), pr(1)]);
});

test("close stops starting audits and returns the requests that never ran", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit });
  queue.enqueue(pr(1));
  queue.enqueue(pr(2));
  queue.enqueue(pr(3));
  await tick();
  queue.enqueue(pr(1));
  assert.deepEqual(queue.close().sort(), [pr(1), pr(2), pr(3)].sort(), "waiting PRs and the dropped re-run are reported");
  assert.equal(queue.enqueue(pr(4)), "closed");
  assert.deepEqual(queue.close(), [], "closing again reports nothing new");
  await control.finish(pr(1));
  await queue.idle();
  assert.deepEqual(control.started, [pr(1)], "nothing starts after close, not even the dropped re-run");
});

test("idle resolves at once when nothing is queued and when the last audit finishes", async () => {
  const control = controlledAudit();
  const queue = createAuditQueue({ concurrency: 1, audit: control.audit });
  await queue.idle();
  queue.enqueue(pr(1));
  await tick();
  let idle = false;
  void queue.idle().then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  await control.finish(pr(1));
  assert.equal(idle, true);
});

for (const concurrency of [0, -1, 1.5, Number.NaN]) {
  test(`rejects a concurrency of ${concurrency}`, () => {
    assert.throws(() => createAuditQueue({ concurrency, audit: async () => {} }), /positive integer/);
  });
}
