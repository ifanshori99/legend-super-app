// Fixture for the EDC agent tests (legend-xcbs7): `writeAhead` only records a
// sale for a real bill that is still payable, for exactly what it still owes.
// `ensureBill` creates (or realigns) that bill (orders + pos_orders rows) for a payment request, so a
// test starts a sale for "the bill of this reference" the way the POS does.
import type { Pool } from "pg";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import type { EdcPaymentRequest } from "@starter/shared/edc";

export async function ensureBill(
  pool: Pool,
  // Plain values: callers pass branded request fields or raw fixture ids.
  request: {
    readonly tenantId: EdcPaymentRequest["tenantId"] | string;
    readonly outletId: EdcPaymentRequest["outletId"] | string;
    readonly reference: string;
    readonly amountIdr: EdcPaymentRequest["amountIdr"] | number;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [request.tenantId],
    );
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'sent', current_date, now())
       ON CONFLICT (tenant_id, outlet_id, number)
       DO UPDATE SET subtotal_idr = $5, total_idr = $5`,
      [
        ulidToUuid(createUlid()),
        request.tenantId,
        request.outletId,
        request.reference,
        request.amountIdr,
      ],
    );
    const [row] = (
      await client.query<{ id: string }>(
        "SELECT id FROM orders WHERE tenant_id = $1 AND outlet_id = $2 AND number = $3",
        [request.tenantId, request.outletId, request.reference],
      )
    ).rows;
    // The card tender path needs the POS side of the bill too (lockPosOrder).
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())
       ON CONFLICT (tenant_id, order_id) DO NOTHING`,
      [row?.id, request.tenantId, request.outletId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
