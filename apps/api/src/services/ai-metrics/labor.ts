// Read-only labor aggregates for AI tool TL-05 (bead legend-mfyo). Aggregate
// only: never an individual's pay or identity (PRD §40 Input Minimum).
// Available data: active headcount (employees by home outlet) and approved
// overtime minutes. NOT available yet: payroll runs, attendance and shift
// schedules have no tables on this branch, so labor cost, scheduled hours and
// worked hours are reported as zero (the tool source label says so).
import { sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import { outletIn } from "./sales";

export type LaborAggregate = {
  headcount: number;
  overtimeMinutes: number;
};

export async function queryLaborAggregate(
  context: ScopedTenantContext,
  input: { outletIds: readonly string[]; from: string; to: string },
): Promise<LaborAggregate> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // employees and overtime_requests carry tenant RLS only: the outlet filter
    // below is the outlet wall.
    const staff = await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM employees e
      WHERE e.tenant_id = ${tenantId}::uuid
        AND e.status = 'active'
        AND ${outletIn(sql`e.home_outlet_id`, input.outletIds)}
        AND e.join_date <= ${input.to}::date
        AND (e.end_date IS NULL OR e.end_date >= ${input.from}::date)`);
    const overtime = await tx.execute(sql`
      SELECT COALESCE(SUM(minutes), 0)::int AS minutes FROM overtime_requests
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'approved'
        AND ${outletIn(sql`outlet_id`, input.outletIds)}
        AND date BETWEEN ${input.from}::date AND ${input.to}::date`);
    return {
      headcount: Number(staff.rows[0]?.n ?? 0),
      overtimeMinutes: Number(overtime.rows[0]?.minutes ?? 0),
    };
  });
}
