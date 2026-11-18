// Gives member points back when a bill is voided before it was paid in
// money (936, legend-hpgyw second-opinion finding 2; brief 1048 decision 2).
//
// A points tender debits the member the moment it is redeemed, so a void of an
// unpaid bill must return those points or the member loses them for nothing.
// Called from the void transaction with the order row already locked; the
// profile lock is taken here (order lock first, then profile lock: the same
// order as the redeem path, so the two never deadlock).
//
// Idempotent twice over: a void is refused once the order is final, and the
// restore row's dedupe key `(tenant, adjust, adjustment, tender id)` makes a
// second post return the first row. The restore is an `adjust` row that points
// at the redeem row (`reverses_entry_id`), like a cancelled reward redemption;
// no journal is booked (the redeem booked none, order.paid never ran).

import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { withProfileLock } from "../db/member-scope.ts";
import { pointLedger } from "../db/schema/crm-ledger.ts";
import { posOrderTenders } from "../db/schema/pos-order.ts";
import type { Tx } from "./menu-internals.ts";
import { postLedgerEntry } from "./point-ledger.service.ts";
import type { TenderRow } from "./pos-order-support.ts";

/** True when the bill took in captured tenders and every one of them is points. */
export function isPointsOnlyCaptured(tenders: readonly TenderRow[]): boolean {
  const captured = tenders.filter((tender) => tender.status === "captured");
  return (
    captured.length > 0 &&
    captured.every((tender) => tender.method === "points")
  );
}

/**
 * Voids every captured points tender of the order and posts one restore ledger
 * row per tender (the exact points that tender debited). A tender with no
 * redeem row (a training order is never debited) is voided with nothing to
 * give back. Run before the order itself turns final: the tender rows are
 * frozen after that.
 */
export async function restorePointsTenders(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    outletId: string;
    tenders: readonly TenderRow[];
    actorUserId: string;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const points = input.tenders.filter(
    (tender) => tender.status === "captured" && tender.method === "points",
  );
  for (const tender of points) {
    const [redeem] = await tx
      .select()
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenantId),
          eq(pointLedger.type, "redeem"),
          eq(pointLedger.sourceType, "pos_tender"),
          eq(pointLedger.sourceId, tender.id),
        ),
      );
    if (redeem) {
      await withProfileLock(tx, tenantId, redeem.customerProfileId);
      await postLedgerEntry(
        tx,
        context,
        {
          tenantId,
          customerProfileId: redeem.customerProfileId,
          outletId: input.outletId,
          type: "adjust",
          points: -Number(redeem.points),
          sourceType: "adjustment",
          sourceId: tender.id,
          reversesEntryId: redeem.id,
          expiresAt: null,
          businessDate: redeem.businessDate,
          reason: "pos_void_points_restored",
          createdBy: input.actorUserId,
          // The redeem booked no journal and emitted no event; neither may
          // its give-back (points.adjusted would credit loyalty liability).
          skipEvent: true,
        },
        input.now,
      );
    }
    await tx
      .update(posOrderTenders)
      .set({ status: "voided", resolvedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.orderId, input.orderId),
          eq(posOrderTenders.id, tender.id),
          eq(posOrderTenders.status, "captured"),
        ),
      );
  }
}
