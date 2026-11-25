// Release-only replay of source-backed outlet days. Reuse the metric service's
// locks/upserts; never fabricate an empty historical day from metrics_daily.
import { sql, type SQL } from "drizzle-orm";
import {
  addBusinessDays,
  businessDateOf,
  businessDateSchema,
  businessDayRange,
  localDateOf,
  outletIdSchema,
  tenantIdSchema,
  type BusinessDate,
  type BusinessDayClock,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { slugSchema } from "@starter/shared/platform";
import type { Tx } from "../services/metric-sources/types";

export const METRICS_BACKFILL_BATCH_SIZE = 25;
export const USAGE =
  "Usage: pnpm --filter @starter/api metrics:backfill -- --from <YYYY-MM-DD> [--tenant <slug>] [--dry-run]";

export class MetricsBackfillUsageError extends Error {}

function validateFrom(from: string, now: Date): BusinessDate {
  const parsed = businessDateSchema.safeParse(from);
  if (!parsed.success)
    throw new MetricsBackfillUsageError(
      "--from must be a valid YYYY-MM-DD date.",
    );
  // No outlet can have a calendar date later than UTC+14. This rejects an
  // accidental future range before opening a database connection.
  if (parsed.data > localDateOf(now, "Pacific/Kiritimati"))
    throw new MetricsBackfillUsageError("--from must not be in the future.");
  return parsed.data;
}

export function parseArgs(args: string[], now: Date = new Date()) {
  let from: string | undefined;
  let tenant: string | undefined;
  let dryRun = false;
  const values = args.filter((arg) => arg !== "--");
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === "--from" && !from && values[i + 1]) from = values[++i];
    else if (arg === "--tenant" && !tenant && values[i + 1])
      tenant = values[++i];
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else throw new MetricsBackfillUsageError("Unknown or repeated argument.");
  }
  if (!from) throw new MetricsBackfillUsageError("--from is required.");
  if (tenant !== undefined && !slugSchema.safeParse(tenant).success)
    throw new MetricsBackfillUsageError("--tenant must be a tenant slug.");
  return { from: validateFrom(from, now), tenant, dryRun };
}

/**
 * Mirror the daily readers' input domains, not their metric calculations.
 * Persistent sources (stock, due items, facility capacity) remain input on
 * later days without events. A metrics_daily row alone is never a source.
 */
async function hasSource(
  tx: Tx,
  tenantId: string,
  outletId: string,
  date: BusinessDate,
  clock: BusinessDayClock,
  now: Date,
): Promise<boolean> {
  const range = businessDayRange(date, clock);
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  const exists = (table: string, predicate: SQL) => sql`EXISTS (
    SELECT 1 FROM ${sql.identifier(table)}
     WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid
       AND (${predicate})
  )`;
  const inDay = (column: string) =>
    sql`${sql.identifier(column)} >= ${start}::timestamptz AND ${sql.identifier(column)} < ${end}::timestamptz`;
  const checks: SQL[] = [
    ...[
      ["orders", "business_date"],
      ["sales_targets", "target_date"],
      ["pos_shifts", "business_date"],
      ["pos_daily_closes", "business_date"],
    ].map(([table, column]) =>
      exists(table!, sql`${sql.identifier(column!)} = ${date}::date`),
    ),
    exists(
      "recipe_deductions",
      sql`business_date = ${date}::date AND kind IN ('remake', 'comp') AND idempotency_key NOT LIKE 'swap:issue:%'`,
    ),
    exists(
      "table_sessions",
      sql`(status IN ('open', 'bill_requested', 'closed') AND ${inDay("opened_at")}) OR (status = 'closed' AND ${inDay("closed_at")})`,
    ),
    exists(
      "service_requests",
      sql`type = 'call_waiter' AND status <> 'cancelled' AND ${inDay("created_at")}`,
    ),
    exists("kitchen_tickets", sql`${inDay("fired_at")} OR ${inDay("done_at")}`),
    exists("customer_visits", inDay("visited_at")),
    exists("feedback", sql`kind = 'rating' AND ${inDay("created_at")}`),
    exists(
      "promotion_redemptions",
      sql`status = 'applied' AND ${inDay("redeemed_at")}`,
    ),
    exists("reservations", inDay("reserved_for")),
    exists("delivery_channel_orders", inDay("received_at")),
    exists("facility_incidents", inDay("triggered_at")),
    exists(
      "purchase_orders",
      sql`status IN ('approved', 'sent', 'partially_received', 'received', 'closed') AND ${inDay("approved_at")}`,
    ),
    exists("waste_logs", inDay("created_at")),
    exists("stock_ledger", sql`occurred_at < ${end}::timestamptz`),
    exists(
      "accounting_open_items",
      sql`kind = 'payable' AND document_date <= ${date}::date AND due_on <= ${date}::date`,
    ),
    exists("facility_units", sql`created_at < ${end}::timestamptz`),
    exists(
      "access_tickets",
      sql`(status = 'completed' AND coalesce(ended_at, ends_at) >= ${start}::timestamptz AND coalesce(ended_at, ends_at) < ${end}::timestamptz)
       OR (status IN ('in_use', 'completed') AND starts_at < ${end}::timestamptz AND coalesce(ended_at, ${now.toISOString()}::timestamptz) > ${start}::timestamptz)`,
    ),
  ];
  if (date === businessDateOf(now, clock))
    checks.push(exists("stock_balances", sql`true`));
  const result = await tx.execute(
    sql`SELECT (${sql.join(checks, sql` OR `)}) AS present`,
  );
  return result.rows[0]?.present === true;
}

export type MetricsBackfillResult = {
  tenants: number;
  outlets: number;
  days: number;
  skippedDays: number;
  written: number;
  unchanged: number;
  deleted: number;
  failedDays: number;
};

export async function backfillMetricsDaily(options: {
  from: BusinessDate;
  tenant?: string;
  dryRun?: boolean;
  now?: Date;
  log?: (line: string) => void;
}): Promise<MetricsBackfillResult> {
  const now = options.now ?? new Date();
  const from = validateFrom(options.from, now);
  if (
    options.tenant !== undefined &&
    !slugSchema.safeParse(options.tenant).success
  )
    throw new MetricsBackfillUsageError("--tenant must be a tenant slug.");
  // Delay app/config imports until CLI argument validation and env loading.
  const { db } = await import("../db/index");
  const { withTenant } = await import("../db/tenant");
  const { recomputeMetricsDaily } =
    await import("../services/metrics-daily.service");
  const log = options.log ?? console.log;
  const result: MetricsBackfillResult = {
    tenants: 0,
    outlets: 0,
    days: 0,
    skippedDays: 0,
    written: 0,
    unchanged: 0,
    deleted: 0,
    failedDays: 0,
  };
  let tenantAfter = "";
  for (;;) {
    const page = await db.execute(sql`
      SELECT id FROM tenants
       WHERE id::text > ${tenantAfter}
         ${options.tenant === undefined ? sql`` : sql`AND slug = ${options.tenant}`}
       ORDER BY id::text LIMIT ${METRICS_BACKFILL_BATCH_SIZE}`);
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const before = { ...result };
      const tenantId = tenantIdSchema.parse(row.id);
      tenantAfter = tenantId;
      result.tenants += 1;
      const context: ScopedTenantContext = establishScopedTenantContext(
        establishTenantContext({ tenantId, brandId: null, source: "job" }),
        { kind: "tenant" },
      );
      let outletAfter = "";
      for (;;) {
        // No status filter: historical records of a closed outlet still count.
        const outlets = await withTenant(db, context, (tx) =>
          tx.execute(sql`
          SELECT id, timezone, business_day_cutoff FROM outlets
           WHERE tenant_id = ${tenantId}::uuid AND id::text > ${outletAfter}
           ORDER BY id::text LIMIT ${METRICS_BACKFILL_BATCH_SIZE}`),
        );
        if (outlets.rows.length === 0) break;
        for (const outlet of outlets.rows) {
          const outletId = outletIdSchema.parse(outlet.id);
          outletAfter = outletId;
          result.outlets += 1;
          const clock = {
            timeZone: String(outlet.timezone),
            cutoff: String(outlet.business_day_cutoff),
          };
          const to = businessDateOf(now, clock);
          for (let day = from; day <= to; day = addBusinessDays(day, 1)) {
            const present = await withTenant(db, context, (tx) =>
              hasSource(tx, tenantId, outletId, day, clock, now),
            );
            if (!present) {
              result.skippedDays += 1;
              continue;
            }
            result.days += 1;
            if (options.dryRun) continue;
            const outcome = await recomputeMetricsDaily(
              context,
              outletId,
              day,
              day,
              { now },
            );
            result.written += outcome.written;
            result.unchanged += outcome.unchanged;
            result.deleted += outcome.deleted;
            if (outcome.failedFamilies.length > 0) result.failedDays += 1;
          }
        }
      }
      log(
        JSON.stringify({
          tenantId,
          days: result.days - before.days,
          skippedDays: result.skippedDays - before.skippedDays,
          written: result.written - before.written,
          unchanged: result.unchanged - before.unchanged,
          deleted: result.deleted - before.deleted,
          failedDays: result.failedDays - before.failedDays,
          dryRun: Number(options.dryRun ?? false),
        }),
      );
    }
  }
  if (options.tenant !== undefined && result.tenants === 0)
    throw new MetricsBackfillUsageError("Tenant was not found.");
  return result;
}

export async function cli(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch {
    console.error(USAGE);
    return 2;
  }
  let pool: typeof import("../db/index").pool | undefined;
  try {
    await import("../load-env");
    // Suppress lower-level family/outlet and SQL logs in this operator CLI.
    const { logger } = await import("../lib/logger");
    logger.level = "silent";
    pool = (await import("../db/index")).pool;
    const result = await backfillMetricsDaily(parsed);
    return result.failedDays > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      error instanceof MetricsBackfillUsageError
        ? "Metrics backfill input was rejected."
        : "Metrics backfill failed; rerun after checking database availability and migrations.",
    );
    return error instanceof MetricsBackfillUsageError ? 2 : 1;
  } finally {
    await pool?.end();
  }
}
