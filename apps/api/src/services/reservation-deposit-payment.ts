// WS-05 adapter of the reservation deposit port (PRD v1.7 §3.22 "DP &
// Kebijakan", §3.13 payment links; RSV-02; bead legend-t8bz).
//
// WS-05 as built is bill based: a server service opens a payment link for a
// priced bill (`createPaymentLink`) and hands the guest its token once; the
// guest opens the hosted page (`/bayar/<token>`, apps/web route
// `_customer/bayar.$token.tsx`) and picks a method, which creates the payment
// intent (`createIntent`). So at booking time there is a link, not an intent.
// The DP bill is the DP amount alone: no table label, no tax or service charge
// (a DP is a deposit credited to the later bill, not a sale).
import {
  idr,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  gatewayListsMethod,
  selectGatewayForNewIntent,
} from "./payment-gateway-select.ts";
import { resolveRoutingRule } from "./payment-routing.service.ts";
import { createPaymentLink } from "./payment.service.ts";
import {
  depositUnavailable,
  type ReservationDepositPort,
} from "./reservation-ports.ts";

/** Actor recorded on WS-05 rows the reservation module creates by itself. */
export const RESERVATION_SYSTEM_ACTOR: SystemRefundActor = "system:reservation";

/** Where the payment page sends the guest back (app-local, public booking). */
const DEPOSIT_RETURN_PATH = "/reservation";

/** Bill reference shown on the payment page and in WS-05 admin lists. */
export function depositReference(reservationId: string): string {
  return `RSV-${reservationId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

/**
 * Fail closed unless a gateway is usable for the deposit and not reported
 * down: a DP booking must never hold a table it cannot collect the DP for. The
 * gateway is the one the outlet's QRIS rule selects (primary, or its fallback
 * when the primary is down), and it must list QRIS as enabled (1269 C0 locks
 * methods; at the DP amount once it is known). A lookup that throws counts as
 * down.
 */
async function assertGatewayReady(
  context: ScopedTenantContext,
  outletId?: string,
  amountIdr?: number,
): Promise<void> {
  if (!outletId) throw depositUnavailable();
  try {
    const routing = await withTenant(db, context, (tx) =>
      resolveRoutingRule(tx, context, outletId, "qris"),
    );
    const selected = await selectGatewayForNewIntent(
      context,
      outletId,
      routing,
    );
    if (
      !routing.enabled ||
      selected.provider === null ||
      !(await gatewayListsMethod(
        context,
        selected.port,
        "qris",
        outletId,
        amountIdr,
      ))
    )
      throw depositUnavailable();
  } catch {
    throw depositUnavailable();
  }
}

export function createPaymentReservationDepositPort(): ReservationDepositPort {
  return {
    assertReady: (context, outletId) => assertGatewayReady(context, outletId),
    async openDeposit(input) {
      await assertGatewayReady(input.context, input.outletId, input.amountIdr);
      const amount = idr(input.amountIdr);
      const opened = await createPaymentLink(
        input.context,
        {
          outletId: outletIdSchema.parse(input.outletId),
          reference: depositReference(input.reservationId),
          tableLabel: null,
          pax: null,
          subtotalIdr: amount,
          discountIdr: idr(0),
          serviceChargeIdr: idr(0),
          taxIdr: idr(0),
          roundingIdr: idr(0),
          totalIdr: amount,
          returnPath: DEPOSIT_RETURN_PATH,
          expiresInMinutes: input.expiresInMinutes,
        },
        RESERVATION_SYSTEM_ACTOR,
        input.now,
      );
      return {
        paymentLinkId: opened.linkId,
        paymentPath: `/bayar/${opened.token}`,
        expiresAt: opened.expiresAt,
      };
    },
  };
}
