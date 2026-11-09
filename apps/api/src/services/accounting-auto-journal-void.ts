// Auto-journal of a completed-sale void (legend-9pz9, Codex 142 finding F2;
// design docs/design/auto-journals.md). A correction void of a completed POS
// sale emits `order.voided` with voidedFinalOrder true: the sale's
// `aj:sale:<orderId>` journal is reversed (never re-derived), so the books
// follow exactly what the sale posted. The void returns captured cash only
// (pos-order-corrections.ts), so only an all-cash sale without DP is
// reversible here; any other sale parks for finance. An open-order void
// (voidedFinalOrder false) never had a sale journal: ignored.
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
  backingStateOf,
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
 * The sale holds non-cash money, but the void returns only cash: parked,
 * never retried (finance corrects).
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
    .select({ method: posOrderTenders.method })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.orderId, p.orderId),
        eq(posOrderTenders.status, "captured"),
      ),
    );
  for (const tender of tenders) {
    let bucket: ReturnType<typeof tenderBucket>;
    try {
      bucket = tenderBucket(tender.method as never);
    } catch {
      throw new AutoJournalPayloadInvalid(
        "Captured tender has an unknown method",
      );
    }
    // The void returns only cash: gateway, EDC and points money would stay
    // booked on the reversed sale.
    if (bucket !== "cash")
      throw new AutoJournalVoidUnsupported(
        "Sale holds non-cash tenders that the void does not return",
      );
  }
  const state = await backingStateOf(tx, tenantId, {
    kind: "sale",
    orderId: p.orderId,
  });
  if (state === "pending")
    throw new AutoJournalSalePending("Sale journal is not posted yet");
  if (state === "none")
    throw new AutoJournalSaleMissing("Sale journal will never post");
  const saleEntryId = await postedEntryIdOf(
    tx,
    tenantId,
    `aj:sale:${p.orderId}`,
  );
  // Posted per the state, yet not readable by key: the sweep re-reads it.
  if (saleEntryId === null)
    throw new AutoJournalSalePending("Sale journal entry not found");
  return {
    saleEntryId,
    sourceId: p.voidId,
    outletId: stored.outletId,
    moneyTime: new Date(p.voidedAt),
  };
}
