import crypto from "node:crypto";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMessageState } from "../src/state.mjs";

// Synthetic test-only values; never real credentials.
export const APP_SECRET = "test-meta-app-secret-not-real";
export const EVOLUTION_SECRET = "test-evolution-webhook-secret-not-real";
export const SERVICE_TOKEN = "test-service-token";

export function sign(secret, raw) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

export function metaStatusBody(id, status, timestamp = "1700000000") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-test",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "pn-test" },
          statuses: [{ id, status, timestamp, recipient_id: "15550000000" }]
        }
      }]
    }]
  });
}

// Test-side handle on each server's state, keyed by base URL. Webhook-only
// records carry no tenant and are deliberately not readable over HTTP.
const states = new Map();

export async function withServer(env, fn) {
  // Capture state logs so scope-mismatch warnings are assertable and quiet.
  const logs = [];
  const state = createMessageState({ logger: (entry) => logs.push(entry) });
  const server = createApp(loadConfig({
    PORT: "0",
    EXTERNAL_SEND_ENABLED: "false",
    FORWARD_EVENTS_ENABLED: "false",
    ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN,
    ...env
  }), { state });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  states.set(base, state);
  try { await fn(base, state, logs); } finally { states.delete(base); server.close(); await once(server, "close"); }
}

export async function postMeta(base, raw, signature) {
  const headers = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return fetch(base + "/internal/v1/whatsapp/webhooks/meta", { method: "POST", headers, body: raw });
}

export async function readState(base, id) {
  const record = states.get(base).get(id);
  return record ? { status: 200, body: record } : { status: 404, body: null };
}

export async function readback(base, id, tenantId) {
  const headers = { authorization: `Bearer ${SERVICE_TOKEN}` };
  if (tenantId !== undefined) headers["x-tenant-id"] = tenantId;
  const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/" + encodeURIComponent(id), { headers });
  return { status: res.status, body: await res.json() };
}
