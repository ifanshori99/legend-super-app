import { sql } from "drizzle-orm";

/**
 * SQL for the batch freeze rule of migration 0660 (`app.payout_batch_frozen`),
 * for readers that run as the app role and cannot call the function: the sweep
 * of GL postings and the finance exception list. One place, so they agree with
 * the database and the batch DTO.
 *
 * A batch is frozen when it has an open dispute (a dispute row without an
 * unfreeze row) or shares a payslip with a batch that has one (a retry batch
 * of the same pay).
 */

/** `d` is a dispute row; true when it is open (no unfreeze row). */
export const disputeIsOpenSql = sql`NOT EXISTS (
  SELECT 1 FROM payroll_payout_batch_unfreezes u
   WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`;

/** `d` is a dispute row; true when it freezes batch `batchId` (itself or a sibling). */
export const disputeFreezesBatchSql = (batchId: ReturnType<typeof sql>) =>
  sql`(d.batch_id = ${batchId}
    OR EXISTS (
      SELECT 1
        FROM payroll_disbursement_items mine
        JOIN payroll_disbursement_items sibling
          ON sibling.tenant_id = mine.tenant_id
         AND sibling.payslip_id = mine.payslip_id
       WHERE mine.tenant_id = d.tenant_id AND mine.batch_id = ${batchId}
         AND sibling.batch_id = d.batch_id))`;

/** True when batch `batchId` of `tenantId` is not frozen. */
export const batchIsNotFrozenSql = (
  tenantId: string,
  batchId: ReturnType<typeof sql>,
) => sql`NOT EXISTS (
  SELECT 1 FROM payroll_payout_batch_disputes d
   WHERE d.tenant_id = ${tenantId}::uuid
     AND ${disputeIsOpenSql}
     AND ${disputeFreezesBatchSql(batchId)})`;
