import { readFileSync } from "node:fs";
﻿function flag(name, fallback = false) {
  const raw = process.env[name];
  return raw == null ? fallback : raw.toLowerCase() === "true";
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number(env.PORT || 8781),
    enrollmentEnabled: String(env.PROVIDER_ENROLLMENT_ENABLED || "false").toLowerCase() === "true",
    externalSendEnabled: String(env.EXTERNAL_SEND_ENABLED || "false").toLowerCase() === "true",
    forwardEventsEnabled: String(env.FORWARD_EVENTS_ENABLED || "false").toLowerCase() === "true",
    middlewareBaseUrl: env.MIDDLEWARE_BASE_URL || "http://middleware-integration-api:8095",
    middlewareEventUrl: env.MIDDLEWARE_EVENT_URL || "",
    middlewareServiceToken: env.MIDDLEWARE_SERVICE_TOKEN || "",
    adapterServiceToken: env.ADAPTER_SERVICE_TOKEN || (env.ADAPTER_SERVICE_TOKEN_FILE ? readFileSync(env.ADAPTER_SERVICE_TOKEN_FILE,"utf8").trim() : ""),
    evolutionBaseUrl: env.EVOLUTION_BASE_URL || "",
    evolutionApiKey: env.EVOLUTION_API_KEY || "",
    evolutionWebhookSecret: env.EVOLUTION_WEBHOOK_SECRET || "",
    metaGraphVersion: env.META_GRAPH_VERSION || "",
    metaAllowedWabaIds: String(env.META_ALLOWED_WABA_IDS || "").split(",").map(x=>x.trim()).filter(Boolean),
    evolutionInstancePrefix: env.EVOLUTION_INSTANCE_PREFIX || "",
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID || "",
    metaAccessToken: env.META_ACCESS_TOKEN || "",
    metaAppSecret: env.META_APP_SECRET || "",
    metaVerifyToken: env.META_VERIFY_TOKEN || ""
  });
}

export const config = loadConfig();
