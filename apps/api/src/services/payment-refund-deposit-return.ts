// A DP return (Q81, `pos_deposit_refunds`) restores customer_deposit with its
// POS refund journal `aj:order-refund:<pos_refund_id>`. Once finance reverses
// that journal by hand (1218), the DP is gone from the books: a payer refund
// of the same intent requested or approved afterwards would pay it out
// twice. Request and approve lock those journals FOR SHARE after the intent
// lock (the payout consumer's order: intent, then source journal), so a
// concurrent manual reversal (FOR UPDATE on the journal) either waits and then
// sees this refund (and is refused) or commits first and is seen here.

import { sql } from "drizzle-orm";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

export async function assertDepositReturnNotReversed(
  tx: Tx,
  tenantId: string,
  paymentIntentId: string,
): Promise<void> {
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT j.id
      FROM pos_deposit_refunds d
      JOIN journal_entries j
        ON j.tenant_id = d.tenant_id
       AND j.idempotency_key = 'aj:order-refund:' || d.pos_refund_id::text
     WHERE d.tenant_id = ${tenantId}::uuid
       AND d.payment_intent_id = ${paymentIntentId}::uuid
     ORDER BY j.id
       FOR SHARE OF j
  `);
  if (locked.rows.length === 0) return;
  const ids = locked.rows.map((row) => row.id);
  const reversed = await tx.execute(sql`
    SELECT 1 FROM journal_entries
     WHERE tenant_id = ${tenantId}::uuid
       AND reversal_of IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     LIMIT 1
  `);
  if (reversed.rows.length > 0)
    throw new HttpError(
      409,
      "DEPOSIT_RETURN_REVERSED",
      "DP yang dikembalikan lewat retur sudah dibalik di jurnal; refund ke pembayar ditolak. Hubungi tim keuangan untuk rekonsiliasi.",
    );
}
