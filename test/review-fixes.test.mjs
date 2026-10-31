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
    await withServer({ EXTERNAL_SEND_ENABLED: "true", EVOLUTION_BASE_URL: mockBase, EVOLUTION_API_KEY: "test-evolution-key-not-real", EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
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

// --- R1 v2 nit 2a: plurals, suffixes, mixed case, more credential words ------

const redactedKeysV3 = [
  // Plurals and numeric suffixes (v1 substring regex caught these).
  "apiKeys", "api_keys", "secrets", "passwords", "apikey1", "api_key_2", "credentials", "client_secrets",
  // Mixed case whole-token.
  "aPiKeY", "ApIkEy", "SeCrEt", "PassWord",
  // Additional credential words.
  "passphrase", "cookie", "Cookie", "set-cookie", "cookies", "signature", "x-hub-signature-256", "signatures",
  // Session: the whole key or with id/token/key/secret/cookie/data.
  "session", "sessionId", "session_id", "session-token", "sessionKey", "session_data",
  // Counter exception leaks closed.
  "access_token_used", "max_token", "total_token", "token_used_by_client", "access_tokens", "refreshTokens",
  "tokenSecret", "auth_token_count"
];

const keptKeysV3 = [
  // Counters stay readable.
  "token_count", "tokenCount", "token_limit", "tokens", "total_tokens", "tokens_used", "max_tokens", "prompt_tokens",
  // Session metadata that is not a credential.
  "session_count", "session_started_at", "sessions_total",
  // Middleware and provider fields.
  "command_id", "correlation_id", "idempotency_key", "provider_message_id", "status", "recipient_id", "wa_id",
  "phone_number_id", "conversation", "pricing", "remoteJid", "key", "keyId", "message_id", "sha256", "signed_at"
];

for (const k of redactedKeysV3) {
  test(`redaction v3: key ${JSON.stringify(k)} is redacted`, () => {
    assert.equal(redactSecrets({ [k]: FAKE })[k], REDACTED);
  });
}

for (const k of keptKeysV3) {
  test(`redaction v3: key ${JSON.stringify(k)} is kept`, () => {
    assert.equal(redactSecrets({ [k]: "plain-value" })[k], "plain-value");
  });
}

// Synthetic 5-part JWE shape (header {"alg":"dir","enc":"A256GCM"}, empty key segment); not real.
const FAKE_JWE = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYtbm90LXJlYWw.Y2lwaGVydGV4dC1ub3QtcmVhbA.dGFnLW5vdC1yZWFs";

test("redaction v3: JWTs embedded in strings, Bearer: forms, JWE and opaque Bearer values are redacted", () => {
  const values = {
    query: `token=${FAKE_JWT}&x=1`,
    hdr: `Bearer: ${FAKE_JWT}`,
    text: `see ${FAKE_JWT} here`,
    jwe: FAKE_JWE,
    jweEmbedded: `cookie-ish ${FAKE_JWE}`,
    opaque: "Bearer test-opaque-credential-not-real"
  };
  const out = redactSecrets(values);
  for (const k of Object.keys(values)) assert.equal(out[k], REDACTED, k);
});

test("redaction v3: eyJ inside a longer word is not a JWT; ordinary text is kept", () => {
  for (const v of ["honeyJar.abcdef.ghijkl", "keyJustify.aa.bb", "Bearer", "bearer of good news", "wamid.HBgLMTU1NTAwMDAwMDAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA"]) {
    assert.equal(redactSecrets({ v }).v, v, v);
  }
});

// --- R1 v2 nit 4b: skipped Meta items are counted in a secret-safe log ------

test("meta webhook: skipped items, non-message fields and value-level errors are logged as counts only, still 200", async () => {
  const received = [];
  await withLoopback(slowMiddleware(0, received), async (mw) => {
    await withServer({ META_APP_SECRET: APP_SECRET, FORWARD_EVENTS_ENABLED: "true", MIDDLEWARE_EVENT_URL: mw + "/events" }, async (base, _state, logs) => {
      const planted = "planted-detail-not-for-logs";
      const raw = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{
          id: "waba-test",
          changes: [
            { field: "messages", value: { metadata: { phone_number_id: "pn-test" }, statuses: [{ status: "delivered" }, { id: "wamid.ok4b", status: "delivered", timestamp: "1700000000" }] } },
            { field: "account_update", value: { event: "VERIFIED_ACCOUNT", detail: planted } },
            { field: "messages", value: { metadata: { phone_number_id: "pn-test" }, errors: [{ code: 131000, title: planted }, { code: 131001, message: planted }] } },
            { field: "weird field<script>", value: {} }
          ]
        }]
      });
      const res = await postMeta(base, raw, sign(APP_SECRET, raw));
      assert.equal(res.status, 200);
      assert.equal(received.length, 1);
      const line = logs.find((l) => l.event === "meta_webhook_items_skipped");
      assert.ok(line, "skip summary logged");
      assert.deepEqual(line, {
        event: "meta_webhook_items_skipped",
        source: "meta",
        no_provider_message_id: 1,
        skipped_fields: { account_update: 1, messages: 1, other: 1 },
        value_errors: 2
      });
      assert.ok(!JSON.stringify(logs).includes(planted));
    });
  });
});

test("meta webhook: a fully id-less notification is logged and acknowledged 200", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base, _state, logs) => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-test", changes: [{ field: "account_update", value: { event: "VERIFIED_ACCOUNT" } }] }] });
    const res = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(res.status, 200);
    const line = logs.find((l) => l.event === "meta_webhook_items_skipped");
    assert.equal(line.no_provider_message_id, 1);
    assert.deepEqual(line.skipped_fields, { account_update: 1 });
  });
});

test("meta webhook: nothing is logged when every item has an id", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base, _state, logs) => {
    const raw = metaBatch([{ id: "wamid.clean", status: "delivered", timestamp: "1700000000" }]);
    assert.equal((await postMeta(base, raw, sign(APP_SECRET, raw))).status, 200);
    assert.equal(logs.filter((l) => l.event === "meta_webhook_items_skipped").length, 0);
  });
});

// --- Body cap: 3 MiB on the Meta webhook route only --------------------------

const MiB = 1024 * 1024;

function metaPadded(bytes) {
  const body = JSON.parse(metaBatch([{ id: "wamid.big", status: "delivered", timestamp: "1700000000" }]));
  body.entry[0].changes[0].value.padding = "x".repeat(bytes);
  return JSON.stringify(body);
}

test("body cap: a 2 MiB signed Meta payload is accepted", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base, state) => {
    const raw = metaPadded(2 * MiB);
    const res = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(res.status, 200);
    assert.equal(state.get("wamid.big").state, "DELIVERED");
  });
});

test("body cap: a Meta payload over 3 MiB gets 413, before signature verification", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = metaPadded(3 * MiB + 1024);
    const res = await postMeta(base, raw, "sha256=" + "0".repeat(64));
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, "payload_too_large");
  });
});

test("body cap: a 2 MiB Evolution webhook body still gets 413", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
      body: JSON.stringify({ event: "messages.update", instance: "i", data: { key: { id: "evo.big" }, status: "READ" }, padding: "x".repeat(2 * MiB) })
    });
    assert.equal(res.status, 413);
  });
});

test("body cap: a 2 MiB internal send body still gets 413", async () => {
  await withServer({ EXTERNAL_SEND_ENABLED: "true" }, async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/transport/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}`, "x-tenant-id": "tenant-a" },
      body: JSON.stringify({ padding: "x".repeat(2 * MiB) })
    });
    assert.equal(res.status, 413);
  });
});

test("body cap: a 413 closes the connection so the unread body cannot poison the next request", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const big = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST", headers: { "x-codestra-webhook-secret": EVOLUTION_SECRET }, body: "x".repeat(2 * MiB)
    });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get("connection"), "close");
    await big.text();
    const next = await fetch(base + "/healthz");
    assert.equal(next.status, 200);
  });
});
