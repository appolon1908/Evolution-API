import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";
import { createMessageState } from "../src/state.mjs";
import { APP_SECRET, EVOLUTION_SECRET, SERVICE_TOKEN, sign, withServer, postMeta, readback } from "./webhook-helpers.mjs";

// Loopback-only stand-ins (127.0.0.1, no external network).
async function withLoopback(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections?.(); server.close(); await once(server, "close"); }
}

function mockEvolution() {
  let n = 0;
  return (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: { id: `evo-msg-${++n}` } }));
    });
  };
}

const FAKE = "test-secret-value-not-real";

// --- R1 nit 1: redaction fails closed past the depth limit -------------------

function nest(levels, leaf) {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = { child: v };
  return v;
}

test("redaction: an apikey nested 40 levels deep is not returned in clear", () => {
  const out = redactSecrets(nest(40, { apikey: FAKE }));
  assert.ok(!JSON.stringify(out).includes(FAKE));
  assert.ok(JSON.stringify(out).includes(REDACTED));
});

test("redaction: an over-deep array is cut, not returned in clear", () => {
  let v = [{ token: FAKE }];
  for (let i = 0; i < 40; i++) v = [v];
  assert.ok(!JSON.stringify(redactSecrets(v)).includes(FAKE));
});

test("redaction: shallow structure is unchanged by the depth cap", () => {
  const out = redactSecrets(nest(5, { status: "READ" }));
  assert.equal(out.child.child.child.child.child.status, "READ");
});

// --- R1 nit 2: whole-token key matching and JWT-shaped values ----------------

const redactedKeys = [
  "apikey", "apiKey", "APIKEY", "api_key", "api-key", "api key", "x-api-key", "API_KEY",
  "token", "access_token", "accessToken", "refresh-token", "id_token", "authToken",
  "secret", "client_secret", "clientSecret", "app-secret",
  "password", "passwd", "pwd", "pass", "user_password", "dbPass",
  "auth", "authorization", "Authorization", "proxy_auth",
  "bearer", "bearer_token",
  "jwt", "jwt_key", "jwtKey",
  "credential", "credentials", "private_key", "privateKey"
];

const keptKeys = [
  "key", "keyId", "remoteJid", "id", "status", "message_id",
  // Counters and usage figures are not credentials.
  "total_tokens", "tokens_used", "token_count", "tokenCount", "max_tokens", "prompt_tokens", "tokens",
  // Substrings that are not whole tokens.
  "author", "authority", "passport", "passed", "bypass", "keyboard", "secretary_name", "jwtish"
];

for (const k of redactedKeys) {
  test(`redaction: key ${JSON.stringify(k)} is redacted`, () => {
    assert.equal(redactSecrets({ [k]: FAKE })[k], REDACTED);
  });
}

for (const k of keptKeys) {
  test(`redaction: key ${JSON.stringify(k)} is kept`, () => {
    assert.equal(redactSecrets({ [k]: "plain-value" })[k], "plain-value");
  });
}

// Synthetic JWT shape (header {"alg":"HS256","typ":"JWT"}); not a real token.
const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LW5vdC1yZWFsIn0.c2lnbmF0dXJlLW5vdC1yZWFs";

test("redaction: JWT-shaped string values are redacted under any key, including Bearer form and in arrays", () => {
  const out = redactSecrets({ note: FAKE_JWT, header: `Bearer ${FAKE_JWT}`, list: [FAKE_JWT], deep: { x: FAKE_JWT } });
  assert.ok(!JSON.stringify(out).includes(FAKE_JWT));
  assert.equal(out.note, REDACTED);
  assert.equal(out.header, REDACTED);
});

test("redaction: dotted non-JWT strings (ids, hosts, versions) are kept", () => {
  for (const v of ["wamid.HBgLMTU1NTAwMDAwMDAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA", "s.whatsapp.net", "15550000000@s.whatsapp.net", "1.2.3", "a.b.c"]) {
    assert.equal(redactSecrets({ v }).v, v);
  }
});

// --- R1 nit 3: instance_id is trimmed at store and compare time --------------

test("scope: a send with instance_id \" inst \" is matched by a webhook for \"inst\"", async () => {
  await withLoopback(mockEvolution(), async (mockBase) => {
    await withServer({ EXTERNAL_SEND_ENABLED: "true", EVOLUTION_BASE_URL: mockBase, EVOLUTION_API_KEY: "test-evolution-key-not-real", EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET }, async (base) => {
      const sent = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}`, "x-tenant-id": "tenant-a" },
        body: JSON.stringify({ command_id: "c-1", correlation_id: "corr-1", idempotency_key: "idem-1", provider: "evolution", instance_id: " inst ", recipient: "15550000000", message: { type: "text", text: "test" } })
      });
      assert.equal(sent.status, 202);
      const id = (await sent.json()).result.provider_message_id;
      const hook = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
        body: JSON.stringify({ event: "messages.update", instance: "inst", data: { key: { id }, status: "DELIVERY_ACK" } })
      });
      const body = await hook.json();
      assert.equal(body.ignored, false);
      const own = await readback(base, id, "tenant-a");
      assert.equal(own.body.state, "DELIVERED");
      assert.equal(own.body.instance_id, "inst");
    });
  });
});

test("state: instance ids are trimmed on both sides; blank counts as absent", () => {
  const state = createMessageState({ logger: () => {} });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "t1" }, { tenantId: "a", instanceId: "inst" });
  assert.equal(state.applyEvent({ source: "evolution", provider_message_id: "t1", instance_id: "  inst\t", provider_payload: { data: { status: "READ" } } }).applied, true);
  state.rememberAccepted({ provider: "evolution", provider_message_id: "t2" }, { tenantId: "a", instanceId: "inst" });
  assert.equal(state.applyEvent({ source: "evolution", provider_message_id: "t2", instance_id: "   ", provider_payload: { data: { status: "READ" } } }).ignored, true);
});

// --- R1 nit 4: skip null-id items; bound total forward time per webhook ------

import { loadConfig } from "../src/config.mjs";

function slowMiddleware(delayMs, received) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      setTimeout(() => { if (!res.destroyed) { res.writeHead(202, { "content-type": "application/json" }); res.end("{}"); } }, delayMs);
    });
  };
}

function metaBatch(statuses) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn-test" }, statuses } }] }]
  });
}

test("meta webhook: items with no id are not forwarded and are counted as ignored", async () => {
  const received = [];
  await withLoopback(slowMiddleware(0, received), async (mw) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: mw + "/events" }, async (base) => {
      const raw = metaBatch([{ status: "delivered" }, { id: "wamid.ok", status: "delivered", timestamp: "1700000000" }, "junk"]);
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.results.length, 3);
      assert.equal(received.length, 1);
      assert.equal(JSON.parse(received[0]).provider_message_id, "wamid.ok");
      for (const i of [0, 2]) {
        assert.equal(body.results[i].ignored, true);
        assert.deepEqual(body.results[i].forward, { forwarded: false, reason: "no_provider_message_id" });
      }
      assert.equal(body.results[1].forward.forwarded, true);
    });
  });
});

test("meta webhook: a generic notification with no message/status id is not forwarded", async () => {
  const received = [];
  await withLoopback(slowMiddleware(0, received), async (mw) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: mw + "/events" }, async (base) => {
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-test", changes: [{ field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }] }] });
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.equal(res.status, 200);
      assert.equal(received.length, 0);
    });
  });
});

test("meta webhook: a batch whose forwards exceed the per-request deadline returns 503 so Meta redelivers", async () => {
  const received = [];
  await withLoopback(slowMiddleware(250, received), async (mw) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: mw + "/events", WEBHOOK_FORWARD_DEADLINE_MS: "600" }, async (base) => {
      const statuses = Array.from({ length: 10 }, (_, i) => ({ id: `wamid.slow${i}`, status: "delivered", timestamp: "1700000000" }));
      const raw = metaBatch(statuses);
      const t0 = Date.now();
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      const elapsed = Date.now() - t0;
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, "forward_deadline_exceeded");
      assert.ok(elapsed < 1500, `bounded by the deadline (took ${elapsed} ms)`);
      assert.ok(received.length < 10, "stopped forwarding at the deadline");
    });
  });
});

test("meta webhook: one hung forward is cut at the deadline, not the 10 s per-call timeout", async () => {
  const received = [];
  await withLoopback(slowMiddleware(2000, received), async (mw) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: mw + "/events", WEBHOOK_FORWARD_DEADLINE_MS: "300" }, async (base) => {
      const raw = metaBatch([{ id: "wamid.hung", status: "delivered", timestamp: "1700000000" }]);
      const t0 = Date.now();
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.equal(res.status, 503);
      assert.ok(Date.now() - t0 < 1500);
    });
  });
});

test("config: forward deadline defaults to 8000 ms and rejects invalid values", () => {
  assert.equal(loadConfig({}).webhookForwardDeadlineMs, 8000);
  assert.equal(loadConfig({ WEBHOOK_FORWARD_DEADLINE_MS: "2500" }).webhookForwardDeadlineMs, 2500);
  for (const bad of ["", "0", "-5", "abc", "1.5"]) assert.equal(loadConfig({ WEBHOOK_FORWARD_DEADLINE_MS: bad }).webhookForwardDeadlineMs, 8000, bad);
});
