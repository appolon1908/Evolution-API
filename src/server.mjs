import http from "node:http";
import { loadConfig } from "./config.mjs";
import { ProviderError, requireString } from "./contracts.mjs";
import { createEvolutionProvider } from "./providers/evolution.mjs";
import { createMetaProvider } from "./providers/meta.mjs";
import { forwardEvent } from "./middleware.mjs";
import { normalizeEvolutionWebhook, normalizeMetaWebhookEvents, verifyMetaSignature, verifySharedSecret } from "./webhooks.mjs";
import { createMessageState, defaultLogger } from "./state.mjs";

const MAX_BODY = 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new ProviderError("payload_too_large", "request body exceeds 1 MiB", { status: 413, retryHint: "never" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Parse a signature/secret-verified webhook body; null when it is not JSON.
function parseWebhookJson(raw) {
  try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return null; }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function createApp(customConfig = loadConfig(), { state = createMessageState(), logger = defaultLogger } = {}) {
  const providers = {
    evolution: createEvolutionProvider(customConfig),
    meta: createMetaProvider(customConfig)
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const correlationId = req.headers["x-correlation-id"] || cryptoRandom();

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, {
          status: "ok",
          service: "codestra-evolution-adapter",
          architecture: "middleware-v3-provider-adapter",
          middleware_authority: customConfig.middlewareBaseUrl,
          external_send_enabled: customConfig.externalSendEnabled
        });
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        // A provider configured to send whose webhook secret is empty would reject
        // every status webhook (fail closed), so readback could never complete:
        // report not-ready instead of silently 401-ing provider callbacks.
        const webhooks = webhookReadiness(customConfig);
        const blocking = Object.keys(providers).filter((k) => providers[k].ready() && !webhooks[k].configured);
        return json(res, blocking.length ? 503 : 200, {
          status: blocking.length ? "not_ready" : "ready",
          safe_mode: !customConfig.externalSendEnabled,
          providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { configured: p.ready() }])),
          webhooks,
          ...(blocking.length ? { reasons: blocking.map((k) => `${k}_webhook_secret_missing`) } : {})
        });
      }

      if (req.method === "GET" && url.pathname === "/internal/v1/whatsapp/transport/health") {
        return json(res, 200, {
          middleware_v3_authority: true,
          provider_adapter_only: true,
          providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { configured: p.ready() }]))
        });
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/transport/messages") {
        const authError = internalAuthError(req, customConfig);
        if (authError) return json(res, authError.status, { error: { code: authError.code } });
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        requireString(body.command_id, "command_id");
        requireString(body.correlation_id, "correlation_id");
        requireString(body.idempotency_key, "idempotency_key");
        const providerName = requireString(body.provider, "provider");
        if (!customConfig.externalSendEnabled) {
          return json(res, 423, {
            error: { code: "external_send_disabled", message: "Provider effects are disabled by default", retryable: false },
            correlation_id: body.correlation_id
          });
        }
        const tenantId = sendTenant(req, body);
        const provider = providers[providerName];
        if (!provider) throw new ProviderError("unknown_provider", `unknown provider: ${providerName}`, { status: 400, retryHint: "never" });
        const result = await provider.send(body);
        const instanceId = providerName === "meta" ? customConfig.metaPhoneNumberId : body.instance_id;
        state.rememberAccepted(result, { tenantId, instanceId });
        return json(res, 202, {
          command_id: body.command_id,
          correlation_id: body.correlation_id,
          idempotency_key: body.idempotency_key,
          result
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/internal/v1/whatsapp/transport/messages/")) {
        const authError = internalAuthError(req, customConfig);
        if (authError) return json(res, authError.status, { error: { code: authError.code } });
        const tenantId = headerTenant(req);
        if (!tenantId) return json(res, 400, { error: { code: "tenant_id_required" } });
        const id = decodeURIComponent(url.pathname.slice("/internal/v1/whatsapp/transport/messages/".length));
        // Unknown id and another tenant's id are indistinguishable (no existence oracle).
        const record = state.getForTenant(id, tenantId);
        if (!record) return json(res, 404, { error: { code: "provider_message_not_found" } });
        return json(res, 200, record);
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/webhooks/evolution") {
        const raw = await readBody(req);
        if (!verifySharedSecret(customConfig.evolutionWebhookSecret, req.headers["x-codestra-webhook-secret"])) {
          return json(res, 401, { error: { code: "invalid_webhook_secret" } });
        }
        const parsed = parseWebhookJson(raw);
        if (parsed === null) {
          logger({ event: "webhook_malformed_payload", source: "evolution", bytes: raw.length });
          return json(res, 400, { error: { code: "malformed_payload" } });
        }
        const event = normalizeEvolutionWebhook(parsed);
        const { duplicate, stale, ignored, unrecognized } = state.applyEvent(event);
        const forward = await forwardEvent(customConfig, event, correlationId);
        return json(res, 202, { accepted: true, duplicate, stale, ignored, unrecognized, event, forward });
      }

      if (req.method === "GET" && url.pathname === "/internal/v1/whatsapp/webhooks/meta") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && verifySharedSecret(customConfig.metaVerifyToken, token)) {
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(challenge || "");
        }
        return json(res, 403, { error: { code: "verification_failed" } });
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/webhooks/meta") {
        const raw = await readBody(req);
        if (!verifyMetaSignature(customConfig.metaAppSecret, raw, req.headers["x-hub-signature-256"])) {
          return json(res, 401, { error: { code: "invalid_meta_signature" } });
        }
        const parsed = parseWebhookJson(raw);
        if (parsed === null) {
          // Signature-verified bytes that are not JSON will never parse on
          // redelivery; Meta retries any non-200 for days, so acknowledge with
          // 200, apply/forward nothing, and log (size only, never the body).
          logger({ event: "webhook_malformed_payload", source: "meta", bytes: raw.length });
          return json(res, 200, { accepted: false, error: { code: "malformed_payload" } });
        }
        const events = normalizeMetaWebhookEvents(parsed);
        // Apply and forward every item. A forward failure throws (non-2xx to
        // Meta), so Meta redelivers the whole batch; already-applied items then
        // report duplicate locally and Middleware must dedupe.
        const results = [];
        for (const event of events) {
          const { duplicate, stale, ignored, unrecognized } = state.applyEvent(event);
          const forward = await forwardEvent(customConfig, event, correlationId);
          results.push({ provider_message_id: event.provider_message_id, duplicate, stale, ignored, unrecognized, forward });
        }
        // Top-level fields mirror the first item for single-event callers.
        const { duplicate, stale, ignored, unrecognized, forward } = results[0];
        // Meta: "respond to all Event Notifications with 200 OK"; any other
        // status is retried (WhatsApp: up to 7 days).
        return json(res, 200, { accepted: true, duplicate, stale, ignored, unrecognized, event: events[0], forward, results });
      }

      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 500;
      return json(res, status, {
        error: {
          code: error.code || "internal_error",
          message: error.message,
          retry_hint: error.retryHint || "middleware_decides"
        },
        correlation_id: correlationId
      });
    }
  });
}

function internalAuthError(req, config) {
  if (!config.adapterServiceToken) return { status: 503, code: "service_auth_not_configured" };
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) return { status: 401, code: "service_auth_required" };
  const actual = authorization.slice("Bearer ".length);
  if (!verifySharedSecret(config.adapterServiceToken, actual)) return { status: 401, code: "service_auth_invalid" };
  return null;
}

function headerTenant(req) {
  const raw = req.headers["x-tenant-id"];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

// The send request must carry X-Tenant-ID; a body tenant_id, when present, must agree.
function sendTenant(req, body) {
  const tenantId = headerTenant(req);
  if (!tenantId) throw new ProviderError("tenant_id_required", "X-Tenant-ID is required", { status: 400, retryHint: "never" });
  if (body.tenant_id != null && (typeof body.tenant_id !== "string" || body.tenant_id.trim() !== tenantId)) {
    throw new ProviderError("tenant_mismatch", "X-Tenant-ID and body tenant_id disagree", { status: 400, retryHint: "never" });
  }
  return tenantId;
}

function webhookReadiness(config) {
  return {
    evolution: { configured: Boolean(config.evolutionWebhookSecret) },
    meta: { configured: Boolean(config.metaAppSecret), verify_token_configured: Boolean(config.metaVerifyToken) }
  };
}

function cryptoRandom() {
  return globalThis.crypto?.randomUUID?.() || `corr-${Date.now()}`;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const config = loadConfig();
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: "codestra-evolution-adapter", port: config.port, external_send_enabled: config.externalSendEnabled }));
  });
}
