import crypto from "node:crypto";

// Fail closed: an unconfigured (missing or empty) secret never authenticates.
export function verifySharedSecret(expected, actual) {
  if (typeof expected !== "string" || expected === "") return false;
  if (typeof actual !== "string" || actual === "") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta: X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app_secret, raw request body)).
// Fail closed: an unconfigured (missing or empty) app secret never authenticates.
export function verifyMetaSignature(appSecret, rawBody, signature) {
  if (typeof appSecret !== "string" || appSecret === "") return false;
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Credential redaction for provider payloads that are echoed and forwarded.
// Upstream Evolution puts the instance `apikey` in every webhook body.
//
// Key rule: a key is split into tokens on "_", "-", ".", whitespace and
// camelCase/acronym boundaries, then lowercased ("x-api-key" -> x|api|key,
// "accessToken" -> access|token, "APIKEY" -> apikey). It is a credential key if
//   - any token is one of SECRET_TOKENS (whole-token match, so "author",
//     "passport", "keyboard", "secretary" and a bare message `key` survive), or
//   - two adjacent tokens are api+key or private+key;
//   - EXCEPT when the only credential token is "token" and another token is a
//     counter word (COUNTER_TOKENS), e.g. token_count, tokenCount. The plural
//     "tokens" is not a credential token (total_tokens, max_tokens, tokens).
// Value rule: any string that looks like a JWT (optionally "Bearer "-prefixed)
// is redacted under any key: three base64url segments separated by "." where
// the first starts with "eyJ" (a base64url-encoded JSON header).
const SECRET_TOKENS = new Set([
  "apikey", "token", "accesstoken", "authtoken", "refreshtoken", "idtoken",
  "secret", "clientsecret", "password", "passwd", "pwd", "pass",
  "auth", "authorization", "bearer", "jwt", "credential", "credentials", "privatekey"
]);
const SECRET_PAIRS = [["api", "key"], ["private", "key"]];
const COUNTER_TOKENS = new Set(["count", "total", "used", "usage", "limit", "max", "min", "num", "number", "remaining", "prompt", "completion", "input", "output"]);
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;
export const REDACTED = "[REDACTED]";

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretKey(key) {
  const tokens = keyTokens(key);
  const hits = tokens.filter((t) => SECRET_TOKENS.has(t));
  const pair = tokens.some((t, i) => SECRET_PAIRS.some(([a, b]) => t === a && tokens[i + 1] === b));
  if (pair) return true;
  if (hits.length === 0) return false;
  if (hits.every((t) => t === "token") && tokens.some((t) => COUNTER_TOKENS.has(t))) return false;
  return true;
}

export function looksLikeJwt(value) {
  if (typeof value !== "string") return false;
  return JWT_VALUE.test(value.trim().replace(/^bearer\s+/i, ""));
}

const MAX_REDACT_DEPTH = 32;

export function redactSecrets(value, depth = 0) {
  if (looksLikeJwt(value)) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  // Fail closed: a subtree deeper than we inspect is replaced, never echoed.
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKey(k) && v != null && v !== "" ? REDACTED : redactSecrets(v, depth + 1);
  }
  return out;
}

export function normalizeEvolutionWebhook(body) {
  const providerEventId = body?.data?.key?.id ?? body?.data?.id ?? body?.id ?? null;
  return {
    source: "evolution",
    provider_event_id: providerEventId,
    provider_message_id: providerEventId,
    event_type: body?.event ?? "provider.event",
    instance_id: body?.instance ?? body?.instanceName ?? null,
    occurred_at: body?.date_time ?? body?.timestamp ?? null,
    provider_payload: redactSecrets(body)
  };
}

// Meta batches up to 1000 updates per POST across entry[], changes[],
// messages[] and statuses[]. Produce one normalized event per message/status;
// each event's provider_payload keeps the Meta envelope shape but carries only
// its own item. A body with no message/status yields one generic event.
export function normalizeMetaWebhookEvents(body) {
  const events = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const { messages, statuses, ...rest } = value;
      const one = (kind, item) => ({
        ...(body?.object !== undefined ? { object: body.object } : {}),
        entry: [{ id: entry?.id, changes: [{ field: change?.field, value: { ...rest, [kind]: [item] } }] }]
      });
      for (const message of Array.isArray(messages) ? messages : []) {
        events.push(metaEvent(value, message, "message.received", one("messages", message)));
      }
      for (const status of Array.isArray(statuses) ? statuses : []) {
        events.push(metaEvent(value, status, "message.delivery.updated", one("statuses", status)));
      }
    }
  }
  if (events.length === 0) events.push(metaEvent(body?.entry?.[0]?.changes?.[0]?.value ?? {}, null, "provider.event", body));
  return events;
}

function metaEvent(value, item, eventType, payload) {
  return {
    source: "meta",
    provider_event_id: item?.id ?? null,
    provider_message_id: item?.id ?? null,
    event_type: eventType,
    instance_id: value?.metadata?.phone_number_id ?? null,
    occurred_at: item?.timestamp ?? null,
    provider_payload: redactSecrets(payload)
  };
}

// First normalized event of a Meta webhook (kept for single-event callers).
export function normalizeMetaWebhook(body) {
  return normalizeMetaWebhookEvents(body)[0];
}
