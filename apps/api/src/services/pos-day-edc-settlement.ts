// X2 (legend-wasr7.11): EDC per terminal on the Tutup Hari recap. The day's
// captured EDC tenders (completed, non-training sales of the business date)
// against the bank settlement CSV lines matched to them. Read-only, live on
// every read: the bank file comes H+1, after the day was frozen.
import { sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import {
  endOfDayEdcTerminalRowSchema,
  type EndOfDayEdcTerminalRow,
} from "@starter/shared/pos";
import type { Tx } from "./permission-resolver.ts";

type Row = {
  terminal_id: string;
  terminal_code: string | null;
  bank: string;
  receipt_idr: string;
  receipt_count: number;
  settled_idr: string;
  settled_count: number;
  flagged_count: number;
  mismatch_count: number;
  difference_idr: string;
  file_seen: boolean;
};

export async function edcSettlementByTerminal(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  businessDate: string,
): Promise<EndOfDayEdcTerminalRow[]> {
  const tenantId = context.tenant.tenantId;
  const result = await tx.execute<Row>(sql`
    SELECT e.terminal_id::text AS terminal_id,
           min(t.terminal_id) AS terminal_code,
           e.bank,
           sum(pt.amount_idr)::text AS receipt_idr,
           count(*)::int AS receipt_count,
           coalesce(sum(pt.amount_idr) FILTER (WHERE m.matched), 0)::text AS settled_idr,
           count(*) FILTER (WHERE m.matched)::int AS settled_count,
           count(*) FILTER (WHERE e.needs_reconciliation)::int AS flagged_count,
           count(*) FILTER (WHERE m.mismatched)::int AS mismatch_count,
           (sum(pt.amount_idr)
             - coalesce(sum(pt.amount_idr) FILTER (WHERE m.matched), 0))::text AS difference_idr,
           -- A bank file naming this terminal was uploaded after every one of
           -- its sales of the day (a file cannot report a sale not yet made).
           bool_and(f.seen) AS file_seen
    FROM pos_order_tenders pt
    JOIN orders o
      ON o.tenant_id = pt.tenant_id AND o.id = pt.order_id
    JOIN pos_orders po
      ON po.tenant_id = o.tenant_id AND po.order_id = o.id
     AND po.outlet_id = o.outlet_id
    JOIN edc_transactions e
      ON e.tenant_id = pt.tenant_id AND e.id = pt.edc_transaction_id
    LEFT JOIN payment_edc_terminals t
      ON t.tenant_id = e.tenant_id AND t.id = e.terminal_id
    LEFT JOIN LATERAL (
      SELECT bool_or(r.match_status = 'matched') AS matched,
             bool_or(r.match_status = 'mismatch') AS mismatched
      FROM edc_settlement_rows r
      WHERE r.tenant_id = e.tenant_id AND r.matched_edc_transaction_id = e.id
    ) m ON TRUE
    LEFT JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM edc_settlement_files sf
        JOIN edc_settlement_rows sr
          ON sr.tenant_id = sf.tenant_id AND sr.file_id = sf.id
         AND sr.outlet_id = sf.outlet_id
        WHERE sf.tenant_id = e.tenant_id
          AND sf.outlet_id = ${outletId}::uuid
          AND sf.bank = e.bank
          AND sf.created_at > e.created_at
          AND (sr.terminal_id = e.terminal_id OR sr.terminal_code = t.terminal_id)
      ) AS seen
    ) f ON TRUE
    WHERE pt.tenant_id = ${tenantId}::uuid
      AND pt.outlet_id = ${outletId}::uuid
      AND pt.status = 'captured'
      AND o.outlet_id = ${outletId}::uuid
      AND o.business_date = ${businessDate}::date
      AND o.status = 'completed'
      AND NOT po.is_training
    GROUP BY e.terminal_id, e.bank
    ORDER BY min(t.terminal_id) NULLS LAST, e.terminal_id
  `);
  return result.rows.map((row) => {
    // mismatch wins; then a confirmed sale; otherwise the bank file decides
    // between "not here yet" and "here, but it did not hit this terminal".
    const bankStatus =
      row.mismatch_count > 0
        ? "mismatch"
        : row.settled_count > 0
          ? "matched"
          : row.file_seen
            ? "no_match"
            : "awaiting";
    return endOfDayEdcTerminalRowSchema.parse({
      terminalId: row.terminal_id,
      terminalCode: row.terminal_code ?? row.terminal_id.slice(0, 8),
      bank: row.bank,
      receiptIdr: Number(row.receipt_idr),
      receiptCount: row.receipt_count,
      settledIdr: Number(row.settled_idr),
      settledCount: row.settled_count,
      flaggedCount: row.flagged_count,
      mismatchCount: row.mismatch_count,
      differenceIdr: Number(row.difference_idr),
      bankStatus,
    });
  });
}
