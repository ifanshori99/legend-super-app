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
// An employee's year-to-date history is passed as the earlier payslips
// (`priorPeriods`), never as raw sums: `buildPph21Prior` fills every field the
// last period needs from the stored taxes, the gross-up tax allowance and the
// scheme mix included (bead legend-s5c1). Pass only the payslips of the
// current period of service: after the latest annual recalculation of the
// year (a rehire in the same year starts a new one), with `monthsWorked` of
// that period. The run service locks through `lockPayrollRunTax` inside its
// lock transaction, which pins the policy ref from the same computation.

import type { BusinessDate, ScopedTenantContext } from "@starter/shared/core";
import {
  PayrollError,
  buildPph21Prior,
  computePayslipTax,
  isSamePph21PolicyRef,
  pph21PolicyForRun,
  type PayrollConfigSnapshot,
  type PayrollRunStatus,
  type PayslipTax,
  type PayslipTaxInput,
  type Pph21PolicyParameters,
  type Pph21PolicyRef,
  type Pph21PriorPeriod,
  type Pph21Tables,
} from "@starter/shared/hris/payroll";
import { loadPph21PolicyVersionsForRun } from "./payroll-pph21-policy.service.ts";
import type { Tx } from "./permission-resolver.ts";

export type PayrollRunTaxRun = {
  status: PayrollRunStatus;
  payDate: BusinessDate;
  configSnapshot: Pick<PayrollConfigSnapshot, "pph21Policy"> | null;
};

export type PayrollRunTaxEmployee = Omit<
  PayslipTaxInput,
  "tables" | "policy" | "prior"
> & {
  employeeId: string;
  /**
   * Earlier payslips of the current period of service in this tax year
   * (after the latest annual recalculation; none: []).
   */
  priorPeriods: readonly Pph21PriorPeriod[];
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

function taxOfPayslips(
  input: PayrollRunTaxInput,
  parameters: Pph21PolicyParameters,
  ref: Pph21PolicyRef | null,
): PayrollRunTax {
  return {
    pph21Policy: ref,
    parameters,
    payslips: input.employees.map(
      ({ employeeId, priorPeriods, ...employee }) => ({
        employeeId,
        tax: computePayslipTax({
          ...employee,
          prior: buildPph21Prior(priorPeriods),
          tables: input.tables,
          policy: parameters,
        }).tax,
      }),
    ),
  };
}

/**
 * PPh 21 of every payslip of a run. A locked (or later) run is computed with
 * the policy version its snapshot pinned, however many versions were
 * published since; a changed or missing pinned version is
 * PAYROLL_SNAPSHOT_MISMATCH. Pass `tx` to read inside the caller's
 * transaction.
 */
export async function calculatePayrollRunTax(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  tx?: Tx,
): Promise<PayrollRunTax> {
  const versions = await loadPph21PolicyVersionsForRun(context, tx);
  const { parameters, ref } = pph21PolicyForRun(input.run, versions);
  return taxOfPayslips(input, parameters, ref);
}

/**
 * The lock step: PPh 21 of every payslip AND the ref to store in
 * `configSnapshot.pph21Policy`, from ONE read of the policy versions inside
 * the lock transaction `tx`. `approved` is the ref the run showed when it was
 * approved (null = default policy); when the version in force now differs in
 * id, number, effective date or parameters (a newer version was published
 * between approval and lock) the lock is refused with
 * PAYROLL_SNAPSHOT_MISMATCH, so the pinned policy always is the one the
 * stored payslips were computed with.
 */
export async function lockPayrollRunTax(
  context: ScopedTenantContext,
  input: PayrollRunTaxInput,
  approved: Pph21PolicyRef | null,
  tx: Tx,
): Promise<PayrollRunTax> {
  const versions = await loadPph21PolicyVersionsForRun(context, tx);
  const { parameters, ref } = pph21PolicyForRun(input.run, versions);
  if (!isSamePph21PolicyRef(ref, approved))
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return taxOfPayslips(input, parameters, ref);
}

/**
 * The ref to store in `configSnapshot.pph21Policy` when the run locks: the
 * version in force on the pay date, null when the tenant has none (default
 * policy). Prefer `lockPayrollRunTax`, which pins from the same computation
 * as the payslips. With `options.tx` the read joins the lock transaction;
 * with `options.approved` (the ref the run was approved with, null = default)
 * a different version in force is PAYROLL_SNAPSHOT_MISMATCH.
 */
export async function capturePph21PolicyForLock(
  context: ScopedTenantContext,
  payDate: BusinessDate,
  options: { tx?: Tx; approved?: Pph21PolicyRef | null } = {},
): Promise<Pph21PolicyRef | null> {
  const versions = await loadPph21PolicyVersionsForRun(context, options.tx);
  const { ref } = pph21PolicyForRun(
    { status: "approved", payDate, configSnapshot: null },
    versions,
  );
  if (
    options.approved !== undefined &&
    !isSamePph21PolicyRef(ref, options.approved)
  )
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return ref;
}
