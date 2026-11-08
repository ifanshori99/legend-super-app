# Sub-brief: DOIT PaymentProvider (bead legend-b9i)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-provider`, branch `ws/doit-provider`. Do not switch branch, commit, push or stash. Never read `.env*` or any real DOIT credential. Heavy commands (build, docker) go through `heavy <cmd>`.

PRD v1.7 `docs/PRD.md`: §3 F13 lines 679-686, PAY-02/03/06 lines 703-707, `gateway_webhook_events` line 1768. Conventions: `AGENTS.md`, `docs/plan/contracts.md` (Adapters section). Money is whole rupiah integers. Comments in English, user-facing error messages in Indonesian like the existing code.

## Existing pieces to build on (read these, do not re-invent)

- Port: `apps/api/src/services/payment-gateway.ts` — `PaymentGatewayPort` (health, createIntent, getStatus, channels, optional methods), `GatewayPaymentMethod`, `setPaymentGateway`. Already extended for this bead; do not change its shape without saying so.
- Settlement: `apps/api/src/services/payment.service.ts` — `confirmPayment(context, intentId, {source:"verified_webhook"|"gateway_status",...})` (:~890), private `syncPendingIntent` (:~778, polling path), `expireDueIntents` (:~1304), private `expireIntent`/`failIntent`, evidence dedupe by providerRef. Lifecycle rules: `payment-lifecycle.ts` `decidePaymentConfirmation`.
- Credentials: `apps/api/src/services/platform-integration.service.ts` `loadActiveIntegrationCredentials(context, "doit", outletId)` (outlet row wins over tenant row, null = fail closed) and `listIntegrations`. Do not edit that file.
- Webhook route pattern: `apps/api/src/routes/identity-wa-webhook.routes.ts` (raw bytes, verify before parse) and its mount in `apps/api/src/app.ts` (~line 218, before `/api` tenant middleware).
- HMAC helpers: `packages/shared/src/adapters/hmac.ts` pattern; Node `crypto.timingSafeEqual` is fine in the API.
- Tenant context for a webhook: `establishTenantContext({tenantId, brandId:null, source:"webhook"})` + `establishScopedTenantContext(tenant, {kind:"tenant"})`, then `withTenant(db, context, tx => …)` (see `identity-wa-inbound.service.ts:~460`).
- Test pattern: `apps/api/src/test/payment-api.test.ts` (createApp, fixtures, FakeGateway at :107, `setPaymentGateway`), RLS pattern `payment-admin-rls.test.ts`. Run one file: `cd apps/api && npx vitest run src/test/<file>` (needs the test Postgres; see `docs/local-development.md`).

## Design (decided — implement exactly)

### S1 Schema + migration (owner: implementer A)

New file `apps/api/src/db/schema/payment-gateway-webhook.ts`, exported from the schema index. Drizzle object `gatewayWebhookEvents`, table `gateway_webhook_events`:
`id uuid pk default random`, `tenant_id uuid not null → tenants`, `outlet_id uuid null` (filled once the intent is known), `integration_id uuid null` (tenant_integrations row whose secret verified it), `provider varchar(20) not null` (check `'doit'`,`'duitku'`), `event_id varchar(200) null` (null when the signature failed), `event_type varchar(60) null`, `signature_valid boolean not null`, `payload_hash char(64) not null` (sha256 hex of raw bytes), `payload jsonb null` (only when the signature is valid), `provider_ref varchar(100) null`, `payment_intent_id uuid null` (composite FK `(tenant_id, payment_intent_id)` like other payment tables if they use that pattern), `status varchar(20) not null default 'received'` check `received|processed|ignored|failed|rejected`, `attempts integer not null default 0`, `last_error_code varchar(64) null`, `received_at timestamptz not null default now()`, `processed_at timestamptz null`, `created_at`, `updated_at`.
Indexes: unique `(tenant_id, provider, event_id) WHERE signature_valid AND event_id IS NOT NULL`; index `(tenant_id, status, received_at)`; index `(tenant_id, provider, provider_ref)`.
Migration: `pnpm --filter <api pkg> db:generate` (number after 0062) and a custom RLS migration (`drizzle-kit generate --custom`) with `SELECT app.enforce_tenant_rls('public.gateway_webhook_events'::regclass);` modelled on `drizzle/0031_payment_admin_rls.sql` / `0021_payment_rls.sql` (grants included if those files grant). Never hand-edit `_journal.json`. Prove with migrate on a fresh test DB.

### S2 DOIT adapter (owner: implementer C) — `apps/api/src/services/payment-doit.ts` (+ `payment-doit-wire.ts`)

`createDoitGateway(options?: { fetch?: typeof fetch; loadCredentials?: (context, outletId) => Promise<{integration:{id:string; outletId:string|null; config:Record<string,unknown>}; credentials:Record<string,string>} | null>; now?: () => Date }): PaymentGatewayPort & { verifyWebhook(...) }` with `provider = "doit"`.

- Credentials (sealed fields): `apiKey`, `webhookSecret`. Config (non-secret): `baseUrl` (must be `https://` unless NODE_ENV=test), optional `merchantCode`. No row / missing field / bad baseUrl → health `down`, create/getStatus throw `CoreError("SERVICE_UNAVAILABLE", …)` (fail closed). Default loader = `loadActiveIntegrationCredentials(context, "doit", null)`; when `GatewayIntentRequest.context` is outlet-scoped to one outlet, use that outlet id.
- Every request: `Authorization: Bearer <apiKey>`, `Accept/Content-Type: application/json`, timeout 10 s (AbortSignal.timeout). Every POST: `Idempotency-Key: <request.idempotencyKey>` (DOIT-side retries reuse it). GETs carry no key.
- Wire format (ASSUMED until DOIT sandbox docs, bead legend-s5c; keep ALL of it in `payment-doit-wire.ts` with zod schemas and one comment block saying so):
  - `GET {baseUrl}/v1/payment-methods` → `{ data: [{ method: "qris"|"virtual_account"|"bank_transfer"|"ewallet"|"card"|string, channel_code: string|null, channel_name: string|null, enabled: boolean }] }` — unknown methods ignored. Map `virtual_account`→`va`. Group channels per method. Cache per integration id 60 s. Also used as `health` (ok → `healthy`, failure → `down`; reuse `PaymentGatewayStatus` values from shared).
  - `POST {baseUrl}/v1/payments` body `{ reference: intentId, amount: amountIdr, currency: "IDR", method: "qris"|"virtual_account"|"bank_transfer", channel_code: channelCode|null, expires_at }` → payment object.
  - `GET {baseUrl}/v1/payments/{id}` → payment object.
  - Payment object: `{ id, reference, status: "pending"|"paid"|"expired"|"failed"|"cancelled", amount, paid_amount: number|null, expires_at, qr_string?, va_number?, channel_code?, channel_name?, account_number?, account_name?, unique_code?, transfer_amount? }`.
  - Map to `GatewayIntent.instructions` per `packages/shared/src/payment/index.ts` `paymentInstructionsSchema` (qris: qrPayload, issuer null; va; bank_transfer with uniqueCode + transferTotalIdr = transfer_amount). Parse with that schema; malformed provider answer → `CoreError("SERVICE_UNAVAILABLE")`, no partial data.
  - Status mapping: `cancelled`→`failed`. `amountIdr` in `GatewayPaymentStatus`: for `paid` = `amount` (the intent amount) when `paid_amount` equals `amount` (qris/va) or equals `transfer_amount` (bank transfer: the unique code is absorbed, not owed by the bill); any other paid amount → report it raw (`paid_amount`) so the lifecycle flags the mismatch; `paid_amount` null → `null` (fail closed, existing rule).
  - Methods `ewallet`/`card` or any method `methods()` reports disabled → `CoreError("VALIDATION_ERROR", …)` before any HTTP call.
  - Non-2xx: 4xx → `CoreError("VALIDATION_ERROR")` for 400/422, `IDEMPOTENCY_KEY_REUSED` for 409, else `SERVICE_UNAVAILABLE`. Never include the response body, headers, apiKey or webhookSecret in an error message, log line or thrown object (PAY-06). No `console.*`; use the API logger only with ids/status codes.
- Webhook verification `verifyDoitSignature({ rawBody: Buffer, header: string|undefined, secrets: readonly string[], now: Date }): boolean` in the wire file. ASSUMED header format `PayBridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw bytes)>`; reject when missing/malformed, `|now−t| > 300 s`, or no secret matches (constant-time compare). Also export `signDoitWebhook(rawBody, secret, now)` for tests.
- Webhook payload (ASSUMED): `{ id: <event id>, type: "payment.paid"|"payment.expired"|"payment.failed"|string, created_at, data: <payment object> }` → zod `doitWebhookEventSchema` exported from the wire file.
- Bootstrap: install `setPaymentGateway(createDoitGateway())` in `apps/api/src/server.ts` (process entry, NOT `createApp`, so tests keep their fakes); also wherever the worker needs it (`worker-main.ts`) if the poll job runs there.

### S3 Webhook service + polling (owner: implementer D) — `apps/api/src/services/payment-webhook.service.ts` (+ small exports in `payment.service.ts`)

`receiveDoitWebhook({ tenantId: string, rawBody: Buffer, signatureHeader: string|undefined, now?: Date, gateway?: DoitGateway }): Promise<{ status: "processed"|"duplicate"|"ignored"|"failed"; eventId: string }>`; throws `CoreError("UNAUTHORIZED", "Tanda tangan webhook tidak valid.")` (one message, no oracle) for any verification failure.

1. Tenant must exist and be active; else UNAUTHORIZED (same message). Context = webhook source, tenant-wide scope.
2. Secrets = `webhookSecret` of every active DOIT integration of the tenant (use `listIntegrations` + `loadActiveIntegrationCredentials` per outletId; dedupe). None → `SERVICE_UNAVAILABLE`.
3. Verify. Invalid → insert one row `signature_valid=false, status='rejected', payload_hash, payload null, event_id null` then throw UNAUTHORIZED. Nothing else changes.
4. Valid → parse JSON + `doitWebhookEventSchema`; malformed → 400 `VALIDATION_ERROR`, row stays `rejected`? No: store a `signature_valid=true,status='failed',last_error_code='MALFORMED'` row with event_id when readable.
5. STORE FIRST: `INSERT … ON CONFLICT (tenant_id, provider, event_id) WHERE … DO NOTHING`; on conflict load the existing row: `processed`/`ignored` → return `duplicate` (no side effect); `received`/`failed` → reprocess it (retry path).
6. PROCESS: find intent by `(tenant_id, provider='doit', provider_ref = data.id)` inside the tenant (RLS); not found → `ignored` (`last_error_code='UNKNOWN_REFERENCE'`). The payload status is the truth, not arrival order:
   - `paid` → `confirmPayment(context, intent.id, { source:"verified_webhook", method:intent.method, amountIdr: <mapped as S2>, providerRef: data.id, at: data.paid_at ?? created_at })`. Settled duplicates are no-ops via existing evidence dedupe; paid-after-expired is handled by the lifecycle (late payment).
   - `expired`/`failed`/`cancelled` → new exported `applyGatewayFailure(context, intentId, "expired"|"failed", now)` in `payment.service.ts` that only acts while the intent is still `pending` (re-read under row lock); a paid intent is never downgraded.
   - `pending` → no-op `processed`.
     Mark row `processed` + `processed_at`, `payment_intent_id`, `outlet_id`, `provider_ref`, `attempts+1`; on an error mark `failed` + `last_error_code` (code only) and rethrow as 500 so DOIT retries.
7. POLLING FALLBACK: exported `pollPendingGatewayIntents(context, now = new Date(), limit = 100): Promise<{checked:number; settled:number}>` in `payment.service.ts` — pending intents with `provider_ref` not null and `created_at < now − 60 s`, run the existing `syncPendingIntent` path for each (gateway errors skipped, as today). Plus `reprocessStoredWebhookEvents(context, now, limit)` in the webhook service for rows `received`/`failed` older than 60 s with attempts < 10. Wire both into the worker if there is a per-tenant periodic job runner pattern (`apps/api/src/worker/*.job.ts`); new job file `apps/api/src/worker/payment-gateway-poll.job.ts` is in scope.

### S4 Route (owner: implementer E) — `apps/api/src/routes/payment-webhook.routes.ts`

`createPaymentWebhookRouter(options?: { receive?: typeof receiveDoitWebhook })` mounted in `app.ts` at `/api/webhooks/payments` next to the WhatsApp mount (one-line mount; before tenant middleware and body parsers). `POST /doit/:tenantId`: `tenantId` must be a uuid (else 404, no body echo); content-type `application/json` (else 415); raw body via `express.raw` with `BODY_LIMIT_BYTES`; read only the `PayBridge-Signature` header; call `receiveDoitWebhook`; answer `200 { received: true, status }`. UNAUTHORIZED → 401 with one fixed message. No session/CSRF/origin checks on this path (verify how WhatsApp is excluded and mirror it). Never log the raw body or header.

### S5 Tests (owners: test-writer F, test-writer G)

F `apps/api/src/test/payment-doit.test.ts` (adapter, no DB needed except creds loader stub): fake DOIT server = real `http.createServer` on 127.0.0.1 random port (baseUrl http allowed in test), injected via `loadCredentials`. Cases: methods list mapping (va/bank_transfer channels, unknown ignored, cache), create QRIS/VA/bank transfer → instructions; Bearer + Idempotency-Key present on POST and same key on retry; ewallet/card refused without HTTP; disabled method refused; getStatus mapping incl. unique-code transfer, mismatch, paid_amount null; 4xx/5xx/malformed/timeout → right CoreError; no creds → health down + 503; signature verify valid/wrong secret/stale/malformed/rotation; secrets never appear in thrown errors or captured logger/console output.
G `apps/api/src/test/payment-webhook-api.test.ts` + `apps/api/src/test/payment-webhook-rls.test.ts` (DB): seed a DOIT integration per tenant via the platform integration service (fake apiKey/webhookSecret), create intents through the existing link flow with a fake/real DOIT gateway (fake DOIT HTTP server), then via HTTP route: valid paid → intent paid once; duplicate event id → no second evidence/money row; two different event ids for same payment → still once; out of order (paid then expired, expired then paid) → ends paid; invalid/missing/stale signature → 401, intent unchanged, rejected row stored; tenant B URL with tenant A's secret → 401; tenant B valid signature referencing tenant A's provider_ref → ignored, A unchanged; polling fallback (no webhook, fake DOIT says paid → `pollPendingGatewayIntents` settles); stored `received` row reprocessed; log capture: apiKey/webhookSecret never in logs or responses. RLS file: `gateway_webhook_events` as `legend_app` — tenant A cannot read/insert/update B's rows, tenant_id NOT NULL.

## Done means

Your files compile (`cd apps/api && npx tsc --noEmit -p .` or the repo's typecheck), your tests pass, prettier clean on your files. Report: files changed, commands run + result, any assumption you had to make.

## Fix wave 1 (from reviewer + architect, all real — implement exactly)

Lifecycle rule stays: a `failed` intent is never revived (`payment-lifecycle.test.ts:105`). Do not change `payment-lifecycle.ts`.

### F-A `services/payment-webhook.service.ts` (owner I1)

1. Bind the event to the intent: look up by `provider_ref = data.id` AND `id = data.reference` (uuid-parse; invalid → mismatch). Require `data.amount === intent.amountIdr`. Require the integration whose secret verified the signature to be the one `loadActiveIntegrationCredentials(ctx,"doit",intent.outletId)` resolves for that intent's outlet. Any mismatch → row `ignored`, `last_error_code='REFERENCE_MISMATCH'`, answer 200, no side effect.
2. Bank transfer amount: absorb the unique code only when `transfer_amount - amount === Number(unique_code)` and that equals the intent's stored `instructions.uniqueCode` (if stored); otherwise pass the raw paid amount so the lifecycle flags the mismatch.
3. Deterministic rejects (`confirmPayment` 409 from `reject` decisions: INVALID_TRANSITION, AMOUNT_MISMATCH, UNTRUSTED_CONFIRMATION) are not retried: mark row `ignored` with `last_error_code='REJECTED_<code>'`, answer 200. For a `paid` event on a `failed`/`cancelled` intent, money arrived on a dead intent: record it for manual follow-up using the existing unallocated-funds or reconciliation-case path (read `payment-unallocated.service.ts`, `payment-admin-reconciliation.service.ts`; use an existing reason/kind value, no schema change to existing tables). If no existing path fits without a schema change, keep only the `ignored` row and say so in your report.
4. `UNKNOWN_REFERENCE` is retryable for 15 minutes after `received_at`: mark `failed` (reprocessed by the worker); after that `ignored`.
5. One answer for every pre-verification failure: unknown tenant, inactive tenant, tenant with no DOIT secret, bad signature → the same `CoreError("UNAUTHORIZED", "Tanda tangan webhook tidak valid.")`. No 503 there.
6. Store the parsed, schema-validated event as `payload` (not the raw JSON with unknown fields).
7. Cache each tenant's webhook secrets in memory for 60 s (Map keyed by tenantId, value + expiry; export a `clearDoitWebhookSecretCache()` for tests).
8. Rejected rows: insert with `ON CONFLICT (tenant_id, payload_hash) WHERE NOT signature_valid DO NOTHING` (index added by I4, name `gateway_webhook_events_rejected_hash_uq`).
9. Export `purgeRejectedWebhookEvents(context, now, olderThanDays = 30)` deleting `rejected` rows older than that.

### F-B `services/payment-doit.ts` + `payment-doit-wire.ts` (owner I2)

1. `getStatus`: the provider payment's `reference` must equal the intent id. Add optional `intentId?: string` to the `getStatus` input in `payment-gateway.ts` (you own that edit); when given and different → throw `CoreError("SERVICE_UNAVAILABLE")` (treated as gateway error, nothing settles).
2. Unique code bound: in the wire mapping, absorb only when `transfer_amount - amount === Number(unique_code)` (and `unique_code` present, 3–6 digits); otherwise report raw `paid_amount`.
3. SSRF: `baseUrl` must be `https:`, no credentials, no port other than default, hostname not an IP literal (v4/v6), not `localhost`, not ending `.local`/`.internal`; reuse `publicHttpsUrlSchema` from `packages/shared/src/adapters/safety.ts` if it fits. `http://127.0.0.1` stays allowed only when `NODE_ENV === "test"` (existing tests). Update `test/payment-doit.test.ts` for any changed behaviour and add cases for 1–3.

### F-C `services/payment.service.ts` (owner I3)

1. `syncPendingIntent`: when a pending intent is past `expiresAt` and has `providerRef`, ask the gateway first (pass `intentId`); `paid` with amount → settle (late payment per lifecycle); anything else or gateway error → expire as today.
2. `pollPendingGatewayIntents`: time budget 20 s per run and stop the run after 3 consecutive gateway errors; return `{checked, settled}` as now. Pass `intentId` into `getStatus` calls (I2 adds the optional field).

### F-D migration + route + job (owner I4)

1. Schema `db/schema/payment-gateway-webhook.ts`: partial unique index `gateway_webhook_events_rejected_hash_uq` on `(tenant_id, payload_hash) WHERE NOT signature_valid`. `pnpm db:generate` → new migration (0065). Never hand-edit the journal. Prove on a fresh DB.
2. `routes/payment-webhook.routes.ts`: in-memory fixed-window limiter before the raw body read: 120 requests/min per tenantId and 60/min per client IP (`req.ip`); over limit → 429 `RATE_LIMITED` with no body echo. Reuse an existing limiter helper in `apps/api/src/middleware` if one exists. Export a reset for tests.
3. `worker/payment-gateway-poll.job.ts`: also call `purgeRejectedWebhookEvents(context, now)` (I1 exports it) as an independent step.

## Fix wave 2 (fresh reviewer, all real — implement exactly)

### G-A `services/payment-webhook.service.ts` (owner I1)

1. Money that arrives but cannot settle is never dropped. A `paid` event rejected with `AMOUNT_MISMATCH` (underpaid or overpaid on any intent state) records evidence + an unallocated-funds row for the paid amount through the same path as `recordFundsOnClosedIntent` (pick the closest existing reason value; say which). A `paid` event with null/zero `paid_amount` (`AMOUNT_MISSING`) is NOT `ignored`: mark it `failed` with `last_error_code='AMOUNT_MISSING'` so it stays visible for manual review and is retried by the worker (DOIT may resend with an amount).
2. Retry by time, not attempt count: `reprocessStoredWebhookEvents` picks `received`/`failed` rows whose next attempt is due: `updated_at + min(2^attempts, 60) minutes <= now`, and only while `received_at > now - 24 h`. Rows older than 24 h that are still `failed` stay `failed` (manual review). `UNKNOWN_REFERENCE` older than 15 min → `ignored` when reprocessed.

### G-B `services/payment-doit.ts` (owner I2)

DNS rebinding / SSRF: before each request (outside `NODE_ENV=test` with local http), resolve the base URL hostname with `dns.promises.lookup(host, { all: true })` and refuse (fail closed, `SERVICE_UNAVAILABLE`, no detail) when any answer is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT 100.64/10, unique-local fc00::/7, unspecified, multicast, or IPv4-mapped forms of those. Reuse an existing helper if the repo has one. Add unit tests in `test/payment-doit.test.ts` with an injectable `lookup` option.

### G-C `services/payment.service.ts` (owner I3)

In the past-expiry branch of `syncPendingIntentDetailed`: if settling the gateway's `paid` answer throws (409 / reject), catch it and fall through to expiring the intent, so the link view never answers 409 for this.

### G-D `routes/payment-webhook.routes.ts` (owner I4)

Never rate-limit a correctly signed delivery. Remove the per-tenant bucket. Keep a per-IP bucket that counts only failed verifications (401 answers): when an IP has more than 30 failed verifications in the current minute, answer 429 before reading the body. Successful deliveries do not consume the bucket. Keep `resetPaymentWebhookRateLimits`.
