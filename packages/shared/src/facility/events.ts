// Facility-domain event payloads (PRD v1.7 §6 K; naming `<aggregate>.<past_verb>`
// in the WS-00 catalog, ids ULID — docs/plan/contracts.md).
//
// Binding rule (docs/plan/contracts.md `defineDomainEvent`): a payload schema is
// registered against the catalogued name at module load, so a typo, an
// unregistered name or a version drift throws instead of publishing an event
// nobody consumes. This bead owns the WS-09 lines in `events/catalog.ts`.
//
// Never in a payload: the door PIN or QR token, a raw device fingerprint, a
// provider secret, or customer personal data beyond the opaque profile id.

import {
  z,
  businessDateSchema,
  idrSchema,
  isoDateTimeSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import {
  accessEventTypeSchema,
  entitlementSourceSchema,
  facilityIncidentTypeSchema,
  wifiSpeedTierSchema,
} from "./schemas.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

/** A ticket became usable: paid, or its entitlement was redeemed (FAC-04). */
export const accessTicketIssuedEvent = defineDomainEvent({
  name: "access_ticket.issued",
  payload: z.strictObject({
    ticketId: ulidSchema,
    facilityId: uuidSchema,
    areaId: uuidSchema,
    unitId: uuidSchema,
    customerProfileId: uuidSchema,
    productId: uuidSchema,
    source: entitlementSourceSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    /** Sold by the edge while the outlet had no internet (FAC-03). */
    issuedOffline: z.boolean(),
  }),
});

/** The guest opened the door: the session started (FAC-01, once per session). */
export const accessTicketRedeemedEvent = defineDomainEvent({
  name: "access_ticket.redeemed",
  payload: z.strictObject({
    ticketId: ulidSchema,
    unitId: uuidSchema,
    areaId: uuidSchema,
    openedAt: isoDateTimeSchema,
  }),
});

/** Raw door log: unlock, denied attempt, tamper, battery (PRD §6 K access_events). */
export const accessEventRecordedEvent = defineDomainEvent({
  name: "access_event.recorded",
  payload: z.strictObject({
    accessEventId: ulidSchema,
    lockDeviceId: uuidSchema,
    accessTicketId: ulidSchema.nullable(),
    unitId: uuidSchema.nullable(),
    type: accessEventTypeSchema,
    occurredAt: isoDateTimeSchema,
    /** Recorded by the lock agent while the edge was offline (FAC-03). */
    offline: z.boolean(),
  }),
});

export const facilitySessionStartedEvent = defineDomainEvent({
  name: "facility_session.started",
  payload: z.strictObject({
    ticketId: ulidSchema,
    unitId: uuidSchema,
    startedAt: isoDateTimeSchema,
  }),
});

/** Session end, including overtime and its fee (PRD §3 F22 Sesi & Pengingat). */
export const facilitySessionEndedEvent = defineDomainEvent({
  name: "facility_session.ended",
  payload: z.strictObject({
    ticketId: ulidSchema,
    unitId: uuidSchema,
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema,
    overtimeMinutes: z.number().int().min(0).max(1440),
    overtimeFeeIdr: nonnegativeIdr,
  }),
});

/** A finished session made the unit dirty (PRD §3 F22 Siklus Kebersihan). */
export const cleaningTaskCreatedEvent = defineDomainEvent({
  name: "cleaning_task.created",
  payload: z.strictObject({
    cleaningTaskId: uuidSchema,
    facilityId: uuidSchema,
    unitId: uuidSchema,
    accessTicketId: ulidSchema.nullable(),
    createdAt: isoDateTimeSchema,
  }),
});

/** FAC-04: an access right was issued after its condition and payment held. */
export const facilityEntitlementIssuedEvent = defineDomainEvent({
  name: "facility_entitlement.issued",
  payload: z.strictObject({
    entitlementLedgerId: uuidSchema,
    customerProfileId: uuidSchema,
    facilityId: uuidSchema,
    sourceType: entitlementSourceSchema,
    sourceRef: z.union([uuidSchema, ulidSchema]),
    sessions: z.number().int().min(1).max(100),
    expiresAt: isoDateTimeSchema.nullable(),
  }),
});

export const facilityEntitlementExpiredEvent = defineDomainEvent({
  name: "facility_entitlement.expired",
  payload: z.strictObject({
    entitlementLedgerId: uuidSchema,
    customerProfileId: uuidSchema,
    facilityId: uuidSchema,
    sessions: z.number().int().min(1).max(100),
    expiredAt: isoDateTimeSchema,
  }),
});

/** FAC-04: the source transaction was refunded, so the grant is revoked. */
export const facilityEntitlementRevokedEvent = defineDomainEvent({
  name: "facility_entitlement.revoked",
  payload: z.strictObject({
    entitlementLedgerId: uuidSchema,
    customerProfileId: uuidSchema,
    facilityId: uuidSchema,
    sourceType: entitlementSourceSchema,
    sourceRef: z.union([uuidSchema, ulidSchema]),
    sessions: z.number().int().min(1).max(100),
    reason: z.string().min(1).max(500),
    revokedAt: isoDateTimeSchema,
  }),
});

/** A recurring invoice was issued (PRD §3 F22 Langganan Bulanan, FAC-07). */
export const subscriptionBilledEvent = defineDomainEvent({
  name: "subscription.billed",
  payload: z.strictObject({
    subscriptionId: uuidSchema,
    invoiceId: uuidSchema,
    planId: uuidSchema,
    periodStart: businessDateSchema,
    periodEnd: businessDateSchema,
    amountIdr: nonnegativeIdr,
    dueAt: isoDateTimeSchema,
  }),
});

/**
 * FAC-12/FAC-13: the daily allowance changed (a paid order added minutes, a
 * tier bonus applied) or the session crossed into the throttled tier. The
 * event never carries the device fingerprint.
 */
export const wifiQuotaUpdatedEvent = defineDomainEvent({
  name: "wifi_quota.updated",
  payload: z.strictObject({
    customerProfileId: uuidSchema,
    sessionId: uuidSchema.nullable(),
    zoneId: uuidSchema,
    quotaMinutes: z.number().int().min(0).max(1440),
    usedMinutes: z.number().int().min(0).max(1440),
    speedTier: wifiSpeedTierSchema,
    /**
     * What the edge needs to push the quota to the controller without the
     * policy row (the edge holds no wifi_policies): both speeds and the end of
     * the session's business day. Optional so older outbox rows still parse;
     * the cloud -> edge forwarder always fills them.
     */
    fullSpeedKbps: z.number().int().min(1).max(1_000_000).optional(),
    baseSpeedKbps: z.number().int().min(1).max(1_000_000).optional(),
    sessionEndsAt: isoDateTimeSchema.optional(),
    reason: z.enum([
      "session_started",
      "spend",
      "tier_bonus",
      "peak_window",
      "quota_spent",
    ]),
  }),
});

/** Edge receive only; the cloud event contract above remains strict. */
export const wifiQuotaUpdatedEdgePayloadSchema =
  wifiQuotaUpdatedEvent.payloadSchema.strip();

/** FAC-08: the emergency button fired; the staff on duty must answer in 5 s. */
export const facilityIncidentRaisedEvent = defineDomainEvent({
  name: "facility_incident.raised",
  payload: z.strictObject({
    incidentId: uuidSchema,
    facilityId: uuidSchema,
    unitId: uuidSchema.nullable(),
    type: facilityIncidentTypeSchema,
    triggeredAt: isoDateTimeSchema,
    /** Raised on the edge during an outage; synced when the link is back. */
    offline: z.boolean(),
  }),
});

/** Every event this workstream publishes, in catalog order. */
export const facilityEvents = {
  accessTicketIssued: accessTicketIssuedEvent,
  accessTicketRedeemed: accessTicketRedeemedEvent,
  accessEventRecorded: accessEventRecordedEvent,
  facilitySessionStarted: facilitySessionStartedEvent,
  facilitySessionEnded: facilitySessionEndedEvent,
  cleaningTaskCreated: cleaningTaskCreatedEvent,
  facilityEntitlementIssued: facilityEntitlementIssuedEvent,
  facilityEntitlementExpired: facilityEntitlementExpiredEvent,
  facilityEntitlementRevoked: facilityEntitlementRevokedEvent,
  subscriptionBilled: subscriptionBilledEvent,
  wifiQuotaUpdated: wifiQuotaUpdatedEvent,
  facilityIncidentRaised: facilityIncidentRaisedEvent,
} as const;

export type FacilityEventDefinitions = typeof facilityEvents;
export const FACILITY_EVENT_DEFINITIONS = Object.values(facilityEvents);
export const FACILITY_EVENT_NAMES = FACILITY_EVENT_DEFINITIONS.map(
  (definition) => definition.name,
);
