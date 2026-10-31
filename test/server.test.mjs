import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function withServer(fn) {
  const server = createApp(loadConfig({ PORT: "0", EXTERNAL_SEND_ENABLED: "false", FORWARD_EVENTS_ENABLED: "false", ADAPTER_SERVICE_TOKEN: "test-service-token" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); await once(server, "close"); }
}

test("health reports Middleware V3 provider-adapter architecture", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/healthz");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.architecture, "middleware-v3-provider-adapter");
    assert.equal(body.external_send_enabled, false);
  });
});

test("external provider send is fail-closed by default", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-service-token" },
      body: JSON.stringify({
        command_id: "11111111-1111-4111-8111-111111111111",
        correlation_id: "corr-12345678",
        idempotency_key: "idem-12345678",
        provider: "evolution",
        instance_id: "test",
        recipient: "15550000000",
        message: { type: "text", text: "test" }
      })
    });
    assert.equal(res.status, 423);
    const body = await res.json();
    assert.equal(body.error.code, "external_send_disabled");
  });
});

test("internal transport requires service authentication", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/not-present");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "service_auth_required");
  });
});

test("authorized readback returns not found for unknown provider message", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/not-present", { headers: { authorization: "Bearer test-service-token", "x-tenant-id": "tenant-a" } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "provider_message_not_found");
  });
});
