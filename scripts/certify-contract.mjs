#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig } from "../src/config.mjs";

function requireCondition(condition, message) {
  if (!condition) {
    console.error(`CERTIFICATION_FAIL: ${message}`);
    process.exit(1);
  }
}

const cfg = loadConfig({});
requireCondition(cfg.externalSendEnabled === false, "external provider sends must default OFF");
requireCondition(cfg.forwardEventsEnabled === false, "event forwarding must default OFF");
requireCondition(
  cfg.middlewareBaseUrl === "http://middleware-integration-api:8095",
  "canonical Middleware authority must be middleware-integration-api:8095"
);
requireCondition(cfg.middlewareServiceToken === "", "Middleware token must not be embedded");
requireCondition(cfg.adapterServiceToken === "", "adapter token must not be embedded");
requireCondition(cfg.evolutionApiKey === "", "Evolution API key must not be embedded");
requireCondition(cfg.metaAccessToken === "", "Meta access token must not be embedded");

const openapi = fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const required = [
  "/internal/v1/whatsapp/transport/messages:",
  "/internal/v1/whatsapp/transport/messages/{provider_message_id}:",
  "/internal/v1/whatsapp/transport/health:",
  "X-Command-ID",
  "X-Tenant-ID",
  "X-Correlation-ID",
  "Idempotency-Key",
  "campaign_id"
];
for (const token of required) {
  requireCondition(openapi.includes(token), `OpenAPI missing required authority token: ${token}`);
}
requireCondition(!openapi.includes("/platform/v3"), "Evolution must not expose a /platform/v3 command authority");
requireCondition(
  openapi.includes("Not a public command API"),
  "OpenAPI must state provider-adapter-only authority"
);

console.log("EVOLUTION_PROVIDER_ADAPTER_CERTIFICATION=PASS");
console.log("PROVIDER_EFFECTS=0");
console.log("PRODUCTION_EFFECTS=0");
console.log("MIDDLEWARE_AUTHORITY=http://middleware-integration-api:8095");
