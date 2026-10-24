// External environment control for real-process election replays. No production hooks.
// Only the parent JS process is affected; RustFS and stock Litestream use real clocks.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";

const file = process.env.PRONTO_TEST_CLOCK;
if (!file) throw new Error("Controlled clock requires PRONTO_TEST_CLOCK");
const read = () => JSON.parse(readFileSync(file, "utf8"));
const poll = globalThis.setInterval;
mock.timers.enable({ apis: ["setInterval"] });
Date.now = () => read().wall;
Object.defineProperty(performance, "now", { value: () => read().mono });
// Poll with the real timer. Advancing this counter explicitly delivers queued
// interval callbacks; leaving it unchanged represents delayed renewal timers.
let delivered = 0;
poll(() => {
  const next = read().intervals ?? 0;
  if (next < delivered) throw new Error("Interval time cannot go backwards");
  if (next > delivered) { const delta = next - delivered; delivered = next; mock.timers.tick(delta); }
}, 10).unref();
