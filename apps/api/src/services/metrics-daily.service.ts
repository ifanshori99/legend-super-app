// WS-11 metrics_daily refresh (bead legend-5wzoc; contract
// docs/briefs/sub-ws11-foundation-design.md §2.4-2.5). Recomputes the stored
// daily values of one outlet business date from the registry's daily readers.
//
// - One transaction per (tenant, outlet, date) under a blocking advisory lock,
//   so a second worker waits and then finds nothing to change.
// - One savepoint per family: a failing reader rolls back its own rows only.
// - Upsert writes a row only when its value, finality or definition version
//   moved, so `updated_at` moves only on change. Rows the reader no longer
//   returns are deleted (its own metric codes and dimensions only, and the
//   total row only when it declares `writesTotal`).
// - Finality of a stored row: settled (day end + settle delay) and, for point
//   of sale readers, closed (`pos_daily_closes`).
import { and, eq, sql } from "drizzle-orm";
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDayRange,
  type BusinessDate,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { reportMetricByCode } from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";
import { db } from "../db/index.ts";
import { posDailyCloses } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { loadOutletClock } from "./ai-anomaly.service.ts";
import { dailyReaders } from "./metric-sources/index.ts";
import {
  readerWritesTotal,
  type DailyMetricReader,
  type DailyMetricValue,
  type Tx,
} from "./metric-sources/types.ts";

/** Wait after the business day end before a stored row can be final. */
export const METRICS_DAILY_SETTLE_MS = 30 * 60_000;

export type MetricsDailyReader = {
  family: string;
  reader: DailyMetricReader;
};

export type MetricsDailyOptions = {
  /** Test seam: readers to run instead of the registry's. */
  readers?: readonly MetricsDailyReader[];
};

export type MetricsDailyResult = {
  written: number;
  unchanged: number;
  deleted: number;
  failedFamilies: string[];
};

type StoredValue = {
  unit: MetricValue["unit"];
  valueInt: number | null;
  valueDecimal: string | null;
};

type ExistingRow = { id: string; key: string; finality: string };

function storedValue(value: MetricValue): StoredValue {
  switch (value.unit) {
    case "idr":
      return { unit: "idr", valueInt: value.valueIdr, valueDecimal: null };
    case "count":
    case "seconds":
      return { unit: value.unit, valueInt: value.value, valueDecimal: null };
    case "percent":
    case "decimal":
      return { unit: value.unit, valueInt: null, valueDecimal: value.value };
  }
}

function rowKey(
  code: string,
  dimensionKey: string | null,
  dimensionValue: string | null,
): string {
  return `${code}\u0000${dimensionKey ?? ""}\u0000${dimensionValue ?? ""}`;
}

/** Throws when a reader value breaks the definition or the reader's promise. */
function validate(
  reader: DailyMetricReader,
  values: readonly DailyMetricValue[],
): void {
  for (const value of values) {
    if (!reader.metricCodes.includes(value.metricCode))
      throw new Error("Metric reader returned a code it does not list");
    const definition = reportMetricByCode.get(value.metricCode);
    if (!definition) throw new Error("Metric reader returned an unknown code");
    if (definition.unit !== value.value.unit)
      throw new Error("Metric reader value unit differs from the definition");
    if (
      value.dimension !== null &&
      (!reader.dimensions.includes(value.dimension.key) ||
        value.dimension.value.length < 1 ||
        value.dimension.value.length > 200)
    )
      throw new Error("Metric reader returned an invalid dimension");
  }
}

async function writeFamily(
  tx: Tx,
  scope: { tenantId: string; outletId: string; businessDate: BusinessDate },
  reader: DailyMetricReader,
  finality: "estimate" | "final",
  now: Date,
): Promise<{ written: number; unchanged: number; deleted: number }> {
  const input = { tx, ...scope, now };
  const values = await reader.compute(input);
  // A reader's hold downgrades a final day to estimate (finality hook).
  if (finality === "final" && (await reader.pendingDay?.(input)))
    finality = "estimate";
  validate(reader, values);

  const records = values.map((entry) => {
    const definition = reportMetricByCode.get(entry.metricCode)!;
    const stored = storedValue(entry.value);
    return {
      metric_code: entry.metricCode,
      definition_id: definition.id,
      definition_version: definition.version,
      dimension_key: entry.dimension?.key ?? null,
      dimension_value: entry.dimension?.value ?? null,
      unit: stored.unit,
      value_int: stored.valueInt,
      value_decimal: stored.valueDecimal,
      finality,
    };
  });

  // Rows this reader owns: its split dimensions, and the total row when it
  // declares `writesTotal`. Another reader of the same code in another
  // dimension keeps its rows.
  const ownsTotal = readerWritesTotal(reader);
  const ownDimensions = [
    ...(ownsTotal ? [sql`dimension_key IS NULL`] : []),
    ...(reader.dimensions.length > 0
      ? [
          sql`dimension_key IN (${sql.join(
            reader.dimensions.map((key) => sql`${key}`),
            sql`, `,
          )})`,
        ]
      : []),
  ];

  const existing = (
    await tx.execute(sql`
      SELECT id, metric_code, dimension_key, dimension_value, finality
        FROM metrics_daily
       WHERE tenant_id = ${scope.tenantId} AND outlet_id = ${scope.outletId}
         AND metric_date = ${scope.businessDate}
         AND metric_code IN (${sql.join(
           reader.metricCodes.map((code) => sql`${code}`),
           sql`, `,
         )})
         AND (${sql.join(ownDimensions, sql` OR `)})`)
  ).rows.map((row): ExistingRow => ({
    id: String(row.id),
    key: rowKey(
      String(row.metric_code),
      row.dimension_key === null ? null : String(row.dimension_key),
      row.dimension_value === null ? null : String(row.dimension_value),
    ),
    finality: String(row.finality),
  }));

  let written = 0;
  if (records.length > 0) {
    const upserted = await tx.execute(sql`
      INSERT INTO metrics_daily
        (tenant_id, outlet_id, metric_date, metric_code, definition_id,
         definition_version, dimension_key, dimension_value, unit, value_int,
         value_decimal, finality, computed_at)
      SELECT ${scope.tenantId}, ${scope.outletId}, ${scope.businessDate},
             r.metric_code, r.definition_id, r.definition_version,
             r.dimension_key, r.dimension_value, r.unit, r.value_int,
             r.value_decimal, r.finality, ${now.toISOString()}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS r(
          metric_code text, definition_id uuid, definition_version integer,
          dimension_key text, dimension_value text, unit text,
          value_int bigint, value_decimal numeric, finality text)
      ON CONFLICT ON CONSTRAINT metrics_daily_key DO UPDATE SET
        value_int = EXCLUDED.value_int,
        value_decimal = EXCLUDED.value_decimal,
        unit = EXCLUDED.unit,
        finality = EXCLUDED.finality,
        definition_id = EXCLUDED.definition_id,
        definition_version = EXCLUDED.definition_version,
        computed_at = EXCLUDED.computed_at,
        updated_at = now()
      WHERE (metrics_daily.value_int, metrics_daily.value_decimal,
             metrics_daily.finality, metrics_daily.definition_version)
        IS DISTINCT FROM
            (EXCLUDED.value_int, EXCLUDED.value_decimal,
             EXCLUDED.finality, EXCLUDED.definition_version)
      RETURNING metric_code, dimension_key, dimension_value`);
    written = upserted.rows.length;
    const wasFinal = new Set(
      existing.filter((row) => row.finality === "final").map((row) => row.key),
    );
    for (const row of upserted.rows) {
      const key = rowKey(
        String(row.metric_code),
        row.dimension_key === null ? null : String(row.dimension_key),
        row.dimension_value === null ? null : String(row.dimension_value),
      );
      if (wasFinal.has(key))
        logger.warn(
          { metricCode: String(row.metric_code), outletId: scope.outletId },
          "metrics_daily final row changed",
        );
    }
  }

  const kept = new Set(
    records.map((record) =>
      rowKey(record.metric_code, record.dimension_key, record.dimension_value),
    ),
  );
  const stale = existing.filter((row) => !kept.has(row.key));
  if (stale.length > 0)
    await tx.execute(sql`
      DELETE FROM metrics_daily
       WHERE tenant_id = ${scope.tenantId}
         AND id IN (${sql.join(
           stale.map((row) => sql`${row.id}::uuid`),
           sql`, `,
         )})`);

  return {
    written,
    unchanged: records.length - written,
    deleted: stale.length,
  };
}

/**
 * Recomputes every daily reader for one outlet business date. A tenant context
 * that does not own the outlet fails at the outlet lookup (RLS) and writes
 * nothing.
 */
export async function refreshMetricsDaily(
  context: ScopedTenantContext,
  input: { outletId: string; businessDate: BusinessDate },
  now: Date = new Date(),
  options: MetricsDailyOptions = {},
): Promise<MetricsDailyResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const readers = options.readers ?? dailyReaders();
  const { outletId, businessDate } = input;
  const lockKey = `metrics_daily:${tenantId}:${outletId}:${businessDate}`;

  return withTenant(db, context, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const clock = await loadOutletClock(tx, context, outletId);
    const settled =
      now.getTime() >=
      businessDayRange(businessDate, clock).end.getTime() +
        METRICS_DAILY_SETTLE_MS;
    let closed = false;
    if (settled && readers.some(({ reader }) => reader.requiresDailyClose)) {
      const [close] = await tx
        .select({ id: posDailyCloses.id })
        .from(posDailyCloses)
        .where(
          and(
            eq(posDailyCloses.tenantId, tenantId),
            eq(posDailyCloses.outletId, outletId as OutletId),
            eq(posDailyCloses.businessDate, businessDate),
          ),
        )
        .limit(1);
      closed = close !== undefined;
    }

    const result: MetricsDailyResult = {
      written: 0,
      unchanged: 0,
      deleted: 0,
      failedFamilies: [],
    };
    for (const { family, reader } of readers) {
      const finality =
        settled && (!reader.requiresDailyClose || closed)
          ? "final"
          : "estimate";
      try {
        const outcome = await tx.transaction((savepoint) =>
          writeFamily(
            savepoint,
            { tenantId, outletId, businessDate },
            reader,
            finality,
            now,
          ),
        );
        result.written += outcome.written;
        result.unchanged += outcome.unchanged;
        result.deleted += outcome.deleted;
      } catch {
        if (!result.failedFamilies.includes(family))
          result.failedFamilies.push(family);
        logger.error(
          { family, metricCodes: reader.metricCodes, outletId },
          "metrics_daily family failed",
        );
      }
    }
    return result;
  });
}

/** Reruns the refresh for an older date range (backfill, version bump). */
export async function recomputeMetricsDaily(
  context: ScopedTenantContext,
  outletId: string,
  from: BusinessDate,
  to: BusinessDate,
  options: MetricsDailyOptions & { now?: Date } = {},
): Promise<MetricsDailyResult> {
  const total: MetricsDailyResult = {
    written: 0,
    unchanged: 0,
    deleted: 0,
    failedFamilies: [],
  };
  const now = options.now ?? new Date();
  for (let date = from; date <= to; date = addBusinessDays(date, 1)) {
    const result = await refreshMetricsDaily(
      context,
      { outletId, businessDate: date },
      now,
      options,
    );
    total.written += result.written;
    total.unchanged += result.unchanged;
    total.deleted += result.deleted;
    for (const family of result.failedFamilies)
      if (!total.failedFamilies.includes(family))
        total.failedFamilies.push(family);
  }
  return total;
}
