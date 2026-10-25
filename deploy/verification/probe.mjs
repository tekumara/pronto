import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { S3Control, replicaConfig } from "/app/src/replication/s3-control.ts";
import { Litestream } from "/app/src/replication/litestream.ts";

const [action, id, expected] = process.argv.slice(2);
if (action === "deliver" || action === "refuse") {
  const body = JSON.stringify({ action: "review_requested", sender: { login: "local-verifier" },
    requested_reviewer: { login: "verification-bot" },
    pull_request: { html_url: "https://github.com/pronto/verification/pull/7", requested_reviewers: [{ login: "verification-bot" }] } });
  const response = await fetch(action === "refuse" ? "http://127.0.0.1:8080/webhook" : "http://pronto-verify:8080/webhook", {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": id,
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", process.env.PRONTO_WEBHOOK_SECRET).update(body).digest("hex")}` }, body,
  });
  const result = await response.json();
  assert.equal(response.status, action === "refuse" ? 503 : 202);
  assert.equal(result.status, action === "refuse" ? "unready" : expected);
  console.log(JSON.stringify({ delivery: id, status: response.status, outcome: result.status }));
} else if (action === "snapshot") {
  const config = replicaConfig();
  const storage = new S3Control(config);
  const root = join("/tmp", `independent-restore-${randomUUID()}`);
  try {
    const control = await storage.read();
    assert.equal(control.record.phase, "ready");
    const points = await storage.inventory(control.record.recovery);
    assert.equal(points.length, 1, "Expected the admitted repository in remote history");
    await mkdir(root);
    const child = new Litestream(config, root, `${config.prefix}/terms/${randomUUID()}`, new AbortController().signal, (error) => { throw error; });
    await child.restore(control.record.recovery, points);
    const db = new DatabaseSync(join(root, points[0].relative), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      // Find the delivery receipt in independently restored SQL data without
      // depending on Durable's private table names or document encoding.
      let receipt = false;
      const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().filter((c) => c.type === "TEXT");
        for (const column of columns) {
          if (db.prepare(`SELECT 1 AS found FROM ${quote(name)} WHERE instr(${quote(column.name)}, ?) > 0 LIMIT 1`).get(id)) receipt = true;
        }
      }
      assert.ok(receipt, "Acknowledged delivery is absent from independent remote restore");
      console.log(JSON.stringify({ owner: control.record.owner, leaseExpires: control.record.expires, recovery: control.record.recovery, points, integrity: "ok", receipt }));
    } finally { db.close(); }
  } finally { storage.close(); await rm(root, { recursive: true, force: true }); }
} else if (action === "runtime") {
  const processes = [];
  for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p))) {
    try { if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() === "litestream") processes.push(Number(pid)); } catch {}
  }
  console.log(JSON.stringify({ terms: await readdir("/state/terms"), litestreamPids: processes }));
} else if (action === "stats") {
  const response = await fetch("http://pronto-verify-fixture:8081/stats");
  console.log(JSON.stringify(await response.json()));
} else throw new Error("Unknown probe action");
