import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMessageState, TENANTLESS_TTL_MS, TENANTLESS_MAX } from "../src/state.mjs";
import { normalizeEvolutionWebhook } from "../src/webhooks.mjs";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { SERVICE_TOKEN } from "./webhook-helpers.mjs";

// R1 go-live v3 follow-up: Evolution messages.update for messages the
// business received (data.fromMe === false, e.g. our read receipts) create
// tenantless records that no send ever binds. They are evicted by TTL and
// by a size cap; tenant-bound records are never touched.

const quiet = () => {};

function receiptBody(instance, keyId, status = "READ") {
  return { event: "messages.update", instance, data: { keyId, remoteJid: "15550000000@s.whatsapp.net", fromMe: false, status, instanceId: "uuid", messageId: "db-cuid" } };
}
const receipt = (instance, keyId, status) => normalizeEvolutionWebhook(receiptBody(instance, keyId, status));
const outbound = (instance, keyId, status) =>
  normalizeEvolutionWebhook({ event: "messages.update", instance, data: { keyId, remoteJid: "15550000000@s.whatsapp.net", fromMe: true, status } });

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("tenantless eviction: an inbound receipt record expires after the TTL", () => {
  const c = clock();
  const state = createMessageState({ logger: quiet, now: c.now });
  assert.equal(state.applyEvent(receipt("inst-a", "in.1")).applied, true);
  assert.equal(state.get("in.1").tenant_id, null);
  c.advance(TENANTLESS_TTL_MS - 1);
  assert.notEqual(state.get("in.1"), null);
  c.advance(1);
  assert.equal(state.get("in.1"), null);
  assert.deepEqual(state.size(), { records: 0, tenantless: 0 });
});

test("tenantless eviction: a redelivered receipt does not extend the TTL", () => {
  const c = clock();
  const state = createMessageState({ logger: quiet, now: c.now });
  state.applyEvent(receipt("inst-a", "in.r", "DELIVERY_ACK"));
  c.advance(TENANTLESS_TTL_MS / 2);
  state.applyEvent(receipt("inst-a", "in.r", "READ"));
  state.applyEvent(receipt("inst-a", "in.r", "READ"));
  c.advance(TENANTLESS_TTL_MS / 2);
  assert.equal(state.get("in.r"), null);
});

test("tenantless eviction: growth is bounded by the default cap", () => {
  const state = createMessageState({ logger: quiet });
  for (let i = 0; i < TENANTLESS_MAX * 2.5; i++) state.applyEvent(receipt("inst-a", `in.${i}`));
  assert.deepEqual(state.size(), { records: TENANTLESS_MAX, tenantless: TENANTLESS_MAX });
  // Oldest first: the earliest receipts are gone, the latest are kept.
  assert.equal(state.get("in.0"), null);
  assert.notEqual(state.get(`in.${TENANTLESS_MAX * 2.5 - 1}`), null);
});

test("tenantless eviction: tenant-bound records survive TTL and cap pressure, readback unchanged", () => {
  const c = clock();
  const state = createMessageState({ logger: quiet, now: c.now, tenantlessMax: 50 });
  for (let i = 0; i < 20; i++) {
    state.rememberAccepted({ provider: "evolution", provider_message_id: `a.${i}` }, { tenantId: "tenant-a", instanceId: "inst-a" });
    state.rememberAccepted({ provider: "evolution", provider_message_id: `b.${i}` }, { tenantId: "tenant-b", instanceId: "inst-b" });
  }
  state.applyEvent(outbound("inst-a", "a.0", "DELIVERY_ACK"));
  c.advance(TENANTLESS_TTL_MS * 10);
  for (let i = 0; i < 1000; i++) state.applyEvent(receipt(i % 2 ? "inst-a" : "inst-b", `in.${i}`));
  c.advance(TENANTLESS_TTL_MS * 10);
  // Receipts reusing tenant-bound ids from the other instance are ignored
  // and neither evict nor alter those records.
  for (let i = 0; i < 20; i++) {
    assert.equal(state.applyEvent(receipt("inst-b", `a.${i}`)).ignored, true);
    assert.equal(state.applyEvent(receipt("inst-a", `b.${i}`)).ignored, true);
  }
  assert.ok(state.size().tenantless <= 50);
  for (let i = 0; i < 20; i++) {
    assert.equal(state.getForTenant(`a.${i}`, "tenant-a").tenant_id, "tenant-a");
    assert.equal(state.getForTenant(`b.${i}`, "tenant-b").tenant_id, "tenant-b");
    assert.equal(state.getForTenant(`a.${i}`, "tenant-b"), null);
    assert.equal(state.getForTenant(`b.${i}`, "tenant-a"), null);
  }
  assert.equal(state.get("a.0").state, "DELIVERED");
  assert.equal(state.get("a.1").state, "ACCEPTED");
  assert.equal(state.get("b.0").state, "ACCEPTED");
  // Bound records still advance from their own instance.
  assert.equal(state.applyEvent(outbound("inst-a", "a.1", "READ")).applied, true);
  assert.equal(state.get("a.1").state, "READ");
});

test("tenantless eviction: a webhook-first record bound by a send leaves the eviction queue", () => {
  const c = clock();
  const state = createMessageState({ logger: quiet, now: c.now, tenantlessMax: 5 });
  state.applyEvent(outbound("inst-a", "race.1", "DELIVERY_ACK"));
  assert.deepEqual(state.size(), { records: 1, tenantless: 1 });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "race.1" }, { tenantId: "tenant-a", instanceId: "inst-a" });
  assert.deepEqual(state.size(), { records: 1, tenantless: 0 });
  c.advance(TENANTLESS_TTL_MS * 2);
  for (let i = 0; i < 100; i++) state.applyEvent(receipt("inst-a", `in.${i}`));
  const record = state.getForTenant("race.1", "tenant-a");
  assert.equal(record.state, "DELIVERED");
  assert.equal(record.tenant_id, "tenant-a");
  assert.deepEqual(state.size(), { records: 6, tenantless: 5 });
});

test("tenantless eviction: a receipt evicted before a later send does not leak into that send's record", () => {
  const c = clock();
  const state = createMessageState({ logger: quiet, now: c.now });
  state.applyEvent(receipt("inst-a", "late.1", "READ"));
  c.advance(TENANTLESS_TTL_MS);
  state.rememberAccepted({ provider: "evolution", provider_message_id: "late.1" }, { tenantId: "tenant-a", instanceId: "inst-a" });
  const record = state.getForTenant("late.1", "tenant-a");
  assert.equal(record.state, "ACCEPTED");
  assert.deepEqual(state.size(), { records: 1, tenantless: 0 });
});

test("tenantless eviction: over HTTP, fromMe=false receipts stay accepted and bounded", async () => {
  const secrets = JSON.stringify({ "inst-a": "test-inst-a-secret-not-real" });
  const state = createMessageState({ logger: quiet, tenantlessMax: 10 });
  const server = createApp(loadConfig({
    PORT: "0",
    EXTERNAL_SEND_ENABLED: "false",
    FORWARD_EVENTS_ENABLED: "false",
    ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN,
    EVOLUTION_WEBHOOK_SECRETS: secrets
  }), { state, logger: quiet });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 40; i++) {
      const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codestra-webhook-secret": "test-inst-a-secret-not-real" },
        body: JSON.stringify(receiptBody("inst-a", `in.http.${i}`))
      });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.accepted, true);
      assert.equal(body.event.provider_message_id, `in.http.${i}`);
    }
    assert.deepEqual(state.size(), { records: 10, tenantless: 10 });
  } finally {
    server.close();
    await once(server, "close");
  }
});
