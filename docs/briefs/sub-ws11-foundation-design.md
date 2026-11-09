# WS-11 fondasi: bentuk konkret (architect, kartu A legend-5wzoc)

Keputusan: `docs/DECISIONS.md` entri 2026-11-10. Berkas ini kontrak antar-subagent.

## 2.1 `apps/api/src/services/metric-sources/types.ts`

```ts
import type { BusinessDate } from "@starter/shared/core";
import type {
  MetricDimensionKey,
  MetricUnavailableReason,
  MetricValue,
} from "@starter/shared/metrics";
import type { withTenant } from "../../db/tenant";
import type { GlMetricSource } from "../metrics-gl-sources";

export type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

export const METRIC_SOURCE_FAMILIES = [
  "sales",
  "traffic-operations",
  "menu-cogs",
  "payments-tax",
  "inventory-purchasing",
  "finance",
  "loyalty-crm",
  "reservation-delivery",
  "hr",
  "facility",
] as const;
export type MetricSourceFamily = (typeof METRIC_SOURCE_FAMILIES)[number];

/** One outlet-day value a daily reader returns; dimension null = the total. */
export type DailyMetricValue = {
  readonly metricCode: string;
  readonly dimension: {
    readonly key: Exclude<MetricDimensionKey, "outlet">;
    readonly value: string; // max 200 chars, never a person's name (ids only)
  } | null;
  readonly value: MetricValue;
};

export type DailyComputeInput = {
  readonly tx: Tx; // job's withTenant transaction (RLS is the second wall)
  readonly tenantId: string;
  readonly outletId: string;
  readonly businessDate: BusinessDate;
};

export type DailyMetricReader = {
  /** Codes this reader writes; the job deletes stale rows of these codes only. */
  readonly metricCodes: readonly string[];
  /** Split keys written besides the total (subset of each definition's dimensions). */
  readonly dimensions: readonly Exclude<MetricDimensionKey, "outlet">[];
  /** POS metrics: final needs a pos_daily_closes row for the outlet-date. */
  readonly requiresDailyClose: boolean;
  compute(input: DailyComputeInput): Promise<readonly DailyMetricValue[]>;
};

export type MetricSource =
  | { readonly kind: "gl"; readonly code: string; readonly gl: GlMetricSource }
  | { readonly kind: "daily"; readonly code: string; readonly reader: DailyMetricReader }
  | {
      /** Recomputed per bucket from two registry codes; never stored. */
      readonly kind: "derived";
      readonly code: string;
      readonly numerator: string;
      readonly denominator: string;
      readonly scale: 1 | 100; // 100 for percent
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly reason: MetricUnavailableReason;
    };

/** Non-outlet split of a `gl` metric: operational rows + ledger residual row. */
export type MetricSplitSource = {
  readonly code: string; // must resolve to kind "gl"
  readonly dimension: Exclude<MetricDimensionKey, "outlet">;
  readonly reader: DailyMetricReader; // writes rows with this dimension only
};

export type MetricSourceFamilyModule = {
  readonly family: MetricSourceFamily;
  readonly sources: readonly MetricSource[];
  readonly splits: readonly MetricSplitSource[];
};
```

`index.ts` exports:
- `METRIC_SOURCE_MODULES: readonly MetricSourceFamilyModule[]` (gl + 10 families),
- `metricSourceOf(code): MetricSource` (unclaimed active code returns
  `{kind:"unavailable", reason:"source_not_built"}`),
- `metricSplitOf(code, dimension): MetricSplitSource | null`,
- `dailyReaders(): readonly { family; reader }[]` (deduplicated, for the job).
- A load-time `assertRegistry()` that throws on: duplicate code, a code missing
  from `reportMetricByCode`, a `gl` source whose unit is not idr/percent per
  `glSourceOf`, a `derived` whose inputs are not registered, a split whose code
  is not `gl` or whose dimension is not in the definition, a reader writing a
  code it does not list.
- Family stub: `export const salesSources: MetricSourceFamilyModule = { family: "sales", sources: [], splits: [] };`

Engine entry (in `metrics-query.service.ts`, A-owned):
```ts
export async function evaluateMetrics(
  tx: Tx,                       // caller's withTenantSnapshot tx
  context: ScopedTenantContext,
  request: {
    metricCodes: readonly string[];
    period: { start: BusinessDate; end: BusinessDate };
    bucket: MetricBucket;
    outletFilter: MetricOutletFilter; // from outletIdsForQuery
    groupBy: readonly MetricDimensionKey[]; // outlet + at most 1 other
    filters: readonly MetricDimensionFilter[];
    comparePrevious: boolean;
    viewer: MetricViewer;
  },
  now: Date,
): Promise<EvaluatedMetrics>; // series + availability per code + book periods
```
`queryMetrics` becomes a thin wrapper (same response, 12 GL metrics regress
unchanged).

## 2.2 Shared contract additions (`packages/shared/src/metrics/schemas.ts`, `dashboard/builder.ts`)

```ts
export const METRIC_UNAVAILABLE_REASONS = [
  "source_not_built",
  "dimension_not_supported",
] as const;
export const metricUnavailableReasonSchema = z.enum(METRIC_UNAVAILABLE_REASONS);

export const metricAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ metricCode: metricCodeSchema, status: z.literal("available") }),
  z.strictObject({
    metricCode: metricCodeSchema,
    status: z.literal("unavailable"),
    reason: metricUnavailableReasonSchema,
    message: z.string().min(1).max(200), // "Data metrik ini belum tersedia."
  }),
]);

/** Residual row of a ledger-controlled split (DASH-02). */
export const METRIC_LEDGER_ADJUSTMENT = "__ledger_adjustment__";
```
- `reportResultSchema`: add required `availability: z.array(metricAvailabilitySchema)`,
  refine: same codes and order as `definitions`; every cell of an unavailable
  metric is `value: null`.
- `metricQueryResponseSchema` (`data`): add the same `availability` array
  (series of an unavailable code have null points). Fixtures and web mocks are
  updated by A in the same branch.
- HTTP status: 200 for partial or full unavailability. 400 stays only for a
  dimension the definition/report does not declare at all.

## 2.3 `metrics_daily` (migration 0176, when 1794255000000, `db/schema/metrics.ts`)

| column | type | rule |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| tenant_id | uuid NOT NULL | FK tenants(id), inside CREATE TABLE |
| outlet_id | uuid NOT NULL | FK outlets(id), inside CREATE TABLE (repo's tenant+outlet column helpers) |
| metric_date | date NOT NULL | outlet business date |
| metric_code | varchar(64) NOT NULL | registry code |
| definition_id | uuid NOT NULL | registry id (global, no FK) |
| definition_version | integer NOT NULL | CHECK > 0 |
| dimension_key | varchar(40) NULL | CHECK dimension_key <> 'outlet' |
| dimension_value | varchar(200) NULL | CHECK (dimension_key IS NULL) = (dimension_value IS NULL) |
| unit | varchar(10) NOT NULL | CHECK IN ('idr','count','percent','decimal','seconds') |
| value_int | bigint NULL | idr, count, seconds |
| value_decimal | numeric(14,4) NULL | percent, decimal |
| finality | varchar(10) NOT NULL | CHECK IN ('estimate','final') |
| computed_at | timestamptz NOT NULL | last compute that saw this row |
| updated_at | timestamptz NOT NULL default now() | moves only on change |

- CHECK value by unit: `(unit IN ('idr','count','seconds') AND value_int IS NOT NULL AND value_decimal IS NULL) OR (unit IN ('percent','decimal') AND value_decimal IS NOT NULL AND value_int IS NULL)`.
- UNIQUE NULLS NOT DISTINCT `metrics_daily_key` (tenant_id, outlet_id, metric_date, metric_code, dimension_key, dimension_value). It also serves the job's per outlet-day read and delete.
- INDEX `metrics_daily_code_date_idx` (tenant_id, metric_code, metric_date, outlet_id). Engine range read across outlets.
- RLS: `SELECT app.enforce_tenant_rls('public.metrics_daily'::regclass); SELECT app.enforce_outlet_rls('public.metrics_daily'::regclass);` in `metrics.custom.sql` (force RLS guard tests must pass).
- Only this table in 0176. No run-log table: idempotency comes from the unique key plus the advisory lock.

## 2.4 Closed versus estimate (exact rule)

Write time (job), per row:
```
settled   = now >= businessDayEnd(outlet clock, metric_date) + METRICS_DAILY_SETTLE_MS
closedDay = reader.requiresDailyClose ? exists pos_daily_closes(outlet, metric_date) : true
finality  = settled && closedDay ? "final" : "estimate"
```
Read time (engine), per bucket value:
```
rule  = metricValueFinality({ officiality, periodClosed: bucket.end < today,
          accountingPeriodClosed: all months of bucket closed (bookState) })
final = rule === "final" && every stored row in the bucket is "final"
```
- `gl` totals: unchanged (bookState, closed_period_only).
- Split rows and the residual row: the finality of the GL total of their bucket.
- `derived`: final only when both inputs are final.
- An absent row is "no data" (null), never zero. It does not downgrade finality.

## 2.5 Job idempotency (`apps/api/src/worker/metrics-daily.job.ts`, service `services/metrics-daily.service.ts`)

1. Tick per tenant, `METRICS_DAILY_INTERVAL_MS = 15 min` (lastRunByTenant map as in ai-daily-summary).
2. Targets per open outlet (`jobOutletClocks`): today, then the last `METRICS_DAILY_REFRESH_DAYS = 7` dates.
3. Per (tenant, outlet, date), in one `withTenant` transaction:
   `SELECT pg_advisory_xact_lock(hashtextextended('metrics_daily:' || tenant || ':' || outlet || ':' || date, 0))`.
4. Each family runs in a savepoint. Steps: `compute()`, then validate each value's unit against the definition.
   Then `INSERT ... ON CONFLICT ON CONSTRAINT metrics_daily_key DO UPDATE SET value_int, value_decimal, unit, finality, definition_id, definition_version, computed_at, updated_at = now() WHERE (metrics_daily.value_int, metrics_daily.value_decimal, metrics_daily.finality, metrics_daily.definition_version) IS DISTINCT FROM (EXCLUDED....)`.
   Then `DELETE` the rows of the reader's `metricCodes` for that outlet-date whose (dimension_key, dimension_value) is not in the new set.
   On error: roll back the savepoint, log the family, code and outlet only, and go on.
5. When a `final` row's value changes, log a warning (`metrics_daily final row changed`) and write it anyway.
6. `recomputeMetricsDaily(context, outletId, from, to)` reruns step 3-4 for older dates (backfill, version bump).

Tests (fail first):
- Two runs leave the same row ids, the same `updated_at` and the same row count.
- A dimension that disappears is deleted.
- Two concurrent runs leave no duplicate rows and no error.
- A family that throws does not block the other families.
- A tenant B context cannot see or write tenant A rows, and an outlet-scoped context cannot read another outlet.

## 2.6 Report run (`report-run.service.ts`, `routes/reports.routes.ts`)

- Catalog list and get: these are served from the shared catalog, filtered by RBAC (`requiredPermissions`).
- Run and preview use the viewer and scope resolution of `metrics.routes.ts`. They open one `withTenantSnapshot` and make one `evaluateMetrics` call. They then pivot the series into rows and fill in `availability`.
- An identity group-by or filter from an aggregate viewer is refused (SH-01), as today.
- groupBy has more than outlet + 1 dimension: every metric is `unavailable` / `dimension_not_supported`.
