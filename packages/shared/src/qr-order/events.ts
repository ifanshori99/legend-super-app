// QR order domain events, registered in the WS-00 catalog
// (packages/shared/src/events/catalog.ts).
//
// PRD v1.7 §6 event conventions: `<aggregate>.<past_verb>`, ULID event ids,
// one version, payload schemas referenced by `<name>.v1`. `order.paid` is
// catalogued by WS-04 (POS) because the order aggregate belongs there; this
// module references it and declares a provisional payload for QR mocks until
// the WS-04 contract lands.

import { z, idrSchema, isoDateTimeSchema } from "../core/index.ts";
import {
  eventCatalogEntrySchema,
  eventEnvelopeSchema,
} from "../events/index.ts";
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

export const tableSessionClosedPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  reason: tableSessionClosedReasonSchema,
  billTotalIdr: idrSchema.refine((value) => value >= 0),
  paidIdr: idrSchema.refine((value) => value >= 0),
  orderCount: z.number().int().nonnegative(),
  closedBy: z.enum(["staff", "system", "guest"]),
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

/** Provisional: the canonical `order.paid` payload is WS-04's (bead legend-4yp). */
export const orderPaidPayloadSchema = z.strictObject({
  orderId: orderIdSchema,
  sessionId: tableSessionIdSchema.nullable(),
  amountIdr: idrSchema.refine((value) => value > 0),
  method: z.string().min(1).max(20),
  paidAt: isoDateTimeSchema,
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

/** Every event this contract emits or consumes. */
export const qrOrderEventNames = [
  "table_session.opened",
  "table_session.closed",
  "order.placed",
  "order.paid",
  "item.failed",
  "service_request.created",
] as const;

/** Events owned here; `order.paid` is owned by WS-04. */
export const qrOrderOwnedEventNames = [
  "table_session.opened",
  "table_session.closed",
  "order.placed",
  "item.failed",
  "service_request.created",
] as const;

export const qrOrderEventCatalogEntries = qrOrderOwnedEventNames.map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-03",
  }),
);

export const qrOrderEventSchema = eventEnvelopeSchema.refine((event) =>
  (qrOrderEventNames as readonly string[]).includes(event.name),
);

export const qrOrderEventPayloads = {
  "table_session.opened": tableSessionOpenedPayloadSchema,
  "table_session.closed": tableSessionClosedPayloadSchema,
  "order.placed": orderPlacedPayloadSchema,
  "order.paid": orderPaidPayloadSchema,
  "item.failed": itemFailedPayloadSchema,
  "service_request.created": serviceRequestCreatedPayloadSchema,
} as const;

export type TableSessionOpenedPayload = z.infer<
  typeof tableSessionOpenedPayloadSchema
>;
export type TableSessionClosedPayload = z.infer<
  typeof tableSessionClosedPayloadSchema
>;
export type OrderPlacedPayload = z.infer<typeof orderPlacedPayloadSchema>;
export type OrderPaidPayload = z.infer<typeof orderPaidPayloadSchema>;
export type ItemFailedPayload = z.infer<typeof itemFailedPayloadSchema>;
export type ServiceRequestCreatedPayload = z.infer<
  typeof serviceRequestCreatedPayloadSchema
>;
