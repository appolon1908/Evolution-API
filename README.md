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

Setting both is a configuration error. Instance names are compared trimmed; every secret must be a non-blank string. The header is compared in constant time with the secret of the instance named in the body (`instance`, else `instanceName`) **before** anything is applied, forwarded or logged. An unmapped instance, a missing or wrong header and an unparseable body all get the same `401 invalid_webhook_secret`. Even with a valid secret, an event for another instance's message is ignored by the state scope check.

The legacy single `EVOLUTION_WEBHOOK_SECRET` is honoured only when `EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET=true` (default `false`), and then only for instances that have no secret of their own. Existing deployments that set only `EVOLUTION_WEBHOOK_SECRET` therefore reject every Evolution webhook (fail closed) until they configure the map or opt in; `/readyz` warns `evolution_webhook_legacy_secret_ignored` in that case.

`/readyz` blocks (503) on `evolution_webhook_secrets_ambiguous`, `_unreadable`, `_invalid_json` or `_invalid`, on `evolution_webhook_legacy_secret_missing` (flag on, secret blank), and on `evolution_webhook_secret_missing` when Evolution sending is configured but no secret applies. It reports `webhooks.evolution.{configured, instances, legacy_shared_secret_enabled}`; values are never returned or logged.

## Connection and memory limits

Each open connection can hold up to 3 MiB of a not-yet-authenticated Meta webhook body (1 MiB on every other route) while it is read, before the signature is checked. The adapter therefore bounds the HTTP server:

| Env | Default | Effect |
|---|---|---|
| `HTTP_MAX_CONNECTIONS` | 128 | Connections beyond this are dropped unserved; worst-case body memory is about 128 x 3 MiB = 384 MiB. |
| `HTTP_HEADERS_TIMEOUT_MS` | 10000 | Request headers must arrive within this time (clamped to the request timeout). |
| `HTTP_REQUEST_TIMEOUT_MS` | 30000 | The whole request, body included, must arrive within this time, otherwise 408 and the connection is closed. |

These are a backstop, not the primary control. At the ingress (reverse proxy / load balancer) in front of the adapter, recommended settings are:

- body size: at most 3 MiB on `/internal/v1/whatsapp/webhooks/meta`, at most 1 MiB elsewhere;
- per-client and total concurrent connections to the adapter well below `HTTP_MAX_CONNECTIONS`, with request buffering so slow senders are absorbed by the proxy;
- client body/header timeouts no longer than the adapter's;
- the `/internal/v1/whatsapp/transport/*` routes reachable only from Middleware, never from the public internet.

## Run

```powershell
node src/server.mjs
node --test
```

See `.env.example` and `openapi.yaml`.
