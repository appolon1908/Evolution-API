import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// Timing assertions for the ReDoS tests. The measured call runs in a worker
// thread so a super-linear regression is cut at a hard deadline and fails
// with a clear message, instead of blocking the test process (a synchronous
// regex cannot be interrupted by node:test's own timeout).

export const LIMIT_MS = 50;
// Hard wall-clock deadline for one case (worker start + 3 runs).
export const DEADLINE_MS = 5000;
// Per-test timeout passed to node:test; a backstop above DEADLINE_MS.
export const TEST_TIMEOUT_MS = DEADLINE_MS + 2000;
export const TIMING_TEST_OPTIONS = Object.freeze({ timeout: TEST_TIMEOUT_MS });

const WEBHOOKS_URL = new URL("../src/webhooks.mjs", import.meta.url).href;

// Best of three runs, so a single scheduler hiccup does not fail the test.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then((mod) => {
  const fn = mod[workerData.fn];
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    fn(workerData.arg);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  parentPort.postMessage(best);
}, (err) => parentPort.postMessage({ error: String(err && err.stack || err) }));
`;

// Runs mod[fn](arg) from src/webhooks.mjs three times in a worker and returns
// the fastest run in ms; rejects if the worker does not finish by deadlineMs.
export function fastestInWorker(fn, arg, { deadlineMs = DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { url: WEBHOOKS_URL, fn, arg } });
    let settled = false;
    const finish = (cb) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().finally(cb);
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`exceeded the ${deadlineMs} ms deadline (likely super-linear)`))), deadlineMs);
    worker.once("message", (m) => finish(() => (typeof m === "number" ? resolve(m) : reject(new Error(m.error)))));
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => finish(() => reject(new Error(`worker exited early (${code})`))));
  });
}

export async function assertLinear(name, fn, arg, limitMs = LIMIT_MS) {
  let ms;
  try {
    ms = await fastestInWorker(fn, arg);
  } catch (err) {
    assert.fail(`${name}: ${err.message}`);
  }
  assert.ok(ms < limitMs, `${name}: ${ms.toFixed(1)} ms`);
}
