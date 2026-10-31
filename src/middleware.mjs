import { ProviderError } from "./contracts.mjs";

const FORWARD_CALL_TIMEOUT_MS = 10000;

function deadlineExceeded() {
  return new ProviderError("forward_deadline_exceeded", "Middleware forwarding exceeded the per-webhook deadline", { status: 503 });
}

// deadline: optional absolute epoch-ms bound shared by all forwards of one
// webhook; each call's timeout is min(10 s, time left).
export async function forwardEvent(config, event, correlationId, { deadline } = {}) {
  if (!config.forwardEventsEnabled) {
    return { forwarded: false, reason: "forwarding_disabled" };
  }
  const remaining = deadline == null ? FORWARD_CALL_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0) throw deadlineExceeded();
  const timeoutMs = Math.min(FORWARD_CALL_TIMEOUT_MS, remaining);
  const byDeadline = deadline != null && timeoutMs < FORWARD_CALL_TIMEOUT_MS;
  if (!config.middlewareEventUrl) {
    throw new Error("MIDDLEWARE_EVENT_URL is required when FORWARD_EVENTS_ENABLED=true");
  }
  const headers = {
    "content-type": "application/json",
    "x-correlation-id": correlationId || event.provider_event_id || "provider-event"
  };
  if (config.middlewareServiceToken) headers.authorization = `Bearer ${config.middlewareServiceToken}`;
  let response;
  let raw;
  try {
    response = await fetch(config.middlewareEventUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs)
    });
    raw = await response.text();
  } catch (error) {
    if (byDeadline && (error?.name === "TimeoutError" || error?.name === "AbortError")) throw deadlineExceeded();
    throw error;
  }
  if (!response.ok) throw new Error(`Middleware event forwarding failed with HTTP ${response.status}: ${raw.slice(0, 300)}`);
  return { forwarded: true, middleware_status: response.status };
}
