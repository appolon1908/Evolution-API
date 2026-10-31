export function createMessageState() {
  const messages = new Map();

  // A status webhook can arrive before provider.send() returns; never let the
  // send acknowledgement regress a state that is already further along.
  // tenantId: the tenant of the authenticated send request; readback is bound to it.
  function rememberAccepted(result, { tenantId = null } = {}) {
    const id = result?.provider_message_id;
    if (!id) return;
    const existing = messages.get(String(id));
    messages.set(String(id), {
      ...existing,
      provider_message_id: String(id),
      tenant_id: existing?.tenant_id ?? tenantId ?? null,
      provider: result.provider ?? existing?.provider ?? null,
      state: existing?.state ?? "ACCEPTED",
      updated_at: existing?.updated_at ?? new Date().toISOString()
    });
  }

  // Provider webhooks may be redelivered and arrive out of order. A status
  // only moves forward (ACCEPTED < SENT < DELIVERED < READ); READ and FAILED
  // are terminal; FAILED may replace only a pre-delivery state (ACCEPTED,
  // SENT): a message the recipient device already received cannot be undone.
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

  // Tenant-scoped readback: records with no tenant (e.g. webhook-only, never
  // sent through this adapter) or another tenant's records are not visible.
  function getForTenant(id, tenantId) {
    const record = get(id);
    if (!record || !tenantId || record.tenant_id !== tenantId) return null;
    return record;
  }

  return Object.freeze({ rememberAccepted, applyEvent, get, getForTenant });
}

const STATE_RANK = Object.freeze({ ACCEPTED: 0, SENT: 1, DELIVERED: 2, READ: 3 });
const TERMINAL_STATES = new Set(["READ", "FAILED"]);

function advances(current, next) {
  if (TERMINAL_STATES.has(current)) return false;
  if (next === "FAILED") return (STATE_RANK[current] ?? -1) < STATE_RANK.DELIVERED;
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
