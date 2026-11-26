// Brief 1270 W1: the one way to lock a WFC seat claim for a change. Lock order
// is payment link first, then claim: a settlement holds the link, and the claim
// trigger locks the link NOWAIT, so any other order fails with 55P03.
import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { paymentLinks } from "../db/schema/payment.ts";
import { wfcSeatReservations } from "../db/schema/wfc-seat.ts";
import { HttpError } from "../lib/http-error.ts";
import { notFound, type Tx } from "./facility-shared.ts";

export type WfcClaimRow = typeof wfcSeatReservations.$inferSelect;

export async function lockWfcClaim(
  tx: Tx,
  context: ScopedTenantContext,
  claimId: string,
): Promise<WfcClaimRow> {
  const claimWhere = and(
    eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
    eq(wfcSeatReservations.id, claimId),
  );
  const [found] = await tx
    .select({ paymentLinkId: wfcSeatReservations.paymentLinkId })
    .from(wfcSeatReservations)
    .where(claimWhere)
    .limit(1);
  if (!found) throw notFound("Pesanan kursi");
  if (found.paymentLinkId !== null)
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, found.paymentLinkId),
        ),
      )
      .for("update");
  const [claim] = await tx
    .select()
    .from(wfcSeatReservations)
    .where(claimWhere)
    .for("update");
  if (!claim) throw notFound("Pesanan kursi");
  // A link attached between the two reads was never locked: try again.
  if (claim.paymentLinkId !== found.paymentLinkId)
    throw new HttpError(
      409,
      "WFC_CLAIM_CHANGED",
      "Pesanan kursi baru saja berubah. Coba lagi.",
    );
  return claim;
}
