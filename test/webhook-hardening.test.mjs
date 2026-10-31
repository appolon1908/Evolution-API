import test from "node:test";
import assert from "node:assert/strict";
import { verifyMetaSignature, verifySharedSecret } from "../src/webhooks.mjs";
import { APP_SECRET, EVOLUTION_SECRET, sign, metaStatusBody, withServer, postMeta } from "./webhook-helpers.mjs";

// Bypass attempts against the fail-closed webhook verification.

const raw = Buffer.from(metaStatusBody("wamid.hard", "delivered"));
const good = sign(APP_SECRET, raw);
const hex = good.slice("sha256=".length);

test("meta signature: wrong-length signatures return false without throwing", () => {
  for (const sig of ["sha256=", "sha256=ab", good.slice(0, -1), good + "0", good + good]) {
    assert.doesNotThrow(() => verifyMetaSignature(APP_SECRET, raw, sig));
    assert.equal(verifyMetaSignature(APP_SECRET, raw, sig), false, sig);
  }
  // Same character count, different byte length (multi-byte char).
  const multibyte = good.slice(0, -1) + "é";
  assert.equal(multibyte.length, good.length);
  assert.doesNotThrow(() => verifyMetaSignature(APP_SECRET, raw, multibyte));
  assert.equal(verifyMetaSignature(APP_SECRET, raw, multibyte), false);
});

test("meta signature: non-hex input of the correct length rejects", () => {
  assert.equal(verifyMetaSignature(APP_SECRET, raw, "sha256=" + "z".repeat(64)), false);
  assert.equal(verifyMetaSignature(APP_SECRET, raw, "sha256=" + "0".repeat(64)), false);
});

test("meta signature: prefix variants and non-string headers reject", () => {
  for (const sig of ["SHA256=" + hex, "sha1=" + hex, " sha256=" + hex, "sha256 =" + hex, hex, "sha256=" + hex.toUpperCase(), `${good}, ${good}`]) {
    assert.equal(verifyMetaSignature(APP_SECRET, raw, sig), false, sig);
  }
  assert.equal(verifyMetaSignature(APP_SECRET, raw, [good]), false);
  assert.equal(verifyMetaSignature(APP_SECRET, raw, good), true);
});

test("shared secret: wrong length, multi-byte and non-string values reject without throwing", () => {
  for (const actual of [EVOLUTION_SECRET.slice(0, -1), EVOLUTION_SECRET + "x", EVOLUTION_SECRET.slice(0, -1) + "é", [EVOLUTION_SECRET], null]) {
    assert.doesNotThrow(() => verifySharedSecret(EVOLUTION_SECRET, actual));
    assert.equal(verifySharedSecret(EVOLUTION_SECRET, actual), false);
  }
});

test("meta webhook HTTP: missing, wrong-length and duplicated signature headers get 401, not 500", async () => {
  await withServer({ META_APP_SECRET: APP_SECRET }, async (base) => {
    const body = raw.toString("utf8");
    for (const sig of [undefined, "sha256=ab", good + "00", "sha256=" + "z".repeat(64)]) {
      const res = await postMeta(base, body, sig);
      assert.equal(res.status, 401, String(sig));
      assert.equal((await res.json()).error.code, "invalid_meta_signature");
    }
    const dup = await fetch(base + "/internal/v1/whatsapp/webhooks/meta", {
      method: "POST",
      headers: [["content-type", "application/json"], ["x-hub-signature-256", good], ["x-hub-signature-256", good]],
      body
    });
    assert.equal(dup.status, 401);
    assert.equal((await postMeta(base, body, good)).status, 200);
  });
});

test("evolution webhook HTTP: missing header rejects when a secret is configured", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(res.status, 401);
  });
});

test("meta verify handshake: empty configured token never matches; correct token returns challenge", async () => {
  await withServer({ META_VERIFY_TOKEN: "" }, async (base) => {
    for (const q of ["hub.mode=subscribe&hub.verify_token=&hub.challenge=c", "hub.mode=subscribe&hub.challenge=c"]) {
      const res = await fetch(base + "/internal/v1/whatsapp/webhooks/meta?" + q);
      assert.equal(res.status, 403, q);
    }
  });
  await withServer({ META_VERIFY_TOKEN: "test-verify-token" }, async (base) => {
    const wrong = await fetch(base + "/internal/v1/whatsapp/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-toke&hub.challenge=c");
    assert.equal(wrong.status, 403);
    const ok = await fetch(base + "/internal/v1/whatsapp/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=c123");
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "c123");
  });
});

test("readyz: not ready when a send-configured provider has an empty webhook secret", async () => {
  const evolutionSend = { EVOLUTION_BASE_URL: "http://127.0.0.1:9", EVOLUTION_API_KEY: "test-key-not-real" };
  await withServer({ ...evolutionSend, EVOLUTION_WEBHOOK_SECRET: "" }, async (base) => {
    const res = await fetch(base + "/readyz");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "not_ready");
    assert.deepEqual(body.reasons, ["evolution_webhook_secret_missing"]);
    assert.equal(body.webhooks.evolution.configured, false);
  });
  await withServer({ ...evolutionSend, EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const res = await fetch(base + "/readyz");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");
  });
});

test("readyz: safe-mode deployment with no provider configured stays ready", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/readyz");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.webhooks.meta.configured, false);
  });
});
