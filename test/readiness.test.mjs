import test from "node:test";
import assert from "node:assert/strict";
import { withServer, SERVICE_TOKEN } from "./webhook-helpers.mjs";

// /readyz reports not-ready for configurations under which the adapter can
// never do its job (E1 section 4); a missing Meta verify token is only a
// warning because it matters only at (re)subscription time.

async function readyz(base) {
  const res = await fetch(base + "/readyz");
  return { status: res.status, body: await res.json() };
}

for (const token of ["", "   ", "\t"]) {
  test(`readyz: not ready when ADAPTER_SERVICE_TOKEN is ${JSON.stringify(token)}`, async () => {
    await withServer({ ADAPTER_SERVICE_TOKEN: token }, async (base) => {
      const { status, body } = await readyz(base);
      assert.equal(status, 503);
      assert.equal(body.status, "not_ready");
      assert.ok(body.reasons.includes("adapter_service_token_missing"));
    });
  });
}

test("readyz: a whitespace-only ADAPTER_SERVICE_TOKEN makes internal routes 503 like an empty one", async () => {
  await withServer({ ADAPTER_SERVICE_TOKEN: "   " }, async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages/x", { headers: { authorization: "Bearer    ", "x-tenant-id": "tenant-a" } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "service_auth_not_configured");
  });
});

test("readyz: ready with a service token and safe defaults", async () => {
  await withServer({ ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.reasons, undefined);
  });
});

for (const url of ["", "  "]) {
  test(`readyz: not ready when forwarding is enabled with MIDDLEWARE_EVENT_URL=${JSON.stringify(url)}`, async () => {
    await withServer({ FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: url }, async (base) => {
      const { status, body } = await readyz(base);
      assert.equal(status, 503);
      assert.deepEqual(body.reasons, ["middleware_event_url_missing"]);
      assert.equal(body.forwarding.enabled, true);
      assert.equal(body.forwarding.event_url_configured, false);
    });
  });
}

test("readyz: forwarding enabled with an event URL is ready; disabled forwarding needs no URL", async () => {
  await withServer({ FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: "http://127.0.0.1:9/events" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 200);
    assert.equal(body.forwarding.event_url_configured, true);
  });
  await withServer({ FORWARD_EVENTS_ENABLED: "false", MIDDLEWARE_EVENT_URL: "" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 200);
    assert.equal(body.forwarding.enabled, false);
  });
});

test("readyz: several blocking reasons are all reported", async () => {
  await withServer({ ADAPTER_SERVICE_TOKEN: "", FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: "" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 503);
    assert.deepEqual([...body.reasons].sort(), ["adapter_service_token_missing", "middleware_event_url_missing"]);
  });
});

test("readyz: a missing Meta verify token is a warning, not a failure", async () => {
  await withServer({ META_APP_SECRET: "test-meta-app-secret-not-real", META_VERIFY_TOKEN: "" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.deepEqual(body.warnings, ["meta_verify_token_missing"]);
    assert.equal(body.webhooks.meta.verify_token_configured, false);
  });
  await withServer({ META_APP_SECRET: "test-meta-app-secret-not-real", META_VERIFY_TOKEN: "test-verify-token" }, async (base) => {
    const { body } = await readyz(base);
    assert.equal(body.warnings, undefined);
  });
});

test("readyz: never echoes configuration values", async () => {
  const env = { ADAPTER_SERVICE_TOKEN: "test-service-token-value", FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: "http://127.0.0.1:9/secret-path" };
  await withServer(env, async (base) => {
    const text = await (await fetch(base + "/readyz")).text();
    assert.ok(!text.includes("test-service-token-value"));
    assert.ok(!text.includes("secret-path"));
  });
});
