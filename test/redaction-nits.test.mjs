import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, summarizeMetaSkips, normalizeEvolutionWebhook, normalizeMetaWebhookEvents, REDACTED } from "../src/webhooks.mjs";

// R1 verdict-v3 remaining redaction nits. All values are synthetic.

const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LW5vdC1yZWFsIn0.c2lnbmF0dXJlLW5vdC1yZWFs";
const BASIC = "Basic " + Buffer.from("test-user:test-pass-not-real").toString("base64");

test("redaction nits: Basic and Token authorization-style values are redacted", () => {
  const values = {
    basic: BASIC,
    basicLower: BASIC.replace("Basic", "basic"),
    basicColon: BASIC.replace("Basic ", "Basic: "),
    basicShort: "Basic dXNlcjpwYXNz",
    token: "Token abcdefghijkl",
    tokenUpper: "TOKEN test-opaque-not-real",
    tokenColon: "token: test-opaque-not-real"
  };
  const out = redactSecrets(values);
  for (const k of Object.keys(values)) assert.equal(out[k], REDACTED, k);
});

test("redaction nits: ordinary text that starts with Basic or Token is kept", () => {
  for (const v of ["Basic plan", "Basic shipping", "Basic", "Token", "Token required for access", "Basic auth is not supported", "basic info please"]) {
    assert.equal(redactSecrets({ text: v }).text, v, v);
  }
});

test("redaction nits: credential query parameters inside URLs are redacted in place", () => {
  const cases = [
    ["https://graph.example.test/v1/media?access_token=test-not-real&id=123", "https://graph.example.test/v1/media?access_token=[REDACTED]&id=123"],
    ["https://h.example.test/cb?id=1&apikey=test-not-real", "https://h.example.test/cb?id=1&apikey=[REDACTED]"],
    ["https://h.example.test/cb?x=1&client_secret=s3cr3t#frag", "https://h.example.test/cb?x=1&client_secret=[REDACTED]#frag"],
    ["see https://h.example.test/?token=abc123 now", "see https://h.example.test/?token=[REDACTED] now"],
    ["https://h.example.test/?sig=1&signature=abc&password=pw", "https://h.example.test/?sig=1&signature=[REDACTED]&password=[REDACTED]"]
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets({ url: input }).url, expected, input);
});

test("redaction nits: userinfo in URLs is redacted in place", () => {
  const cases = [
    ["https://u:p@host.example.test/path", "https://[REDACTED]@host.example.test/path"],
    ["postgres://svc:test-not-real@db.example.test:5432/x", "postgres://[REDACTED]@db.example.test:5432/x"],
    ["fetch https://tok-not-real@host.example.test/ please", "fetch https://[REDACTED]@host.example.test/ please"]
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets({ server_url: input }).server_url, expected, input);
});

test("redaction nits: URLs without credentials, emails and JIDs are untouched", () => {
  for (const v of [
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=456&hash=ATtest",
    "https://evolution.example.test/instance?id=inst-1&page=2",
    "https://mmg.whatsapp.net/v/t62/abc.enc?ccb=11-4&oh=01_test&oe=6700",
    "15550000000@s.whatsapp.net",
    "someone@example.test",
    "token_count=5"
  ]) {
    assert.equal(redactSecrets({ v }).v, v, v);
  }
});

test("redaction nits: Baileys mediaKey is redacted; other media fields are kept", () => {
  const out = redactSecrets({ imageMessage: { mediaKey: "dGVzdC1tZWRpYS1rZXktbm90LXJlYWw=", media_key: "x-not-real", mediaKeyTimestamp: "1700000000", mimetype: "image/jpeg", fileSha256: "abc=", url: "https://mmg.whatsapp.net/x.enc" } });
  assert.equal(out.imageMessage.mediaKey, REDACTED);
  assert.equal(out.imageMessage.media_key, REDACTED);
  assert.equal(out.imageMessage.mediaKeyTimestamp, "1700000000");
  assert.equal(out.imageMessage.mimetype, "image/jpeg");
  assert.equal(out.imageMessage.fileSha256, "abc=");
  assert.equal(out.imageMessage.url, "https://mmg.whatsapp.net/x.enc");
});

test("redaction nits: plural sessions is redacted like session; session metadata kept", () => {
  assert.equal(redactSecrets({ sessions: "x-not-real" }).sessions, REDACTED);
  assert.equal(redactSecrets({ sessions_total: "3" }).sessions_total, "3");
  assert.equal(redactSecrets({ session_count: "3" }).session_count, "3");
});

test("redaction nits: a JWT right after an underscore is redacted", () => {
  assert.equal(redactSecrets({ v: `x_${FAKE_JWT}` }).v, REDACTED);
  assert.equal(redactSecrets({ v: "honeyJar.abcdef.ghijkl" }).v, "honeyJar.abcdef.ghijkl");
});

test("redaction nits: Middleware-needed fields survive in Evolution and Meta payloads", () => {
  const evo = normalizeEvolutionWebhook({
    event: "messages.update", instance: "inst-1", date_time: "2026-10-30T00:00:00Z",
    command_id: "11111111-1111-4111-8111-111111111111", correlation_id: "corr-12345678", idempotency_key: "idem-12345678",
    apikey: "test-not-real",
    data: { key: { id: "evo.keep", remoteJid: "15550000000@s.whatsapp.net", fromMe: true }, status: "READ", messageTimestamp: 1700000000 }
  });
  const p = evo.provider_payload;
  assert.equal(p.apikey, REDACTED);
  assert.equal(p.command_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(p.correlation_id, "corr-12345678");
  assert.equal(p.idempotency_key, "idem-12345678");
  assert.deepEqual(p.data.key, { id: "evo.keep", remoteJid: "15550000000@s.whatsapp.net", fromMe: true });
  assert.equal(p.data.status, "READ");
  assert.equal(p.data.messageTimestamp, 1700000000);
  assert.equal(p.date_time, "2026-10-30T00:00:00Z");

  const status = {
    id: "wamid.HBgLMTU1NTAwMDAwMDAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA", status: "delivered", timestamp: "1700000000", recipient_id: "15550000000",
    pricing: { billable: true, pricing_model: "CBP", category: "utility" },
    conversation: { id: "conv-1", origin: { type: "utility" }, expiration_timestamp: "1700086400" }
  };
  const [meta] = normalizeMetaWebhookEvents({
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn-test", display_phone_number: "15550001111" }, contacts: [{ wa_id: "15550000000" }], statuses: [status] } }] }]
  });
  const v = meta.provider_payload.entry[0].changes[0].value;
  assert.equal(meta.provider_message_id, status.id);
  assert.deepEqual(v.statuses[0], status);
  assert.equal(v.metadata.phone_number_id, "pn-test");
  assert.equal(v.contacts[0].wa_id, "15550000000");
});

test("skip summary: constructor and __proto__ field names are counted as own keys", () => {
  const body = JSON.parse(JSON.stringify({
    entry: [{ changes: [
      { field: "constructor", value: {} },
      { field: "__proto__", value: {} },
      { field: "__proto__", value: {} },
      { field: "toString", value: {} }
    ] }]
  }));
  const { skippedFields } = summarizeMetaSkips(body);
  assert.deepEqual(Object.keys(skippedFields).sort(), ["__proto__", "constructor", "other"]);
  assert.equal(Object.getOwnPropertyDescriptor(skippedFields, "constructor").value, 1);
  assert.equal(Object.getOwnPropertyDescriptor(skippedFields, "__proto__").value, 2);
  assert.equal(skippedFields.other, 1, "toString is not a lower-case Meta field name");
  assert.deepEqual(JSON.parse(JSON.stringify(skippedFields)), JSON.parse('{"constructor":1,"__proto__":2,"other":1}'));
});
