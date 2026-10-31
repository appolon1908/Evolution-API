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
// Key rule. A key is split into words on "_", "-", ".", whitespace,
// camelCase/acronym and letter/digit boundaries, lowercased; pure-digit words
// are dropped ("x-hub-signature-256" -> x|hub|signature, "apikey1" -> apikey).
// A word's base is the word, or the word minus a trailing "s" (plural). The
// key is a credential key when any of these holds:
//   1. adjacent words are api+key(s) or private+key(s);
//   2. a word is "session"/"sessions" and it is the only word, or another word is one of
//      id, token, key, secret, cookie, data (session, sessionId, session_data);
//      other session_* metadata (session_count, session_started_at) is kept;
//   3. a word's base, or the base of all words joined (case-insensitive
//      whole-key match: "aPiKeY" -> apikey), is in SECRET_WORDS;
//   4. token family (token/tokens), evaluated only if 1-3 did not match:
//      - any other word that is not a COUNTER_WORD -> credential
//        (access_token_used, refreshTokens, token_used_by_client);
//      - singular "token": kept only as token_<counter...> (token_count,
//        tokenCount, token_limit); "token" alone, max_token, total_token are
//        credentials;
//      - plural "tokens" with only counter words (or none) is a counter and
//        kept (tokens, total_tokens, tokens_used, max_tokens, prompt_tokens).
// Words are matched whole, so author, passport, keyboard, secretary, keyId,
// sha256 and the message `key` object survive.
//
// "mediakey" (Baileys mediaKey / media_key, a media decryption key) is a
// whole-key match only, so mediaKeyTimestamp is kept.
//
// Value rule. A string is replaced entirely when it
//   - contains a JWT/JWE anywhere, not preceded by a letter, digit or "-"
//     ("x_eyJ.." is redacted, "honeyJar.." is not): "eyJ" + 3-part JWS
//     (eyJ.., .., ..) or 5-part JWE (the encrypted-key segment may be
//     empty), e.g. "token=eyJ..", "Bearer: eyJ..", or
//   - is an opaque authorization value: after trimming, "Bearer" or "Token"
//     + (":" and optional whitespace, or whitespace) + one token68-style
//     value of 8+ characters and nothing else (a whole-string
//     "Token abcdefgh" message is an accepted false positive); strings over
//     MAX_WHOLE_STRING_RULE_LENGTH are not checked by this rule, or
//   - is "Basic" + one base64 value that decodes to "user:pass" form.
// Otherwise URL credentials are redacted in place, keeping the rest of the
// string: userinfo ("https://u:p@host" -> "https://[REDACTED]@host") and the
// value of any query parameter whose name is a credential key by the key rule
// ("?access_token=..", "&apikey=..").
// Every value pattern must stay linear: the input is third-party message
// text. The bearer/token pattern is anchored on the trimmed value and its
// separator alternatives are disjoint from the token class, so a long run of
// whitespace is scanned once (the old \s*[:\s]\s* form was quadratic).
const SECRET_WORDS = new Set([
  "apikey", "accesstoken", "authtoken", "refreshtoken", "idtoken",
  "secret", "clientsecret", "password", "passwd", "pwd", "pass", "passphrase",
  "auth", "authorization", "bearer", "jwt", "credential", "privatekey",
  "cookie", "signature", "mediakey"
]);
const SECRET_PAIRS = [["api", "key"], ["private", "key"]];
const SESSION_QUALIFIERS = new Set(["id", "token", "key", "secret", "cookie", "data"]);
const COUNTER_WORDS = new Set(["count", "total", "used", "usage", "limit", "max", "min", "num", "number", "remaining", "prompt", "completion", "input", "output"]);
const B64 = "[A-Za-z0-9_-]";
const JWT_ANYWHERE = new RegExp(`(?<![A-Za-z0-9-])eyJ${B64}{2,}\\.(?:${B64}{2,}\\.${B64}*|${B64}*\\.${B64}{2,}\\.${B64}{2,}\\.${B64}*)`);
const OPAQUE_AUTH = /^(?:bearer|token)(?::\s*|\s+)[A-Za-z0-9._~+/=-]{8,}$/i;
const MAX_WHOLE_STRING_RULE_LENGTH = 8192;
const BASIC_AUTH = /^\s*basic\s*[:\s]\s*([A-Za-z0-9+/]{4,}={0,2})\s*$/i;
// Bounded/disjoint character classes keep both scans linear on hostile input.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]{1,512}@/gi;
const QUERY_PARAM = /([?&])([^=&#?\s]+)=([^&#\s]*)/g;
export const REDACTED = "[REDACTED]";

function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/^[0-9]+$/.test(w));
}

function base(word) {
  return word.length > 1 && word.endsWith("s") ? [word, word.slice(0, -1)] : [word];
}

const isWord = (set) => (w) => base(w).some((b) => set.has(b));
const isSecretWord = isWord(SECRET_WORDS);
const isKeyWord = (w) => w === "key" || w === "keys";
const isTokenWord = (w) => w === "token" || w === "tokens";

export function isSecretKey(key) {
  const words = keyWords(key);
  if (words.length === 0) return false;
  // 1. api+key / private+key
  if (words.some((w, i) => (w === "api" || w === "private") && isKeyWord(words[i + 1] ?? ""))) return true;
  // 2. session
  if (words.some((w) => w === "session" || w === "sessions") && (words.length === 1 || words.some((w) => SESSION_QUALIFIERS.has(w)))) return true;
  // 3. credential words, per word and as a whole key
  if (words.some(isSecretWord) || isSecretWord(words.join(""))) return true;
  // 4. token family
  const joined = words.join("");
  const tokenWords = isTokenWord(joined) ? [joined] : words.filter(isTokenWord);
  if (tokenWords.length === 0) return false;
  const others = isTokenWord(joined) ? [] : words.filter((w) => !isTokenWord(w));
  if (others.some((w) => !COUNTER_WORDS.has(w))) return true;
  if (tokenWords.includes("token")) {
    return !(tokenWords.length === 1 && words[0] === "token" && others.length > 0);
  }
  return false;
}

function isBasicCredential(value) {
  const m = BASIC_AUTH.exec(value);
  return m !== null && Buffer.from(m[1], "base64").toString("latin1").includes(":");
}

export function looksLikeCredentialValue(value) {
  if (typeof value !== "string") return false;
  return JWT_ANYWHERE.test(value) || isOpaqueAuth(value) || isBasicCredential(value);
}

function isOpaqueAuth(value) {
  return value.length <= MAX_WHOLE_STRING_RULE_LENGTH && OPAQUE_AUTH.test(value.trim());
}

function decodeName(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

// In-place redaction of credentials carried inside URLs (see Value rule).
function redactUrlCredentials(value) {
  if (!value.includes("://") && !value.includes("?")) return value;
  return value
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(QUERY_PARAM, (match, sep, name, v) => (v !== "" && isSecretKey(decodeName(name)) ? `${sep}${name}=${REDACTED}` : match));
}

const MAX_REDACT_DEPTH = 32;

export function redactSecrets(value, depth = 0) {
  if (looksLikeCredentialValue(value)) return REDACTED;
  if (typeof value === "string") return redactUrlCredentials(value);
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

// Secret-safe summary of what a Meta webhook carried that yields no
// forwardable item: changes with no messages/statuses, counted by field name
// (Meta field names only; anything else is "other"), and the number of
// value-level errors. Counts and field names only, never values.
export function summarizeMetaSkips(body) {
  // Counted on a prototype-less object so a field named "constructor" or
  // "__proto__" is just a key; returned as a plain object of own properties.
  const counts = Object.create(null);
  let valueErrors = 0;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value ?? {};
      if (Array.isArray(value?.errors)) valueErrors += value.errors.length;
      const items = (Array.isArray(value?.messages) ? value.messages.length : 0) + (Array.isArray(value?.statuses) ? value.statuses.length : 0);
      if (items === 0) {
        const field = typeof change?.field === "string" && /^[a-z0-9_]{1,64}$/.test(change.field) ? change.field : "other";
        counts[field] = (counts[field] ?? 0) + 1;
      }
    }
  }
  return { skippedFields: Object.fromEntries(Object.entries(counts)), valueErrors };
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
