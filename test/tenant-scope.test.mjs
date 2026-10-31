import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createMessageState } from "../src/state.mjs";
import { APP_SECRET, EVOLUTION_SECRET, SERVICE_TOKEN, sign, metaStatusBody, withServer, postMeta, readback } from "./webhook-helpers.mjs";

// Loopback-only stand-in for the Evolution API (127.0.0.1, no external network).
async function withMockEvolution(fn) {
  const received = [];
  let n = 0;
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: { id: `evo-msg-${++n}` } }));
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try { await fn(`http://127.0.0.1:${mock.address().port}`, received); } finally { mock.close(); await once(mock, "close"); }
}

function sendEnv(mockBase, extra = {}) {
  return {
    EXTERNAL_SEND_ENABLED: "true",
    EVOLUTION_BASE_URL: mockBase,
    EVOLUTION_API_KEY: "test-evolution-key-not-real",
    EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET,
    META_APP_SECRET: APP_SECRET,
    ...extra
  };
}

async function sendEvolution(base, tenant, instance = "inst-a") {
  const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}`, "x-tenant-id": tenant },
    body: JSON.stringify({
      command_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: "corr-12345678",
      idempotency_key: "idem-12345678",
      provider: "evolution",
      instance_id: instance,
      recipient: "15550000000",
      message: { type: "text", text: "test" }
    })
  });
  assert.equal(res.status, 202);
  return (await res.json()).result.provider_message_id;
}

export function postEvolution(base, body) {
  return fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

// --- (a) tenant / provider / instance scoping ------------------------------

test("scope: a Meta status for an Evolution-sent id does not change the tenant's message", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base, _state, logs) => {
      const id = await sendEvolution(base, "tenant-a");
      const raw = metaStatusBody(id, "failed");
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.ok(res.status < 300);
      const body = await res.json();
      assert.equal(body.ignored, true);
      assert.equal(body.duplicate, false);
      const own = await readback(base, id, "tenant-a");
      assert.equal(own.body.state, "ACCEPTED");
      assert.equal(own.body.provider, "evolution");
      const warn = logs.find((l) => l.event === "webhook_scope_mismatch");
      assert.ok(warn, "mismatch is logged");
      assert.equal(warn.reason, "provider_mismatch");
      assert.ok(!JSON.stringify(logs).includes(APP_SECRET));
    });
  });
});

test("scope: an Evolution webhook from another instance does not change the tenant's message", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base, _state, logs) => {
      const id = await sendEvolution(base, "tenant-a", "inst-a");
      const res = await postEvolution(base, { event: "messages.update", instance: "inst-other", data: { key: { id }, status: "READ" } });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.ignored, true);
      assert.equal((await readback(base, id, "tenant-a")).body.state, "ACCEPTED");
      assert.equal(logs.find((l) => l.event === "webhook_scope_mismatch")?.reason, "instance_mismatch");
      // The matching instance still advances it.
      const ok = await postEvolution(base, { event: "messages.update", instance: "inst-a", data: { key: { id }, status: "READ" } });
      assert.equal((await ok.json()).ignored, false);
      assert.equal((await readback(base, id, "tenant-a")).body.state, "READ");
    });
  });
});

test("scope: an Evolution webhook with no instance cannot change an instance-bound message", () => {
  const state = createMessageState({ logger: () => {} });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "x" }, { tenantId: "a", instanceId: "inst-a" });
  const r = state.applyEvent({ source: "evolution", provider_message_id: "x", instance_id: null, provider_payload: { data: { status: "READ" } } });
  assert.equal(r.ignored, true);
  assert.equal(state.get("x").state, "ACCEPTED");
});

test("state: rememberAccepted with a different tenant does not rebind (first binder wins, logged)", () => {
  const logs = [];
  const state = createMessageState({ logger: (e) => logs.push(e) });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "x" }, { tenantId: "a", instanceId: "i" });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "x" }, { tenantId: "b", instanceId: "i" });
  assert.ok(state.getForTenant("x", "a"));
  assert.equal(state.getForTenant("x", "b"), null);
  assert.equal(logs.find((l) => l.event === "send_binding_conflict")?.reason, "tenant_already_bound");
});

test("state: a tenantless webhook-first record from the same provider/instance is bound by the later send", () => {
  const state = createMessageState({ logger: () => {} });
  state.applyEvent({ source: "evolution", provider_message_id: "y", instance_id: "i", provider_payload: { data: { status: "DELIVERY_ACK" } } });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "y" }, { tenantId: "a", instanceId: "i" });
  const rec = state.getForTenant("y", "a");
  assert.equal(rec.state, "DELIVERED");
  assert.equal(rec.tenant_id, "a");
});

test("state: a tenantless webhook-first record from another provider does not leak its state into the send", () => {
  const state = createMessageState({ logger: () => {} });
  state.applyEvent({ source: "meta", provider_message_id: "z", instance_id: "pn", provider_payload: { entry: [{ changes: [{ value: { statuses: [{ status: "failed" }] } }] }] } });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "z" }, { tenantId: "a", instanceId: "i" });
  const rec = state.getForTenant("z", "a");
  assert.equal(rec.state, "ACCEPTED");
  assert.equal(rec.provider, "evolution");
});

test("state: READ cannot become FAILED; FAILED cannot become READ", () => {
  const state = createMessageState({ logger: () => {} });
  const ev = (id, status) => ({ source: "evolution", provider_message_id: id, instance_id: "i", provider_payload: { data: { status } } });
  state.applyEvent(ev("r", "READ"));
  assert.equal(state.applyEvent(ev("r", "ERROR")).stale, true);
  assert.equal(state.get("r").state, "READ");
  state.applyEvent(ev("f", "ERROR"));
  assert.equal(state.applyEvent(ev("f", "READ")).stale, true);
  assert.equal(state.get("f").state, "FAILED");
});
