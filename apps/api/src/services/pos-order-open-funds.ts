// SO-896 (legend-o6q8i): guest money of this bill that is parked and still
// open (`payment_unallocated_funds.resolved_at IS NULL`).
//
// After a manager force release the QR tender is voided and its hold closed,
// so a late verified payment is parked, not applied, and the intent need not be
// `failed`. The bill then looks free, yet the guest has paid once already: a new
// cash or QR tender before the money is refunded or credited is a second
// payment. Every intent that can belong to the bill counts, whatever its
// status: tender intents (voided tenders included), hold intents, intents of
// the tenders' and the order's payment links, and intents of split parts.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { HttpError } from "../lib/http-error.ts";
import type { TenantId } from "@starter/shared/core";
import {
  billSplits,
  paymentIntents,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { posOrderTenders } from "../db/schema/pos-order.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import type { Tx } from "./menu-internals.ts";

/** An open parked fund of any tender, hold, link or split intent of the bill. */
export async function openFundOfPosOrderTx(
  tx: Tx,
  tenantId: TenantId,
  order: { id: string; paymentLinkId: string | null },
): Promise<{ id: string } | null> {
  const tenderLinks = tx
    .select({ id: posOrderTenders.paymentLinkId })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, order.id),
      ),
    );
  const [fund] = await tx
    .select({ id: paymentUnallocatedFunds.id })
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        isNull(paymentUnallocatedFunds.resolvedAt),
        inArray(
          paymentUnallocatedFunds.paymentIntentId,
          tx
            .select({ id: paymentIntents.id })
            .from(paymentIntents)
            .where(
              and(
                eq(paymentIntents.tenantId, tenantId),
                or(
                  inArray(
                    paymentIntents.id,
                    tx
                      .select({ id: posOrderTenders.paymentIntentId })
                      .from(posOrderTenders)
                      .where(
                        and(
                          eq(posOrderTenders.tenantId, tenantId),
                          eq(posOrderTenders.orderId, order.id),
                        ),
                      ),
                  ),
                  inArray(
                    paymentIntents.id,
                    tx
                      .select({ id: posQrisHolds.paymentIntentId })
                      .from(posQrisHolds)
                      .where(
                        and(
                          eq(posQrisHolds.tenantId, tenantId),
                          eq(posQrisHolds.orderId, order.id),
                        ),
                      ),
                  ),
                  inArray(paymentIntents.paymentLinkId, tenderLinks),
                  order.paymentLinkId === null
                    ? undefined
                    : eq(paymentIntents.paymentLinkId, order.paymentLinkId),
                  inArray(
                    paymentIntents.billSplitId,
                    tx
                      .select({ id: billSplits.id })
                      .from(billSplits)
                      .where(
                        and(
                          eq(billSplits.tenantId, tenantId),
                          eq(billSplits.orderId, order.id),
                        ),
                      ),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return fund ?? null;
}

/** 409 `FUNDS_UNRESOLVED` while the bill has open parked guest money. */
export async function assertNoOpenFundsOfPosOrderTx(
  tx: Tx,
  tenantId: TenantId,
  order: { id: string; paymentLinkId: string | null },
): Promise<void> {
  if (await openFundOfPosOrderTx(tx, tenantId, order))
    throw new HttpError(
      409,
      "FUNDS_UNRESOLVED",
      "Uang pelanggan dari pembayaran QRIS sebelumnya masih tersimpan; kembalikan atau selesaikan dulu sebelum menerima pembayaran baru.",
    );
}
