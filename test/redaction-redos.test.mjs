import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";
import { assertLinear, LIMIT_MS, TIMING_TEST_OPTIONS } from "./timing-helpers.mjs";

// Redaction runs on inbound third-party text (WhatsApp messages relayed by
// Evolution or signed by Meta), so every value rule must be linear. These
// pathological 64 KiB inputs took 0.8-12 s with the old
// /^\s*bearer\s*[:\s]\s*...\s*$/ pattern.

const K64 = 64 * 1024;
const pathological = {
  "Bearer + 64K spaces": "Bearer" + " ".repeat(K64),
  "Bearer + 64K spaces + !": "Bearer" + " ".repeat(K64) + "!",
  "Bearer + 64K tabs + !": "Bearer" + "\t".repeat(K64) + "!",
  "Bearer: + 64K spaces + !": "Bearer:" + " ".repeat(K64) + "!",
  "64K spaces + Bearer + 64K spaces + !": " ".repeat(K64) + "Bearer" + " ".repeat(K64) + "!",
  "Bearer x + 64K spaces + !": "Bearer abcdefgh" + " ".repeat(K64) + "!",
  "Bearer + 64K token chars + !": "Bearer " + "a".repeat(K64) + "!",
  "64K eyJ": "eyJ".repeat(K64 / 3),
  "64K spaces": " ".repeat(K64),
  // Just under the whole-string length guard, so the pattern itself runs.
  "Bearer + 8000 spaces + !": "Bearer" + " ".repeat(8000) + "!",
  "Bearer + 8000 tabs + !": "Bearer" + "\t".repeat(8000) + "!",
  "Bearer: + 8000 spaces + !": "Bearer:" + " ".repeat(8000) + "!"
};

for (const [name, value] of Object.entries(pathological)) {
  test(`redaction is linear: ${name} under ${LIMIT_MS} ms`, TIMING_TEST_OPTIONS, () => assertLinear(name, "redactSecrets", { text: value }));
}

test("redaction: anchored Bearer rule still redacts the accepted forms", () => {
  for (const v of ["Bearer test-opaque-credential-not-real", "bearer abcdefgh", "BEARER:abcdefgh", "Bearer: abcdefgh", "Bearer\tabcdefgh", "  Bearer abcdefgh  ", "Bearer  abcdefgh"]) {
    assert.equal(redactSecrets({ v }).v, REDACTED, JSON.stringify(v));
  }
});

test("redaction: anchored Bearer rule still keeps ordinary text", () => {
  for (const v of ["Bearer", "Bearer token required", "Please send the Bearer header", "Hi, use Bearer abcdefgh? thanks", "Bearer abc", "Bearer abcdefgh\nsecond line text"]) {
    assert.equal(redactSecrets({ v }).v, v, JSON.stringify(v));
  }
});

test("redaction: an oversized single-value Bearer string is not scanned by the whole-string rule", () => {
  const v = "Bearer " + "a".repeat(9000);
  assert.equal(redactSecrets({ v }).v, v);
});
