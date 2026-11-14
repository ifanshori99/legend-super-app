// Emergency button contract (bead legend-bod; PRD v1.7 §3 F25 "Keselamatan",
// FAC-08; design docs/design/edge-emergency.md D-03, D-05, D-06, D-09). A panic
// button posts `panicPressBodySchema` to the edge (or to the cloud API of a
// cloud-only outlet). The edge keeps one alert per press burst, fans a
// `PanicRealtimeFrame` out to the staff on duty and up-syncs the alert to the
// cloud as the four `panic_alert.*` events below. Browser-safe and Node-safe:
// the SHA-256 of the alert id lives in the API (`panic-alert-outbox.ts`).
//
// The tenant, the outlet and the device come from the device token, never from
// a body (TEN-02). No payload carries a PIN, a token or guest personal data.

import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { staffPinInputSchema } from "../identity/index.ts";

// ------------------------------------------------------------------ constants

/** WebSocket subprotocol of the staff emergency stream (D-03). */
export const EMERGENCY_WS_PROTOCOL = "legend.emergency.v1";
/** Cookie of a receiver session: `<tenantId>.<43-char base64url>` (D-03). */
export const EMERGENCY_COOKIE_NAME = "legend_emergency";
export const EMERGENCY_COOKIE_PATH = "/api/emergency";
/** WebSocket close code sent when a receiver session is revoked (D-03). */
export const EMERGENCY_REVOKED_CLOSE_CODE = 4401;
/** Resolve note limit (D-07). */
export const EMERGENCY_RESOLUTION_NOTE_MAX = 500;
/** Why a receiver session ended (`panic_receiver_sessions.revoke_reason`). */
export const PANIC_SESSION_REVOKE_REASONS = [
  "logout",
  "replaced",
  "pin_changed",
  "staff_inactive",
  "permission_removed",
  "device_revoked",
  "off_duty",
  "expired",
] as const;
export type PanicSessionRevokeReason =
  (typeof PANIC_SESSION_REVOKE_REASONS)[number];

/** Permissions of the emergency button (D-02, D-07; Q95). */
export const EMERGENCY_PERMISSION_RESPOND = "facility.emergency.respond";
export const EMERGENCY_PERMISSION_RESOLVE = "facility.emergency.resolve";

export const panicAlertKindSchema = z.enum(["press", "test"]);
export type PanicAlertKind = z.infer<typeof panicAlertKindSchema>;

// ------------------------------------------------------------------ alert id

/** `panic_alerts.id`: the deterministic UUID made at ingest (D-06). */
export const panicAlertIdSchema = uuidSchema;

/**
 * The text the alert id is hashed from: tenant, device and the FIRST press's
 * device event id. Both ids are fixed-length UUIDs, so joining with a newline
 * cannot make two different inputs collide. Lowercase UUIDs, event id as sent.
 */
export function panicAlertIdMaterial(
  tenantId: string,
  deviceId: string,
  firstDeviceEventId: string,
): string {
  return `legend.panic-alert.v1\n${tenantId.toLowerCase()}\n${deviceId.toLowerCase()}\n${firstDeviceEventId}`;
}

/**
 * UUID text from the first 16 bytes of SHA-256(`panicAlertIdMaterial(...)`),
 * version nibble 5 and RFC 4122 variant (10xx), like uuid v5 (D-06). The API
 * computes the digest (`panicAlertIdFor` in `panic-alert-outbox.ts`).
 */
export function panicAlertIdFromDigest(digest: Uint8Array): string {
  if (digest.length < 16)
    throw new RangeError("A SHA-256 digest has at least 16 bytes");
  const bytes = Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --------------------------------------------------------------------- bodies

/**
 * Body of `POST /api/emergency/press`. `eventId` is the device's idempotency
 * key (unique per press). `triggeredAt` is the device clock and may be wrong.
 */
export const panicPressBodySchema = z.strictObject({
  eventId: z.string().trim().min(1).max(64),
  kind: panicAlertKindSchema.default("press"),
  triggeredAt: isoDateTimeSchema.optional(),
});
export type PanicPressBody = z.infer<typeof panicPressBodySchema>;

/** Body of `POST /api/emergency/sessions` (D-03). Device token is the header. */
export const panicSessionBodySchema = z.strictObject({
  staffUserId: userIdSchema,
  pin: staffPinInputSchema,
});
export type PanicSessionBody = z.infer<typeof panicSessionBodySchema>;

/** Body of `POST /api/emergency/alerts/:id/ack`: nothing to send. */
export const panicAckBodySchema = z.strictObject({});
export type PanicAckBody = z.infer<typeof panicAckBodySchema>;

/** Body of the cloud `POST /api/outlets/:outletId/emergency-alerts/:alertId/resolve`. */
export const panicResolveBodySchema = z.strictObject({
  note: z.string().trim().min(1).max(EMERGENCY_RESOLUTION_NOTE_MAX),
});
export type PanicResolveBody = z.infer<typeof panicResolveBodySchema>;

// ------------------------------------------------------------------- fallback

/**
 * One item of `GET /api/emergency/fallback` (Q94): room name and time only.
 * Exactly these keys; no device label, staff or guest detail.
 */
export const panicFallbackItemSchema = z.strictObject({
  alertId: panicAlertIdSchema,
  unitCode: z.string().nullable(),
  receivedAt: isoDateTimeSchema,
});
export type PanicFallbackItem = z.infer<typeof panicFallbackItemSchema>;

export const panicFallbackResponseSchema = z.strictObject({
  alerts: z.array(panicFallbackItemSchema),
});
export type PanicFallbackResponse = z.infer<typeof panicFallbackResponseSchema>;

// ------------------------------------------------------------------ WS frames

/** Server to client: an open alert (resent every 3 s until `received`). */
export const panicRealtimeFrameSchema = z.strictObject({
  type: z.literal("panic"),
  alertId: panicAlertIdSchema,
  outletId: outletIdSchema,
  unitId: uuidSchema.nullable(),
  unitCode: z.string().nullable(),
  areaName: z.string().nullable(),
  receivedAt: isoDateTimeSchema,
  /** `test` is shown with the "UJI" flag. */
  kind: panicAlertKindSchema,
});
export type PanicRealtimeFrame = z.infer<typeof panicRealtimeFrameSchema>;

/** Server to client: a receiver has taken responsibility for the alert. */
export const panicAcknowledgedFrameSchema = z.strictObject({
  type: z.literal("acknowledged"),
  alertId: panicAlertIdSchema,
  acknowledgedAt: isoDateTimeSchema,
  byName: z.string(),
});
export type PanicAcknowledgedFrame = z.infer<
  typeof panicAcknowledgedFrameSchema
>;
export type PanicServerFrame = PanicRealtimeFrame | PanicAcknowledgedFrame;

/** Client to server: this phone showed the alert (D-05 receipt). */
export const panicReceivedFrameSchema = z.strictObject({
  type: z.literal("received"),
  alertId: panicAlertIdSchema,
});
export type PanicReceivedFrame = z.infer<typeof panicReceivedFrameSchema>;

// ---------------------------------------------------------------- sync events

/**
 * Edge to cloud sync, aggregate `panic_alert`, aggregate id = alert id (D-09).
 * `raised` is sequence 1 and carries the first press; the envelope sequence
 * equals the queue's aggregate sequence. Label snapshots are the labels at the
 * moment of the press; `unitId` and `deviceId` carry no FK in the cloud.
 */
export const panicAlertRaisedEvent = defineDomainEvent({
  name: "panic_alert.raised",
  payload: z.strictObject({
    alertId: panicAlertIdSchema,
    outletId: outletIdSchema,
    deviceId: uuidSchema,
    unitId: uuidSchema.nullable(),
    firstDeviceEventId: z.string().min(1).max(64),
    kind: panicAlertKindSchema,
    triggeredAt: isoDateTimeSchema.nullable(),
    /** Edge clock. */
    receivedAt: isoDateTimeSchema,
    unitCodeSnapshot: z.string().max(255),
    facilityNameSnapshot: z.string().max(255),
    deviceLabelSnapshot: z.string().max(255),
    /** The edge could not reach the cloud when the button was pressed. */
    linkOffline: z.boolean(),
  }),
});

/** A later press folded into the open alert (D-06). */
export const panicAlertPressedEvent = defineDomainEvent({
  name: "panic_alert.pressed",
  payload: z.strictObject({
    alertId: panicAlertIdSchema,
    deviceId: uuidSchema,
    deviceEventId: z.string().min(1).max(64),
    /** Edge clock. */
    receivedAt: isoDateTimeSchema,
    /** Total presses of the alert after this one; the cloud keeps the max. */
    pressCount: z.number().int().min(2).max(100_000),
  }),
});

/** Receipt totals, batched every 5 s while new receipts arrive (D-09). */
export const panicAlertDeliveredEvent = defineDomainEvent({
  name: "panic_alert.delivered",
  payload: z.strictObject({
    alertId: panicAlertIdSchema,
    /** Recipients that confirmed; the cloud keeps the max. */
    deliveredCount: z.number().int().min(0).max(100_000),
    firstDeliveredAt: isoDateTimeSchema.nullable(),
    /** Set once the POS fallback (Q94) showed the alert. */
    fallbackShownAt: isoDateTimeSchema.nullable(),
  }),
});

/** The first acknowledgement wins; the cloud sets it once (D-07, D-09). */
export const panicAlertAcknowledgedEvent = defineDomainEvent({
  name: "panic_alert.acknowledged",
  payload: z.strictObject({
    alertId: panicAlertIdSchema,
    acknowledgedBy: userIdSchema,
    /** The outlet device the receiver session was opened on. */
    ackDeviceId: uuidSchema.nullable(),
    /** Edge clock. */
    acknowledgedAt: isoDateTimeSchema,
  }),
});

/**
 * Cloud to edge (direction `cloud_to_edge`, aggregate `panic_alert`): a manager
 * closed the incident in the cloud. The edge closes its copy: no resend, no POS
 * fallback banner. Set-once on the edge; a replay changes nothing. Resolve also
 * counts as an acknowledgement when the alert had none (D-07).
 */
export const panicAlertResolvedEvent = defineDomainEvent({
  name: "panic_alert.resolved",
  payload: z.strictObject({
    alertId: panicAlertIdSchema,
    resolvedBy: userIdSchema,
    /** Cloud clock. */
    resolvedAt: isoDateTimeSchema,
    resolutionNote: z.string().max(500).nullable(),
  }),
});

export const panicAlertEvents = {
  raised: panicAlertRaisedEvent,
  pressed: panicAlertPressedEvent,
  delivered: panicAlertDeliveredEvent,
  acknowledged: panicAlertAcknowledgedEvent,
  resolved: panicAlertResolvedEvent,
} as const;

export const PANIC_ALERT_AGGREGATE_TYPE = "panic_alert";
export type PanicAlertEventKey = keyof typeof panicAlertEvents;
