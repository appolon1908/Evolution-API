import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { SERVICE_TOKEN, EVOLUTION_SECRET, withServer, readback } from "./webhook-helpers.mjs";

// Loopback-only stand-in for the Evolution API (127.0.0.1, no external network).
async function withMockEvolution(fn) {
  const calls = [];
  let n = 0;
  const mock = http.createServer((req, res) => {
    calls.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: { id: `evo-msg-${++n}` } }));
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try { await fn(`http://127.0.0.1:${mock.address().port}`, calls); } finally { mock.close(); await once(mock, "close"); }
}

function sendEnv(mockBase) {
  return {
    EXTERNAL_SEND_ENABLED: "true",
    EVOLUTION_BASE_URL: mockBase,
    EVOLUTION_API_KEY: "test-evolution-key-not-real",
    EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true"
  };
}

function send(base, { headerTenant, bodyTenant } = {}) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}` };
  if (headerTenant !== undefined) headers["x-tenant-id"] = headerTenant;
  const body = {
    command_id: "11111111-1111-4111-8111-111111111111",
    correlation_id: "corr-12345678",
    idempotency_key: "idem-12345678",
    provider: "evolution",
    instance_id: "test",
    recipient: "15550000000",
    message: { type: "text", text: "test" }
  };
  if (bodyTenant !== undefined) body.tenant_id = bodyTenant;
  return fetch(base + "/internal/v1/whatsapp/transport/messages", { method: "POST", headers, body: JSON.stringify(body) });
}

test("readback: the sending tenant reads its message; another tenant gets the same 404 as an unknown id", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base) => {
      const res = await send(base, { headerTenant: "tenant-a", bodyTenant: "tenant-a" });
      assert.equal(res.status, 202);
      const id = (await res.json()).result.provider_message_id;
      assert.equal(id, "evo-msg-1");

      const own = await readback(base, id, "tenant-a");
      assert.equal(own.status, 200);
      assert.equal(own.body.state, "ACCEPTED");
      assert.equal(own.body.tenant_id, "tenant-a");

      const other = await readback(base, id, "tenant-b");
      const unknown = await readback(base, "evo-msg-does-not-exist", "tenant-b");
      assert.equal(other.status, 404);
      assert.deepEqual(other, unknown);
    });
  });
});

test("readback: missing or blank X-Tenant-ID is rejected", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base) => {
      const id = (await (await send(base, { headerTenant: "tenant-a" })).json()).result.provider_message_id;
      for (const tenant of [undefined, "", "   "]) {
        const res = await readback(base, id, tenant);
        assert.equal(res.status, 400, JSON.stringify(tenant));
        assert.equal(res.body.error.code, "tenant_id_required");
      }
    });
  });
});

test("readback: tenant binding survives webhook status updates", async () => {
  await withMockEvolution(async (mockBase) => {
    await withServer(sendEnv(mockBase), async (base) => {
      const id = (await (await send(base, { headerTenant: "tenant-a", bodyTenant: "tenant-a" })).json()).result.provider_message_id;
      const hook = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
        body: JSON.stringify({ event: "messages.update", instance: "test", data: { key: { id }, status: "DELIVERY_ACK" } })
      });
      assert.equal(hook.status, 202);
      const own = await readback(base, id, "tenant-a");
      assert.equal(own.body.state, "DELIVERED");
      assert.equal(own.body.tenant_id, "tenant-a");
      assert.equal((await readback(base, id, "tenant-b")).status, 404);
    });
  });
});

test("readback: webhook-only records (never sent here) are not readable by any tenant", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const hook = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
      body: JSON.stringify({ event: "messages.update", instance: "test", data: { key: { id: "evo.orphan" }, status: "READ" } })
    });
    assert.equal(hook.status, 202);
    assert.equal((await readback(base, "evo.orphan", "tenant-a")).status, 404);
  });
});

test("send: X-Tenant-ID is required and must agree with body tenant_id; no provider call otherwise", async () => {
  await withMockEvolution(async (mockBase, calls) => {
    await withServer(sendEnv(mockBase), async (base) => {
      const missing = await send(base, { bodyTenant: "tenant-a" });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error.code, "tenant_id_required");
      const mismatch = await send(base, { headerTenant: "tenant-a", bodyTenant: "tenant-b" });
      assert.equal(mismatch.status, 400);
      assert.equal((await mismatch.json()).error.code, "tenant_mismatch");
      const nonString = await send(base, { headerTenant: "tenant-a", bodyTenant: 42 });
      assert.equal(nonString.status, 400);
      assert.equal((await nonString.json()).error.code, "tenant_mismatch");
      assert.equal(calls.length, 0);
    });
  });
});

test("send: safe mode (external send disabled) still returns 423 regardless of tenant headers", async () => {
  await withServer({}, async (base) => {
    for (const t of [{}, { headerTenant: "tenant-a" }, { headerTenant: "tenant-a", bodyTenant: "tenant-b" }]) {
      const res = await send(base, t);
      assert.equal(res.status, 423);
      assert.equal((await res.json()).error.code, "external_send_disabled");
    }
  });
});
