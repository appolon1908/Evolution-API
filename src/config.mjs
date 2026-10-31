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

export function loadConfig(env = process.env) {
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
    evolutionWebhookSecret: env.EVOLUTION_WEBHOOK_SECRET || "",
    metaGraphVersion: env.META_GRAPH_VERSION || "",
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID || "",
    metaAccessToken: env.META_ACCESS_TOKEN || "",
    metaAppSecret: env.META_APP_SECRET || "",
    metaVerifyToken: env.META_VERIFY_TOKEN || "",
    webhookForwardDeadlineMs: positiveInt(env.WEBHOOK_FORWARD_DEADLINE_MS, DEFAULT_WEBHOOK_FORWARD_DEADLINE_MS)
  });
}

export const config = loadConfig();
