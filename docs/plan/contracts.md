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

- `TenantContext` has a private type brand; only `establishTenantContext({ tenantId, brandId, source })` creates one, with `source` in `domain | session | device | mcp_token | job | webhook`. Server middleware calls it after resolving the tenant; services take `TenantContext` (or `ScopedTenantContext`) as a parameter, never a bare `tenantId` from the request.
- Request schemas are built with `clientInputSchema({...})`: declaring `tenantId` / `tenant_id` is a compile error and throws at module load; parsing is strict, so a submitted `tenantId` is rejected.
- The database enforces the same with RLS and `SET LOCAL` (bead `legend-73d`). `login_challenges` and `wa_inbound_messages` resolve the tenant from the receiving WhatsApp number (`source: "webhook"`) and are service-scoped without RLS (coordinator decision).
- `OutletScope` (`{ kind: "tenant" }` or `{ kind: "outlets", outletIds }`) carries TEN-03; `isOutletInScope` is the single check. Denials use `OUTLET_OUT_OF_SCOPE`.

### D-CORE-4 Errors

Envelope: `{ "error": { "code", "message", "details"?: [{ field, message }], "requestId"? } }`, the starter's shape. `code` is stable `UPPER_SNAKE_CASE`; the UI maps it to catalog text. `message` is a safe Indonesian fallback. Core codes and their HTTP status live in `coreErrorHttpStatus` (starter codes plus `TENANT_CONTEXT_REQUIRED`, `OUTLET_OUT_OF_SCOPE`, `FEATURE_DISABLED`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `PRECONDITION_FAILED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`). Domain contracts declare their own codes next to their schemas (for example `PERIOD_CLOSED` in WS-07).

### D-CORE-5 Pagination

New list endpoints use cursor (keyset) pagination: query `cursorPageQuerySchema` (`cursor?`, `limit` 1–100, default 25), response `{ data, meta: { limit, nextCursor } }` (`nextCursor: null` on the last page). The cursor is `encodeCursor([sortKey…, id])`, opaque base64url; a tampered cursor decodes to `RangeError` → `VALIDATION_ERROR`. Offset paging stays only on the starter Notes example.

### D-CORE-6 Dates

Instants: ISO 8601 with offset (`isoDateTimeSchema`); the server emits UTC with milliseconds (`toIsoDateTime`). Business dates: `YYYY-MM-DD` in the outlet time zone (`businessDateSchema`, `businessDateOf(instant, outlet.timeZone)`), derived on the server. Times of day: `HH:mm` (`timeOfDaySchema`). Time zone: IANA per outlet, default `Asia/Jakarta`. DB: `TIMESTAMPTZ`, `DATE`, `TIME`.

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
- No Node-only or browser-only APIs (no `Buffer`, `node:*`, `window`, `document`); the code runs in the API, the web app and the edge. Keep files loadable by Node type stripping: no `enum`, `namespace` or constructor parameter properties, and use `import type` for type-only imports.
- Every contract bead adds a fixture test (fixtures parse) to `tests/<domain>-contract.test.mjs`.
