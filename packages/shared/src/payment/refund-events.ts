// Refund escalation event (bead legend-n9kn). A refund that waits too long is
// never auto-cancelled or auto-paid; past a per-tenant age threshold it is
// marked escalated once per reason and this event fans out to outlet managers
// and finance through the notification outbox path.
//
// - pending_unapproved: pending refund with no approval chain after the threshold.
// - provider_pending: approved refund still polling the provider after the threshold.
// - payout_stalled: approved refund whose payout is stuck.
// - failed_holds_order (SO-885): failed refund that keeps a guest QR order held; alerted at once.

import { idrSchema, isoDateTimeSchema, uuidSchema, z } from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";

export const refundEscalationReasonSchema = z.enum([
  "pending_unapproved",
  "provider_pending",
  "payout_stalled",
  "failed_holds_order",
]);
export type RefundEscalationReason = z.infer<
  typeof refundEscalationReasonSchema
>;

export const paymentRefundEscalatedPayloadSchema = z.strictObject({
  refundId: uuidSchema,
  outletId: uuidSchema,
  amountIdr: idrSchema.refine((value) => value > 0),
  reason: refundEscalationReasonSchema,
  waitingSince: isoDateTimeSchema,
  thresholdHours: z.number().int().min(0).max(720),
  escalatedAt: isoDateTimeSchema,
});
export type PaymentRefundEscalatedPayload = z.infer<
  typeof paymentRefundEscalatedPayloadSchema
>;

export const paymentRefundEscalatedEvent = defineDomainEvent({
  name: "payment.refund_escalated",
  payload: paymentRefundEscalatedPayloadSchema,
});
