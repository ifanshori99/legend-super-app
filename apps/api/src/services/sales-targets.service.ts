// Sales targets (WS-11, bead legend-ne81z): the rupiah an outlet aims to sell on
// one business date. A month target is stored as its days (spread evenly), so
// the `sales_target` metric and the achievement ratio read one table. Tenant +
// outlet scoped: the caller's context decides which outlets it may touch, RLS
// (tenant + outlet policies) backs it.
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  createUlid,
  idr,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import { salesTargets } from "../db/schema/sales-targets";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";

export type SalesTargetDto = {
  id: string;
  outletId: string;
  /** Outlet business date, `YYYY-MM-DD`. */
  targetDate: string;
  /** Whole rupiah. */
  targetIdr: number;
  updatedAt: string;
};

export type SalesTargetDayInput = { targetDate: string; targetIdr: number };

const AUDIT_SAFE_FIELDS = ["outletId", "from", "to", "days", "totalIdr"];

function toDto(row: typeof salesTargets.$inferSelect): SalesTargetDto {
  return {
    id: row.id,
    outletId: row.outletId,
    targetDate: row.targetDate,
    targetIdr: Number(row.targetIdr),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

/** Dates `YYYY-MM-01` .. last day of `month` (`YYYY-MM`). */
export function daysOfMonth(month: string): string[] {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const count = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

/**
 * Spreads a month total over its days: every day gets floor(total / days) and
 * the first `total % days` days get one more rupiah, so the days add up to the
 * total exactly.
 */
export function spreadMonthTarget(
  month: string,
  totalIdr: number,
): SalesTargetDayInput[] {
  const days = daysOfMonth(month);
  const base = Math.floor(totalIdr / days.length);
  const remainder = totalIdr - base * days.length;
  return days.map((targetDate, index) => ({
    targetDate,
    targetIdr: base + (index < remainder ? 1 : 0),
  }));
}

export async function listSalesTargets(
  context: ScopedTenantContext,
  outletId: string,
  range: { from: string; to: string },
): Promise<SalesTargetDto[]> {
  assertOutletInScope(context.outletScope, outletId);
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(salesTargets)
      .where(
        and(
          eq(salesTargets.tenantId, context.tenant.tenantId),
          eq(salesTargets.outletId, outlet),
          gte(salesTargets.targetDate, range.from),
          lte(salesTargets.targetDate, range.to),
        ),
      )
      .orderBy(asc(salesTargets.targetDate));
    return rows.map(toDto);
  });
}

/** Creates or replaces the targets of the given days; audited. */
export async function upsertSalesTargets(
  context: ScopedTenantContext,
  outletId: string,
  days: readonly SalesTargetDayInput[],
  actorUserId: string,
  now = new Date(),
): Promise<SalesTargetDto[]> {
  assertOutletInScope(context.outletScope, outletId);
  const outlet = outletIdSchema.parse(outletId);
  if (days.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "No target days given.");
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .insert(salesTargets)
      .values(
        days.map((day) => ({
          tenantId,
          outletId: outlet,
          targetDate: day.targetDate,
          targetIdr: idr(day.targetIdr),
          createdBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          salesTargets.tenantId,
          salesTargets.outletId,
          salesTargets.targetDate,
        ],
        set: {
          targetIdr: sql`excluded.target_idr`,
          createdBy: actorUserId,
          updatedAt: now,
        },
      })
      .returning();
    const dates = days.map((day) => day.targetDate).sort();
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: outlet,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "sales_target.upserted",
        objectType: "sales_target",
        objectId: outlet,
        reason: null,
        maskedChanges: {
          before: null,
          after: maskAuditChanges(
            {
              outletId: outlet,
              from: dates[0],
              to: dates[dates.length - 1],
              days: days.length,
              totalIdr: days.reduce((sum, day) => sum + day.targetIdr, 0),
            },
            AUDIT_SAFE_FIELDS,
          ),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
    return rows
      .map(toDto)
      .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  });
}

/** Sets a month's total, spread evenly over its days (see spreadMonthTarget). */
export function upsertMonthTarget(
  context: ScopedTenantContext,
  outletId: string,
  month: string,
  totalIdr: number,
  actorUserId: string,
  now = new Date(),
): Promise<SalesTargetDto[]> {
  return upsertSalesTargets(
    context,
    outletId,
    spreadMonthTarget(month, totalIdr),
    actorUserId,
    now,
  );
}

/** Removes one day's target; false when none was stored. Audited. */
export async function deleteSalesTarget(
  context: ScopedTenantContext,
  outletId: string,
  targetDate: string,
  actorUserId: string,
  now = new Date(),
): Promise<boolean> {
  assertOutletInScope(context.outletScope, outletId);
  const outlet = outletIdSchema.parse(outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const removed = await tx
      .delete(salesTargets)
      .where(
        and(
          eq(salesTargets.tenantId, tenantId),
          eq(salesTargets.outletId, outlet),
          eq(salesTargets.targetDate, targetDate),
        ),
      )
      .returning({ id: salesTargets.id, targetIdr: salesTargets.targetIdr });
    const [row] = removed;
    if (!row) return false;
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: outlet,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "sales_target.deleted",
        objectType: "sales_target",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          after: null,
          before: maskAuditChanges(
            {
              outletId: outlet,
              from: targetDate,
              to: targetDate,
              days: 1,
              totalIdr: Number(row.targetIdr),
            },
            AUDIT_SAFE_FIELDS,
          ),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
    return true;
  });
}
