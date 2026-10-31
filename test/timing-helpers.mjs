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

// Best of `runs`. Each run imports a fresh module instance, so the
// isSecretKey memo is empty at the start of every run and a regression in
// the uncached classification cannot hide behind a warm cache. `variants`
// are optional setup calls ([exportName, ...args] or null) run on each fresh
// instance; variants are interleaved run by run and the best of each is
// returned, so a comparison sees the same machine load.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { url, fn, arg, variants, runs } = workerData;
  const best = variants.map(() => Infinity);
  for (let i = 0; i < runs; i++) {
    for (let v = 0; v < variants.length; v++) {
      const mod = await import(url + "?run=" + i + "-" + v);
      if (variants[v]) mod[variants[v][0]](...variants[v].slice(1));
      const t = process.hrtime.bigint();
      mod[fn](arg);
      best[v] = Math.min(best[v], Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  parentPort.postMessage(best);
})().catch((err) => parentPort.postMessage({ error: String((err && err.stack) || err) }));
`;

// Runs mod[fn](arg) from src/webhooks.mjs in a worker and returns the best
// time in ms per variant; rejects if the worker does not finish by deadlineMs.
export function timeInWorker(fn, arg, { variants = [null], runs = 3, deadlineMs = DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { url: WEBHOOKS_URL, fn, arg, variants, runs } });
    let settled = false;
    const finish = (cb) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().finally(cb);
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`exceeded the ${deadlineMs} ms deadline (likely super-linear)`))), deadlineMs);
    worker.once("message", (m) => finish(() => (Array.isArray(m) ? resolve(m) : reject(new Error(m.error)))));
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => finish(() => reject(new Error(`worker exited early (${code})`))));
  });
}

export async function fastestInWorker(fn, arg, options = {}) {
  return (await timeInWorker(fn, arg, options))[0];
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
