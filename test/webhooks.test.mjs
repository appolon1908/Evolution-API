import test from "node:test";
import assert from "node:assert/strict";
import { verifyMetaSignature, verifySharedSecret } from "../src/webhooks.mjs";
import { APP_SECRET, EVOLUTION_SECRET, sign, metaStatusBody, withServer, postMeta, readState } from "./webhook-helpers.mjs";

// --- verification helpers -------------------------------------------------

test("meta signature: missing app secret rejects (fail closed)", () => {
  const raw = Buffer.from(metaStatusBody("wamid.1", "delivered"));
  assert.equal(verifyMetaSignature(undefined, raw, sign("anything", raw)), false);
  assert.equal(verifyMetaSignature(null, raw, sign("anything", raw)), false);
});

test("meta signature: empty app secret rejects even when signed with empty key", () => {
  const raw = Buffer.from(metaStatusBody("wamid.1", "delivered"));
  assert.equal(verifyMetaSignature("", raw, sign("", raw)), false);
  assert.equal(verifyMetaSignature("", raw, undefined), false);
});

test("meta signature: valid HMAC-SHA256 over the raw body passes", () => {
  const raw = Buffer.from(metaStatusBody("wamid.1", "delivered"));
  assert.equal(verifyMetaSignature(APP_SECRET, raw, sign(APP_SECRET, raw)), true);
});

test("meta signature: invalid, malformed, or missing signature rejects", () => {
  const raw = Buffer.from(metaStatusBody("wamid.1", "delivered"));
  assert.equal(verifyMetaSignature(APP_SECRET, raw, sign("wrong-secret", raw)), false);
  assert.equal(verifyMetaSignature(APP_SECRET, raw, sign(APP_SECRET, raw).slice("sha256=".length)), false);
  assert.equal(verifyMetaSignature(APP_SECRET, raw, "sha256="), false);
  assert.equal(verifyMetaSignature(APP_SECRET, raw, undefined), false);
});

test("meta signature: tampered or re-serialized body rejects", () => {
  const raw = Buffer.from(metaStatusBody("wamid.1", "delivered"));
  const signature = sign(APP_SECRET, raw);
  const tampered = Buffer.from(metaStatusBody("wamid.1", "read"));
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8")), null, 2));
  assert.equal(verifyMetaSignature(APP_SECRET, tampered, signature), false);
  assert.equal(verifyMetaSignature(APP_SECRET, reserialized, signature), false);
});

test("shared secret: missing or empty expected secret rejects (fail closed)", () => {
  assert.equal(verifySharedSecret("", ""), false);
  assert.equal(verifySharedSecret("", "anything"), false);
  assert.equal(verifySharedSecret(undefined, "anything"), false);
  assert.equal(verifySharedSecret(EVOLUTION_SECRET, ""), false);
  assert.equal(verifySharedSecret(EVOLUTION_SECRET, "wrong"), false);
  assert.equal(verifySharedSecret(EVOLUTION_SECRET, EVOLUTION_SECRET), true);
});

// --- HTTP handlers ----------------------------------------------------------

test("meta webhook: unconfigured app secret rejects unsigned and signed requests", async () => {
  await withServer({ META_APP_SECRET: "" }, async (base) => {
    const raw = metaStatusBody("wamid.unconfigured", "delivered");
    const unsigned = await postMeta(base, raw);
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).error.code, "invalid_meta_signature");
    const emptyKeySigned = await postMeta(base, raw, sign("", raw));
    assert.equal(emptyKeySigned.status, 401);
    assert.equal((await readState(base, "wamid.unconfigured")).status, 404);
  });
});

test("meta webhook: valid raw-body signature is accepted and recorded", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = metaStatusBody("wamid.valid", "delivered");
    const res = await postMeta(base, raw, sign(APP_SECRET, raw));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, true);
    assert.equal(body.event.provider_message_id, "wamid.valid");
    const state = await readState(base, "wamid.valid");
    assert.equal(state.status, 200);
    assert.equal(state.body.state, "DELIVERED");
  });
});

test("meta webhook: invalid signature and tampered body are rejected without state change", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const raw = metaStatusBody("wamid.tamper", "delivered");
    const bad = await postMeta(base, raw, sign("wrong-secret", raw));
    assert.equal(bad.status, 401);
    const tampered = await postMeta(base, metaStatusBody("wamid.tamper", "read"), sign(APP_SECRET, raw));
    assert.equal(tampered.status, 401);
    assert.equal((await readState(base, "wamid.tamper")).status, 404);
  });
});

test("evolution webhook: unconfigured shared secret rejects (fail closed)", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: "" }, async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "messages.update", instance: "test", data: { key: { id: "evo.unconfigured" }, status: "READ" } })
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "invalid_webhook_secret");
    assert.equal((await readState(base, "evo.unconfigured")).status, 404);
  });
});

test("evolution webhook: wrong secret rejects, correct secret accepts", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const body = JSON.stringify({ event: "messages.update", instance: "test", data: { key: { id: "evo.1" }, status: "DELIVERY_ACK" } });
    const wrong = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST", headers: { "content-type": "application/json", "x-codestra-webhook-secret": "wrong" }, body
    });
    assert.equal(wrong.status, 401);
    const ok = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST", headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET }, body
    });
    assert.equal(ok.status, 202);
    assert.equal((await readState(base, "evo.1")).body.state, "DELIVERED");
  });
});
