import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { normalizeEvolutionWebhook, normalizeMetaWebhookEvents } from "../src/webhooks.mjs";
import { APP_SECRET, sign, withServer, postMeta } from "./webhook-helpers.mjs";

// R1 go-live v2 nit: the forwarded instance_id is trimmed exactly like the
// stored one (state compares trimmed ids; blank means absent).

test("normalize: Evolution instance_id is trimmed; blank or non-scalar is null", () => {
  assert.equal(normalizeEvolutionWebhook({ instance: "  inst-a \t", data: { keyId: "m" } }).instance_id, "inst-a");
  assert.equal(normalizeEvolutionWebhook({ instanceName: " inst-b ", data: { keyId: "m" } }).instance_id, "inst-b");
  assert.equal(normalizeEvolutionWebhook({ instance: "   ", data: { keyId: "m" } }).instance_id, null);
  assert.equal(normalizeEvolutionWebhook({ instance: { x: 1 }, data: { keyId: "m" } }).instance_id, null);
  assert.equal(normalizeEvolutionWebhook({ instance: 42, data: { keyId: "m" } }).instance_id, "42");
});

test("normalize: Meta instance_id (phone_number_id) is trimmed", () => {
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: " pn-1 " }, statuses: [{ id: "w1", status: "sent" }] } }] }] };
  assert.equal(normalizeMetaWebhookEvents(body)[0].instance_id, "pn-1");
});

async function withMiddleware(fn) {
  const received = [];
  const mw = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { received.push(JSON.parse(raw)); res.writeHead(202, { "content-type": "application/json" }); res.end("{}"); });
  });
  mw.listen(0, "127.0.0.1");
  await once(mw, "listening");
  try { await fn(`http://127.0.0.1:${mw.address().port}/events`, received); } finally { mw.close(); await once(mw, "close"); }
}

test("http: forwarded Evolution and Meta events carry the trimmed instance_id", async () => {
  await withMiddleware(async (url, received) => {
    const secret = "test-instance-a-secret-not-real";
    const env = { FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: url, EVOLUTION_WEBHOOK_SECRETS: JSON.stringify({ "inst-a": secret }), META_APP_SECRET: APP_SECRET };
    await withServer(env, async (base) => {
      const evo = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codestra-webhook-secret": secret },
        body: JSON.stringify({ event: "messages.update", instance: " inst-a ", data: { keyId: "m-trim", status: "DELIVERY_ACK" } })
      });
      assert.equal(evo.status, 202);
      assert.equal((await evo.json()).event.instance_id, "inst-a");
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: " pn-test " }, statuses: [{ id: "wamid.trim", status: "sent", timestamp: "1700000000" }] } }] }] });
      assert.equal((await postMeta(base, raw, sign(APP_SECRET, raw))).status, 200);
    });
    assert.deepEqual(received.map((e) => e.instance_id), ["inst-a", "pn-test"]);
  });
});
