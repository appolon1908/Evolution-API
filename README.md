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

## Run

```powershell
node src/server.mjs
node --test
```

See `.env.example` and `openapi.yaml`.
