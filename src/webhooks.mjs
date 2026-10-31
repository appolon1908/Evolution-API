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

export function normalizeEvolutionWebhook(body) {
  const providerEventId = body?.data?.key?.id ?? body?.data?.id ?? body?.id ?? null;
  return {
    source: "evolution",
    provider_event_id: providerEventId,
    provider_message_id: providerEventId,
    event_type: body?.event ?? "provider.event",
    instance_id: body?.instance ?? body?.instanceName ?? null,
    occurred_at: body?.date_time ?? body?.timestamp ?? null,
    provider_payload: body
  };
}

export function normalizeMetaWebhook(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value ?? {};
  const message = value?.messages?.[0];
  const status = value?.statuses?.[0];
  return {
    source: "meta",
    provider_event_id: message?.id ?? status?.id ?? null,
    provider_message_id: message?.id ?? status?.id ?? null,
    event_type: message ? "message.received" : status ? "message.delivery.updated" : "provider.event",
    instance_id: value?.metadata?.phone_number_id ?? null,
    occurred_at: message?.timestamp ?? status?.timestamp ?? null,
    provider_payload: body
  };
}
