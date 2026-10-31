// Secret-safe default logger: callers pass only ids, provider/instance names
// and reason codes, never payloads, headers or configuration values.
export function defaultLogger(entry) {
  console.warn(JSON.stringify({ level: "warn", service: "codestra-evolution-adapter", ...entry }));
}

// Records with no tenant (webhook-first records: inbound fromMe=false
// receipts, statuses for messages never sent through this adapter, or a
// status that arrived before provider.send() returned) are never readable
// through tenant readback, and inbound receipts are never bound to a tenant,
// so they are evicted: after TENANTLESS_TTL_MS from creation, and oldest
// first beyond TENANTLESS_MAX records. Tenant-bound records are never
// evicted by this. A record leaves the eviction queue when a send binds it
// to a tenant.
export const TENANTLESS_TTL_MS = 15 * 60 * 1000;
export const TENANTLESS_MAX = 10000;

export function createMessageState({
  logger = defaultLogger,
  // Monotonic milliseconds: a wall-clock step must not expire or keep
  // records early/late. Injectable for tests.
  now = () => performance.now(),
  tenantlessTtlMs = TENANTLESS_TTL_MS,
  tenantlessMax = TENANTLESS_MAX
} = {}) {
  const messages = new Map();
  // provider_message_id -> creation time (ms), oldest first (insertion order).
  const tenantless = new Map();

  function evict(key) {
    tenantless.delete(key);
    // Defensive: only ever drop a record that is still tenantless.
    if (messages.get(key)?.tenant_id == null) messages.delete(key);
  }

  function pruneTenantless() {
    const cutoff = now() - tenantlessTtlMs;
    for (const [key, createdAt] of tenantless) {
      if (tenantless.size <= tenantlessMax && createdAt > cutoff) break;
      evict(key);
    }
  }

  // Stores a record and keeps the tenantless queue in step with it.
  function store(key, record, { fresh = false } = {}) {
    messages.set(key, record);
    if (record.tenant_id != null) {
      tenantless.delete(key);
    } else if (fresh || !tenantless.has(key)) {
      tenantless.delete(key);
      tenantless.set(key, now());
      pruneTenantless();
    }
  }

  // A status webhook can arrive before provider.send() returns; never let the
  // send acknowledgement regress a state that is already further along.
  // tenantId: the tenant of the authenticated send request; readback is bound to it.
  // instanceId: the provider instance (Evolution instance / Meta phone_number_id)
  // the message was sent from; later webhooks must come from the same one.
  function rememberAccepted(result, { tenantId = null, instanceId: rawInstanceId = null } = {}) {
    const instanceId = normInstance(rawInstanceId);
    const id = result?.provider_message_id;
    if (!id) return;
    const key = String(id);
    pruneTenantless();
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
    store(key, {
      ...existing,
      provider_message_id: key,
      tenant_id: existing?.tenant_id ?? tenantId ?? null,
      provider,
      instance_id: existing?.instance_id ?? instanceId,
      state: existing?.state ?? "ACCEPTED",
      updated_at: existing?.updated_at ?? new Date().toISOString()
    }, { fresh: existing === undefined });
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
    pruneTenantless();
    const existing = messages.get(String(id));
    const eventInstance = normInstance(event?.instance_id);
    const mismatch = existing && scopeMismatch(existing, event?.source ?? null, eventInstance, { strictInstance: true });
    if (mismatch) {
      logger({ event: "webhook_scope_mismatch", reason: mismatch, source: event?.source ?? null });
      return { applied: false, duplicate: false, stale: false, ignored: true, unrecognized: false };
    }
    const next = deriveState(event);
    // Unrecognised statuses (e.g. Evolution PENDING, inbound messages)
    // carry no delivery progress: never "duplicate", never create a record.
    if (next === null) return { applied: false, duplicate: false, stale: false, ignored: false, unrecognized: true };
    if (existing?.state === next) return { applied: false, duplicate: true, stale: false, ignored: false, unrecognized: false };
    if (existing && !advances(existing.state, next)) return { applied: false, duplicate: false, stale: true, ignored: false, unrecognized: false };
    const current = existing ?? {
      provider_message_id: String(id),
      tenant_id: null,
      provider: event?.source ?? null,
      instance_id: eventInstance
    };
    store(String(id), {
      ...current,
      state: next,
      updated_at: new Date().toISOString()
    }, { fresh: existing === undefined });
    return { applied: true, duplicate: false, stale: false, ignored: false, unrecognized: false };
  }

  function get(id) {
    pruneTenantless();
    return messages.get(String(id)) ?? null;
  }

  // Test/ops hook: record counts (no ids or payloads).
  function size() {
    return { records: messages.size, tenantless: tenantless.size };
  }

  // Tenant-scoped readback: records with no tenant (e.g. webhook-only, never
  // sent through this adapter) or another tenant's records are not visible.
  function getForTenant(id, tenantId) {
    const record = get(id);
    if (!record || !tenantId || record.tenant_id !== tenantId) return null;
    return record;
  }

  return Object.freeze({ rememberAccepted, applyEvent, get, getForTenant, size });
}

// Returns a reason code when (provider, instance) does not match the record.
// strictInstance: an instance-bound record requires the same instance (a
// missing instance does not match); otherwise only two known instances that
// differ are a mismatch.
// Instance ids are compared trimmed, as the providers use them (the Evolution
// provider trims instance_id before calling sendText); blank means absent.
function normInstance(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function scopeMismatch(record, provider, rawInstanceId, { strictInstance = false } = {}) {
  const instanceId = normInstance(rawInstanceId);
  if (record.provider != null && provider != null && record.provider !== provider) return "provider_mismatch";
  if (record.provider != null && provider == null && strictInstance) return "provider_mismatch";
  if (record.instance_id != null) {
    if (instanceId == null) return strictInstance ? "instance_mismatch" : null;
    if (instanceId !== record.instance_id) return "instance_mismatch";
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

  // PLAYED (Evolution renderStatus 5: a voice/video message was played) is a
  // terminal success like READ (owner decision 2026-10-30).
  if (raw.includes("read") || raw.includes("played")) return "READ";
  if (raw.includes("deliver")) return "DELIVERED";
  if (raw.includes("sent") || raw.includes("server_ack") || raw.includes("device_ack")) return "SENT";
  if (raw.includes("fail") || raw.includes("error")) return "FAILED";
  return null;
}
