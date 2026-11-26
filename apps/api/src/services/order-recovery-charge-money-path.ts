// legend-f1mmf: one money path at a time for a dearer-swap charge. Every path
// that may take the charge's money (guest QRIS / VA, cashier QRIS, cash, the
// card sale) asks these guards inside its own transaction, after the charge
// chain is locked (`lockChargeChain`).

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { OutletId, TenantId } from "@starter/shared/core";
import { edcTransactions } from "../db/schema/edc.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./menu-internals.ts";
import { liveCodeWhere } from "./payment-live-code.ts";

/**
 * legend-f1mmf: one money path at a time. An EDC sale of the charge (its
 * reference is the charge id) that is unresolved (`pending`, `unknown`),
 * approved but not recorded yet, or waiting for reconciliation refuses a QRIS
 * code, cash and another sale: the bank may hold the money already.
 */
export async function assertNoEdcSaleOutstanding(
  tx: Tx,
  tenantId: TenantId,
  charge: { id: string; outletId: OutletId },
): Promise<void> {
  // The EDC agent's write-ahead lock for this reference (edge/edc/agent.ts):
  // a sale starting now waits for this transaction, and this one sees a sale
  // already written. Taken after the charge chain; the agent locks no charge.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${charge.outletId}:${charge.id}`}))`,
  );
  const [sale] = await tx
    .select({ id: edcTransactions.id })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.outletId, charge.outletId),
        eq(edcTransactions.type, "sale"),
        eq(edcTransactions.reference, charge.id),
        or(
          inArray(edcTransactions.status, ["pending", "unknown", "approved"]),
          eq(edcTransactions.needsReconciliation, true),
        ),
      ),
    )
    .limit(1);
  if (sale)
    throw new HttpError(
      409,
      "CONFLICT",
      "Transaksi EDC untuk tagihan ini belum selesai atau sudah disetujui; cek status EDC dulu.",
    );
}

/**
 * A code of the charge's link that may still take money (`liveCodeWhere`, the
 * rule `createIntent` refuses on and the cashier's screen locks on) refuses
 * cash and a card sale: the guest may still pay it. The caller locked the
 * link (cash) or holds the charge chain and the agent lock (card sale).
 */
export async function assertNoLiveChargeCode(
  tx: Tx,
  tenantId: TenantId,
  paymentLinkId: string | null,
): Promise<void> {
  if (paymentLinkId === null) return;
  const [live] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        liveCodeWhere(),
      ),
    )
    .limit(1);
  if (live)
    throw new HttpError(
      409,
      "CONFLICT",
      "Kode QRIS tagihan ini masih bisa dibayar; tunggu sampai berakhir.",
    );
}
