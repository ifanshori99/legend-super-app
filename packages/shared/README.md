# @starter/shared

The TypeScript contract package shared by the API, the web app and the edge node. Source only (no build step); every entry point is listed under `exports` in `package.json`. No Node-only or browser-only code.

## Core conventions (`@starter/shared/core`)

The base every Legend domain contract imports. Decisions and rationale: [`docs/plan/contracts.md`](../../docs/plan/contracts.md).

| Area            | Use                                                                                                                                | Rule                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ids             | `uuidIdSchema<"XId">()`, `ulidIdSchema<"XId">()`, `createUlidFactory()`, `ulidToUuid` / `uuidToUlid`                               | UUID ids; ULID for time-ordered aggregates and events; every id stored in a Postgres `uuid` column                                |
| Money           | `Idr`, `idr()`, `addIdr`, `sumIdr`, `applyBasisPoints`, `roundToIncrement`, `allocateIdr`, `splitIdrEvenly`                        | Whole rupiah (BIGINT), `…Idr` fields, explicit `RoundingMode`, splits sum exactly                                                 |
| Unit cost / qty | `Decimal4`, `extendCostIdr`, `unitCostOf`, `multiplyDecimal4`                                                                      | NUMERIC(14,4) as a decimal string, never a float                                                                                  |
| Tenant          | `TenantContext`, `OutletScope`, `assertTrustedScopedContext`, `isOutletInScope`, `outletIdsForQuery`, `clientInputSchema`          | Checks only; values are minted server-side (TEN-02/TEN-03)                                                                        |
| Server only     | `@starter/shared/core/server`: `establishTenantContext`, `establishOutletScope`, `establishScopedTenantContext`                    | API/edge only; refuses to load in a browser                                                                                       |
| Errors          | `apiErrorBodySchema`, `apiErrorBody`, `coreErrorHttpStatus`, `errorCodeSchema`                                                     | `{ error: { code, message, details?, requestId? } }`, UPPER_SNAKE codes                                                           |
| Pagination      | `cursorPageQuerySchema`, `cursorPageSchema(item)`, `encodeCursor` / `decodeCursor`                                                 | Keyset cursor ≤ 1024 chars both ways, limit 1–100 (default 25)                                                                    |
| Dates           | `isoDateTimeSchema`, `businessDateSchema`, `timeOfDaySchema`, `businessDateOf`, `businessDayRange`, `localDateOf`, `toIsoDateTime` | Instants with offset (UTC out); business date = outlet-local date of (instant − business-day cutoff, default 04:00), see D-CORE-7 |
| Misc            | `dataResponseSchema(item)`, `idempotencyKeySchema`                                                                                 | `{ data }` envelope; idempotency keys up to 100 chars                                                                             |
| Fixtures        | `cafeLegendFixtures`                                                                                                               | Cafe Legend tenant, brand, outlets, sample page and error                                                                         |

```ts
import {
  allocateIdr,
  clientInputSchema,
  idr,
  ulidIdSchema,
  z,
} from "@starter/shared/core";

export const orderIdSchema = ulidIdSchema<"OrderId">();
export const splitBillInputSchema = clientInputSchema({
  orderId: orderIdSchema,
  parts: z.number().int().min(2).max(20),
});
const shares = allocateIdr(idr(137_500), [1, 1, 1]); // [45834, 45833, 45833]
```

Tests: `tests/core-contract.test.mjs` (runs in `pnpm test`) and `src/core/type-tests.ts` (compile-time checks, runs in `pnpm typecheck`).
