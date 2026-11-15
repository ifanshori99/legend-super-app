import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type FinancialEvalOptions = {
  tenantId: string;
  legalEntityId: string;
  outletId: string;
  creatorId: string;
};

/** Actual source rows for financial statement questions.
 * Call in the tenant-scoped fixture transaction before closing other periods.
 */
export async function seedFinancialEval(
  client: PoolClient,
  { tenantId, legalEntityId, outletId, creatorId }: FinancialEvalOptions,
): Promise<void> {
  const cashId = randomUUID();
  const revenueId = randomUUID();
  for (const [id, code, name, type, reportGroup] of [
    [cashId, "1100", "Kas evaluasi", "asset", "cash_and_equivalents"],
    [revenueId, "4100", "Pendapatan evaluasi", "revenue", "revenue"],
  ]) {
    await client.query(
      `INSERT INTO chart_of_accounts
         (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenantId, legalEntityId, code, name, type, reportGroup],
    );
  }

  // Each queried month has a balanced posted sale; shareholder reports only
  // expose closed periods, so close after posting both journal lines.
  for (const period of [
    "2030-10",
    "2030-11",
    "2030-12",
    "2031-01",
    "2031-02",
    "2031-03",
  ]) {
    const periodId = randomUUID();
    const entryId = randomUUID();
    await client.query(
      `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3, $4)`,
      [periodId, tenantId, legalEntityId, period],
    );
    await client.query(
      `INSERT INTO journal_entries
         (id, tenant_id, legal_entity_id, outlet_id, entry_date,
          fiscal_period_id, source_type, description, idempotency_key,
          request_fingerprint, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', 'Eval posted sale', $7, $8, $9)`,
      [
        entryId,
        tenantId,
        legalEntityId,
        outletId,
        `${period}-15`,
        periodId,
        randomUUID(),
        "f".repeat(64),
        creatorId,
      ],
    );
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, 10001, 0), ($1, $2, $4, 2, 0, 10001)`,
      [tenantId, entryId, cashId, revenueId],
    );
    await client.query(
      `UPDATE fiscal_periods
       SET status = 'closed', closed_by = $2, closed_at = now(), version = version + 1
       WHERE id = $1`,
      [periodId, creatorId],
    );
  }
}
