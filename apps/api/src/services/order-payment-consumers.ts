// One entry point for WS-05 payment events that concern an order (bead
// legend-x4qy; PRD v1.7 §3 F10 "Mode Bayar", §4 Alur A; ORD-02). Wired in
// worker-main.ts after the reservation consumer and before the deployment's
// own `deliverEvent`.
//
// Routing is decided from the database, never from the event alone: the
// payment link named by the event (or the intent's link, for expiry and
// failure) is looked up under the worker's tenant context (RLS). A link that
// belongs to a QR order goes to qr-order-consumers.ts inside the consumption
// transaction. Any other `payment.paid` goes to the POS order consumer
// (`handlePosPaymentPaid`, bead legend-kk7), which ignores bills it does not
// own. `payment.expired` / `payment.failed` of a link that belongs to a POS
// tender go to `handlePosPaymentClosed` (bead legend-b0au) inside the
// consumption transaction: the still-authorized tender becomes `failed`.
// A link that belongs to a ticket's breakfast order (channel `facility`, bead
// oa0qk) goes to facility-breakfast-consumers.ts the same way.
// A link that belongs to a dearer-swap difference charge (legend-i83ls) goes to
// order-recovery-charge-payment.ts the same way, after the order check.
// Events of another tenant are refused before any query (TEN-01).

import { and, eq } from "drizzle-orm";
import { uuidSchema, z, type ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  handleBreakfastFundsUnallocated,
  handleBreakfastPaymentClosed,
  handleBreakfastPaymentPaid,
  withBreakfastProviderProof,
  type BreakfastClosedOutcome,
  type BreakfastFundsOutcome,
  type BreakfastPaidOutcome,
} from "./facility-breakfast-consumers.ts";
import type { Tx } from "./menu-internals.ts";
import {
  dispatchIssueChargeClosed,
  dispatchIssueChargePaid,
} from "./order-recovery-charge-payment.ts";
import type {
  IssueChargeClosedOutcome,
  IssueChargePaidOutcome,
} from "./order-recovery-charge.ts";
import {
  handlePosPaymentClosed,
  handlePosPaymentPaid,
} from "./pos-order-payment.ts";
import {
  handleQrOrderFundsUnallocated,
  handleQrOrderPaymentClosed,
  handleQrOrderPaymentPaid,
  type QrFundsOutcome,
  type QrPaymentClosedOutcome,
  type QrPaymentPaidOutcome,
} from "./qr-order-consumers.ts";

export const ORDER_PAYMENT_EVENT_NAMES = [
  "payment.paid",
  "payment.expired",
  "payment.failed",
  // bead 519: a breakfast bill consumes it, and a QR bill for a method-change
  // voided code (legend-hs1rc); every other bill ignores it.
  "payment.funds_unallocated",
] as const;
type OrderPaymentEventName = (typeof ORDER_PAYMENT_EVENT_NAMES)[number];

export function isOrderPaymentEvent(event: EventEnvelope): boolean {
  return (ORDER_PAYMENT_EVENT_NAMES as readonly string[]).includes(event.name);
}

export type OrderPaymentDispatch =
  | { readonly route: "ignored" }
  | {
      readonly route: "qr";
      readonly outcome:
        QrPaymentPaidOutcome | QrPaymentClosedOutcome | QrFundsOutcome;
    }
  | {
      /** legend-i83ls: the link of a dearer-swap difference charge. */
      readonly route: "issue_charge";
      readonly outcome: IssueChargePaidOutcome | IssueChargeClosedOutcome;
    }
  | {
      /** oa0qk: a ticket's breakfast order (channel `facility`). */
      readonly route: "facility";
      readonly outcome:
        BreakfastPaidOutcome | BreakfastClosedOutcome | BreakfastFundsOutcome;
    }
  | { readonly route: "pos" };

const linkPayloadSchema = z.looseObject({ paymentLinkId: uuidSchema });
const intentPayloadSchema = z.looseObject({ intentId: uuidSchema });

/** The payment link the event is about, read under RLS. */
async function linkOf(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
): Promise<string | null> {
  if (event.name === "payment.paid") {
    const parsed = linkPayloadSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.paymentLinkId : null;
  }
  const parsed = intentPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return null;
  const [intent] = await tx
    .select({ paymentLinkId: paymentIntents.paymentLinkId })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, parsed.data.intentId),
      ),
    );
  return intent?.paymentLinkId ?? null;
}

export type DeliverOptions = {
  /** The provider was asked about the breakfast link's other codes (legend-1146). */
  breakfastProviderProven?: boolean;
};

async function dispatchInTx(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now: Date,
  options: DeliverOptions,
): Promise<OrderPaymentDispatch | "pos"> {
  const linkId = await linkOf(tx, context, event);
  if (linkId !== null) {
    const [order] = await tx
      .select({ channel: orders.channel })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.paymentLinkId, linkId),
        ),
      );
    // Parked funds belong to the breakfast consumer and, for money that
    // arrives late on a code the guest voided by changing method (legend-hs1rc),
    // the QR consumer; the charge and POS consumers never saw this event and
    // still do not.
    if (
      event.name === "payment.funds_unallocated" &&
      order?.channel !== "facility" &&
      order?.channel !== "qr"
    )
      return { route: "ignored" };
    if (order?.channel === "qr")
      return {
        route: "qr",
        outcome:
          event.name === "payment.paid"
            ? await handleQrOrderPaymentPaid(context, event, tx, now)
            : event.name === "payment.funds_unallocated"
              ? await handleQrOrderFundsUnallocated(context, event, tx, now)
              : await handleQrOrderPaymentClosed(context, event, tx, now),
      };
    // oa0qk: a facility breakfast order is paid only by its verified event;
    // it never falls through to the POS consumer.
    if (order?.channel === "facility")
      return {
        route: "facility",
        outcome:
          event.name === "payment.paid"
            ? await handleBreakfastPaymentPaid(
                context,
                event,
                tx,
                now,
                options.breakfastProviderProven,
              )
            : event.name === "payment.funds_unallocated"
              ? await handleBreakfastFundsUnallocated(context, event, tx, now)
              : await handleBreakfastPaymentClosed(context, event, tx),
      };
    // legend-i83ls: a swap-difference charge has its own link; anything that
    // is not one falls through to the POS consumer.
    const charge =
      event.name === "payment.paid"
        ? await dispatchIssueChargePaid(context, event, tx, now)
        : await dispatchIssueChargeClosed(context, event, tx, now);
    if (charge !== null) return { route: "issue_charge", outcome: charge };
  }
  if (event.name === "payment.funds_unallocated") return { route: "ignored" };
  if (event.name === "payment.paid") return "pos";
  return (await handlePosPaymentClosed(context, event, tx, now))
    ? { route: "pos" }
    : { route: "ignored" };
}

/**
 * Routes one WS-05 payment event to the order consumer that owns its bill.
 * Idempotent and replay safe (each consumer re-reads its locked rows). With
 * `tx` (the outbox consumption transaction) the QR change commits with the
 * consumed offset; without it the dispatcher opens its own tenant transaction.
 */
export async function deliverOrderPaymentEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx?: Tx,
  now = new Date(),
  options: DeliverOptions = {},
): Promise<OrderPaymentDispatch> {
  if (!isOrderPaymentEvent(event)) return { route: "ignored" };
  if (event.tenantId !== context.tenant.tenantId) return { route: "ignored" };
  // With `tx` the caller (the outbox consumer) owns the provider proof round
  // trip (`withBreakfastProviderProof`); without it we own it here.
  const routed = tx
    ? await dispatchInTx(context, event, tx, now, options)
    : await withBreakfastProviderProof(
        context,
        (proven) =>
          withTenant(db, context, (own) =>
            dispatchInTx(context, event, own, now, {
              ...options,
              breakfastProviderProven:
                proven || options.breakfastProviderProven,
            }),
          ),
        now,
      );
  if (routed !== "pos") return routed;
  // POS runs its own transaction (legend-kk7 signature); it ignores bills of
  // other modules (reservations, facilities) and is replay safe itself.
  await handlePosPaymentPaid(context, event);
  return { route: "pos" };
}

export type { OrderPaymentEventName };
