import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { normalizeEvolutionWebhook } from "../src/webhooks.mjs";
import { SERVICE_TOKEN, EVOLUTION_SECRET, withServer, readback } from "./webhook-helpers.mjs";

// Upstream-shaped Evolution messages.update webhooks (R1 go-live blocker).
// Shapes from EvolutionAPI/evolution-api main (fa09d37):
// - whatsapp.baileys.service.ts L1613-1621: data = { keyId: key.id,
//   remoteJid, fromMe, participant, status, pollUpdates, instanceId }, and
//   L1652 data.messageId = Prisma row id (NOT the WhatsApp id) when DB saving
//   is on;
// - webhook.controller.ts L93-103: envelope { event, instance, data,
//   destination, date_time, sender, server_url, apikey }; no top-level id.
// All values are synthetic.

const WA_ID = "3EB0C1D2E3F4A5B6C7D8";
const DB_CUID = "clz9x8y7w0000abcdtestcuid";

export function upstreamUpdate(keyId, status, { instance = "test", instanceId = "8a1b2c3d-0000-4000-8000-000000000001", messageId = DB_CUID } = {}) {
  return {
    event: "messages.update",
    instance,
    data: {
      keyId,
      remoteJid: "15550000000@s.whatsapp.net",
      fromMe: true,
      participant: undefined,
      status,
      pollUpdates: undefined,
      instanceId,
      ...(messageId === null ? {} : { messageId })
    },
    destination: "http://127.0.0.1:9/hook",
    date_time: "2026-10-30T12:00:00.000Z",
    sender: "15550001111@s.whatsapp.net",
    server_url: "http://127.0.0.1:9",
    apikey: "test-evolution-instance-key-not-real"
  };
}

test("normalize: upstream messages.update uses data.keyId, never data.messageId", () => {
  const event = normalizeEvolutionWebhook(upstreamUpdate(WA_ID, "DELIVERY_ACK"));
  assert.equal(event.provider_message_id, WA_ID);
  assert.equal(event.provider_event_id, WA_ID);
  assert.notEqual(event.provider_message_id, DB_CUID);
  assert.equal(event.instance_id, "test");
  assert.equal(event.provider_payload.apikey, "[REDACTED]");
  assert.equal(event.provider_payload.data.messageId, DB_CUID, "the DB id is kept as payload data, not used as the id");
});

test("normalize: a body with only data.messageId has no provider message id", () => {
  const body = upstreamUpdate(undefined, "DELIVERY_ACK");
  delete body.data.keyId;
  assert.equal(normalizeEvolutionWebhook(body).provider_message_id, null);
});

test("normalize: id precedence is data.key.id, data.keyId, data.id, id", () => {
  assert.equal(normalizeEvolutionWebhook({ data: { key: { id: "a" }, keyId: "b", id: "c" }, id: "d" }).provider_message_id, "a");
  assert.equal(normalizeEvolutionWebhook({ data: { keyId: "b", id: "c", messageId: "x" }, id: "d" }).provider_message_id, "b");
  assert.equal(normalizeEvolutionWebhook({ data: { id: "c", messageId: "x" }, id: "d" }).provider_message_id, "c");
  assert.equal(normalizeEvolutionWebhook({ data: { messageId: "x" }, id: "d" }).provider_message_id, "d");
});

async function withMockEvolution(fn) {
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: { id: WA_ID, remoteJid: "15550000000@s.whatsapp.net", fromMe: true }, status: "PENDING" }));
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try { await fn(`http://127.0.0.1:${mock.address().port}`); } finally { mock.close(); await once(mock, "close"); }
}

test("http: send ack then upstream messages.update DELIVERY_ACK -> readback DELIVERED with id == keyId", async () => {
  await withMockEvolution(async (mockBase) => {
    const env = {
      EXTERNAL_SEND_ENABLED: "true",
      EVOLUTION_BASE_URL: mockBase,
      EVOLUTION_API_KEY: "test-evolution-key-not-real",
      EVOLUTION_WEBHOOK_SECRETS: JSON.stringify({ test: EVOLUTION_SECRET })
    };
    await withServer(env, async (base) => {
      const sent = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}`, "x-tenant-id": "tenant-a" },
        body: JSON.stringify({
          command_id: "11111111-1111-4111-8111-111111111111", correlation_id: "corr-12345678", idempotency_key: "idem-12345678",
          provider: "evolution", instance_id: "test", recipient: "15550000000", message: { type: "text", text: "test" }
        })
      });
      assert.equal(sent.status, 202);
      assert.equal((await sent.json()).result.provider_message_id, WA_ID);

      const hook = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
        body: JSON.stringify(upstreamUpdate(WA_ID, "DELIVERY_ACK"))
      });
      assert.equal(hook.status, 202);
      const ack = await hook.json();
      assert.equal(ack.event.provider_message_id, WA_ID);
      assert.equal(ack.duplicate, false);
      assert.equal(ack.stale, false);

      const rb = await readback(base, WA_ID, "tenant-a");
      assert.equal(rb.status, 200);
      assert.equal(rb.body.state, "DELIVERED");
      assert.equal(rb.body.provider_message_id, WA_ID);
      assert.equal((await readback(base, DB_CUID, "tenant-a")).status, 404);
    });
  });
});
