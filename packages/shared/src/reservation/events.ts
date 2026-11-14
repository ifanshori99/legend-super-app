// Reservation, waitlist and event pre-order domain events, registered on the
// WS-08 line of the WS-00 catalog (packages/shared/src/events/catalog.ts) and
// bound with defineDomainEvent (contracts.md "One catalog, typed payloads").
//
// PRD v1.7 §6 conventions: `<aggregate>.<past_verb>`, ULID event ids, one
// version, payload schemas referenced by `<name>.v1`. Payloads carry ids and
// money only: no guest name, note or phone hash (the aggregate row is the
// place for that), and no server-issued policy object beyond its version.
//
// WS-05 owns the DP money movement (`payment.paid`, `payment.refunded`); these
// events report the reservation decision (confirmed, seated with its DP
// allocated, cancelled/no-show with the refund split from the snapshot).

import { z, idrSchema, isoDateTimeSchema } from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry } from "../events/index.ts";
import {
  floorZoneIdSchema,
  tableIdSchema,
  tableSessionIdSchema,
} from "../qr-order/schemas.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import {
  reservationIdSchema,
  reservationPackageIdSchema,
  reservationPreOrderIdSchema,
  reservationStatusSchema,
  waitlistEntryIdSchema,
} from "./schemas.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

export const reservationEventNames = [
  "reservation.created",
  "reservation.confirmed",
  "reservation.seated",
  "reservation.completed",
  "reservation.cancelled",
  "reservation.rescheduled",
  "reservation.no_show",
  "waitlist_entry.called",
  "waitlist_entry.seated",
  "waitlist_entry.left",
  "reservation_preorder.placed",
] as const;
export type ReservationEventName = (typeof reservationEventNames)[number];

export const reservationCreatedPayloadSchema = z.strictObject({
  reservationId: reservationIdSchema,
  customerProfileId: z.uuid().toLowerCase().nullable(),
  reservedFor: isoDateTimeSchema,
  durationMinutes: z.number().int().min(15).max(720),
  pax: z.number().int().min(1).max(60),
  zoneId: floorZoneIdSchema.nullable(),
  tableIds: z.array(tableIdSchema),
  /** DP the snapshot requires; 0 when the reservation needs none. */
  depositIdr: nonnegativeIdr,
  depositPaymentId: z.uuid().toLowerCase().nullable(),
  /** RSV-03: the snapshot version this reservation will be judged by. */
  policyVersion: z.string().min(1).max(40),
  status: reservationStatusSchema,
});
export type ReservationCreatedPayload = z.infer<
  typeof reservationCreatedPayloadSchema
>;

export const reservationConfirmedPayloadSchema = z.strictObject({
  reservationId: reservationIdSchema,
  /** Null when the snapshot required no DP. */
  depositPaymentId: z.uuid().toLowerCase().nullable(),
  depositIdr: nonnegativeIdr,
});
export type ReservationConfirmedPayload = z.infer<
  typeof reservationConfirmedPayloadSchema
>;

export const reservationSeatedPayloadSchema = z.strictObject({
  reservationId: reservationIdSchema,
  tableSessionId: tableSessionIdSchema,
  tableIds: z.array(tableIdSchema),
  pax: z.number().int().min(1).max(60),
  /** RSV-02: the paid DP that is now allocated to the table's bill. */
  depositAllocatedIdr: nonnegativeIdr,
});
export type ReservationSeatedPayload = z.infer<
  typeof reservationSeatedPayloadSchema
>;

export const reservationCompletedPayloadSchema = z.strictObject({
  reservationId: reservationIdSchema,
  tableSessionId: tableSessionIdSchema,
  pax: z.number().int().min(1).max(60),
});
export type ReservationCompletedPayload = z.infer<
  typeof reservationCompletedPayloadSchema
>;

/**
 * RSV-03: the split comes from the snapshot, the refund is a WS-05 action.
 * Refund plus forfeit always reconciles the DP that was actually paid.
 */
export const reservationClosedPayloadSchema = z
  .strictObject({
    reservationId: reservationIdSchema,
    closedBy: z.enum(["guest", "staff", "system"]),
    reason: z.string().min(1).max(300).nullable(),
    depositPaidIdr: nonnegativeIdr,
    depositRefundIdr: nonnegativeIdr,
    depositForfeitedIdr: nonnegativeIdr,
    policyVersion: z.string().min(1).max(40),
  })
  .refine(
    (payload) =>
      payload.depositRefundIdr + payload.depositForfeitedIdr ===
      payload.depositPaidIdr,
    {
      path: ["depositRefundIdr"],
      message: "Refund plus forfeit equals the DP that was paid",
    },
  );
export type ReservationClosedPayload = z.infer<
  typeof reservationClosedPayloadSchema
>;

/** Staff approved a guest's reschedule request; the booking moved. */
export const reservationRescheduledPayloadSchema = z.strictObject({
  reservationId: reservationIdSchema,
  requestId: z.uuid().toLowerCase(),
  previousReservedFor: isoDateTimeSchema,
  reservedFor: isoDateTimeSchema,
  previousPax: z.number().int().min(1).max(60),
  pax: z.number().int().min(1).max(60),
  tableIds: z.array(tableIdSchema),
});
export type ReservationRescheduledPayload = z.infer<
  typeof reservationRescheduledPayloadSchema
>;

export const waitlistEntryCalledPayloadSchema = z.strictObject({
  waitlistEntryId: waitlistEntryIdSchema,
  pax: z.number().int().min(1).max(60),
  zoneId: floorZoneIdSchema.nullable(),
  estimatedWaitMinutes: z.number().int().min(0).max(600).nullable(),
});
export type WaitlistEntryCalledPayload = z.infer<
  typeof waitlistEntryCalledPayloadSchema
>;

export const waitlistEntrySeatedPayloadSchema = z.strictObject({
  waitlistEntryId: waitlistEntryIdSchema,
  tableSessionId: tableSessionIdSchema,
  pax: z.number().int().min(1).max(60),
});
export type WaitlistEntrySeatedPayload = z.infer<
  typeof waitlistEntrySeatedPayloadSchema
>;

export const waitlistEntryLeftPayloadSchema = z.strictObject({
  waitlistEntryId: waitlistEntryIdSchema,
  /** `left`: the guest walked away; `cancelled`: staff removed the entry. */
  resolution: z.enum(["left", "cancelled"]),
});
export type WaitlistEntryLeftPayload = z.infer<
  typeof waitlistEntryLeftPayloadSchema
>;

export const reservationPreOrderPlacedPayloadSchema = z.strictObject({
  preOrderId: reservationPreOrderIdSchema,
  reservationId: reservationIdSchema,
  packageId: reservationPackageIdSchema,
  pax: z.number().int().min(1).max(60),
  /** Net subtotal before tax and service (menu prices exclude both). */
  subtotalIdr: nonnegativeIdr,
  /** Kitchen order once the event day creates it; null at placement. */
  orderId: orderIdSchema.nullable(),
});
export type ReservationPreOrderPlacedPayload = z.infer<
  typeof reservationPreOrderPlacedPayloadSchema
>;

const payloadSchemas: Record<
  ReservationEventName,
  z.ZodType<Record<string, unknown>>
> = {
  "reservation.created": reservationCreatedPayloadSchema,
  "reservation.confirmed": reservationConfirmedPayloadSchema,
  "reservation.seated": reservationSeatedPayloadSchema,
  "reservation.completed": reservationCompletedPayloadSchema,
  "reservation.cancelled": reservationClosedPayloadSchema,
  "reservation.rescheduled": reservationRescheduledPayloadSchema,
  "reservation.no_show": reservationClosedPayloadSchema,
  "waitlist_entry.called": waitlistEntryCalledPayloadSchema,
  "waitlist_entry.seated": waitlistEntrySeatedPayloadSchema,
  "waitlist_entry.left": waitlistEntryLeftPayloadSchema,
  "reservation_preorder.placed": reservationPreOrderPlacedPayloadSchema,
};

/** Catalog-bound definitions: throws at module load for an unregistered name. */
export const reservationEvents = Object.fromEntries(
  reservationEventNames.map((name) => [
    name,
    defineDomainEvent({ name, payload: payloadSchemas[name] }),
  ]),
) as Record<ReservationEventName, ReturnType<typeof defineDomainEvent>>;

/** Payload schema for a reservation event name, or null for any other event. */
export function reservationEventPayloadSchema(name: string): z.ZodType | null {
  return Object.hasOwn(reservationEvents, name)
    ? reservationEvents[name as ReservationEventName].payloadSchema
    : null;
}

export const reservationEventCatalogEntries: readonly EventCatalogEntry[] =
  reservationEventNames.map((name) => reservationEvents[name].entry);

/**
 * An event envelope that must be one of the reservation events and match its
 * catalogued definition (name, version, schema ref and payload).
 */
export const reservationEventSchema = eventEnvelopeSchema
  .refine(
    (event) =>
      (reservationEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a reservation event" },
  )
  .refine(
    (event) =>
      reservationEvents[
        event.name as ReservationEventName
      ]?.envelopeSchema.safeParse(event).success === true,
    {
      path: ["payload"],
      message:
        "Reservation event name and payload must match a registered schema",
    },
  );
