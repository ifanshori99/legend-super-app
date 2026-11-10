# Sub-brief 302: gateway registry + Duitku (shared context for subagents)

Main brief: `docs/briefs/302-payment-gateway-adapter-duitku.md` (read §Tujuan, §Asumsi aman, §Scope).
Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/gateway-adapter-duitku`, branch `ws/gateway-adapter-duitku`.
Never read `.env*`. Never push/merge. Tier K (money, credentials, webhook).
Design decisions: `docs/DECISIONS.md` section "302 gateway registry" (written by architect; implementers follow it).

## Map of what exists (paths under apps/api/src)

### Port + singleton
- `services/payment-gateway.ts`: `PaymentGatewayPort` {provider, health, createIntent, getStatus, channels, methods?, cancel?}; module singleton `setPaymentGateway`/`paymentGateway()` (:175-188), default `unconfiguredPaymentGateway`.
- DOIT: `services/payment-doit.ts` `createDoitGateway(options)` :284 (type `DoitGateway` :103 adds refund port, `verifyWebhook`, `lookupPayment`); creds via `loadActiveIntegrationCredentials(ctx,"doit",outletId)` / `loadIntegrationCredentialsById` (`platform-integration.service.ts:658,:706`), decrypt `openSecret(row.credentialsEncrypted, credentialAad(tenantId,id))`, `lib/secrets.ts` `sealSecret`/`openSecret` (AES-256-GCM). Wire/signature: `payment-doit-wire.ts` (`verifyDoitSignature` :591, `DOIT_SIGNATURE_TOLERANCE` :49 = 25h past / 5min future).
- Boot: `server.ts:44-46`, `worker-main.ts:149-151` call `setPaymentGateway(doitGateway)`; refund port `setPaymentRefundGateway` only if `env.DOIT_REFUNDS_ENABLED` (`payment-refund-gateway.ts:127`).
- Call sites of `paymentGateway()`: `payment.service.ts` 367, 403, 652, 711, 1240, 1931, 2040, 2215; `qr-order-payment.ts` 239, 279; `reservation-deposit-payment.ts:44`; `payment-failover.service.ts` 206, 430; `worker/payment-failover-probe.job.ts:73`; `payment-admin-config.service.ts` 217, 273. Refund: `payment-refund.service.ts` 1732, 1997 (`paymentRefundGateway()`).

### Routing
- `services/payment-routing.service.ts`: rule {outletId|null, method, provider, fallbackProvider|null, enabled}; `defaultRouting` :92 (online -> doit); `resolveRoutingRule` :110 (outlet > tenant > default). Used `payment.service.ts:347,:555`.
- Admin routing API: `routes/payment-admin.routes.ts:65` GET, `:78` PUT `/api/payments/admin/routing/:method` (perm `payment.edc.manage`); service `payment-admin-config.service.ts:183` get (providers list built from singleton :217), `:259` update (rejects provider != singleton :273, rejects any fallback). Contract `packages/shared/src/payment/admin.ts` :61 route, :80 view, :90 update input, :485/:494 endpoints, :684 providerFixtures (doit, duitku). UI `apps/web/src/features/ws05-payment-admin/` (DO NOT EDIT UI).

### Tenant integrations / platform
- `db/schema/platform-integrations.ts` `tenant_integrations`: provider varchar(30), config jsonb (non-secret), credentialsEncrypted, credentialSecretRef, credentialFields text[], credentialsSetAt/By, credentialsKeyVersion, status draft|active|disabled, lastCheckedAt.
- `services/platform-integration.service.ts`: upsertIntegration :399, setIntegrationStatus :525, rotateIntegrationCredentials :591, listIntegrations :361 (masked). Routes `routes/platform-integrations.routes.ts` :69-107 (no test-connection endpoint).
- `packages/shared/src/platform/integrations.ts:25-37` `INTEGRATION_PROVIDERS` (has duitku), `integrationCategoryOf` :43.
- Per-tenant package `tenants.feature_flags.integrationProviders[]` set by Super Admin (`platform.routes.ts:160`, `platform-org.service.ts:605` setTenantPackage, audit action `tenant.package_changed`). UI `ws01-platform-ops/components/kuota-page.tsx:330` GatewayEditor.
- Platform perms (`packages/shared/src/access/permissions.ts:50-53`): platform.tenant.manage, platform.package.manage, platform.integration.manage, platform.health.view. Audit: `recordAudit({...}, {tx, context})`.
- Provider lists: `GATEWAY_SETTLEMENT_PROVIDERS` (`shared/payment/settlement-events.ts:45`), `POS_TENDER_PROVIDERS` (`shared/pos/schemas.ts:541`), DB checks `pos-order.ts:299`, `payment-gateway-webhook.ts:91` already allow duitku. Accounting journals use clearing accounts, no provider strings.

### Webhook / poller / failover
- Route `routes/payment-webhook.routes.ts:122` `POST /doit/:tenantId`, header `PayBridge-Signature`, failed-verification limiter per IP :23,:41-81 -> `receiveDoitWebhook` `payment-webhook.service.ts:1326` (`PROVIDER="doit"` :94).
- `gateway_webhook_events` (`db/schema/payment-gateway-webhook.ts`): dedupe unique (tenant_id, provider, event_id) where signature_valid; rejected rows unique (tenant_id, payload_hash). Store `insertRow` :1174, process `processStoredEvent` :1162, retry `reprocessStoredWebhookEvents` :1536, `recordRejectedAttempt` :1210, `processPaymentEvent` :495 -> `confirmPayment` (`payment.service.ts:1445`); `handleRejectedConfirmation` :435; `recordUnsettledFunds` :411.
- Late payment: `payment.service.ts` 1139-1160, 1611-1660 (`paymentUnallocatedFunds`), `syncPendingIntentDetailed` :1219; consumers `pos-order-late-payment.ts`, `qr-order-late-payment.ts`.
- Poller: `pollPendingGatewayIntents` `payment.service.ts:2170` (lease), `expireDueIntents` :1923, `applyGatewayFailure` :1987; job `worker/payment-gateway-poll.job.ts:58`.
- Failover: `payment-failover.service.ts` `syncGatewayHealth` :278, `probeGatewayHealth` :425, `markLinkFailedOverToCashier` :466.
- Tests (`src/test/`): payment-webhook-api, payment-webhook-limiter, payment-webhook-retry-integration, payment-webhook-rls, payment-doit-refund-webhook, qr-order-late-payment, qr-order-late-refund-after-failed, pos-order-late-payment, payment-poll-lease, payment-doit-get-payment, payment-failover, payment-failover-tenants; `services/payment-lifecycle.test.ts`.

## Duitku (official docs, docs.duitku.com/api/en/)
- Sandbox base `https://sandbox.duitku.com/webapi/api/merchant/`, production `https://passport.duitku.com/webapi/api/merchant/`. Paths: `paymentmethod/getpaymentmethod`, `v2/inquiry`, `transactionStatus`. POST JSON.
- Signatures, HMAC-SHA256 keyed by apiKey, hex lowercase (MD5/SHA256 marked obsolete):
  - getpaymentmethod: `merchantcode + amount + datetime` (fields merchantcode, amount, datetime `yyyy-MM-dd HH:mm:ss`, signature).
  - inquiry: `merchantCode + merchantOrderId + paymentAmount`.
  - transactionStatus: `merchantCode + merchantOrderId`.
  - callback (form-urlencoded POST): `merchantCode + amount + merchantOrderId`. NOTE: signature does NOT cover resultCode -> paid must be confirmed via transactionStatus before confirmPayment (brief asumsi 1).
- Inquiry required: merchantCode, paymentAmount, merchantOrderId(50), productDetails(255), email, paymentMethod(2), customerVaName(20), returnUrl, callbackUrl, signature; optional expiryPeriod (minutes), etc.
- Callback params: merchantCode, amount, merchantOrderId, productDetail, additionalParam, paymentCode, resultCode (00 success, 01 failed), merchantUserId, reference, signature.
- transactionStatus statusCode: 00 success, 01 process, 02 failed/expired.
- Method codes: card VC; VA BC M2 VA I1 B1 BT A1 AG NC BR S1 DM BV; retail FT IR; e-wallet OV SA LF LA DA SL OL; QRIS SP NQ SQ; paylater DN AT. Active list comes from getpaymentmethod (never hardcode which are on; a code->method category map is fine).
- No refund API in docs -> refund goes manual path + card.
- Port source (read-only): `/Users/ifanshori99/Projects/119connect-portal-alumni/apps/api/src/lib/payment/duitku.ts` (:100-228) and `apps/api/src/test/duitku.test.ts` (22 tests). Use HMAC only per docs.

## Test command
`bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/gateway-adapter-duitku/apps/api" && pwd && LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test'` (check exact form in apps/api/package.json). Never full `pnpm test` / `pnpm check`. Heavy typecheck only by the lead.

## Architect task (design only, no code edits)
Produce a design the implementers can follow without guessing. Write it with Bash heredoc to `docs/briefs/sub-302-design.md` (Indonesian or English, concise, numbered decisions). Cover:
1. Registry API in `payment-gateway.ts`: replace singleton with `registerPaymentGateway(port)` / `paymentGatewayFor(provider)` (keep `setPaymentGateway`/`paymentGateway()` as compat shims? decide; 43 test files call them). How each call site picks provider: new intent -> routing rule provider (+fallback when primary health `down`, Q73); existing intent -> `payment_intents.provider` (PAY-05, never re-route); health/failover/probe per outlet -> which provider(s); poller/expire (`eq(paymentIntents.provider, paymentGateway().provider)` at :1931/:2215) -> all registered providers; refund port per provider (Duitku has no refund API -> manual path, which existing path?).
2. Platform gateway config: new table vs reuse (`platform_packages`, `tenants.feature_flags.integrationProviders`). Need: per-gateway enabled on platform, default gateway for new tenants, platform permission (which existing perm), audit, endpoints for Super Admin. Disabling a gateway: blocks new rules/new intents, never in-flight intents/webhooks/status.
3. Tenant side: admin picks gateway per method (existing routing API `payment-admin-config.service.ts`, today perm `payment.edc.manage`; brief says `org.settings.manage` -> decide), validation: provider must be platform-enabled AND tenant-allowed AND have an active integration (tenant-wide or that outlet); fallback must differ from provider and pass same checks. Credentials via `tenant_integrations` (Duitku fields: merchantCode, apiKey, environment sandbox|production in non-secret config?); test-connection endpoint (calls adapter health/getpaymentmethod). Never echo secrets.
4. Webhook secret rotation (asumsi 2): where previous secret + grace lives (inside sealed credentials JSON? `rotateIntegrationCredentials`), verification accepting both, audit. Timestamp window per gateway as config (asumsi 1). For Duitku: callback signature lacks resultCode -> confirm with transactionStatus before confirmPayment.
5. Asumsi 3 (failed/expired then paid): confirm existing late-payment path covers any provider; what tests.
6. Duitku webhook route: path (`POST /duitku/:tenantId`? Duitku callbackUrl is set per inquiry so tenant id can be in URL), form-urlencoded parsing, store-then-process reuse of `payment-webhook.service.ts` (generalize `PROVIDER` or new `payment-duitku-webhook.ts`?), event_id = Duitku `reference` or merchantOrderId+resultCode.
7. Duitku merchantOrderId = intent id? amounts integer IDR; expiryPeriod from intent expiresAt; method/channel mapping from getpaymentmethod codes to GatewayPaymentMethod + PaymentChannel.
8. Migration 0211 (`when` 1794290000000) contents, RLS needs.
9. File split for up to 5 parallel implementers with NO overlapping files, each with its exact files + tests to write (fail-first list in main brief §Bukti selesai). Note `payment.service.ts`/`qr-order-payment.ts` edits allowed but minimal.
Keep `docs/DECISIONS.md` style: numbered, short reasons.

## Slice W: Duitku wire client (pure, no DB) — start now
Files (only these): NEW `apps/api/src/services/payment-duitku-wire.ts`, NEW `apps/api/src/test/payment-duitku-wire.test.ts`.
- Mirror style of `services/payment-doit-wire.ts` (injected fetch, timeouts, CoreError SERVICE_UNAVAILABLE on network/5xx, never log secrets/bodies).
- Port from 119connect `lib/payment/duitku.ts` (:100-228) + its 22 tests, HMAC-SHA256 only (hex lowercase), formulas in §Duitku above; constant-time compare (`timingSafeEqual`).
- Exports (pure functions taking `{merchantCode, apiKey, environment: "sandbox"|"production"}` creds + `fetch`):
  `duitkuBaseUrl(env)`, `signGetPaymentMethod`, `signInquiry`, `signTransactionStatus`, `signCallback`,
  `duitkuGetPaymentMethods({creds, amountIdr, datetime, fetch})` -> parsed list {code, name, imageUrl, totalFee},
  `duitkuInquiry({creds, merchantOrderId, amountIdr, paymentMethod, productDetails, email, customerVaName, callbackUrl, returnUrl, expiryPeriodMinutes, fetch})` -> {reference, paymentUrl, vaNumber|null, qrString|null, amountIdr},
  `duitkuTransactionStatus({creds, merchantOrderId, fetch})` -> {statusCode "00"|"01"|"02", status: "paid"|"pending"|"failed", reference, amountIdr},
  `parseDuitkuCallback(formFields)` (strict zod, strings) and `verifyDuitkuCallback({creds(list: current + previous secret), fields, expectedAmountIdr?})` -> {ok, reason} (rejects bad signature, wrong merchantCode, non-integer/mismatched amount),
  `duitkuMethodCategory(code)` -> "qris"|"va"|"ewallet"|"card"|"retail"|"paylater"|"other" (static code->category map is OK; WHICH are enabled always comes from getpaymentmethod).
- Validate all Duitku responses with zod; unexpected shape -> SERVICE_UNAVAILABLE. Amounts: integer IDR only.
- Tests: mock fetch; signature vectors computed with node:crypto in test; wrong sig, wrong amount, wrong merchant, previous-secret accepted, sandbox vs production URL, malformed response. Run: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/payment-duitku-wire.test.ts" pnpm test'` (check if a pure test needs `cd apps/api && pnpm exec vitest run <file>` instead; prefer the fastest that works).

## Review fixes (tier-K review, 10 Nov). Each: failing test first, then fix. No commit.
- F1+F2 (files: services/payment.service.ts, test/payment-gateway-registry.test.ts):
  F1 payment.service.ts:2283-2287 poller: rows of a provider at its error budget are `continue`d before `gatewayPolledAt` is stamped; with `order by gatewayPolledAt asc nulls first limit 100` they stay at the front, so >=100 pending intents of a down provider starve the other provider. Fix: claim per provider with its own limit (or stamp skipped rows). Test: 100+ pending of provider X (down) + 1 pending of Y -> Y polled in the same run.
  F2 payment.service.ts:385 `onlineMethods` calls `.channels()` on a down primary when no gateway usable; Duitku channels throws -> getPaymentLinkView fails before failover. Fix: skip channels when `!gatewayUsable` (as qr-order-payment.ts does). Test: primary down whose channels throws -> link view renders with gateway_down + failover.
- F3 (files: services/payment-duitku-webhook.service.ts, test/payment-duitku-webhook.test.ts): :181-188 `askStatus` lets a later reference-mismatch answer (previous merchantCode in grace) overwrite an earlier transient error -> row `ignored` REFERENCE_MISMATCH, never retried. Fix: if any call errored and none matched, report the error (row failed, retried). Test for it.
- F4 (files: services/platform-org.service.ts, test/payment-routing-gateway-choice.test.ts): :270-281 new tenant default rules always use platform default even when Super Admin listed only another gateway (e.g. ["duitku"] while default doit). Fix: seed with the platform default only if the tenant's integrationProviders contains it; else seed with the first listed payment gateway that is platform-enabled; none -> no seed. Test it.
- F5 (file: test/payment-gateway-registry.test.ts only; code already fixed by lead in payment.service.ts `pollPendingGatewayIntents`, claimed rows now sorted gatewayPolledAt nulls first, then createdAt): add a test that two providers' pending intents are polled in one global least-recently-polled order, not grouped by provider (e.g. provider A rows polled recently, provider B rows never polled -> B's getStatus calls come before A's; record call order with fake gateways). Confirm it fails if the sort is removed (temporarily revert, then restore).
