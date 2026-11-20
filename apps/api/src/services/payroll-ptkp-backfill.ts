// One-shot PTKP history backfill (bead 1223 r2, architect review of
// 75febb246). Migration 0519 recorded today's status from the join date, so an
// employee whose status changed earlier this year (TK/0 in January, K/0 since
// July) would have the new status for the whole running tax year. For every
// employee with a locked (or paid) payslip in the tax year this writes:
// - the status of his first payslip of that year on the anchor date (1 January,
//   or the join date when he joined that year), the status the year started
//   with;
// - when today's status differs, today's status on the deploy date (Jakarta),
//   in force from the next tax year.
// Idempotent (upsert on employee + day). Refused once HR has corrected a
// PTKP in the tenant unless forced. Runs as the migration owner (the app
// role cannot write the history) inside the tenant's context; see
// src/db/backfill-ptkp-history.ts and docs/deployment.md.
import type { PoolClient } from "pg";
import {
  payslipCalculationSchema,
  type PayslipCalculation,
} from "@starter/shared/hris/payroll";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { ptkpAnchorDate } from "./payroll-ptkp-tax-year.ts";

type SlipRow = {
  id: string;
  employee_id: string;
  join_date: string;
  ptkp_status: string | null;
  calculation_encrypted: Buffer;
  pii_key_version: number;
};

const UPSERT = `INSERT INTO employee_ptkp_history (tenant_id, employee_id, effective_from, ptkp_status)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id, employee_id, effective_from)
  DO UPDATE SET ptkp_status = EXCLUDED.ptkp_status`;

/** The caller holds a transaction with app.tenant_id set to `tenantId`. */
export async function backfillPtkpHistoryForTenant(
  client: PoolClient,
  tenantId: string,
  taxYear: number,
  deployDate: string,
  force = false,
): Promise<{ employees: number; changed: number }> {
  // Run once, before any HR correction (PUT /api/hris/employees/:id/ptkp): a
  // correction made since then would be overwritten by the first slip's status.
  const corrections = await client.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'hris.employee_ptkp.corrected'
      LIMIT 1`,
    [tenantId],
  );
  if (corrections.rows.length > 0 && !force)
    throw new Error(
      "Sudah ada koreksi PTKP oleh HR di tenant ini; backfill PTKP ditolak (pakai --force hanya bila yakin koreksi itu boleh ditimpa).",
    );
  const slips = await client.query<SlipRow>(
    `SELECT DISTINCT ON (ps.employee_id)
            ps.id, ps.employee_id, to_char(e.join_date, 'YYYY-MM-DD') AS join_date,
            e.ptkp_status, ps.calculation_encrypted, ps.pii_key_version
       FROM payslips ps
       JOIN payroll_runs pr ON pr.tenant_id = ps.tenant_id AND pr.id = ps.payroll_run_id
       JOIN employees e ON e.tenant_id = ps.tenant_id AND e.id = ps.employee_id
      WHERE ps.tenant_id = $1
        AND pr.status IN ('locked', 'paid')
        AND pr.pay_date >= $2::date AND pr.pay_date < $3::date
      ORDER BY ps.employee_id, pr.pay_date, pr.period_start, ps.id`,
    [tenantId, `${taxYear}-01-01`, `${taxYear + 1}-01-01`],
  );
  let changed = 0;
  for (const slip of slips.rows) {
    let calc: PayslipCalculation;
    try {
      calc = payslipCalculationSchema.parse(
        JSON.parse(
          openPayrollValue(
            slip.calculation_encrypted,
            {
              tenantId,
              table: "payslips",
              rowId: slip.id,
              field: "calculation",
            },
            slip.pii_key_version,
          ),
        ),
      );
    } catch {
      // Never echo the decrypt error: it may carry payroll values.
      throw new Error(
        `Slip ${slip.id} tidak bisa dibaca; backfill PTKP berhenti.`,
      );
    }
    const yearStatus = calc.tax.ptkpStatus;
    await client.query(UPSERT, [
      tenantId,
      slip.employee_id,
      ptkpAnchorDate(taxYear, slip.join_date),
      yearStatus,
    ]);
    if (slip.ptkp_status !== null && slip.ptkp_status !== yearStatus) {
      const from = deployDate > slip.join_date ? deployDate : slip.join_date;
      await client.query(UPSERT, [
        tenantId,
        slip.employee_id,
        from,
        slip.ptkp_status,
      ]);
      changed += 1;
    }
  }
  return { employees: slips.rows.length, changed };
}
