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

import { z, idrSchema } from "../core/index.ts";
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
  tableSessionIdSchema,
} from "./schemas.ts";

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
  "service_request.created",
  "service_request.overdue",
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
  "service_request.created": serviceRequestCreatedPayloadSchema,
  "service_request.overdue": serviceRequestOverduePayloadSchema,
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
export type ServiceRequestCreatedPayload = z.infer<
  typeof serviceRequestCreatedPayloadSchema
>;
