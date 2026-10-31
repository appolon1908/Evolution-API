import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";

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
