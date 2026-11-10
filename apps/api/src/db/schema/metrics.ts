// WS-11 metrics_daily: pre-aggregated daily metric values per outlet, written
// by the metrics-daily worker job and read by the metric query engine.
// Contract: docs/briefs/sub-ws11-foundation-design.md §2.3. Tenant + outlet
// RLS lives in metrics.custom.sql.
//
// - One row per (outlet, business date, metric code, optional single
//   dimension). `dimension_key` never names `outlet` (the outlet is the row).
// - `value_int` holds idr, count and seconds; `value_decimal` holds percent and
//   decimal. The unit decides which one is set (check constraint).
// - Idempotent writes go through `metrics_daily_key`; `updated_at` moves only
//   when a value, finality or definition version changes.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businessDate, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export const metricsDaily = pgTable(
  "metrics_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Outlet business date. */
    metricDate: businessDate("metric_date").notNull(),
    /** Registry code (`MetricDefinition.code`). */
    metricCode: varchar("metric_code", { length: 64 }).notNull(),
    /** Registry id and version; the registry is global, so no foreign key. */
    definitionId: uuid("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    dimensionKey: varchar("dimension_key", { length: 40 }),
    dimensionValue: varchar("dimension_value", { length: 200 }),
    /** `idr` | `count` | `percent` | `decimal` | `seconds`. */
    unit: varchar("unit", { length: 10 }).notNull(),
    /** idr (whole rupiah), count, seconds. */
    valueInt: bigint("value_int", { mode: "bigint" }),
    /** percent, decimal; returned as a string by the driver. */
    valueDecimal: numeric("value_decimal", { precision: 14, scale: 4 }),
    /** `estimate` | `final`. */
    finality: varchar("finality", { length: 10 }).notNull(),
    /** Last compute that saw this row. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Moves only when the stored value changes. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("metrics_daily_key")
      .on(
        table.tenantId,
        table.outletId,
        table.metricDate,
        table.metricCode,
        table.dimensionKey,
        table.dimensionValue,
      )
      .nullsNotDistinct(),
    index("metrics_daily_code_date_idx").on(
      table.tenantId,
      table.metricCode,
      table.metricDate,
      table.outletId,
    ),
    check(
      "metrics_daily_definition_version_check",
      sql`${table.definitionVersion} > 0`,
    ),
    check(
      "metrics_daily_dimension_key_check",
      sql`${table.dimensionKey} <> 'outlet'`,
    ),
    check(
      "metrics_daily_dimension_pair_check",
      sql`(${table.dimensionKey} IS NULL) = (${table.dimensionValue} IS NULL)`,
    ),
    check(
      "metrics_daily_unit_check",
      sql`${table.unit} IN ('idr', 'count', 'percent', 'decimal', 'seconds')`,
    ),
    check(
      "metrics_daily_value_check",
      sql`(${table.unit} IN ('idr', 'count', 'seconds') AND ${table.valueInt} IS NOT NULL AND ${table.valueDecimal} IS NULL) OR (${table.unit} IN ('percent', 'decimal') AND ${table.valueDecimal} IS NOT NULL AND ${table.valueInt} IS NULL)`,
    ),
    check(
      "metrics_daily_finality_check",
      sql`${table.finality} IN ('estimate', 'final')`,
    ),
  ],
);
