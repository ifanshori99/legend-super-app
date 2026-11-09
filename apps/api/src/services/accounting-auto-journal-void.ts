// Auto-journal of a completed-sale void (legend-9pz9, Codex 142 finding F2;
// design docs/design/auto-journals.md). A correction void of a completed POS
// sale emits `order.voided` with voidedFinalOrder true: the sale's
// `aj:sale:<orderId>` journal is reversed (never re-derived), so the books
// follow exactly what the sale posted. The void hands back captured cash
// (pos-order-corrections.ts); a gateway tender paid by an intent whose receipt
// posted was booked out of customer_deposit, so reversing the sale credits it
// back there, owed to the guest until the intent's refund pays it out
// (legend-x1i1h, like order.refunded books refundGatewayIdr). A sale with DP,
// EDC, points or gateway money outside customer_deposit (no intent, or a
// receipt that never posted: gateway_clearing) parks for finance. An
// open-order void (voidedFinalOrder false) never had a sale journal: ignored.
// The correction void refuses a total-0 sale (pos-order-corrections.ts) and
// its row needs a pos_orders row, so a total-0 sale (legend-fbms) or a QR
// pay-first sale never reaches here with a real void row: such an event
// parks as invalid on the void row check below.
//
// The sale journal is a fact that may not exist yet (delivery order, receipt
// pending) or never will (never journaled): the void waits retryably in the
// first case and parks for finance in the second.

import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { tenderBucket } from "@starter/shared/pos";
import { orders, posOrderTenders, posOrderVoids } from "../db/schema/index.ts";
import {
  AutoJournalPayloadInvalid,
  orderVoidedStoredSchema,
  type StoredAutoJournalEvent,
} from "./accounting-auto-journal-amounts.ts";
import {
  backingKeyOf,
  backingStateOf,
  backingStatesOf,
  postedEntryIdOf,
} from "./accounting-auto-journal-guards.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

/** The void met its sale before the sale journal posted: parked retryable. */
export class AutoJournalSalePending extends Error {
  readonly code = "AUTO_JOURNAL_SALE_PENDING";
}

/** The sale journal will never post: parked, never retried. */
export class AutoJournalSaleMissing extends Error {
  readonly code = "AUTO_JOURNAL_SALE_MISSING";
}

/**
 * The sale holds money the void neither returns nor puts back in
 * customer_deposit (DP aside: EDC, points, gateway outside customer_deposit):
 * parked, never retried (finance corrects).
 */
export class AutoJournalVoidUnsupported extends Error {
  readonly code = "AUTO_JOURNAL_VOID_UNSUPPORTED";
}

export type AutoJournalVoidFact = {
  /** The sale journal the consumer reverses. */
  readonly saleEntryId: string;
  readonly sourceId: string;
  readonly outletId: string;
  readonly moneyTime: Date;
};

/**
 * Reversal input of one stored `order.voided` event, or null when the void
 * never touched a final sale. Re-reads only rows that are final once the void
 * exists (the void row, the completed order, its captured tenders).
 */
export async function voidFactOf(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<AutoJournalVoidFact | null> {
  const p = orderVoidedStoredSchema.parse(stored.payload);
  if (!p.voidedFinalOrder) return null;
  if (p.voidId === null)
    throw new AutoJournalPayloadInvalid("Void of a final sale has no voidId");
  const [voided] = await tx
    .select({ id: posOrderVoids.id })
    .from(posOrderVoids)
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.id, p.voidId),
        eq(posOrderVoids.orderId, p.orderId),
      ),
    );
  if (!voided)
    throw new AutoJournalPayloadInvalid("Void row of the event not found");
  const [order] = await tx
    .select({
      depositAppliedIdr: orders.depositAppliedIdr,
      totalIdr: orders.totalIdr,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, p.orderId)));
  if (!order)
    throw new AutoJournalPayloadInvalid("Order of the event not found");
  if (Number(order.depositAppliedIdr) !== 0)
    throw new AutoJournalPayloadInvalid(
      "Void of a sale with a reservation DP is not supported",
    );
  if (Number(order.totalIdr) !== p.amountIdr)
    throw new AutoJournalPayloadInvalid(
      "Void amount does not match the order total",
    );
  const tenders = await tx
    .select({
      method: posOrderTenders.method,
      paymentIntentId: posOrderTenders.paymentIntentId,
    })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, p.orderId),
        eq(posOrderTenders.status, "captured"),
      ),
    );
  const intentIds = new Set<string>();
  for (const tender of tenders) {
    let bucket: ReturnType<typeof tenderBucket>;
    try {
      bucket = tenderBucket(tender.method as never);
    } catch {
      throw new AutoJournalPayloadInvalid(
        "Captured tender has an unknown method",
      );
    }
    if (bucket === "cash") continue;
    // legend-x1i1h: a gateway tender of an intent; whether the sale booked it
    // out of customer_deposit is checked once the sale is known posted.
    if (bucket === "gateway" && tender.paymentIntentId !== null) {
      intentIds.add(tender.paymentIntentId);
      continue;
    }
    // EDC, points and gateway money without an intent would stay booked on
    // the reversed sale.
    throw new AutoJournalVoidUnsupported(
      "Sale holds tenders that the void neither returns nor keeps in customer_deposit",
    );
  }
  const state = await backingStateOf(tx, tenantId, {
    kind: "sale",
    orderId: p.orderId,
  });
  if (state === "pending")
    throw new AutoJournalSalePending("Sale journal is not posted yet");
  const saleEntryId = await postedEntryIdOf(
    tx,
    tenantId,
    `aj:sale:${p.orderId}`,
  );
  if (saleEntryId === null) {
    // Posted per the state, yet not readable by key: the sweep re-reads it.
    if (state === "posted")
      throw new AutoJournalSalePending("Sale journal entry not found");
    throw new AutoJournalSaleMissing("Sale journal will never post");
  }
  // legend-j0ag5: a sale journal finance reversed reads "none" yet exists; the
  // reversal below refuses it (JOURNAL_ALREADY_REVERSED), never a second one.
  // legend-x1i1h: the sale debited customer_deposit for a gateway tender only
  // when its intent receipt was posted (order.paid cutover guard, else
  // gateway_clearing); a receipt not posted now fails closed for finance.
  if (intentIds.size > 0) {
    const receipts = await backingStatesOf(
      tx,
      tenantId,
      [...intentIds].map((intentId) => ({ kind: "intent", intentId })),
    );
    for (const intentId of intentIds)
      if (receipts.get(backingKeyOf({ kind: "intent", intentId })) !== "posted")
        throw new AutoJournalVoidUnsupported(
          "Gateway tender of the sale was not booked out of customer_deposit",
        );
  }
  return {
    saleEntryId,
    sourceId: p.voidId,
    outletId: stored.outletId,
    moneyTime: new Date(p.voidedAt),
  };
}
