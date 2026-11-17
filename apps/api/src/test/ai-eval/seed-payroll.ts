import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type PayrollEvalOptions = {
  tenantId: string;
  legalEntityId: string;
};

/** Plain run totals, in the shape `payroll_runs.totals` holds. */
const runTotals = (grossIdr: number, bpjsCompanyIdr: number) => ({
  employeeCount: 0,
  grossIdr,
  deductionsIdr: 0,
  netIdr: grossIdr,
  bpjsEmployeeIdr: 0,
  bpjsCompanyIdr,
  pph21Idr: 0,
  pph21WithheldIdr: 0,
  pph21EmployerBorneIdr: 0,
  pph21RefundIdr: 0,
  pph21EmployerRefundIdr: 0,
  pph21EmployerAllowanceRefundIdr: 0,
  loanRepaymentIdr: 0,
  pph21ReceivableIdr: 0,
  pph21ReceivableCollectedIdr: 0,
  otherDeductionsIdr: 0,
  customDeductionsIdr: 0,
  serviceChargeIdr: 0,
  reimbursementIdr: 0,
  bankTransferIdr: grossIdr,
  cashIdr: 0,
});

/** One LOCKED payroll run that covers all of March 2031, so TL-05 labor cost
 * (owner, `payroll.view`) is numeric: 31_000_000 gross + 3_100_000 BPJS.
 * The caller owns the tenant-scoped transaction.
 */
export async function seedPayrollEval(
  client: PoolClient,
  { tenantId, legalEntityId }: PayrollEvalOptions,
): Promise<void> {
  const policyId = randomUUID();
  const code = `EV${policyId.slice(0, 8)}`;
  await client.query(
    `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                   employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
     VALUES ($1, $2, $3, 'Kebijakan evaluasi', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
    [policyId, tenantId, legalEntityId, code, JSON.stringify({ code })],
  );
  const runId = randomUUID();
  await client.query(
    `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                               period_start, period_end, pay_date, created_by)
     VALUES ($1, $2, $3, $4, 'regular', '2031-03-01', '2031-03-31', '2031-03-31', 'ai-eval')`,
    [runId, tenantId, legalEntityId, policyId],
  );
  // The status machine only moves one step at a time.
  await client.query(
    `UPDATE payroll_runs SET status = 'simulated' WHERE id = $1`,
    [runId],
  );
  await client.query(
    `UPDATE payroll_runs SET status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now() WHERE id = $1`,
    [runId],
  );
  await client.query(
    `UPDATE payroll_runs SET status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now() WHERE id = $1`,
    [runId],
  );
  await client.query(
    `UPDATE payroll_runs SET status = 'locked', config_snapshot = '{"v":1}', totals = $2::jsonb,
            locked_by = 'lock-user', locked_at = now() WHERE id = $1`,
    [runId, JSON.stringify(runTotals(31_000_000, 3_100_000))],
  );
}
