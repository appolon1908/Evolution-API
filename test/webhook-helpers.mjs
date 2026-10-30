import crypto from "node:crypto";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

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

export async function withServer(env, fn) {
  const server = createApp(loadConfig({
    PORT: "0",
    EXTERNAL_SEND_ENABLED: "false",
    FORWARD_EVENTS_ENABLED: "false",
    ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN,
    ...env
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); await once(server, "close"); }
}

export async function postMeta(base, raw, signature) {
  const headers = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return fetch(base + "/internal/v1/whatsapp/webhooks/meta", { method: "POST", headers, body: raw });
}

export async function readState(base, id) {
  const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/" + encodeURIComponent(id), {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
  });
  return { status: res.status, body: await res.json() };
}
