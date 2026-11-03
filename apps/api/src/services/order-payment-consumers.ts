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
// own; expiry/failure of POS bills is not routed yet (WS-04 owns that rule).
// Events of another tenant are refused before any query (TEN-01).

import { and, eq } from "drizzle-orm";
import { uuidSchema, z, type ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "./menu-internals.ts";
import { handlePosPaymentPaid } from "./pos-order-payment.ts";
import {
  handleQrOrderPaymentClosed,
  handleQrOrderPaymentPaid,
  type QrPaymentClosedOutcome,
  type QrPaymentPaidOutcome,
} from "./qr-order-consumers.ts";

export const ORDER_PAYMENT_EVENT_NAMES = [
  "payment.paid",
  "payment.expired",
  "payment.failed",
] as const;
type OrderPaymentEventName = (typeof ORDER_PAYMENT_EVENT_NAMES)[number];

export function isOrderPaymentEvent(event: EventEnvelope): boolean {
  return (ORDER_PAYMENT_EVENT_NAMES as readonly string[]).includes(event.name);
}

export type OrderPaymentDispatch =
  | { readonly route: "ignored" }
  | {
      readonly route: "qr";
      readonly outcome: QrPaymentPaidOutcome | QrPaymentClosedOutcome;
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

async function dispatchInTx(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now: Date,
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
    if (order?.channel === "qr")
      return {
        route: "qr",
        outcome:
          event.name === "payment.paid"
            ? await handleQrOrderPaymentPaid(context, event, tx, now)
            : await handleQrOrderPaymentClosed(context, event, tx, now),
      };
  }
  return event.name === "payment.paid" ? "pos" : { route: "ignored" };
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
): Promise<OrderPaymentDispatch> {
  if (!isOrderPaymentEvent(event)) return { route: "ignored" };
  if (event.tenantId !== context.tenant.tenantId) return { route: "ignored" };
  const routed = tx
    ? await dispatchInTx(context, event, tx, now)
    : await withTenant(db, context, (own) =>
        dispatchInTx(context, event, own, now),
      );
  if (routed !== "pos") return routed;
  // POS runs its own transaction (legend-kk7 signature); it ignores bills of
  // other modules (reservations, facilities) and is replay safe itself.
  await handlePosPaymentPaid(context, event);
  return { route: "pos" };
}

export type { OrderPaymentEventName };
