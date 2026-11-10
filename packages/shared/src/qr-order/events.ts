// QR order domain events, registered on the WS-03 line of the WS-00 catalog
// (packages/shared/src/events/catalog.ts) and bound with defineDomainEvent
// (contracts.md "One catalog, typed payloads").
//
// PRD v1.7 §6 event conventions: `<aggregate>.<past_verb>`, ULID event ids,
// one version, payload schemas referenced by `<name>.v1`.
//
// Coordinator decision (legend-6li review): `order.placed` is the QR-channel
// event (WS-03, a guest placed the shared cart as an order); `order.submitted`
// stays the POS / captain event owned by WS-04. Both are the same `order`
// aggregate; consumers that want every new order subscribe to both.
// `order.paid` is owned and defined by WS-04 (bead legend-4yp); QR consumers
// use that definition, this module does not redefine its payload.

import { z, idrSchema, isoDateTimeSchema } from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import {
  floorZoneIdSchema,
  orderIdSchema,
  orderIssueIdSchema,
  orderIssueTypeSchema,
  orderItemIdSchema,
  paymentModeSchema,
  serviceRequestIdSchema,
  serviceRequestReasonSchema,
  serviceRequestTypeSchema,
  sessionParticipantIdSchema,
  tableIdSchema,
  tableSessionClosedReasonSchema,
  tableLinkGroupIdSchema,
  tableSessionIdSchema,
  tableStatusSchema,
} from "./schemas.ts";
import { TABLE_LINK_LEFT_REASONS } from "./table-link.ts";

export const tableSessionOpenedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  pax: z.number().int().min(1).max(30),
  paymentMode: paymentModeSchema,
  openedBy: z.enum(["guest", "staff"]),
  participantId: sessionParticipantIdSchema,
});

/**
 * A later guest scanned the table QR and joined the active session (PRD
 * "Scan & Sesi Meja"). Emitted only when a new participant row is created; a
 * rescan by the same device just refreshes lastSeenAt. The name is catalogued
 * on the WS-03 line (`table_session.joined`) but had no payload schema yet.
 */
export const tableSessionJoinedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  participantId: sessionParticipantIdSchema,
});

export const tableSessionClosedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  reason: tableSessionClosedReasonSchema,
  billTotalIdr: idrSchema.refine((value) => value >= 0),
  paidIdr: idrSchema.refine((value) => value >= 0),
  orderCount: z.number().int().nonnegative(),
  closedBy: z.enum(["staff", "system", "guest"]),
});

/** Staff moved a live session (and its bill) to another table. */
export const tableSessionMovedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  fromTableId: tableIdSchema,
  toTableId: tableIdSchema,
  billTotalIdr: idrSchema.refine((value) => value >= 0),
});

/** Staff merged the source session's orders into the target session's bill. */
export const tableSessionMergedPayloadSchema = z.strictObject({
  targetSessionId: tableSessionIdSchema,
  sourceSessionId: tableSessionIdSchema,
  targetTableId: tableIdSchema,
  sourceTableId: tableIdSchema,
  movedItemCount: z.number().int().nonnegative(),
  movedTotalIdr: idrSchema.refine((value) => value >= 0),
});

/** Staff moved order items from one live session to another. */
export const tableSessionItemsMovedPayloadSchema = z.strictObject({
  fromSessionId: tableSessionIdSchema,
  toSessionId: tableSessionIdSchema,
  orderItemIds: z.array(orderItemIdSchema).min(1).max(50),
  movedItemCount: z.number().int().positive(),
  movedTotalIdr: idrSchema.refine((value) => value >= 0),
});

/** A table's floor status changed (staff action or session lifecycle). */
export const tableStatusChangedPayloadSchema = z.strictObject({
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  from: tableStatusSchema,
  to: tableStatusSchema,
  cause: z.enum([
    "staff_action",
    "session_closed",
    "session_expired",
    "session_moved",
    "session_merged",
  ]),
});

/** A session joined a service-only table link group. */
export const tableSessionLinkedPayloadSchema = z.strictObject({
  groupId: tableLinkGroupIdSchema,
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  tableIds: z.array(tableIdSchema).min(2),
});

/** A session left a table link group (or the group dissolved around it). */
export const tableSessionUnlinkedPayloadSchema = z.strictObject({
  groupId: tableLinkGroupIdSchema,
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  reason: z.enum(TABLE_LINK_LEFT_REASONS),
});

export const orderPlacedPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  sessionId: tableSessionIdSchema,
  channel: z.literal("qr"),
  itemCount: z.number().int().positive(),
  totalIdr: idrSchema.refine((value) => value >= 0),
  paymentMode: paymentModeSchema,
  status: z.enum(["awaiting_payment", "sent"]),
});

/** ORD-08: the guest is offered exactly these two resolutions. */
export const itemFailedPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  orderIssueId: orderIssueIdSchema,
  type: orderIssueTypeSchema,
  reason: z.string().min(1).max(500),
  offeredResolutions: z.tuple([z.literal("swap"), z.literal("voucher")]),
});

/** A failed item was settled: swap, voucher credit or approved manual refund. */
export const orderIssueResolvedPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  orderIssueId: orderIssueIdSchema,
  resolution: z.enum(["swap", "voucher", "manual_refund"]),
  resolvedBy: z.enum(["guest", "staff"]),
  replacementItemId: z.string().uuid().nullable(),
  voucherId: z.string().uuid().nullable(),
  priceDifferenceIdr: idrSchema.nullable(),
  /** Approval that allowed a dearer swap or a manual refund, when one applied. */
  approvalRequestId: z.string().uuid().optional(),
});

/**
 * ORD-09: a manual refund was approved for a failed item. The payment module
 * consumes this; the recovery flow never moves money itself.
 */
export const orderIssueManualRefundApprovedPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  orderIssueId: orderIssueIdSchema,
  amountIdr: idrSchema.refine((value) => value > 0),
  approvalRequestId: z.string().uuid(),
  approvedBy: z.string().min(1),
  reason: z.string().min(10).max(500),
});

/**
 * legend-94q2l: the refund opened for a failed item was rejected for good
 * (`rejected`), so its `order.refunded` journal is reversed. Appended once per
 * issue, only when an `order.refunded` event of that issue exists.
 */
export const orderIssueRefundReversalRequestedPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  orderIssueId: orderIssueIdSchema,
  /** The rejected `payment_refunds` row. */
  refundId: z.string().uuid(),
  amountIdr: idrSchema.refine((value) => value > 0),
  rejectedAt: isoDateTimeSchema,
});

export const serviceRequestCreatedPayloadSchema = z.strictObject({
  serviceRequestId: serviceRequestIdSchema,
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  type: serviceRequestTypeSchema,
  reason: serviceRequestReasonSchema.nullable(),
});

export const serviceRequestOverduePayloadSchema = z.strictObject({
  serviceRequestId: serviceRequestIdSchema,
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  type: serviceRequestTypeSchema,
  status: z.string(),
  assignedTo: z.string().nullable(),
  ageSeconds: z.number().int().nonnegative(),
  thresholdSeconds: z.number().int().positive(),
});

/** Events owned and emitted by this contract (WS-03 catalog line). */
export const qrOrderEventNames = [
  "table_session.opened",
  "table_session.joined",
  "table_session.closed",
  "table_session.moved",
  "table_session.merged",
  "table_session.items_moved",
  "order.placed",
  "item.failed",
  "order_issue.resolved",
  "order_issue.manual_refund_approved",
  "order_issue.refund_reversal_requested",
  "service_request.created",
  "service_request.overdue",
  "table.status_changed",
  "table_session.linked",
  "table_session.unlinked",
] as const;
export type QrOrderEventName = (typeof qrOrderEventNames)[number];
/** Kept for compatibility: identical to qrOrderEventNames. */
export const qrOrderOwnedEventNames = qrOrderEventNames;

export const qrOrderEventPayloads: Record<
  QrOrderEventName,
  z.ZodType<Record<string, unknown>>
> = {
  "table_session.opened": tableSessionOpenedPayloadSchema,
  "table_session.joined": tableSessionJoinedPayloadSchema,
  "table_session.closed": tableSessionClosedPayloadSchema,
  "table_session.moved": tableSessionMovedPayloadSchema,
  "table_session.merged": tableSessionMergedPayloadSchema,
  "table_session.items_moved": tableSessionItemsMovedPayloadSchema,
  "order.placed": orderPlacedPayloadSchema,
  "item.failed": itemFailedPayloadSchema,
  "order_issue.resolved": orderIssueResolvedPayloadSchema,
  "order_issue.manual_refund_approved":
    orderIssueManualRefundApprovedPayloadSchema,
  "order_issue.refund_reversal_requested":
    orderIssueRefundReversalRequestedPayloadSchema,
  "service_request.created": serviceRequestCreatedPayloadSchema,
  "service_request.overdue": serviceRequestOverduePayloadSchema,
  "table.status_changed": tableStatusChangedPayloadSchema,
  "table_session.linked": tableSessionLinkedPayloadSchema,
  "table_session.unlinked": tableSessionUnlinkedPayloadSchema,
};

/**
 * Catalog-bound definitions: defineDomainEvent throws at module load if a
 * name is not catalogued, and each `envelopeSchema` validates name, version,
 * schema ref and payload together.
 */
export const qrOrderEvents = Object.fromEntries(
  qrOrderEventNames.map((name) => [
    name,
    defineDomainEvent({ name, payload: qrOrderEventPayloads[name] }),
  ]),
) as Record<QrOrderEventName, ReturnType<typeof defineDomainEvent>>;

export const qrOrderEventCatalogEntries: readonly EventCatalogEntry[] =
  qrOrderEventNames.map((name) => qrOrderEvents[name].entry);

/** Envelope whose name and payload belong to this domain. */
export const qrOrderEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (qrOrderEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a QR order event" },
  )
  .refine(
    (event) =>
      qrOrderEvents[event.name as QrOrderEventName]?.envelopeSchema.safeParse(
        event,
      ).success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );
export type QrOrderEvent = EventEnvelope;

export type TableSessionOpenedPayload = z.infer<
  typeof tableSessionOpenedPayloadSchema
>;
export type TableSessionJoinedPayload = z.infer<
  typeof tableSessionJoinedPayloadSchema
>;
export type TableSessionClosedPayload = z.infer<
  typeof tableSessionClosedPayloadSchema
>;
export type OrderPlacedPayload = z.infer<typeof orderPlacedPayloadSchema>;
export type ItemFailedPayload = z.infer<typeof itemFailedPayloadSchema>;
export type OrderIssueResolvedPayload = z.infer<
  typeof orderIssueResolvedPayloadSchema
>;
export type OrderIssueManualRefundApprovedPayload = z.infer<
  typeof orderIssueManualRefundApprovedPayloadSchema
>;
export type OrderIssueRefundReversalRequestedPayload = z.infer<
  typeof orderIssueRefundReversalRequestedPayloadSchema
>;
export type ServiceRequestCreatedPayload = z.infer<
  typeof serviceRequestCreatedPayloadSchema
>;
