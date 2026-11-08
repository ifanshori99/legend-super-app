// PPh 21 step of a payroll run (beads legend-iwgb, legend-oo3q, legend-y4wp;
// PRD v1.7 §3 D.30 "PPh 21", PAYR-02, PAYR-03). The payroll run tables do not
// exist yet (legend-gfcr, legend-07eg), so this service takes the run facts it
// needs (status, pay date, config snapshot) as arguments and answers the tax of
// every payslip; the run service that follows stores the results and the
// policy ref.
//
// The policy comes from the tenant's versions: before lock the version in
// force on the pay date, from lock on exactly the one the snapshot pinned
// (`pph21PolicyForRun`, shared). The statutory tables are resolved by the
// caller (`statutoryVersionsForRun`) and passed in. Each payslip goes through
// `computePayslipTax`, the same step the mock payslip builder uses.
//
// No permission check: the run caller has authorised its user, like
// `resolvePph21PolicyFor`.

import type { BusinessDate, ScopedTenantContext } from "@starter/shared/core";
import {
  computePayslipTax,
  pph21PolicyForRun,
  type PayrollConfigSnapshot,
  type PayrollRunStatus,
  type PayslipTax,
  type PayslipTaxInput,
  type Pph21PolicyParameters,
  type Pph21PolicyRef,
  type Pph21Tables,
} from "@starter/shared/hris/payroll";
import {
  loadPph21PolicyVersionsForRun,
  resolvePph21PolicyFor,
} from "./payroll-pph21-policy.service.ts";

export type PayrollRunTaxRun = {
  status: PayrollRunStatus;
  payDate: BusinessDate;
  configSnapshot: Pick<PayrollConfigSnapshot, "pph21Policy"> | null;
};

export type PayrollRunTaxEmployee = Omit<
  PayslipTaxInput,
  "tables" | "policy"
> & {
  employeeId: string;
};

export type PayrollRunTaxInput = {
  run: PayrollRunTaxRun;
  tables: Pph21Tables;
  employees: readonly PayrollRunTaxEmployee[];
};

export type PayrollRunTax = {
  /** What the snapshot holds (or would hold at lock): null = default policy. */
  pph21Policy: Pph21PolicyRef | null;
  parameters: Pph21PolicyParameters;
  payslips: { employeeId: string; tax: PayslipTax }[];
};

/**
 * PPh 21 of every payslip of a run. A locked (or later) run is computed with
 * the policy version its snapshot pinned, however many versions were
 * published since; a changed or missing pinned version is
 * PAYROLL_SNAPSHOT_MISMATCH.
 */
export async function calculatePayrollRunTax(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
): Promise<PayrollRunTax> {
  const versions = await loadPph21PolicyVersionsForRun(context);
  const { parameters, ref } = pph21PolicyForRun(input.run, versions);
  return {
    pph21Policy: ref,
    parameters,
    payslips: input.employees.map(({ employeeId, ...employee }) => ({
      employeeId,
      tax: computePayslipTax({
        ...employee,
        tables: input.tables,
        policy: parameters,
      }).tax,
    })),
  };
}

/**
 * The ref to store in `configSnapshot.pph21Policy` when the run locks: the
 * version in force on the pay date, null when the tenant has none (default
 * policy).
 */
export async function capturePph21PolicyForLock(
  context: ScopedTenantContext,
  payDate: BusinessDate,
): Promise<Pph21PolicyRef | null> {
  const inForce = await resolvePph21PolicyFor(context, payDate);
  return inForce.versionId === null ||
    inForce.version === null ||
    inForce.effectiveFrom === null
    ? null
    : {
        versionId: inForce.versionId,
        version: inForce.version,
        effectiveFrom: inForce.effectiveFrom,
      };
}
