import test from "node:test";
import assert from "node:assert/strict";
import { APP_SECRET, sign, metaStatusBody, withServer, postMeta, readState } from "./webhook-helpers.mjs";

// Duplicate and out-of-order provider status events (Meta webhooks may be
// redelivered and are not guaranteed to arrive in order).

test("meta webhook: duplicate delivery is acknowledged idempotently", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = metaStatusBody("wamid.dup", "delivered");
    const first = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).duplicate, false);
    const second = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicate, true);
    assert.equal((await readState(base, "wamid.dup")).body.state, "DELIVERED");
  });
});

test("meta webhook: stale out-of-order status does not regress a terminal status", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const read = metaStatusBody("wamid.order", "read", "1700000300");
    assert.equal((await postMeta(base, read, sign(APP_SECRET, read))).status, 200);
    for (const [status, ts] of [["delivered", "1700000200"], ["sent", "1700000100"]]) {
      const stale = metaStatusBody("wamid.order", status, ts);
      const res = await postMeta(base, stale, sign(APP_SECRET, stale));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).stale, true);
    }
    assert.equal((await readState(base, "wamid.order")).body.state, "READ");
  });
});

test("meta webhook: failed is terminal and later progress events do not overwrite it", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const failed = metaStatusBody("wamid.failed", "failed");
    assert.equal((await postMeta(base, failed, sign(APP_SECRET, failed))).status, 200);
    const late = metaStatusBody("wamid.failed", "delivered");
    const res = await postMeta(base, late, sign(APP_SECRET, late));
    assert.equal((await res.json()).stale, true);
    assert.equal((await readState(base, "wamid.failed")).body.state, "FAILED");
  });
});

test("meta webhook: in-order progress still advances", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    for (const status of ["sent", "delivered", "read"]) {
      const raw = metaStatusBody("wamid.progress", status);
      assert.equal((await postMeta(base, raw, sign(APP_SECRET, raw))).status, 200);
    }
    assert.equal((await readState(base, "wamid.progress")).body.state, "READ");
  });
});
