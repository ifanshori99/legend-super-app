# Contract conventions (WS-00 core)

Bead `legend-6gu` · PRD v1.7 §3 "Kontrak Bersama", §6 conventions, TEN-02/TEN-03, ORD-06.
Code: `packages/shared/src/core` (import `@starter/shared/core`). Tests: `tests/core-contract.test.mjs` (runtime) and `packages/shared/src/core/type-tests.ts` (compile time).

Every domain contract (`CT` bead) builds on these rules. Change them only through a WS-00 bead.

## Decisions

### D-CORE-1 Ids: UUID everywhere, ULID for time-ordered aggregates, one `uuid` column type

PRD §6 says all ids are UUID, but operational events use ULID, and several ULID primary keys (orders, order_items, kitchen tickets, stock_ledger, access tickets) are referenced by UUID-typed foreign keys (for example `order_items.order_id`, `stock_ledger.source_id`).

- **Postgres:** every id column, primary or foreign, is `uuid`. A ULID is 128 bits, so it is stored losslessly in a `uuid` column (`ulidToUuid` / `uuidToUlid`). Byte order equals time order, so index locality and ordering are kept. This keeps every §6 foreign-key type as written.
- **Wire and TypeScript:** one id type per aggregate everywhere it appears. UUID aggregates use `uuidIdSchema<"XId">()`; ULID aggregates use `ulidIdSchema<"XId">()` and always travel as the 26-character ULID text, including in foreign-key fields of other aggregates (for example `payment.orderId`). The API converts at the DB boundary (a Drizzle custom type in the BE schema bead).
- **Generation:** UUIDs come from Postgres `gen_random_uuid()` or `crypto.randomUUID()`. ULIDs come from `createUlidFactory()` (monotonic within a millisecond, so one device's outbox stays ordered offline) or `createUlid()`.
- Ids are branded per aggregate (`TenantId`, `OutletId`, …), so mixing them is a type error.

### D-CORE-2 Money: BIGINT whole rupiah for amounts, NUMERIC(14,4) only per-unit cost and quantity

PRD §6 says money is BIGINT rupiah, but `stock_ledger.unit_cost_idr` and `recipes.theoretical_cost_idr` are NUMERIC(14,4) and `ai_jobs.cost_idr` is NUMERIC(12,2). Tech-lead decision:

- **Any amount that is posted, paid, billed, allocated or reported** (order totals, payments, journals, payroll, profit share, budgets, stock value totals): `BIGINT` whole rupiah. TypeScript/JSON: `Idr`, a branded safe integer (JSON `number`; every realistic amount is far below 2^53). Field suffix `Idr` (`totalIdr` ↔ `total_idr`).
- **Per-unit cost and quantity** (`stock_ledger.quantity`, `stock_ledger.unit_cost_idr`, `recipes.theoretical_cost_idr`, yields, UOM factors): `NUMERIC(14,4)`. TypeScript/JSON: `Decimal4`, a decimal string such as `"0.0180"` (the form `pg` returns), computed as scaled bigint, never as a float.
- **`ai_jobs.cost_idr`** (per-call estimate, fractions of a rupiah): `NUMERIC(14,4)` instead of NUMERIC(12,2), so there is one decimal type. Totals derived from it for reports or quotas are rounded to `Idr`.
- Converting between the two is always explicit and rounded: `extendCostIdr(quantity, unitCost, mode)`, `unitCostOf(totalIdr, quantity, mode)`.
- **Rounding is explicit.** Every helper that can produce a fraction takes a `RoundingMode` (`half_up` = half away from zero, `half_even`, `down`, `floor`, `ceil`). Which mode and cash increment a tenant uses is configuration (PRD F11 "aturan pembulatan", WS-05 tax contract), not code. `roundToIncrement` returns the rounded amount and the rounding line (`orders.rounding_idr`).
- **Splits sum exactly (ORD-06).** `allocateIdr(total, weights)` / `splitIdrEvenly` use the largest-remainder method with deterministic index tie-breaks; use them for split bills, combo revenue allocation, service-charge pools and profit share (weights in basis points, 10,000 = 100%).

### D-CORE-3 Tenant from domain or token, never from the client (TEN-02)

- **Provenance is enforced at runtime, not only by types.** `TenantContext` and `OutletScope` are valid only if the server minted them: an internal WeakSet registry (`core/trust.ts`, exported from no entry point) records every minted object. Plain objects, JSON round-trips, `structuredClone` and spread copies are never members.
- **Minting is server-only.** `@starter/shared/core/server` exports `establishTenantContext({ tenantId, brandId, source })` (`source` in `domain | session | device | mcp_token | job | webhook`), `establishOutletScope(tenant, assignment)` and `establishScopedTenantContext(tenant, assignment)`. It throws at import time where a DOM exists, and the browser-safe `@starter/shared/core` exports only the checks. Import the server entry only from `apps/api` and the edge runtime, with values the server resolved itself (host name → `tenant_domains`, verified token, job row, receiving webhook account; outlet reach from verified role assignments, which the RBAC contract `legend-0mc` expands from brand or station level to outlet ids).
- **Service boundaries assert.** Services take `ScopedTenantContext` (or `TenantContext`) and call `assertTrustedScopedContext` / `assertTrustedTenantContext` first, never accept a bare `tenantId` from the request. An `OutletScope` is bound to its tenant; pairing it with another tenant's context fails.
- Request schemas are built with `clientInputSchema({...})`: declaring `tenantId` / `tenant_id` is a compile error and throws at module load; parsing is strict, so a submitted `tenantId` is rejected.
- The database enforces the same with RLS and `SET LOCAL` (bead `legend-73d`). `login_challenges` and `wa_inbound_messages` resolve the tenant from the receiving WhatsApp number (`source: "webhook"`) and are service-scoped without RLS (coordinator decision).
- **TEN-03.** `isOutletInScope(scope, outletId)` and `assertOutletInScope` are the single check; an untrusted scope throws `TypeError` (fail closed). Lists, reports, exports, Tanya AI and MCP derive their outlet filter with `outletIdsForQuery(scope, requested?)`: nothing requested → the whole scope (`{ kind: "all" }` or the assigned outlets); any requested outlet outside the scope → `CoreError` `OUTLET_OUT_OF_SCOPE` (403).
- Ids normalize on parse (UUID lowercase, ULID uppercase), so comparisons are plain `===`.
- Two copies of the shared package in one process would not trust each other's objects (fails closed). Keep `@starter/shared` a single workspace dependency.

### D-CORE-4 Errors

Envelope: `{ "error": { "code", "message", "details"?: [{ field, message }], "requestId"? } }`, the starter's shape. `code` is stable `UPPER_SNAKE_CASE`; the UI maps it to catalog text. `message` is a safe Indonesian fallback. Core codes and their HTTP status live in `coreErrorHttpStatus` (starter codes plus `TENANT_CONTEXT_REQUIRED`, `OUTLET_OUT_OF_SCOPE`, `FEATURE_DISABLED`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `PRECONDITION_FAILED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`). Domain contracts declare their own codes next to their schemas (for example `PERIOD_CLOSED` in WS-07).

### D-CORE-5 Pagination

New list endpoints use cursor (keyset) pagination: query `cursorPageQuerySchema` (`cursor?`, `limit` 1–100, default 25), response `{ data, meta: { limit, nextCursor } }` (`nextCursor: null` on the last page). The cursor is `encodeCursor([sortKey…, id])`, opaque base64url; a tampered cursor decodes to `RangeError` → `VALIDATION_ERROR`. One limit, `CURSOR_MAX_LENGTH` = 1024 characters, applies to both sides: `encodeCursor` throws instead of emitting a longer cursor, and the query schema rejects one. Sort only on bounded columns (timestamps, ids, names up to 150 characters), never free text. Offset paging stays only on the starter Notes example.

### D-CORE-6 Dates

Instants: ISO 8601 with offset (`isoDateTimeSchema`); the server emits UTC with milliseconds (`toIsoDateTime`). Business dates: `YYYY-MM-DD` in the outlet time zone (`businessDateSchema`, `businessDateOf(instant, outlet.timeZone)`), derived on the server; supported range 0001-01-01 to 9999-12-31 (zero-padded year), anything else or an invalid `Date` throws `RangeError`. Times of day: `HH:mm` (`timeOfDaySchema`). Time zone: IANA per outlet, default `Asia/Jakarta`. DB: `TIMESTAMPTZ`, `DATE`, `TIME`.

## Naming

- DB: English `snake_case` tables, columns and status values (PRD §6). Wire/TypeScript: `camelCase` keys, same English words (`total_idr` → `totalIdr`, `tenant_id` → `tenantId`). Status values stay `snake_case` strings on the wire (`awaiting_payment`).
- Schema names end in `Schema`; inferred types drop it (`orderSchema` → `Order`). Request schemas are `create…Schema`, `update…Schema`, `list…QuerySchema`, built with `clientInputSchema`.
- Domain events: `<aggregate>.<past_verb>` (`order.paid`), catalogued in the WS-00 event contract (`legend-m59`). Core defines no events; event ids are ULIDs.

## Domain contract folder layout

```
packages/shared/src/<domain>/      # e.g. pos, payments, inventory (English, kebab-case)
  schemas.ts      # zod schemas + inferred types (DTOs and request inputs)
  events.ts       # event payload schemas, registered in the WS-00 catalog
  errors.ts       # domain error codes (optional)
  fixtures.ts     # Cafe Legend mock data; must parse against schemas.ts
  index.ts        # public surface
```

- One `package.json` export per domain: `"./<domain>": "./src/<domain>/index.ts"`. Import from the subpath, never deep paths.
- Import shared conventions only from `@starter/shared/core` (inside the package: relative `../core`).
- No Node-only or browser-only APIs (no `Buffer`, `node:*`, `window`, `document`); the code runs in the API, the web app and the edge. Keep files loadable by native Node ESM with type stripping (the edge runtime and the contract tests load them without a bundler or resolve hook): relative imports carry the `.ts` extension (`./ids.ts`; `allowImportingTsExtensions` is on in `tsconfig.base.json`), type-only imports use `import type`, and no `enum`, `namespace` or constructor parameter properties.
- Every contract bead adds a fixture test (fixtures parse) to `tests/<domain>-contract.test.mjs`.

## Events, outbox and sync (`@starter/shared/events`, bead `legend-m59`, reviewed in `legend-cyu.4`)

Code: `packages/shared/src/events`. Tests: `tests/events-contract.test.mjs`. PRD §5 Sinkronisasi, §6 `order_events` / `sync_cursors`.

- **One catalog, typed payloads.** Every event name is listed once in `events/catalog.ts` (`<aggregate>.<past_verb>`, `payloadSchemaRef` = `<name>.v<version>`, derived and enforced). A workstream registers its payload from `<domain>/events.ts` with `defineDomainEvent({ name, payload })`: it throws at module load for a name that is not catalogued or a mismatching version, and returns `envelopeSchema` validating name, version, schema ref and payload together. Adding an event is a one-line catalog change in the owning bead; changing a payload shape means a new `version` and a new ref.
- **Envelope.** Payload is JSON only (`z.json()`): no `Date`, `bigint`, `NaN` or `undefined`, so a row survives JSONB and the edge link unchanged. `actor.type` is `user | ai | mcp_client | device | system`, the same kinds as audit (`mcp` was renamed `mcp_client`); every actor id is a UUID. `deviceId` (nullable, default `null`) is the originating device, as in PRD `order_events.device_id`.
- **Idempotency and order.** `idempotencyKey` is unique per tenant (`eventDedupeKey`). Order is the per tenant + aggregate `sequence` (starts at 1, no gaps): consumers call `classifyEventSequence(lastApplied, event)` and apply only `apply`, drop `duplicate`, and park `gap` while requesting the missing range. Never order by arrival time or ULID.
- **Outbox.** Statuses `pending | processing | delivered | failed`. `attempts` counts leases (a leased or delivered row has at least one). After the worker's retry limit a row becomes terminal `failed` with `lastError` (PRD "retry terbatas"); `isOutboxRowClaimable(row, now)` is the single claim rule (due `pending`, or `processing` with an expired lease). The retry limit and backoff are worker configuration, not contract.
- **Order events by channel** (coordinator decision, legend-6li review): `order.placed` is the QR-channel event owned by WS-03 (`@starter/shared/qr-order`); `order.submitted`, `order.paid`, `order.voided` and `order.refunded` are owned by WS-04 (POS). Consumers that need every new order subscribe to both `order.placed` and `order.submitted`.
- **Adapter events** (`provider_webhook.received`, `wa_inbound_message.received`, `outbound_message.sent|failed`, `edc_transaction.created|settled|cancelled`, `wifi_session.authorized|revoked`, `lock_credential.issued|revoked`, `delivery_channel.action_executed`) are owned by WS-00 in the catalog (`adapterEventNames`). The service wrapping a provider emits them; providers never do. A webhook that fails verification has no trusted tenant and is logged in `gateway_webhook_events`, not published.

## Audit (`@starter/shared/audit`, bead `legend-pnj`, reviewed in `legend-cyu.4`)

Code: `packages/shared/src/audit`. Tests: `tests/audit-contract.test.mjs`. PRD §6 `audit_logs`, retention two years, support access (§4).

- **Actor rules.** `user`, `ai`, `mcp_client` need `actorId`; `system` has none; `device` acts as itself (`deviceId === actorId`).
- **Sensitive access needs a reason** (`sensitiveAccess: true` requires a non-blank `reason`; PRD support access).
- **`action`** is dotted lowercase (`role.updated`), **`objectType`** one snake_case word (`menu_item`).
- **Masking.** Use `maskAuditChanges(value, safeFields)` for `before` and `after`; the schema rejects any sensitive-named field that does not hold `[REDACTED]` (`auditChangesAreMasked`) and a `maskedChanges` over 64 KiB. The deny list (`isSensitiveAuditKey`) always beats the safe list: long terms match as fragments (`bank_account`, `apiKey`, `alamat`, `nohp`), short ones (`pin`, `pan`, `otp`, `nik`, `ktp`, `hp`, `ip`, `dob`, `cvv`) only as whole words, so `pinCode` is redacted but `shipping` and `company` are not. Safe scalar arrays are kept, `null` stays `null`. Free text is never safe: leave it off the safe list.
- **`ipHash`** is `await hashIpForAudit(ip, secret)`: HMAC-SHA256 with a server secret (at least 16 characters), never a bare hash (the IPv4 space is enumerable).
- Append-only is enforced by the database bead; the schema cannot.

## Adapters (`@starter/shared/adapters`, bead `legend-4lk`, reviewed in `legend-cyu.4`)

Code: `packages/shared/src/adapters`. Tests: `tests/adapters-contract.test.mjs`. PRD §5 adapters, §7; provider choices in [providers.md](providers.md).

- **Context.** Every method takes a server-minted `ScopedTenantContext` (D-CORE-3) and the request carries `tenantId`/`outletId` that must equal it; they never widen it. `outletId: null` (storage, email, push, LLM) means tenant-level and needs a tenant-wide `OutletScope`.
- **Idempotent mutations.** Repeating a request returns the first result and has no second side effect; the same key or reference with a different request fails `IDEMPOTENCY_KEY_REUSED` (409). Keys: payments and refunds by `(tenant, idempotencyKey)` (core `idempotencyKeySchema`), everything else by `(tenant, outlet, reference)`. Fakes enforce this, so tests written against them hold for real adapters.
- **`PaymentProvider`** has `createPayment`, `getPayment` (source of truth for scheduled status checks) and `refund` (paid only, up to the paid amount). Statuses follow PRD §5: `pending → paid | expired | failed → refunded`, plus `cancelled`. **`LockProvider`** has `issue` and `revoke`. Fakes expose `simulate(ref, "paid" | "failed" | "expired")` for the provider's asynchronous outcome.
- **WhatsApp / KirimDev (AUTH-02, owner-approved).** `MessagingProvider.verifyWebhook` replaces Meta's `X-Hub-Signature-256` with KirimDev's `X-Kirim-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(secret, `"<t>." + raw bytes`), rejected when `|now − t| > 300 s`, one `v1` per active secret during rotation (any match passes), compared in constant time via Web Crypto. Every failure is `CoreError` `UNAUTHORIZED` with one message (no oracle). Verify the exact bytes (`express.raw`), before parsing or tenant routing. `X-Kirim-Event-Id` is the dedupe key: the service routes by receiving number, then `receive()` returns `duplicate: true` for a repeated id, and a duplicate or forged message never creates a session. `signKirimWebhook` builds valid headers for route tests. `InboundMessage` no longer carries a header name; WhatsApp numbers are digits (`628…`), text is at most 4096 characters. Source: docs.kirimdev.com/webhooks/signing (1 Nov 2026); recheck it at integration, with live forgery, replay and rotation tests.
- **Outbound safety.** Push endpoints and the tenant-configured LLM `baseUrl` must be public `https` DNS names (no IP literals, credentials, `localhost`, `.local`, `.internal`); the real adapter must also refuse private DNS answers at connect time (rebinding). Email subjects are single-line. Storage keys are relative portable paths without `.` or `..` segments; the real adapter prefixes `tenant/outlet`. `redactLlmConfig` is the only form of an LLM config that may be logged. Lock credentials (door codes) are secrets: never logged, audited or put in an event payload.
- **Not in the contract.** DOIT's `PayBridge-Signature` verifier (header format not yet confirmed) belongs to the WS-05 DOIT adapter.
