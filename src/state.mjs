// Secret-safe default logger: callers pass only ids, provider/instance names
// and reason codes, never payloads, headers or configuration values.
export function defaultLogger(entry) {
  console.warn(JSON.stringify({ level: "warn", service: "codestra-evolution-adapter", ...entry }));
}

export function createMessageState({ logger = defaultLogger } = {}) {
  const messages = new Map();

  // A status webhook can arrive before provider.send() returns; never let the
  // send acknowledgement regress a state that is already further along.
  // tenantId: the tenant of the authenticated send request; readback is bound to it.
  // instanceId: the provider instance (Evolution instance / Meta phone_number_id)
  // the message was sent from; later webhooks must come from the same one.
  function rememberAccepted(result, { tenantId = null, instanceId = null } = {}) {
    const id = result?.provider_message_id;
    if (!id) return;
    const key = String(id);
    let existing = messages.get(key);
    const provider = result.provider ?? existing?.provider ?? null;
    if (existing && existing.tenant_id == null && scopeMismatch(existing, provider, instanceId)) {
      // A tenantless webhook-first record from another provider/instance is not
      // this message's history: start fresh instead of inheriting its state.
      logger({ event: "send_binding_conflict", reason: "foreign_webhook_record_replaced", provider });
      existing = undefined;
    } else if (existing?.tenant_id != null && tenantId != null && existing.tenant_id !== tenantId) {
      // First binder wins; never rebind another tenant's record.
      logger({ event: "send_binding_conflict", reason: "tenant_already_bound", provider });
      return;
    }
    messages.set(key, {
      ...existing,
      provider_message_id: key,
      tenant_id: existing?.tenant_id ?? tenantId ?? null,
      provider,
      instance_id: existing?.instance_id ?? (instanceId != null ? String(instanceId) : null),
      state: existing?.state ?? "ACCEPTED",
      updated_at: existing?.updated_at ?? new Date().toISOString()
    });
  }

  // Provider webhooks may be redelivered and arrive out of order. A status
  // only moves forward (ACCEPTED < SENT < DELIVERED < READ); READ and FAILED
  // are terminal; FAILED may replace only a pre-delivery state (ACCEPTED,
  // SENT): a message the recipient device already received cannot be undone.
  // A webhook only applies to a record of the same provider and, when the
  // record is bound to an instance, the same instance; otherwise it is ignored
  // so one tenant's provider events never alter another tenant's message.
  function applyEvent(event) {
    const id = event?.provider_message_id ?? event?.provider_event_id;
    if (!id) return { applied: false, duplicate: false, stale: false, ignored: false, unrecognized: false };
    const existing = messages.get(String(id));
    const mismatch = existing && scopeMismatch(existing, event?.source ?? null, event?.instance_id ?? null, { strictInstance: true });
    if (mismatch) {
      logger({ event: "webhook_scope_mismatch", reason: mismatch, source: event?.source ?? null });
      return { applied: false, duplicate: false, stale: false, ignored: true, unrecognized: false };
    }
    const next = deriveState(event);
    // Unrecognised statuses (e.g. Evolution PENDING/PLAYED, inbound messages)
    // carry no delivery progress: never "duplicate", never create a record.
    if (next === null) return { applied: false, duplicate: false, stale: false, ignored: false, unrecognized: true };
    if (existing?.state === next) return { applied: false, duplicate: true, stale: false, ignored: false, unrecognized: false };
    if (existing && !advances(existing.state, next)) return { applied: false, duplicate: false, stale: true, ignored: false, unrecognized: false };
    const current = existing ?? {
      provider_message_id: String(id),
      tenant_id: null,
      provider: event?.source ?? null,
      instance_id: event?.instance_id != null ? String(event.instance_id) : null
    };
    messages.set(String(id), {
      ...current,
      state: next,
      updated_at: new Date().toISOString()
    });
    return { applied: true, duplicate: false, stale: false, ignored: false, unrecognized: false };
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

// Returns a reason code when (provider, instance) does not match the record.
// strictInstance: an instance-bound record requires the same instance (a
// missing instance does not match); otherwise only two known instances that
// differ are a mismatch.
function scopeMismatch(record, provider, instanceId, { strictInstance = false } = {}) {
  if (record.provider != null && provider != null && record.provider !== provider) return "provider_mismatch";
  if (record.provider != null && provider == null && strictInstance) return "provider_mismatch";
  if (record.instance_id != null) {
    if (instanceId == null) return strictInstance ? "instance_mismatch" : null;
    if (String(instanceId) !== record.instance_id) return "instance_mismatch";
  }
  return null;
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
  // Only explicit status fields count; the event_type label is not a status.
  const raw = String(metaStatus ?? evolutionStatus ?? "").toLowerCase();

  if (raw.includes("read")) return "READ";
  if (raw.includes("deliver")) return "DELIVERED";
  if (raw.includes("sent") || raw.includes("server_ack") || raw.includes("device_ack")) return "SENT";
  if (raw.includes("fail") || raw.includes("error")) return "FAILED";
  return null;
}
