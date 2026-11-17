// Read-only labor aggregates for AI tool TL-05 (bead legend-mfyo, legend-39d.4).
// Aggregate only: never an individual's pay or identity (PRD §40 Input Minimum).
// Headcount (employees by home outlet), approved overtime, scheduled hours
// (published shifts) and worked hours (valid attendance) are outlet-scoped.
// Labor COST comes from frozen payroll runs (locked or paid) and is tenant-wide
// (a run has no outlet split); `queryLaborCost` returns null, never 0, when no
// frozen run covers the whole period.
import { sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import { outletIn } from "./sales";

export type LaborAggregate = {
  headcount: number;
  overtimeMinutes: number;
  scheduledMinutes: number;
  workedMinutes: number;
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
    // Published (or swapped) shifts: segment length minus the break, per shift.
    const scheduled = await tx.execute(sql`
      SELECT COALESCE(SUM(GREATEST(per.mins - per.break_minutes, 0)), 0)::bigint AS minutes
      FROM (
        SELECT sa.break_minutes,
          COALESCE((
            SELECT SUM(EXTRACT(EPOCH FROM (
              (seg->>'endsAt')::timestamptz - (seg->>'startsAt')::timestamptz
            )) / 60)
            FROM jsonb_array_elements(sa.segments) seg
          ), 0) AS mins
        FROM shift_assignments sa
        WHERE sa.tenant_id = ${tenantId}::uuid
          AND sa.status IN ('published', 'swapped')
          AND ${outletIn(sql`sa.outlet_id`, input.outletIds)}
          AND sa.business_date BETWEEN ${input.from}::date AND ${input.to}::date
      ) per`);
    // Valid logs only: first clock-in to last clock-out per employee and day
    // (a day without both is not counted), minus the break span, capped at 16 h.
    const worked = await tx.execute(sql`
      SELECT COALESCE(SUM(LEAST(GREATEST(day.span - day.break_span, 0), 960)), 0)::bigint AS minutes
      FROM (
        SELECT
          EXTRACT(EPOCH FROM (
            MAX(a.occurred_at) FILTER (WHERE a.type = 'out')
            - MIN(a.occurred_at) FILTER (WHERE a.type = 'in')
          )) / 60 AS span,
          COALESCE(EXTRACT(EPOCH FROM (
            MAX(a.occurred_at) FILTER (WHERE a.type = 'break_end')
            - MIN(a.occurred_at) FILTER (WHERE a.type = 'break_start')
          )) / 60, 0) AS break_span
        FROM attendance_logs a
        WHERE a.tenant_id = ${tenantId}::uuid
          AND a.validity = 'valid'
          AND ${outletIn(sql`a.outlet_id`, input.outletIds)}
          AND a.business_date BETWEEN ${input.from}::date AND ${input.to}::date
        GROUP BY a.employee_id, a.business_date
        HAVING MAX(a.occurred_at) FILTER (WHERE a.type = 'out')
             > MIN(a.occurred_at) FILTER (WHERE a.type = 'in')
      ) day`);
    return {
      headcount: Number(staff.rows[0]?.n ?? 0),
      overtimeMinutes: Number(overtime.rows[0]?.minutes ?? 0),
      scheduledMinutes: Number(scheduled.rows[0]?.minutes ?? 0),
      workedMinutes: Number(worked.rows[0]?.minutes ?? 0),
    };
  });
}

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string): number =>
  Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / DAY_MS);

const wholeIdr = (value: unknown): bigint => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.trunc(n)) : 0n;
};

/**
 * Employer labor cost for the period, from frozen (locked or paid) payroll runs:
 * gross + employer BPJS + employer-borne PPh 21 - employer refund. A run that
 * overlaps the period counts pro rata by days, so the share never exceeds the
 * run's own total. Returns null (never 0) when no run exists or the frozen runs
 * do not cover every day of the period: a partial figure would read as a low
 * cost. Tenant-wide: the caller holds `payroll.view` at tenant scope.
 */
export async function queryLaborCost(
  context: ScopedTenantContext,
  input: { from: string; to: string },
): Promise<number | null> {
  const tenantId = context.tenant.tenantId;
  const runs = await withTenant(db, context, (tx) =>
    tx.execute(sql`
      SELECT period_start::text AS period_start, period_end::text AS period_end, totals
      FROM payroll_runs
      WHERE tenant_id = ${tenantId}::uuid
        AND status IN ('locked', 'paid')
        AND totals IS NOT NULL
        AND period_start <= ${input.to}::date
        AND period_end >= ${input.from}::date`),
  );
  const from = dayNumber(input.from);
  const to = dayNumber(input.to);
  const spans: [number, number][] = [];
  let total = 0n;
  for (const run of runs.rows) {
    const start = dayNumber(String(run.period_start));
    const end = dayNumber(String(run.period_end));
    const totals = (run.totals ?? {}) as Record<string, unknown>;
    const full =
      wholeIdr(totals.grossIdr) +
      wholeIdr(totals.bpjsCompanyIdr) +
      wholeIdr(totals.pph21EmployerBorneIdr) -
      wholeIdr(totals.pph21EmployerRefundIdr);
    const runDays = end - start + 1;
    const overlapStart = Math.max(start, from);
    const overlapEnd = Math.min(end, to);
    if (runDays <= 0 || overlapEnd < overlapStart || full <= 0n) continue;
    spans.push([overlapStart, overlapEnd]);
    total += (full * BigInt(overlapEnd - overlapStart + 1)) / BigInt(runDays);
  }
  if (spans.length === 0) return null;
  // Every day of the period must sit inside at least one frozen run.
  spans.sort((a, b) => a[0] - b[0]);
  let covered = from - 1;
  for (const [start, end] of spans) {
    if (start > covered + 1) return null;
    covered = Math.max(covered, end);
  }
  if (covered < to) return null;
  return Number(total);
}
