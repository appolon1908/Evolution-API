import http from "node:http";
import { loadConfig } from "./config.mjs";
import { ProviderError, requireString } from "./contracts.mjs";
import { createEvolutionProvider } from "./providers/evolution.mjs";
import { createMetaProvider } from "./providers/meta.mjs";
import { forwardEvent } from "./middleware.mjs";
import { normalizeEvolutionWebhook, normalizeMetaWebhook, verifyMetaSignature, verifySharedSecret } from "./webhooks.mjs";
import { createMessageState } from "./state.mjs";

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

function requireJsonContentType(req) {
  const value = String(req.headers["content-type"] || "").toLowerCase();
  if (!value.startsWith("application/json")) {
    throw new ProviderError("unsupported_media_type", "content-type must be application/json", { status: 415, retryHint: "never" });
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw new ProviderError("invalid_json", "request body must be valid JSON", { status: 400, retryHint: "never" });
  }
}

function requiredHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderError("required_header_missing", `${name} is required`, { status: 400, retryHint: "never" });
  }
  return value.trim();
}

function enforceTransportParity(req, body) {
  const expected = {
    "X-Command-ID": requireString(body.command_id, "command_id"),
    "X-Tenant-ID": requireString(body.tenant_id, "tenant_id"),
    "X-Correlation-ID": requireString(body.correlation_id, "correlation_id"),
    "Idempotency-Key": requireString(body.idempotency_key, "idempotency_key")
  };
  for (const [name, bodyValue] of Object.entries(expected)) {
    const headerValue = requiredHeader(req, name);
    if (headerValue !== bodyValue) {
      throw new ProviderError("header_body_mismatch", `${name} must match request body`, { status: 409, retryHint: "never" });
    }
  }
}

function json(res, status, body, headers = {}) {
  const correlation = typeof body?.correlation_id === "string" ? { "x-correlation-id": body.correlation_id } : {};
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...correlation,
    ...headers
  });
  res.end(JSON.stringify(body));
}

export function createApp(customConfig = loadConfig()) {
  const state = createMessageState();
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
        const providerStatus = Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { configured: p.ready() }]));
        const problems = [];
        if (!customConfig.adapterServiceToken) problems.push("service_auth_not_configured");
        if (customConfig.externalSendEnabled && !Object.values(providerStatus).some((item) => item.configured)) {
          problems.push("no_provider_configured");
        }
        if (customConfig.forwardEventsEnabled && !customConfig.middlewareEventUrl) problems.push("middleware_event_url_not_configured");
        const ready = problems.length === 0;
        return json(res, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          safe_mode: !customConfig.externalSendEnabled,
          service_auth_configured: Boolean(customConfig.adapterServiceToken),
          providers: providerStatus,
          problems
        });
      }

      if (req.method === "GET" && url.pathname === "/internal/v1/whatsapp/transport/health") {
        const authError = internalAuthError(req, customConfig);
        if (authError) return json(res, authError.status, { error: { code: authError.code } });
        return json(res, 200, {
          middleware_v3_authority: true,
          provider_adapter_only: true,
          providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { configured: p.ready() }]))
        });
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/transport/messages") {
        const authError = internalAuthError(req, customConfig);
        if (authError) return json(res, authError.status, { error: { code: authError.code } });
        requireJsonContentType(req);
        const raw = await readBody(req);
        const body = parseJson(raw);
        enforceTransportParity(req, body);
        requireString(body.campaign_id, "campaign_id");
        const providerName = requireString(body.provider, "provider");
        if (!customConfig.externalSendEnabled) {
          return json(res, 423, {
            error: { code: "external_send_disabled", message: "Provider effects are disabled by default", retryable: false },
            correlation_id: body.correlation_id
          });
        }
        const provider = providers[providerName];
        if (!provider) throw new ProviderError("unknown_provider", `unknown provider: ${providerName}`, { status: 400, retryHint: "never" });
        const result = await provider.send(body);
        state.rememberAccepted(result);
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
        const id = decodeURIComponent(url.pathname.slice("/internal/v1/whatsapp/transport/messages/".length));
        const record = state.get(id);
        if (!record) return json(res, 404, { error: { code: "provider_message_not_found" } });
        return json(res, 200, record);
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/webhooks/evolution") {
        requireJsonContentType(req);
        const raw = await readBody(req);
        if (!verifySharedSecret(customConfig.evolutionWebhookSecret, req.headers["x-codestra-webhook-secret"])) {
          return json(res, 401, { error: { code: "invalid_webhook_secret" } });
        }
        const event = normalizeEvolutionWebhook(parseJson(raw));
        state.applyEvent(event);
        const forward = await forwardEvent(customConfig, event, correlationId);
        return json(res, 202, { accepted: true, event, forward });
      }

      if (req.method === "GET" && url.pathname === "/internal/v1/whatsapp/webhooks/meta") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && customConfig.metaVerifyToken && token === customConfig.metaVerifyToken) {
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(challenge || "");
        }
        return json(res, 403, { error: { code: "verification_failed" } });
      }

      if (req.method === "POST" && url.pathname === "/internal/v1/whatsapp/webhooks/meta") {
        requireJsonContentType(req);
        const raw = await readBody(req);
        if (!verifyMetaSignature(customConfig.metaAppSecret, raw, req.headers["x-hub-signature-256"])) {
          return json(res, 401, { error: { code: "invalid_meta_signature" } });
        }
        const event = normalizeMetaWebhook(parseJson(raw));
        state.applyEvent(event);
        const forward = await forwardEvent(customConfig, event, correlationId);
        return json(res, 202, { accepted: true, event, forward });
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

function cryptoRandom() {
  return globalThis.crypto?.randomUUID?.() || `corr-${Date.now()}`;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const config = loadConfig();
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: "codestra-evolution-adapter", port: config.port, external_send_enabled: config.externalSendEnabled }));
  });
}
