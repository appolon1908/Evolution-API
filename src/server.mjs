import http from "node:http";
import { loadConfig } from "./config.mjs";
import { ProviderError, requireString } from "./contracts.mjs";
import { createEvolutionProvider } from "./providers/evolution.mjs";
import { createMetaProvider } from "./providers/meta.mjs";
import { forwardEvent } from "./middleware.mjs";
import { evolutionWebhookInstance, evolutionWebhookSecretFor, normalizeEvolutionWebhook, normalizeMetaWebhookEvents, summarizeMetaSkips, verifyMetaSignature, verifySharedSecret } from "./webhooks.mjs";
import { createMessageState, defaultLogger } from "./state.mjs";

// Request body caps, enforced while reading and therefore before any
// signature or secret check (the read is unauthenticated memory exposure).
const MAX_BODY = 1024 * 1024;
// Meta: "Webhook payloads can be up to 3 MB" (WhatsApp webhooks guide); the
// Meta webhook route alone accepts up to 3 MiB.
const MAX_META_WEBHOOK_BODY = 3 * 1024 * 1024;

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new ProviderError("payload_too_large", `request body exceeds ${limit / (1024 * 1024)} MiB`, { status: 413, retryHint: "never" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Parse a signature/secret-verified webhook body; null when it is not JSON.
function parseWebhookJson(raw) {
  try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return null; }
}

const DROP_LOG_INTERVAL_MS = 10000;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export function createApp(customConfig = loadConfig(), { state = createMessageState(), logger = defaultLogger } = {}) {
  const providers = {
    evolution: createEvolutionProvider(customConfig),
    meta: createMetaProvider(customConfig)
  };

  // Bound total connections and how long a request may take to arrive (see
  // config.mjs). Node enforces the timeouts on a periodic sweep, so the sweep
  // interval follows the smaller timeout (at most 1 s).
  const server = http.createServer({
    headersTimeout: customConfig.httpHeadersTimeoutMs,
    requestTimeout: customConfig.httpRequestTimeoutMs,
    connectionsCheckingInterval: Math.max(10, Math.min(1000, Math.floor(customConfig.httpHeadersTimeoutMs / 2)))
  }, async (req, res) => {
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
        // Not ready when a configuration can never work:
        // - a provider configured to send whose webhook secret is empty would
        //   reject every status webhook (fail closed), so readback could never
        //   complete;
        // - an empty/whitespace ADAPTER_SERVICE_TOKEN makes every internal
        //   route answer 503;
        // - FORWARD_EVENTS_ENABLED=true without MIDDLEWARE_EVENT_URL makes every
        //   webhook fail.
        // A missing Meta verify token only matters when (re)subscribing the
        // webhook, so it is a warning. Booleans and reason codes only.
        const webhooks = webhookReadiness(customConfig);
        const forwarding = {
          enabled: customConfig.forwardEventsEnabled,
          event_url_configured: isConfigured(customConfig.middlewareEventUrl)
        };
        const reasons = Object.keys(providers)
          .filter((k) => providers[k].ready() && !webhooks[k].configured)
          .map((k) => `${k}_webhook_secret_missing`);
        if (!isConfigured(customConfig.adapterServiceToken)) reasons.push("adapter_service_token_missing");
        if (forwarding.enabled && !forwarding.event_url_configured) reasons.push("middleware_event_url_missing");
        if (customConfig.evolutionWebhookSecretsError) reasons.push(customConfig.evolutionWebhookSecretsError);
        if (customConfig.evolutionWebhookLegacySharedSecret && !isConfigured(customConfig.evolutionWebhookSecret)) reasons.push("evolution_webhook_legacy_secret_missing");
        const metaInUse = providers.meta.ready() || webhooks.meta.configured;
        const warnings = metaInUse && !webhooks.meta.verify_token_configured ? ["meta_verify_token_missing"] : [];
        if (!customConfig.evolutionWebhookLegacySharedSecret && isConfigured(customConfig.evolutionWebhookSecret)) warnings.push("evolution_webhook_legacy_secret_ignored");
        return json(res, reasons.length ? 503 : 200, {
          status: reasons.length ? "not_ready" : "ready",
          safe_mode: !customConfig.externalSendEnabled,
          providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { configured: p.ready() }])),
          webhooks,
          forwarding,
          ...(reasons.length ? { reasons } : {}),
          ...(warnings.length ? { warnings } : {})
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
        let id;
        try {
          id = decodeURIComponent(url.pathname.slice("/internal/v1/whatsapp/transport/messages/".length));
        } catch {
          return json(res, 400, { error: { code: "invalid_provider_message_id" } });
        }
        // Unknown id and another tenant's id are indistinguishable (no existence oracle).
        const record = state.getForTenant(id, tenantId);
        if (!record) return json(res, 404, { error: { code: "provider_message_not_found" } });
        return json(res, 200, record);
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/webhooks/evolution") {
        const raw = await readBody(req);
        // The secret depends on the instance the body names, so the body is
        // parsed first; nothing is applied, forwarded or logged before the
        // per-instance secret (or the opted-in legacy secret) verifies.
        // Unknown instance, missing header and unparseable body all get the
        // same 401 (no instance-existence oracle).
        const parsed = parseWebhookJson(raw);
        const instance = parsed !== null && typeof parsed === "object" ? evolutionWebhookInstance(parsed) : null;
        if (!verifySharedSecret(evolutionWebhookSecretFor(customConfig, instance), req.headers["x-codestra-webhook-secret"])) {
          return json(res, 401, { error: { code: "invalid_webhook_secret" } });
        }
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
        const raw = await readBody(req, MAX_META_WEBHOOK_BODY);
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
        // All forwards share one deadline; exceeding it throws a 503 so Meta
        // redelivers instead of the batch running for up to N x 10 s.
        // Items with no message/status id carry nothing Middleware can join on:
        // they are not applied or forwarded and are counted as ignored.
        // Id-less items, non-message fields and value-level errors are
        // not forwarded; record counts only, before forwarding so the line is
        // emitted even if the forward deadline is hit.
        const noId = events.filter((e) => e.provider_message_id == null).length;
        const { skippedFields, valueErrors } = summarizeMetaSkips(parsed);
        if (noId > 0 || valueErrors > 0 || Object.keys(skippedFields).length > 0) {
          logger({ event: "meta_webhook_items_skipped", source: "meta", no_provider_message_id: noId, skipped_fields: skippedFields, value_errors: valueErrors });
        }
        const deadline = Date.now() + customConfig.webhookForwardDeadlineMs;
        const results = [];
        for (const event of events) {
          if (event.provider_message_id == null) {
            results.push({ provider_message_id: null, duplicate: false, stale: false, ignored: true, unrecognized: false, forward: { forwarded: false, reason: "no_provider_message_id" } });
            continue;
          }
          const { duplicate, stale, ignored, unrecognized } = state.applyEvent(event);
          const forward = await forwardEvent(customConfig, event, correlationId, { deadline });
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
      // An oversized body was left partly unread: close the connection so it
      // is not reused with the rest of that body still in flight.
      const headers = status === 413 ? { connection: "close" } : {};
      return json(res, status, {
        error: {
          code: error.code || "internal_error",
          message: error.message,
          retry_hint: error.retryHint || "middleware_decides"
        },
        correlation_id: correlationId
      }, headers);
    }
  });
  server.maxConnections = customConfig.httpMaxConnections;
  // Connections over the cap are dropped by Node with no HTTP response.
  // Count them; log at most one line per DROP_LOG_INTERVAL_MS (the first drop
  // immediately) with the number dropped since the last line, and no
  // addresses, so a flood cannot flood the logs.
  let dropped = 0;
  let lastDropLog = -Infinity;
  server.on("drop", () => {
    dropped += 1;
    const now = Date.now();
    if (now - lastDropLog < DROP_LOG_INTERVAL_MS) return;
    logger({ event: "http_connection_dropped", reason: "max_connections", max_connections: customConfig.httpMaxConnections, dropped });
    dropped = 0;
    lastDropLog = now;
  });
  return server;
}

function internalAuthError(req, config) {
  if (!isConfigured(config.adapterServiceToken)) return { status: 503, code: "service_auth_not_configured" };
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

// A whitespace-only value can never match a real credential or name a URL.
function isConfigured(value) {
  return typeof value === "string" && value.trim() !== "";
}

function webhookReadiness(config) {
  return {
    evolution: {
      configured: (config.evolutionWebhookSecrets?.size ?? 0) > 0 || (config.evolutionWebhookLegacySharedSecret && isConfigured(config.evolutionWebhookSecret)),
      instances: config.evolutionWebhookSecrets?.size ?? 0,
      legacy_shared_secret_enabled: config.evolutionWebhookLegacySharedSecret
    },
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
