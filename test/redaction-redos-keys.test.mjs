import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, isSecretKey, REDACTED } from "../src/webhooks.mjs";

// R1 go-live v2 blocker: query-parameter names from free message text reach
// isSecretKey -> keyWords, whose /([A-Z]+)([A-Z][a-z])/g split was quadratic
// ("see ?" + "A" x 65536 + "=x" took 2.7 s). Long JSON keys hit the same path.

const K64 = 64 * 1024;
const M1 = 1024 * 1024;
const LIMIT_MS = 50;

function fastest(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

for (const [label, n] of [["64 KiB", K64], ["1 MiB", M1]]) {
  const caps = "A".repeat(n);
  const cases = {
    [`all-caps query name (${label})`]: () => redactSecrets({ text: "see ?" + caps + "=x" }),
    [`all-caps query name after & (${label})`]: () => redactSecrets({ text: "https://h.example.test/?a=1&" + caps + "=x" }),
    [`all-caps query name ending in Ab (${label})`]: () => redactSecrets({ text: "see ?" + caps + "Ab=x" }),
    [`all-caps JSON key (${label})`]: () => redactSecrets({ [caps]: "v" }),
    [`all-caps JSON key ending in Ab (${label})`]: () => redactSecrets({ [caps + "Ab"]: "v" }),
    [`isSecretKey on all-caps key (${label})`]: () => isSecretKey(caps + "Ab")
  };
  for (const [name, fn] of Object.entries(cases)) {
    test(`redaction is linear: ${name} under ${LIMIT_MS} ms`, () => {
      const ms = fastest(fn);
      assert.ok(ms < LIMIT_MS, `${name}: ${ms.toFixed(1)} ms`);
    });
  }
}

test("key split: acronym boundaries are unchanged", () => {
  for (const k of ["APIKey", "XMLApiKey", "JWTToken", "HTTPAuthorization", "OAuthToken", "x-API-KEY", "AWSSecretAccessKey"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ["HTTPStatus", "XMLParser", "keyId", "remoteJid", "messageTimestamp", "URLPath"]) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test("keys over 256 characters are not treated as credential keys", () => {
  assert.equal(isSecretKey("api_key_" + "x".repeat(300)), false);
  assert.equal(isSecretKey("api_key_" + "x".repeat(200)), true);
});

test("query names over 128 characters are not inspected; short credential names still are", () => {
  const long = "access_token" + "_x".repeat(70);
  assert.equal(redactSecrets({ u: `https://h.example.test/?${long}=v` }).u, `https://h.example.test/?${long}=v`);
  assert.equal(redactSecrets({ u: "https://h.example.test/?access_token=v&id=1" }).u, `https://h.example.test/?access_token=${REDACTED}&id=1`);
});
