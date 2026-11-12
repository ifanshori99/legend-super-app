// AI-09 rule-based anomaly alerts (WS-12 wave 3, part A; bead legend-lely).
//
// Rule (rule-v1, no LLM): per outlet and business date, the observed rupiah
// total of each kind is compared with the baseline = total of the previous 28
// business days / 28 (days without rows count as zero):
//   void     pos_order_voids.amount_idr      by voided_at
//   discount pos_order_discounts.amount_idr  by created_at, removed_at IS NULL
//   refund   POS tender + released DP amount by refunded_at
//   waste    waste_logs.value_idr            by occurred_at
// ratio >= 3 -> high, >= 2 -> warn. Baseline 0: observed < Rp100.000 is
// skipped, else a high alert with the capped ratio. Day boundaries come from
// the outlet's business-day clock (timezone + cutoff).
//
// - `detectAnomalies` runs from the worker (tenant-wide system context) and
//   is idempotent through (tenant, outlet, business_date, kind); a re-run
//   refreshes the numbers but keeps the status and never notifies twice. A
//   new alert appends `ai_insight.anomaly_detected` (destination
//   `notification`); the worker rule notifies `report.operational.view`. A
//   later rise from warn to high is notified once more (own sequence and
//   idempotency key); severity never drops back.
// - Reads and acknowledge run in `access.contextFor("report.operational.view")`
//   contexts; RLS (tenant + outlet) is the second wall.
// - Gap: cash variance (no cash variance table yet).
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  anomalyAlertSchema,
  type AnomalyAlert,
  type anomalyKindSchema,
  type listAnomalyAlertsQuerySchema,
} from "@starter/shared/ai";
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDayRange,
  idr,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
  type z,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { aiAnomalyAlerts } from "../db/schema/ai-insights.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { outletReadGroups } from "./ai-insights-access.ts";
import { emitInsightNotification } from "./ai-insights-notify.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AnomalyKind = z.infer<typeof anomalyKindSchema>;
type ListQuery = z.infer<typeof listAnomalyAlertsQuerySchema>;

export const ANOMALY_PERMISSION = "report.operational.view" as const;
export const ANOMALY_BASELINE_DAYS = 28;
export const ANOMALY_WARN_RATIO = 2;
export const ANOMALY_HIGH_RATIO = 3;
/** Baseline 0: smaller observed totals are never an anomaly. */
export const ANOMALY_ZERO_BASELINE_MIN_IDR = 100_000;
/** numeric(8,2) upper bound. */
const MAX_RATIO = 999_999.99;
const LIST_LIMIT = 200;

const KINDS: readonly AnomalyKind[] = ["void", "discount", "refund", "waste"];

export type KindTotals = Record<AnomalyKind, number>;

/** Business-day clock of one outlet (RLS: tenant). */
export async function loadOutletClock(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
) {
  const [row] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return outletBusinessDayClock({
    timezone: row.timezone,
    businessDayCutoff: row.businessDayCutoff,
  });
}

/** Rupiah totals of the four kinds in [start, end), one outlet. */
export async function kindTotals(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  start: Date,
  end: Date,
): Promise<KindTotals> {
  const tenantId = context.tenant.tenantId;
  const s = start.toISOString();
  const e = end.toISOString();
  const scope = sql`tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid`;
  const result = await tx.execute(sql`SELECT
      (SELECT COALESCE(SUM(amount_idr), 0) FROM pos_order_voids
        WHERE ${scope} AND voided_at >= ${s}::timestamptz AND voided_at < ${e}::timestamptz) AS void,
      (SELECT COALESCE(SUM(amount_idr), 0) FROM pos_order_discounts
        WHERE ${scope} AND removed_at IS NULL
          AND created_at >= ${s}::timestamptz AND created_at < ${e}::timestamptz) AS discount,
      (SELECT COALESCE(SUM(amount_idr), 0) FROM (
         SELECT tenant_id, outlet_id, refunded_at, amount_idr FROM pos_order_refunds
         UNION ALL
         SELECT d.tenant_id, d.outlet_id, r.refunded_at, d.amount_idr
           FROM pos_deposit_refunds d
           JOIN pos_order_refunds r ON r.tenant_id = d.tenant_id AND r.id = d.pos_refund_id
       ) economic_refunds
        WHERE ${scope} AND refunded_at >= ${s}::timestamptz AND refunded_at < ${e}::timestamptz) AS refund,
      (SELECT COALESCE(SUM(value_idr), 0) FROM waste_logs
        WHERE ${scope} AND occurred_at >= ${s}::timestamptz AND occurred_at < ${e}::timestamptz) AS waste`);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    void: Number(row.void ?? 0),
    discount: Number(row.discount ?? 0),
    refund: Number(row.refund ?? 0),
    waste: Number(row.waste ?? 0),
  };
}

export type AnomalyDecision = {
  kind: AnomalyKind;
  observedIdr: number;
  baselineIdr: number;
  ratio: number;
  severity: "warn" | "high";
};

/** Pure rule: the alert for one kind, or null. */
export function decideAnomaly(
  kind: AnomalyKind,
  observedIdr: number,
  baselineTotalIdr: number,
): AnomalyDecision | null {
  const baselineIdr = Math.round(baselineTotalIdr / ANOMALY_BASELINE_DAYS);
  if (observedIdr <= 0) return null;
  if (baselineIdr === 0) {
    if (observedIdr < ANOMALY_ZERO_BASELINE_MIN_IDR) return null;
    return {
      kind,
      observedIdr,
      baselineIdr,
      ratio: MAX_RATIO,
      severity: "high",
    };
  }
  const ratio = Math.min(
    MAX_RATIO,
    Math.round((observedIdr / baselineIdr) * 100) / 100,
  );
  if (ratio < ANOMALY_WARN_RATIO) return null;
  return {
    kind,
    observedIdr,
    baselineIdr,
    ratio,
    severity: ratio >= ANOMALY_HIGH_RATIO ? "high" : "warn",
  };
}

type AlertRow = typeof aiAnomalyAlerts.$inferSelect;

function toAlert(row: AlertRow): AnomalyAlert {
  return anomalyAlertSchema.parse({
    id: row.id,
    outletId: row.outletId,
    businessDate: row.businessDate,
    kind: row.kind,
    observedIdr: Number(row.observedIdr),
    baselineIdr: Number(row.baselineIdr),
    ratio: Number(row.ratio),
    severity: row.severity,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

/**
 * Evaluates one outlet and business date (worker, system context). Returns
 * the alerts of that day and how many are new (each new one is notified to
 * the holders of `report.operational.view` at the outlet).
 */
export async function detectAnomalies(
  context: ScopedTenantContext,
  input: { outletId: string; businessDate: string },
  now: Date = new Date(),
): Promise<{ created: number; alerts: AnomalyAlert[] }> {
  assertTrustedScopedContext(context);
  const date = input.businessDate as BusinessDate;
  return withTenant(db, context, async (tx) => {
    const clock = await loadOutletClock(tx, context, input.outletId);
    const day = businessDayRange(date, clock);
    const baselineStart = businessDayRange(
      addBusinessDays(date, -ANOMALY_BASELINE_DAYS),
      clock,
    ).start;
    const observed = await kindTotals(
      tx,
      context,
      input.outletId,
      day.start,
      day.end,
    );
    const baseline = await kindTotals(
      tx,
      context,
      input.outletId,
      baselineStart,
      day.start,
    );
    let created = 0;
    const alerts: AnomalyAlert[] = [];
    for (const kind of KINDS) {
      const decision = decideAnomaly(kind, observed[kind], baseline[kind]);
      if (!decision) continue;
      // Lock the day's row (if any) so a parallel run sees the same previous
      // severity; severity never drops, so warn -> high happens at most once.
      const [previous] = await tx
        .select({ id: aiAnomalyAlerts.id, severity: aiAnomalyAlerts.severity })
        .from(aiAnomalyAlerts)
        .where(
          and(
            eq(aiAnomalyAlerts.tenantId, context.tenant.tenantId),
            eq(aiAnomalyAlerts.outletId, input.outletId),
            eq(aiAnomalyAlerts.businessDate, date),
            eq(aiAnomalyAlerts.kind, kind),
          ),
        )
        .for("update")
        .limit(1);
      const severity =
        previous?.severity === "high" ? "high" : decision.severity;
      const [row] = await tx
        .insert(aiAnomalyAlerts)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          businessDate: date,
          kind,
          observedIdr: idr(decision.observedIdr),
          baselineIdr: idr(decision.baselineIdr),
          ratio: decision.ratio.toFixed(2),
          severity,
        })
        .onConflictDoUpdate({
          target: [
            aiAnomalyAlerts.tenantId,
            aiAnomalyAlerts.outletId,
            aiAnomalyAlerts.businessDate,
            aiAnomalyAlerts.kind,
          ],
          set: {
            observedIdr: idr(decision.observedIdr),
            baselineIdr: idr(decision.baselineIdr),
            ratio: decision.ratio.toFixed(2),
            severity,
          },
        })
        .returning();
      if (!row) continue;
      alerts.push(toAlert(row));
      const escalated = previous?.severity === "warn" && severity === "high";
      if (previous && !escalated) continue;
      if (!previous) created += 1;
      await emitInsightNotification(
        tx,
        context,
        {
          name: "ai_insight.anomaly_detected",
          aggregateId: row.id,
          outletId: input.outletId,
          // The first alert is sequence 1; the one warn -> high rise is 2.
          sequence: escalated ? 2 : 1,
          payload: {
            alertId: row.id,
            outletId: input.outletId,
            businessDate: date,
            kind,
            severity,
            observedIdr: decision.observedIdr,
            baselineIdr: decision.baselineIdr,
          },
        },
        now,
      );
    }
    return { created, alerts };
  });
}

/** Alerts the caller may read (`report.operational.view`), newest first. */
export async function listAnomalyAlerts(
  access: AccessSnapshot,
  query: ListQuery,
): Promise<AnomalyAlert[]> {
  const groups = await outletReadGroups(
    access,
    ANOMALY_PERMISSION,
    query.outletId,
  );
  const rows: AlertRow[] = [];
  for (const group of groups) {
    const found = await withTenant(db, group.context, (tx) =>
      tx
        .select()
        .from(aiAnomalyAlerts)
        .where(
          and(
            eq(aiAnomalyAlerts.tenantId, access.tenant.tenantId),
            inArray(aiAnomalyAlerts.outletId, [...group.outletIds]),
            query.status ? eq(aiAnomalyAlerts.status, query.status) : undefined,
            query.from
              ? gte(aiAnomalyAlerts.businessDate, query.from)
              : undefined,
            query.to ? lte(aiAnomalyAlerts.businessDate, query.to) : undefined,
          ),
        )
        .orderBy(
          desc(aiAnomalyAlerts.businessDate),
          desc(aiAnomalyAlerts.createdAt),
        )
        .limit(LIST_LIMIT),
    );
    rows.push(...found);
  }
  return rows
    .sort(
      (a, b) =>
        String(b.businessDate).localeCompare(String(a.businessDate)) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, LIST_LIMIT)
    .map(toAlert);
}

/**
 * Marks an alert acknowledged. 404 when the alert is outside the caller's
 * reach (other tenant, other outlet) so its existence never leaks; a second
 * acknowledge returns the row unchanged.
 */
export async function acknowledgeAnomalyAlert(
  access: AccessSnapshot,
  id: string,
  now: Date = new Date(),
): Promise<AnomalyAlert> {
  const groups = await outletReadGroups(access, ANOMALY_PERMISSION);
  for (const group of groups) {
    const row = await withTenant(db, group.context, async (tx) => {
      const where = and(
        eq(aiAnomalyAlerts.tenantId, access.tenant.tenantId),
        eq(aiAnomalyAlerts.id, id),
        inArray(aiAnomalyAlerts.outletId, [...group.outletIds]),
      );
      const [updated] = await tx
        .update(aiAnomalyAlerts)
        .set({
          status: "acknowledged",
          acknowledgedBy: access.userId as UserId,
          acknowledgedAt: now,
        })
        .where(and(where, eq(aiAnomalyAlerts.status, "open")))
        .returning();
      if (updated) return updated;
      const [existing] = await tx
        .select()
        .from(aiAnomalyAlerts)
        .where(where)
        .limit(1);
      return existing ?? null;
    });
    if (row) return toAlert(row);
  }
  throw new HttpError(404, "NOT_FOUND", "Anomaly alert not found.");
}
