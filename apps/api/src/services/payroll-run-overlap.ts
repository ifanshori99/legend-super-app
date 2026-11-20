// One employee is paid once per period across REGULAR runs (bead legend-1213,
// SO 1208 P1). Two policies of one legal entity, or a policy whose cycle was
// changed, can open a second regular run whose period overlaps a run that
// already holds the employee's payslip; slips are unique per run only, so
// nothing else stops the double payment (and double BPJS / kasbon deduction).
//
// Fail closed: any employee with a slip in ANOTHER live (not reversed) regular
// run whose period overlaps is refused, the whole run with them. THR and
// off-cycle runs are never compared (a correction or THR is a legitimate
// second payment of the same days), and the run's own slips never count.
//
// The caller holds the legal entity lock (`lockPph21ReceivableScope`) after the
// month lock, so a racing lock of the other run waits here and then sees the
// slips this one wrote.
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { BusinessDate, TenantId } from "@starter/shared/core";
import type { PayrollRunId } from "@starter/shared/hris/payroll";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

export async function assertNoOverlappingRegularPayslips(
  tx: Tx,
  tenantId: TenantId,
  run: {
    id: PayrollRunId;
    runType: string;
    periodStart: BusinessDate;
    periodEnd: BusinessDate;
  },
  employeeIds: readonly string[],
): Promise<void> {
  if (run.runType !== "regular" || employeeIds.length === 0) return;
  const rows = await tx
    .selectDistinct({ employeeId: payslips.employeeId })
    .from(payslips)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payslips.tenantId),
        eq(payrollRuns.id, payslips.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payslips.tenantId, tenantId),
        inArray(payslips.employeeId, [...employeeIds]),
        eq(payrollRuns.runType, "regular"),
        ne(payrollRuns.status, "reversed"),
        ne(payrollRuns.id, run.id),
        lte(payrollRuns.periodStart, run.periodEnd),
        gte(payrollRuns.periodEnd, run.periodStart),
      ),
    );
  if (rows.length > 0)
    throw new HttpError(
      409,
      "PAYROLL_EMPLOYEE_PERIOD_OVERLAP",
      `${rows.length} karyawan sudah punya slip gaji di payroll reguler lain yang periodenya beririsan. Payroll ini ditolak supaya tidak ada yang digaji dua kali; periksa kebijakan dan periode payroll.`,
    );
}
