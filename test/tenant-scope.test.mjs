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

// --- (b) secret redaction in echo and forward --------------------------------

async function withMockMiddleware(fn) {
  const received = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try { await fn(`http://127.0.0.1:${mock.address().port}/events`, received); } finally { mock.close(); await once(mock, "close"); }
}

const FAKE_KEY = "test-upstream-apikey-not-real";

test("redaction: Evolution apikey and token-like fields are stripped from the echo and the Middleware forward", async () => {
  await withMockMiddleware(async (eventUrl, received) => {
    await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: eventUrl }, async (base) => {
      const res = await postEvolution(base, {
        event: "messages.update",
        instance: "inst-a",
        apikey: FAKE_KEY,
        server_url: "http://127.0.0.1:1",
        data: { key: { id: "evo.redact", remoteJid: "15550000000@s.whatsapp.net" }, status: "DELIVERY_ACK", accessToken: FAKE_KEY, nested: { jwt_key: FAKE_KEY, client_secret: FAKE_KEY } }
      });
      assert.equal(res.status, 202);
      const text = await res.text();
      assert.ok(!text.includes(FAKE_KEY), "echo carries no key");
      assert.equal(received.length, 1);
      assert.ok(!received[0].includes(FAKE_KEY), "forward carries no key");
      const event = JSON.parse(received[0]);
      assert.equal(event.provider_payload.apikey, "[REDACTED]");
      // Non-secret structure survives, including the message key object.
      assert.equal(event.provider_payload.data.key.id, "evo.redact");
      assert.equal(event.provider_message_id, "evo.redact");
      assert.equal(event.provider_payload.data.status, "DELIVERY_ACK");
    });
  });
});

test("redaction: token-like fields in a Meta payload are stripped too", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const body = JSON.parse(metaStatusBody("wamid.redact", "delivered"));
    body.entry[0].changes[0].value.access_token = FAKE_KEY;
    const raw = JSON.stringify(body);
    const res = await postMeta(base, raw, sign(APP_SECRET, raw));
    const text = await res.text();
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(text.includes("wamid.redact"));
  });
});

// --- (c) batched Meta webhooks -----------------------------------------------

function metaBatchBody() {
  const status = (id, s) => ({ id, status: s, timestamp: "1700000000", recipient_id: "15550000000" });
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      { id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn-test" }, statuses: [status("wamid.b1", "delivered"), status("wamid.b2", "read")] } }] },
      { id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn-test" }, statuses: [status("wamid.b3", "sent")] } }] }
    ]
  });
}

test("meta webhook: every status in every entry/change of a batch is applied and forwarded once each", async () => {
  await withMockMiddleware(async (eventUrl, received) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: eventUrl }, async (base, state) => {
      const raw = metaBatchBody();
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.ok(res.status < 300);
      const body = await res.json();
      assert.equal(body.results.length, 3);
      assert.equal(state.get("wamid.b1").state, "DELIVERED");
      assert.equal(state.get("wamid.b2").state, "READ");
      assert.equal(state.get("wamid.b3").state, "SENT");
      const forwarded = received.map((r) => JSON.parse(r));
      assert.deepEqual(forwarded.map((e) => e.provider_message_id), ["wamid.b1", "wamid.b2", "wamid.b3"]);
      // Each forwarded event carries only its own status, in the Meta envelope shape.
      for (const e of forwarded) {
        const statuses = e.provider_payload.entry[0].changes[0].value.statuses;
        assert.equal(statuses.length, 1);
        assert.equal(statuses[0].id, e.provider_message_id);
      }
    });
  });
});

// --- (d) Meta acknowledgement semantics -------------------------------------

test("meta webhook: a verified event is acknowledged with 200 (Meta retries anything else)", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = metaStatusBody("wamid.ack", "delivered");
    const res = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accepted, true);
  });
});

test("meta webhook: malformed JSON with a valid signature is acknowledged (200, not accepted), not 500", async () => {
  await withMockMiddleware(async (eventUrl, received) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: eventUrl }, async (base, _state, logs) => {
      const raw = '{"object":"whatsapp_business_account","entry":[';
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.accepted, false);
      assert.equal(body.error.code, "malformed_payload");
      assert.equal(received.length, 0, "nothing forwarded");
      assert.ok(logs.some((l) => l.event === "webhook_malformed_payload" && l.source === "meta"));
      assert.ok(!JSON.stringify(logs).includes(raw), "raw body is not logged");
    });
  });
});

test("meta webhook: malformed JSON with an invalid signature is still 401", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = "{not json";
    assert.equal((await postMeta(base, raw, sign("wrong-secret", raw))).status, 401);
  });
});

test("evolution webhook: success stays 202; malformed JSON with the right secret is 400, not 500", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET }, async (base) => {
    const ok = await postEvolution(base, { event: "messages.update", instance: "i", data: { key: { id: "evo.ack" }, status: "DELIVERY_ACK" } });
    assert.equal(ok.status, 202);
    const bad = await postEvolution(base, "{not json");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "malformed_payload");
  });
});

// --- (e) unrecognised statuses ------------------------------------------------

// PLAYED is no longer unrecognised: owner decision 2026-10-30 maps it to READ
// (see test/played.test.mjs).
test("state: unrecognised statuses (PENDING, unknown) on an ACCEPTED record are not reported as duplicate", () => {
  const state = createMessageState({ logger: () => {} });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "u" }, { tenantId: "a", instanceId: "i" });
  for (const status of ["PENDING", "SOMETHING_NEW"]) {
    const r = state.applyEvent({ source: "evolution", provider_message_id: "u", instance_id: "i", provider_payload: { data: { status } } });
    assert.deepEqual(r, { applied: false, duplicate: false, stale: false, ignored: false, unrecognized: true }, status);
  }
  assert.equal(state.get("u").state, "ACCEPTED");
});

test("state: an unrecognised status or inbound message does not create a record", () => {
  const state = createMessageState({ logger: () => {} });
  state.applyEvent({ source: "evolution", event_type: "messages.upsert", provider_message_id: "in-1", instance_id: "i", provider_payload: { event: "messages.upsert", data: { key: { id: "in-1" } } } });
  state.applyEvent({ source: "meta", event_type: "message.received", provider_message_id: "in-2", instance_id: "pn", provider_payload: { entry: [{ changes: [{ value: { messages: [{ id: "in-2" }] } }] }] } });
  assert.equal(state.get("in-1"), null);
  assert.equal(state.get("in-2"), null);
});

test("state: a Meta status object with no status field is unrecognised, not inferred from event_type", () => {
  const state = createMessageState({ logger: () => {} });
  const r = state.applyEvent({ source: "meta", event_type: "message.delivery.updated", provider_message_id: "m", instance_id: "pn", provider_payload: { entry: [{ changes: [{ value: { statuses: [{ id: "m" }] } }] }] } });
  assert.equal(r.unrecognized, true);
  assert.equal(state.get("m"), null);
});

test("evolution webhook HTTP: PENDING on a sent message reports unrecognized, not duplicate", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base) => {
      const id = await sendEvolution(base, "tenant-a", "inst-a");
      const res = await postEvolution(base, { event: "messages.update", instance: "inst-a", data: { key: { id }, status: "PENDING" } });
      const body = await res.json();
      assert.equal(body.duplicate, false);
      assert.equal(body.unrecognized, true);
      assert.equal((await readback(base, id, "tenant-a")).body.state, "ACCEPTED");
    });
  });
});

// --- (f) readback path decoding ----------------------------------------------

test("readback: malformed percent-encoding in the path returns 400, not 500", async () => {
  await withServer({}, async (base) => {
    for (const bad of ["%E0", "%", "abc%zz"]) {
      const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/" + bad, {
        headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-tenant-id": "tenant-a" }
      });
      assert.equal(res.status, 400, bad);
      assert.equal((await res.json()).error.code, "invalid_provider_message_id");
    }
  });
});
