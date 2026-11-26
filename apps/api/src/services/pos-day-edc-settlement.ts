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
           count(*) FILTER (WHERE m.mismatched)::int AS mismatch_count
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
  return result.rows.map((row) =>
    endOfDayEdcTerminalRowSchema.parse({
      terminalId: row.terminal_id,
      terminalCode: row.terminal_code ?? row.terminal_id.slice(0, 8),
      bank: row.bank,
      receiptIdr: Number(row.receipt_idr),
      receiptCount: row.receipt_count,
      settledIdr: Number(row.settled_idr),
      settledCount: row.settled_count,
      flaggedCount: row.flagged_count,
      mismatchCount: row.mismatch_count,
    }),
  );
}
