# Provider-scoped phone enrollment — release preconditions

The private enrollment adapter requires a 24+ character service key and explicit PROVIDER_ENROLLMENT_ENABLED=true for actual enrollment operations. Default is false; EXTERNAL_SEND_ENABLED and FORWARD_EVENTS_ENABLED also default false.

Meta Business official operations use only validated configured Graph version and a scoped server-managed token. The caller-supplied WABA must appear in the META_ALLOWED_WABA_IDS allowlist. Before a request-code, verification or registration effect, the adapter obtains the approved WABA phone_numbers list and confirms that the requested phone ID belongs to the WABA. Unapproved WABAs or mismatching numbers fail with no provider effect. The request-code payload uses code_method and locale, as documented by Meta; verify_code and register use separate validated one-time code and six-digit PIN parameters. Never persist verification codes or PINs.

Evolution QR operations require a configured trusted HTTPS EVOLUTION_BASE_URL, a scoped EVOLUTION_API_KEY, and an allowlisted EVOLUTION_INSTANCE_PREFIX. The upstream API version must be pinned and certified with real instance create, QR, connection-state and webhook behavior before activation. No raw pairing code or token is exposed to the frontend or retained by the registry; only bounded transient PNG QR image responses are allowed.

Caution: Meta Cloud API is the official business messaging route. Evolution Baileys QR sessions are not equivalent to Meta's official registration and have different platform and operational risks.

Production remains blocked until a real Meta Business app, token, WABA and phone number, or an approved Evolution deployment and owned test phone, can be verified with explicit user authorization. Even then, enrollment does not authorize customer message sends. Signed webhook validation, consent, audit, replays, Middleware command registration and independent production approval remain required.

References:
Meta https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
Evolution https://docs.evoapicloud.com/api-reference/instance-controller/instance-connect
