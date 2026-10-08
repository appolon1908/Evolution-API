# Meta registration and Evolution QR provider adapter — staging

The adapter exposes an internal, service-authenticated phone enrollment interface only:

- `GET /internal/v1/whatsapp/enrollment/health` — requires `X-Enrollment-Service-Key`, reports configuration and effect gate.
- `POST /internal/v1/whatsapp/enrollment/execute` — requires the same service key and an approved action payload.

The key must contain at least 24 characters and is read from a mounted `ADAPTER_SERVICE_TOKEN_FILE`. Requests are private Docker-network service calls from Codestra WhatsApp. Provider secrets are read only from the adapter's environment/secret mounts and are **never accepted from the browser or returned in API responses**. Provider HTTP requests use explicit HTTPS base URLs, strict identifier validation, JSON-only bodies, bounded timeouts, no redirects, and sanitized provider errors.

### Official Meta Cloud API

After user-directed **Embedded Signup/WhatsApp Manager**, business ownership verification and WABA/phone-number creation, use these action handlers (gated behind `PROVIDER_ENROLLMENT_ENABLED`):

| Action | Graph API | Fields |
|---|---|---|
| `meta.phone-numbers` | GET `/{waba-id}/phone_numbers` | WABA ID |
| `meta.request-code` | POST `/{phone-number-id}/request_code` | SMS or VOICE method, language |
| `meta.verify-code` | POST `/{phone-number-id}/verify_code` | user-provided numeric code |
| `meta.register` | POST `/{phone-number-id}/register` | `messaging_product=whatsapp`, 6-digit PIN |

The adapter gets `META_ACCESS_TOKEN` and `META_GRAPH_VERSION` from protected configuration. A real registration is **an external provider effect** and is disabled in staging. A successful registration does not turn on WhatsApp message delivery.

Official reference: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api

### Existing number / Evolution QR

For configured trusted `EVOLUTION_BASE_URL` and `EVOLUTION_API_KEY`, support `evolution.create` via `POST /instance/create`, `evolution.qr` via `GET /instance/connect/{instance}`, and `evolution.status` via `GET /instance/connectionState/{instance}`. Instance names are strictly validated; QR results return only a bounded PNG image data URL if supplied. Raw pairing secrets and provider API keys are never returned or persisted. QR generation and instance creation remain gated OFF in staging.

Evolution documentation: https://docs.evoapicloud.com/api-reference/instance-controller/instance-connect

Version and upstream-specific endpoint behavior must be re-certified against the actual configured provider before enabling enrollment. QR linking is not an official Meta Cloud API registration and should be reviewed for platform compatibility.

**Default:** `PROVIDER_ENROLLMENT_ENABLED=false`, `EXTERNAL_SEND_ENABLED=false`, `FORWARD_EVENTS_ENABLED=false`. Do not bypass either effect gate.
