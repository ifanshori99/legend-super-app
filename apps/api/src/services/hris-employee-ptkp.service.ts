// PTKP status with its effective day (bead 1223 r2, SO 1221 A P2-1; PMK
// 168/2023). HR with payroll access (hr.employee.manage + payroll.run on the
// home outlet) sets the status and the day it is in force:
// - the start of the running tax year (1 January, or the join date when he
//   joined this year): corrects a wrong entry for this year. Refused once the
//   year's annual payslip (December, or the last tax period of a leaver) is
//   locked: the annual tax of the year is already final.
// - today (Jakarta): a change of status (marriage, a child), in force from
//   the next tax year.
// Payslips already computed are never recomputed. The trigger on employees
// writes the history row (app.ptkp_effective_from, migration 0516); the app
// role cannot write the history table.
import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  correctEmployeePtkpInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { readDbClock } from "./access.service.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
} from "./hris-access.ts";
import { idempotentHrisWrite, toEmployee } from "./hris-employee.service.ts";
import { ptkpAnchorDate } from "./payroll-ptkp-tax-year.ts";

export const PTKP_CORRECTED_ACTION = "hris.employee_ptkp.corrected";
const PAYROLL_RUN_CODE = "payroll.run";

/** Calendar day in Jakarta (UTC+7, no daylight saving). */
const jakartaDate = (at: Date) =>
  new Date(at.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

type CorrectPtkpBody = {
  ptkpStatus: unknown;
  effectiveFrom: unknown;
  reason: unknown;
  idempotencyKey: string;
};

export async function correctEmployeePtkp(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  body: CorrectPtkpBody,
  now?: Date,
): Promise<Employee> {
  const { idempotencyKey, ...rest } = body;
  const input = correctEmployeePtkpInputSchema.parse(rest);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const clock = now ?? (await readDbClock(tx));
    const access = await loadHrisAccess(tx, context, actorUserId, clock);
    const [visible] = await tx
      .select()
      .from(employees)
      .where(
        and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)),
      )
      .limit(1);
    if (!visible || access.viewerFor(visible) === null) throw notFound();
    const codes = access.permissionsAt(visible.homeOutletId);
    if (!codes.includes(HRIS_MANAGE_CODE) || !codes.includes(PAYROLL_RUN_CODE))
      throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "hris.employee.ptkp",
      { actor: access.actorUserId, employeeId: visible.id, ...input },
      async () => {
        const [row] = await tx
          .select()
          .from(employees)
          .where(
            and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)),
          )
          .limit(1)
          .for("update");
        if (!row) throw notFound();
        const today = jakartaDate(clock);
        const taxYear = Number(today.slice(0, 4));
        const anchor = ptkpAnchorDate(taxYear, row.joinDate);
        if (input.effectiveFrom !== anchor && input.effectiveFrom !== today)
          throw new HttpError(
            422,
            "PTKP_EFFECTIVE_DATE_INVALID",
            `Tanggal berlaku PTKP hanya boleh ${anchor} (awal tahun pajak berjalan atau tanggal masuk) atau hari ini.`,
          );
        if (input.effectiveFrom < row.joinDate)
          throw new HttpError(
            422,
            "PTKP_EFFECTIVE_DATE_INVALID",
            "Tanggal berlaku PTKP tidak boleh sebelum tanggal masuk karyawan.",
          );
        if (input.effectiveFrom === anchor) {
          // The annual payslip of the year: December, or the last tax period
          // of a leaver (same rule as simulate's lastTaxPeriodOf).
          const closed = await tx.execute(sql`
            SELECT 1 FROM payslips ps
              JOIN payroll_runs pr
                ON pr.tenant_id = ps.tenant_id AND pr.id = ps.payroll_run_id
             WHERE ps.tenant_id = ${tenantId}::uuid
               AND ps.employee_id = ${row.id}::uuid
               AND pr.status IN ('locked', 'paid')
               AND pr.pay_date >= ${`${taxYear}-01-01`}::date
               AND pr.pay_date < ${`${taxYear + 1}-01-01`}::date
               AND (EXTRACT(MONTH FROM pr.pay_date) = 12
                    OR (${row.endDate}::date IS NOT NULL
                        AND to_char(${row.endDate}::date, 'YYYY-MM') <= to_char(pr.pay_date, 'YYYY-MM')))
             LIMIT 1`);
          if (closed.rows.length > 0)
            throw new HttpError(
              409,
              "PTKP_TAX_YEAR_CLOSED",
              `Slip tahunan ${taxYear} karyawan ini sudah dikunci, PTKP tahun ${taxYear} tidak bisa dikoreksi lagi. Ubah dengan tanggal hari ini untuk tahun berikutnya.`,
            );
        }
        await tx.execute(
          sql`SELECT set_config('app.ptkp_effective_from', ${input.effectiveFrom}, true)`,
        );
        const [updated] = await tx
          .update(employees)
          .set({ ptkpStatus: input.ptkpStatus, updatedAt: clock })
          .where(
            and(eq(employees.tenantId, tenantId), eq(employees.id, row.id)),
          )
          .returning();
        await tx.execute(
          sql`SELECT set_config('app.ptkp_effective_from', '', true)`,
        );
        if (!updated) throw notFound();
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, access.actorUserId, clock, {
            outletId: row.homeOutletId,
            action: PTKP_CORRECTED_ACTION,
            objectType: "employee",
            objectId: row.id,
            before: { ptkpStatus: row.ptkpStatus },
            after: {
              ptkpStatus: input.ptkpStatus,
              effectiveFrom: input.effectiveFrom,
            },
            reason: input.reason,
          }),
          [...HRIS_AUDIT_SAFE_FIELDS, "ptkpStatus", "effectiveFrom"],
        );
        return toEmployee(updated);
      },
    );
  });
}
