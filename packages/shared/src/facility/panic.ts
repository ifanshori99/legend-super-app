// Panic alert relay contract (bead legend-bod; PRD v1.7 §3 F25 "Keselamatan",
// FAC-08). A panic button posts `panicEventInputSchema` to the edge; the edge
// fans a `PanicRealtimeFrame` out to the staff on duty of the outlet and keeps
// one `PanicAlert` row per press. The tenant and the outlet come from the
// device token and the node identity, never from the body (TEN-02).

import {
  z,
  cursorPageQuerySchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";

/**
 * The UUID form of the alert's ULID key. It carries ULID bytes, so it is not an
 * RFC 4122 version/variant UUID and `uuidSchema` would refuse it.
 */
export const panicAlertIdSchema = z.guid().toLowerCase();

/** The WebSocket sub-protocol of the staff panic stream. */
export const PANIC_REALTIME_PROTOCOL = "legend.panic.v1";

/** Body of a panic-button press. `eventId` is the device's idempotency key. */
export const panicEventInputSchema = z.strictObject({
  deviceId: uuidSchema,
  eventId: z.string().trim().min(1).max(100),
  triggeredAt: isoDateTimeSchema,
});
export type PanicEventInput = z.infer<typeof panicEventInputSchema>;

export const panicAlertListQuerySchema = cursorPageQuerySchema;
export type PanicAlertListQuery = z.infer<typeof panicAlertListQuerySchema>;

export const panicAlertSchema = z.strictObject({
  id: panicAlertIdSchema,
  outletId: outletIdSchema,
  deviceId: uuidSchema,
  eventId: z.string(),
  unitId: uuidSchema.nullable(),
  facilityIncidentId: uuidSchema.nullable(),
  triggeredAt: isoDateTimeSchema,
  receivedAt: isoDateTimeSchema,
  fannedOutAt: isoDateTimeSchema.nullable(),
  recipientCount: z.number().int().min(0),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
  offline: z.boolean(),
});
export type PanicAlert = z.infer<typeof panicAlertSchema>;

/** What the staff screens receive the moment a button is pressed. */
export const panicRealtimeFrameSchema = z.strictObject({
  type: z.literal("panic"),
  alertId: panicAlertIdSchema,
  outletId: outletIdSchema,
  unitId: uuidSchema.nullable(),
  receivedAt: isoDateTimeSchema,
});
export type PanicRealtimeFrame = z.infer<typeof panicRealtimeFrameSchema>;

export const panicRealtimeHelloSchema = z.strictObject({
  type: z.literal("hello"),
  outletId: outletIdSchema,
});
export type PanicRealtimeHello = z.infer<typeof panicRealtimeHelloSchema>;
