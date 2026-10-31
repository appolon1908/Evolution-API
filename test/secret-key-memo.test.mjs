import test from "node:test";
import assert from "node:assert/strict";
import { isSecretKey, redactSecrets, secretKeyCacheSize, SECRET_KEY_CACHE_MAX, REDACTED } from "../src/webhooks.mjs";
import { timeInWorker, TIMING_TEST_OPTIONS } from "./timing-helpers.mjs";

// R1 go-live v3 nit: isSecretKey is memoized per name with a bounded cache.
// Memoization must not change any result.

const CORPUS = [
  "apikey", "apiKey", "api_key", "API_KEY", "x-api-key", "aPiKeY", "apikey1", "APIKey", "XMLApiKey", "JWTToken",
  "HTTPAuthorization", "OAuthToken", "x-API-KEY", "AWSSecretAccessKey", "private_key", "privateKeys", "access_token",
  "hub.verify_token", "refreshTokens", "access_token_used", "token_used_by_client", "token", "tokens", "token_count",
  "tokenCount", "token_limit", "max_token", "total_token", "total_tokens", "tokens_used", "max_tokens", "prompt_tokens",
  "session", "sessions", "sessionId", "session_data", "session_count", "session_started_at", "password", "passwords",
  "client_secret", "Authorization", "cookie", "x-hub-signature-256", "mediaKey", "media_key", "mediaKeyTimestamp",
  "author", "passport", "keyboard", "secretary", "keyId", "key", "sha256", "remoteJid", "messageTimestamp", "HTTPStatus",
  "XMLParser", "URLPath", "id", "", " ", "_", "123", "api_key_" + "x".repeat(200), "api_key_" + "x".repeat(300), "é_token"
];

// A fresh module instance has an empty cache, so its first call per name is
// the uncached classification.
async function coldResults() {
  const fresh = await import(`../src/webhooks.mjs?cold=${Math.random()}`);
  return CORPUS.map((k) => fresh.isSecretKey(k));
}

test("memoized isSecretKey: warm results equal cold results", async () => {
  const cold = await coldResults();
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(CORPUS.map((k) => isSecretKey(k)), cold, `round ${round}`);
  }
  // Non-string keys are classified by their string form, cached or not.
  assert.equal(isSecretKey(123), isSecretKey("123"));
  assert.equal(isSecretKey(123), false);
});

test("memoized isSecretKey: cache is bounded and eviction keeps results correct", async () => {
  const cold = await coldResults();
  for (let i = 0; i < SECRET_KEY_CACHE_MAX * 3; i++) {
    isSecretKey(`field_${i}`);
    isSecretKey(`field_${i}_token`);
  }
  assert.equal(secretKeyCacheSize(), SECRET_KEY_CACHE_MAX);
  assert.equal(isSecretKey(`field_${SECRET_KEY_CACHE_MAX * 3 - 1}_token`), true);
  assert.equal(isSecretKey("field_0"), false);
  assert.deepEqual(CORPUS.map((k) => isSecretKey(k)), cold);
  assert.ok(secretKeyCacheSize() <= SECRET_KEY_CACHE_MAX);
});

test("memoized isSecretKey: names over 256 characters are not cached", async () => {
  const fresh = await import(`../src/webhooks.mjs?long=${Math.random()}`);
  for (let i = 0; i < 100; i++) assert.equal(fresh.isSecretKey(`api_key_${i}_` + "x".repeat(300)), false);
  assert.equal(fresh.secretKeyCacheSize(), 0);
  assert.equal(fresh.isSecretKey("api_key"), true);
  assert.equal(fresh.secretKeyCacheSize(), 1);
});

test("memoized isSecretKey: redaction output is unchanged", () => {
  const payload = { apikey: "k", data: { key: { id: "m" }, token_count: 3, access_token: "t" }, u: "https://h.example.test/?apikey=v&id=1&access_token=w" };
  const expected = { apikey: REDACTED, data: { key: { id: "m" }, token_count: 3, access_token: REDACTED }, u: `https://h.example.test/?apikey=${REDACTED}&id=1&access_token=${REDACTED}` };
  for (let i = 0; i < 3; i++) assert.deepEqual(redactSecrets(payload), expected);
});

// Repeated non-empty query parameters call isSecretKey once each; with the
// cache the name is classified once. Load-robust: the cached and uncached
// (bypassed) paths are timed interleaved in one worker, so both see the same
// load, and the cached path must be markedly faster (idle: ~22 vs ~130 ms).
// The absolute ceiling is generous but still far below super-linear
// behaviour, which the 5 s worker deadline also cuts.
const REPEATED_PARAMS = { text: "see ?" + "a=1&".repeat(64 * 1024) };
const CEILING_MS = 2000;
const MAX_RATIO = 0.5;

test(`redaction: 64K repeated query parameters, cached path markedly faster than uncached`, TIMING_TEST_OPTIONS, async () => {
  let cached, uncached;
  try {
    [cached, uncached] = await timeInWorker("redactSecrets", REPEATED_PARAMS, {
      variants: [null, ["setSecretKeyCacheEnabledForTests", false]],
      runs: 5
    });
  } catch (err) {
    assert.fail(`repeated query params: ${err.message}`);
  }
  assert.ok(cached < CEILING_MS, `cached: ${cached.toFixed(1)} ms (ceiling ${CEILING_MS} ms)`);
  assert.ok(cached < uncached * MAX_RATIO, `cached ${cached.toFixed(1)} ms vs uncached ${uncached.toFixed(1)} ms (ratio limit ${MAX_RATIO})`);
});
