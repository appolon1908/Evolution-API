import fs from "node:fs";

function flag(name, fallback = false) {
  const raw = process.env[name];
  return raw == null ? fallback : raw.toLowerCase() === "true";
}

// Total time budget for forwarding all items of one provider webhook to
// Middleware. Meta's docs state no response timeout, so the adapter picks a
// conservative 8 s (below the 10 s per-call forward timeout) and returns
// non-2xx when it is exceeded so the provider redelivers.
const DEFAULT_WEBHOOK_FORWARD_DEADLINE_MS = 8000;

function positiveInt(raw, fallback) {
  return typeof raw === "string" && /^[1-9][0-9]*$/.test(raw.trim()) ? Number(raw.trim()) : fallback;
}

// HTTP server bounds. Every open connection may hold up to 3 MiB of an
// unauthenticated Meta body while it is read, so worst-case body memory is
// about maxConnections x 3 MiB (128 -> ~384 MiB). Node's defaults are an
// unlimited connection count, a 60 s headers timeout and a 300 s request
// timeout; a slow sender could otherwise pin memory for minutes.
const DEFAULT_HTTP_MAX_CONNECTIONS = 128;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10000;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30000;

// Per-instance Evolution webhook secrets: a JSON object {instanceName: secret}
// read from EVOLUTION_WEBHOOK_SECRETS_FILE (preferred: a mounted secret file)
// or EVOLUTION_WEBHOOK_SECRETS (inline JSON), never both. Instance names are
// trimmed (as state compares them); every secret must be a non-blank string.
// Any problem yields an empty map plus a reason code (never a value), so the
// adapter fails closed and /readyz reports the code.
function loadEvolutionWebhookSecrets(env) {
  const inline = env.EVOLUTION_WEBHOOK_SECRETS;
  const file = env.EVOLUTION_WEBHOOK_SECRETS_FILE;
  const hasInline = typeof inline === "string" && inline.trim() !== "";
  const hasFile = typeof file === "string" && file.trim() !== "";
  const fail = (code) => ({ secrets: new Map(), error: code });
  if (hasInline && hasFile) return fail("evolution_webhook_secrets_ambiguous");
  if (!hasInline && !hasFile) return { secrets: new Map(), error: null };
  let raw = inline;
  if (hasFile) {
    try { raw = fs.readFileSync(file.trim(), "utf8"); } catch { return fail("evolution_webhook_secrets_unreadable"); }
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fail("evolution_webhook_secrets_invalid_json"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("evolution_webhook_secrets_invalid");
  const secrets = new Map();
  for (const [name, secret] of Object.entries(parsed)) {
    const instance = name.trim();
    if (instance === "" || secrets.has(instance)) return fail("evolution_webhook_secrets_invalid");
    if (typeof secret !== "string" || secret.trim() === "") return fail("evolution_webhook_secrets_invalid");
    secrets.set(instance, secret);
  }
  return { secrets, error: null };
}

export function loadConfig(env = process.env) {
  const evolutionWebhook = loadEvolutionWebhookSecrets(env);
  const httpRequestTimeoutMs = positiveInt(env.HTTP_REQUEST_TIMEOUT_MS, DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
  // Node rejects a headers timeout larger than the request timeout.
  const httpHeadersTimeoutMs = Math.min(positiveInt(env.HTTP_HEADERS_TIMEOUT_MS, DEFAULT_HTTP_HEADERS_TIMEOUT_MS), httpRequestTimeoutMs);
  return Object.freeze({
    port: Number(env.PORT || 8781),
    externalSendEnabled: String(env.EXTERNAL_SEND_ENABLED || "false").toLowerCase() === "true",
    forwardEventsEnabled: String(env.FORWARD_EVENTS_ENABLED || "false").toLowerCase() === "true",
    middlewareBaseUrl: env.MIDDLEWARE_BASE_URL || "http://middleware-integration-api:8095",
    middlewareEventUrl: env.MIDDLEWARE_EVENT_URL || "",
    middlewareServiceToken: env.MIDDLEWARE_SERVICE_TOKEN || "",
    adapterServiceToken: env.ADAPTER_SERVICE_TOKEN || "",
    evolutionBaseUrl: env.EVOLUTION_BASE_URL || "",
    evolutionApiKey: env.EVOLUTION_API_KEY || "",
    // Legacy single secret for every instance: used only when
    // EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET=true (default off, fail closed).
    evolutionWebhookSecret: env.EVOLUTION_WEBHOOK_SECRET || "",
    evolutionWebhookLegacySharedSecret: String(env.EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET || "false").toLowerCase() === "true",
    evolutionWebhookSecrets: evolutionWebhook.secrets,
    evolutionWebhookSecretsError: evolutionWebhook.error,
    metaGraphVersion: env.META_GRAPH_VERSION || "",
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID || "",
    metaAccessToken: env.META_ACCESS_TOKEN || "",
    metaAppSecret: env.META_APP_SECRET || "",
    metaVerifyToken: env.META_VERIFY_TOKEN || "",
    webhookForwardDeadlineMs: positiveInt(env.WEBHOOK_FORWARD_DEADLINE_MS, DEFAULT_WEBHOOK_FORWARD_DEADLINE_MS),
    httpMaxConnections: positiveInt(env.HTTP_MAX_CONNECTIONS, DEFAULT_HTTP_MAX_CONNECTIONS),
    httpHeadersTimeoutMs,
    httpRequestTimeoutMs
  });
}

export const config = loadConfig();
