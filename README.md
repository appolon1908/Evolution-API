# Codestra Evolution Adapter

Thin WhatsApp provider adapter behind **Middleware V3 :8095**.

## Authority boundary

Middleware V3 owns command lifecycle, idempotency, durable ledger/outbox/workers, retries, DLQ/replay, reconciliation, audit and policy. This repository does not duplicate those capabilities.

This adapter owns only provider-specific concerns:

- Meta Cloud API / Evolution-Baileys request translation
- instance/session identifiers
- provider message IDs
- webhook verification/parsing
- delivery/read normalization
- provider health/readiness
- provider-specific telemetry hooks

Public/business callers never use provider endpoints directly.

## Safe defaults

`EXTERNAL_SEND_ENABLED=false` and `FORWARD_EVENTS_ENABLED=false` by default.

## Known limitation: Meta batch forwarding

With `FORWARD_EVENTS_ENABLED=true`, the items of a batched Meta webhook are forwarded to Middleware sequentially under one per-webhook deadline (`WEBHOOK_FORWARD_DEADLINE_MS`, default 8000 ms). When the deadline is exceeded the adapter answers 503 and Meta redelivers the whole batch from its first item, so a batch whose total forward time always exceeds the deadline (for example 1000 items at more than 8 ms each) never completes, and its tail is never forwarded before Meta stops retrying after 7 days. Redelivery itself is safe (state is monotonic; Middleware dedupes). Keep forwarding disabled at volume until the forwarding design (bounded-parallel forwarding, a single batched Middleware call, or a Middleware latency SLO) is decided.

## Evolution webhook authentication

Upstream Evolution sends no body signature. The adapter requires a shared-secret header, `x-codestra-webhook-secret`, which the operator puts in each instance's **per-instance** webhook `headers`. Evolution's global webhook sends no custom headers and therefore cannot be used.

Each instance has its own secret, configured as a JSON object `{"<instanceName>": "<secret>"}`:

- `EVOLUTION_WEBHOOK_SECRETS_FILE`: path to a file with that JSON (preferred: a mounted secret file rendered from the secret store), or
- `EVOLUTION_WEBHOOK_SECRETS`: the same JSON inline.

Setting both is a configuration error. Instance names are compared trimmed; every secret must be a non-blank string.

The map is read **once at startup**: rotating or adding an instance secret requires a restart (roll replicas one at a time, and set the new secret in Evolution's per-instance webhook headers in the same window). The adapter does not check the file's permissions; mount it read-only and owned by the adapter's user with mode `0600` (or `0400`), never world-readable. The header is compared in constant time with the secret of the instance named in the body (`instance`, else `instanceName`) **before** anything is applied, forwarded or logged. An unmapped instance, a missing or wrong header and an unparseable body all get the same `401 invalid_webhook_secret`. Even with a valid secret, an event for another instance's message is ignored by the adapter's in-memory state scope check, **but it is still forwarded** to Middleware (with `FORWARD_EVENTS_ENABLED=true`). Middleware must therefore scope every forwarded event itself: join on `(provider, event.instance_id, provider_message_id)` against its own command row and drop events whose `instance_id` does not match. Use `event.instance_id` (the trimmed instance whose secret was verified), never `provider_payload.data.instanceId` (Evolution's internal UUID, not authenticated).

The legacy single `EVOLUTION_WEBHOOK_SECRET` is honoured only when `EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET=true` (default `false`), and then only for instances that have no secret of their own. Existing deployments that set only `EVOLUTION_WEBHOOK_SECRET` therefore reject every Evolution webhook (fail closed) until they configure the map or opt in; `/readyz` warns `evolution_webhook_legacy_secret_ignored` in that case.

`/readyz` blocks (503) on `evolution_webhook_secrets_ambiguous`, `_unreadable`, `_invalid_json` or `_invalid`, on `evolution_webhook_legacy_secret_missing` (flag on, secret blank), and on `evolution_webhook_secret_missing` when Evolution sending is configured but no secret applies. It reports `webhooks.evolution.{configured, instances, legacy_shared_secret_enabled}`; values are never returned or logged.

## Connection and memory limits

Each open connection can hold up to 3 MiB of a not-yet-authenticated Meta webhook body (1 MiB on every other route) while it is read, before the signature is checked. The adapter therefore bounds the HTTP server:

| Env | Default | Effect |
|---|---|---|
| `HTTP_MAX_CONNECTIONS` | 128 | Connections beyond this are dropped unserved; worst-case body memory is about 128 x 3 MiB = 384 MiB. |
| `HTTP_HEADERS_TIMEOUT_MS` | 10000 | Request headers must arrive within this time (clamped to the request timeout). |
| `HTTP_REQUEST_TIMEOUT_MS` | 30000 | The whole request, body included, must arrive within this time, otherwise 408 and the connection is closed. |

Dropped connections are logged as `{"event":"http_connection_dropped","reason":"max_connections","max_connections":N,"dropped":K}`: the first drop immediately, then at most one line per 10 s carrying the count since the previous line, without client addresses. Alert on it.

These are a backstop, not the primary control. At the ingress (reverse proxy / load balancer) in front of the adapter, recommended settings are:

- body size: at most 3 MiB on `/internal/v1/whatsapp/webhooks/meta`, at most 1 MiB elsewhere;
- per-client and total concurrent connections to the adapter well below `HTTP_MAX_CONNECTIONS`, with request buffering so slow senders are absorbed by the proxy;
- the proxy's upstream keep-alive pool to the adapter (e.g. nginx `keepalive`, Envoy `max_connections`) well below `HTTP_MAX_CONNECTIONS`, summed over all proxy replicas: idle keep-alive sockets count against the cap for up to the keep-alive timeout (about 5 s), and a connection over the cap is dropped with no HTTP response (Meta retries, so nothing is lost, only delayed);
- client body/header timeouts no longer than the adapter's;
- the `/internal/v1/whatsapp/transport/*` routes reachable only from Middleware, never from the public internet.

## Readiness (`GET /readyz`)

`/readyz` reads static configuration only (no network calls), so it does not flap. It returns 503 with `reasons` when the adapter cannot do its job:

- `adapter_service_token_missing`: `ADAPTER_SERVICE_TOKEN` is empty or whitespace. Every internal route (`/internal/v1/whatsapp/transport/*`) then answers 503, so Middleware cannot send or read back. This applies to **every** deployment, including a webhook-only one: a webhook-only deploy (no send, no readback) still serves its webhook routes but reports not-ready until a service token is set. That is intended for production, where Middleware needs send and readback; a deploy that really is webhook-only must either set a token or not gate traffic on `/readyz`.
- `middleware_event_url_missing`: `FORWARD_EVENTS_ENABLED=true` without `MIDDLEWARE_EVENT_URL`.
- `<provider>_webhook_secret_missing`, the Evolution secret-map codes (see above).

Non-blocking `warnings`: `meta_verify_token_missing` (only matters when (re)subscribing the Meta webhook) and `evolution_webhook_legacy_secret_ignored`.

## Tenantless records from inbound receipts (bounded)

Evolution also sends `messages.update` for messages the business *received* (`data.fromMe === false`, e.g. our read receipts of inbound messages). These apply to the in-memory state as webhook-only records with no tenant: they are never readable through readback, and they are still forwarded as before. Because no send ever binds them, every tenantless record is evicted **15 minutes after it was created** (a redelivery does not extend this), and beyond **10,000** tenantless records the oldest are evicted first. Records bound to a tenant by a send are never evicted by this; a webhook-first record (a status that arrived before `provider.send()` returned) leaves the eviction queue as soon as the send binds it. If a send binds an id only after its tenantless record was evicted, it starts fresh at `ACCEPTED`. State is process-local and lost on restart anyway.

## Open question: media keys

Redaction replaces Baileys `mediaKey` / `media_key` values in the payload copies that are echoed and forwarded to Middleware. `mediaKey` decrypts the WhatsApp media blob at the `mmg.whatsapp.net` URL. If Middleware needs to download inbound Evolution media itself from the forwarded payload, it cannot with the key redacted; it would instead have to ask Evolution for the decoded media by message key (for example Evolution's get-base64-from-media-message endpoint). This is not confirmed against Middleware. Meta media are unaffected (they are fetched by media id via the Graph API). Owner decision needed before inbound media handling ships.

## Run

```powershell
node src/server.mjs
node --test
```

See `.env.example` and `openapi.yaml`.
