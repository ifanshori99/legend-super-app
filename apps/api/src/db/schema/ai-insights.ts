// AI insights tables (WS-12 wave 3; beads legend-hkd4, legend-lely): demand
// forecasts (AI-07), anomaly alerts (AI-09) and daily summaries (AI-10).
// Contract: `@starter/shared/ai` (insights.ts). Tenant + outlet RLS lives in
// ai-insights.custom.sql.
//
// - Every table is tenant owned and outlet owned (`tenant_id`, `outlet_id`
//   NOT NULL); unique keys include `tenant_id`.
// - Money: `*_idr` is whole rupiah. `forecasts.value` is numeric(14,2) (sales
//   in rupiah, orders and covers as counts), returned as a string by the driver.
// - Rows are written by worker jobs (system context) and are idempotent through
//   the natural unique keys.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import { businessDate, idrColumn, tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** AI-07: rule-based demand forecast, one row per outlet, date, hour and metric. */
export const forecasts = pgTable(
  "forecasts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    targetDate: businessDate("target_date").notNull(),
    hour: smallint("hour").notNull(),
    /** `ForecastMetricCode`: sales_idr | orders | covers. */
    metricCode: varchar("metric_code", { length: 20 }).notNull(),
    value: numeric("value", { precision: 14, scale: 2 }).notNull(),
    modelVersion: varchar("model_version", { length: 20 }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("forecasts_tenant_outlet_date_hour_metric_key").on(
      table.tenantId,
      table.outletId,
      table.targetDate,
      table.hour,
      table.metricCode,
    ),
    index("forecasts_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.targetDate,
    ),
    check("forecasts_hour_check", sql`${table.hour} BETWEEN 0 AND 23`),
    check(
      "forecasts_metric_check",
      sql`${table.metricCode} IN ('sales_idr', 'orders', 'covers')`,
    ),
    check("forecasts_value_check", sql`${table.value} >= 0`),
  ],
);

/** AI-09: rule-based anomaly alert, one per outlet, business date and kind. */
export const aiAnomalyAlerts = pgTable(
  "ai_anomaly_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    /** `AnomalyKind`: void | discount | refund | waste. */
    kind: varchar("kind", { length: 20 }).notNull(),
    observedIdr: idrColumn("observed_idr").notNull(),
    baselineIdr: idrColumn("baseline_idr").notNull(),
    ratio: numeric("ratio", { precision: 8, scale: 2 }).notNull(),
    /** warn (ratio >= 2) | high (ratio >= 3). */
    severity: varchar("severity", { length: 10 }).notNull(),
    /** open | acknowledged. */
    status: varchar("status", { length: 15 }).notNull().default("open"),
    acknowledgedBy: text("acknowledged_by")
      .$type<UserId>()
      .references(() => user.id),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    unique("ai_anomaly_alerts_tenant_outlet_date_kind_key").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
      table.kind,
    ),
    index("ai_anomaly_alerts_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.businessDate,
    ),
    check(
      "ai_anomaly_alerts_kind_check",
      sql`${table.kind} IN ('void', 'discount', 'refund', 'waste')`,
    ),
    check(
      "ai_anomaly_alerts_severity_check",
      sql`${table.severity} IN ('warn', 'high')`,
    ),
    check(
      "ai_anomaly_alerts_status_check",
      sql`${table.status} IN ('open', 'acknowledged')`,
    ),
    check(
      "ai_anomaly_alerts_amount_check",
      sql`${table.observedIdr} >= 0 AND ${table.baselineIdr} >= 0 AND ${table.ratio} >= 0`,
    ),
  ],
);

/** AI-10: daily summary, one per outlet and business date. */
export const aiDailySummaries = pgTable(
  "ai_daily_summaries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    text: text("text").notNull(),
    /** false when the deterministic template wrote the text (no LLM call). */
    aiAssisted: boolean("ai_assisted").notNull(),
    /** `DailySummaryMetrics`: salesIdr, orders, voidIdr, discountIdr, refundIdr, wasteIdr. */
    metrics: jsonb("metrics").notNull(),
    createdAt,
  },
  (table) => [
    unique("ai_daily_summaries_tenant_outlet_date_key").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    index("ai_daily_summaries_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    check(
      "ai_daily_summaries_metrics_check",
      sql`jsonb_typeof(${table.metrics}) = 'object'`,
    ),
  ],
);
