import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifySharedSecret } from "../src/webhooks.mjs";
import { withServer } from "./webhook-helpers.mjs";

// R1 go-live v2 nit: secret length and instance existence must not be
// observable by timing. Asserted on the code path, not wall-clock: every
// check performs exactly one timingSafeEqual over two 32-byte SHA-256
// digests, whatever the inputs.

function spy() {
  const calls = [];
  const original = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return original(a, b); };
  return { calls, restore: () => { crypto.timingSafeEqual = original; } };
}

test("verifySharedSecret: one fixed-length digest compare for every input shape", () => {
  const cases = [
    ["test-secret-not-real", "test-secret-not-real", true],
    ["test-secret-not-real", "test-secret-not-reaL", false],
    ["short", "a-much-longer-presented-value-not-real", false],
    ["a-much-longer-configured-value-not-real", "x", false],
    [null, "anything", false],
    ["", "anything", false],
    [undefined, "", false],
    ["test-secret-not-real", undefined, false],
    ["test-secret-not-real", "", false],
    ["ü-multibyte", "u-multibyte", false]
  ];
  const s = spy();
  try {
    for (const [expected, actual, result] of cases) {
      s.calls.length = 0;
      assert.equal(verifySharedSecret(expected, actual), result, `${expected} / ${actual}`);
      assert.deepEqual(s.calls, [[32, 32]], `${expected} / ${actual}`);
    }
  } finally { s.restore(); }
});

test("evolution webhook: an unknown instance runs the same single digest compare as a known one", async () => {
  const env = { EVOLUTION_WEBHOOK_SECRETS: JSON.stringify({ "inst-a": "test-instance-a-secret-not-real" }) };
  await withServer(env, async (base) => {
    const post = (instance, secret) => fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codestra-webhook-secret": secret },
      body: JSON.stringify({ event: "messages.update", instance, data: { keyId: "m", status: "READ" } })
    });
    const s = spy();
    try {
      for (const [instance, secret, status] of [["inst-a", "wrong-not-real", 401], ["inst-unknown", "wrong-not-real", 401], ["inst-a", "test-instance-a-secret-not-real", 202]]) {
        s.calls.length = 0;
        const res = await post(instance, secret);
        assert.equal(res.status, status, instance);
        await res.text();
        assert.deepEqual(s.calls, [[32, 32]], instance);
      }
    } finally { s.restore(); }
  });
});
