import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function withServer(fn, env = {}) {
  const server = createApp(loadConfig({ PORT: "0", EXTERNAL_SEND_ENABLED: "false", FORWARD_EVENTS_ENABLED: "false", ADAPTER_SERVICE_TOKEN: "test-service-token", ...env }));
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

test("internal transport health requires service authentication", async () => {
  await withServer(async (base) => {
    const denied = await fetch(base + "/internal/v1/whatsapp/transport/health");
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, "service_auth_required");

    const allowed = await fetch(base + "/internal/v1/whatsapp/transport/health", {
      headers: { authorization: "Bearer test-service-token" }
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.middleware_v3_authority, true);
  });
});

test("external provider send is fail-closed by default", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-service-token",
        "x-command-id": "11111111-1111-4111-8111-111111111111",
        "x-tenant-id": "TEST_SYN",
        "x-correlation-id": "corr-12345678",
        "idempotency-key": "idem-12345678"
      },
      body: JSON.stringify({
        command_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "TEST_SYN",
        correlation_id: "corr-12345678",
        idempotency_key: "idem-12345678",
        campaign_id: "cmp-1",
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
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/not-present", { headers: { authorization: "Bearer test-service-token" } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "provider_message_not_found");
  });
});


test("transport rejects header/body mismatches before provider dispatch", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-service-token",
        "x-command-id": "11111111-1111-4111-8111-111111111111",
        "x-tenant-id": "WRONG",
        "x-correlation-id": "corr-12345678",
        "idempotency-key": "idem-12345678"
      },
      body: JSON.stringify({
        command_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "TEST_SYN",
        correlation_id: "corr-12345678",
        idempotency_key: "idem-12345678",
        campaign_id: "cmp-1",
        provider: "evolution"
      })
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "header_body_mismatch");
  });
});

test("transport rejects non-json content", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
      method: "POST",
      headers: { authorization: "Bearer test-service-token", "content-type": "text/plain" },
      body: "not-json"
    });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, "unsupported_media_type");
  });
});

test("json responses carry no-store and nosniff headers", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/healthz");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

test("readiness fails closed when internal service auth is not configured", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/readyz");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.problems.includes("service_auth_not_configured"));
  }, { ADAPTER_SERVICE_TOKEN: "" });
});
