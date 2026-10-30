export function createMessageState() {
  const messages = new Map();

  function rememberAccepted(result) {
    const id = result?.provider_message_id;
    if (!id) return;
    messages.set(String(id), {
      provider_message_id: String(id),
      provider: result.provider ?? null,
      state: "ACCEPTED",
      updated_at: new Date().toISOString()
    });
  }

  // Provider webhooks may be redelivered and arrive out of order. A status
  // only moves forward (ACCEPTED < SENT < DELIVERED < READ); READ and FAILED
  // are terminal; FAILED may replace a non-terminal state.
  function applyEvent(event) {
    const id = event?.provider_message_id ?? event?.provider_event_id;
    if (!id) return { applied: false, duplicate: false, stale: false };
    const existing = messages.get(String(id));
    const next = deriveState(event);
    if (existing?.state === next) return { applied: false, duplicate: true, stale: false };
    if (existing && !advances(existing.state, next)) return { applied: false, duplicate: false, stale: true };
    const current = existing ?? {
      provider_message_id: String(id),
      provider: event?.source ?? null
    };
    messages.set(String(id), {
      ...current,
      state: next,
      updated_at: new Date().toISOString()
    });
    return { applied: true, duplicate: false, stale: false };
  }

  function get(id) {
    return messages.get(String(id)) ?? null;
  }

  return Object.freeze({ rememberAccepted, applyEvent, get });
}

const STATE_RANK = Object.freeze({ ACCEPTED: 0, SENT: 1, DELIVERED: 2, READ: 3 });
const TERMINAL_STATES = new Set(["READ", "FAILED"]);

function advances(current, next) {
  if (TERMINAL_STATES.has(current)) return false;
  if (next === "FAILED") return true;
  return (STATE_RANK[next] ?? -1) > (STATE_RANK[current] ?? -1);
}

function deriveState(event) {
  const payload = event?.provider_payload ?? {};
  const metaStatus = payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.status;
  const evolutionStatus = payload?.data?.status ?? payload?.data?.update?.status ?? payload?.status;
  const raw = String(metaStatus ?? evolutionStatus ?? event?.event_type ?? "").toLowerCase();

  if (raw.includes("read")) return "READ";
  if (raw.includes("deliver")) return "DELIVERED";
  if (raw.includes("sent") || raw.includes("server_ack") || raw.includes("device_ack")) return "SENT";
  if (raw.includes("fail") || raw.includes("error")) return "FAILED";
  return "ACCEPTED";
}
