// Client request bodies and queries for the facility and Wi-Fi endpoints
// (PRD v1.7 §3 F22/F23/F39). Every schema is built with `clientInputSchema`:
// the tenant comes from the domain or token, never from the body (TEN-02), and
// an unknown field is rejected instead of ignored.
//
// Staff-only inputs (config writes, cleaning, incidents, POS sale) are
// authorized by the API's service layer; the schema only pins the shape.

import {
  z,
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";
import {
  accessTicketStatusSchema,
  cancellationPolicySchema,
  cleaningChecklistSchema,
  entitlementSourceSchema,
  entitlementValiditySchema,
  facilityProductTypeSchema,
  facilityUnitStatusSchema,
  overtimePolicySchema,
  peakWindowSchema,
  subscriptionIntervalSchema,
} from "./schemas.ts";
import { facilityHoursSchema } from "./slots.ts";
import {
  facilityAddonIdSchema,
  facilityAreaIdSchema,
  facilityIdSchema,
  facilityProductIdSchema,
  facilityQueueEntryIdSchema,
  facilitySubscriptionIdSchema,
  facilityUnitIdSchema,
  subscriptionPlanIdSchema,
  wifiPolicyIdSchema,
  wifiSessionIdSchema,
} from "./ids.ts";

const minuteCount = z.number().int().min(0).max(1440);
const sortOrder = z.number().int().min(0).max(10_000);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveInt = z.number().int().min(1);

// ---- Booking and tickets ----------------------------------------------------

/** "Pilih slot" or "masuk sekarang" (PRD §3 F22 Pemesanan). */
export const bookingTimingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("slot"), startsAt: isoDateTimeSchema }),
  z.strictObject({ kind: z.literal("now") }),
]);
export type BookingTiming = z.infer<typeof bookingTimingSchema>;

const addonIds = z.array(facilityAddonIdSchema).max(10);

export const bookAccessTicketSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  /** FAC-09: the area is chosen per booking and stored on the ticket. */
  areaId: facilityAreaIdSchema,
  /** Optional unit preference; the service picks any free unit when omitted. */
  unitId: facilityUnitIdSchema.optional(),
  timing: bookingTimingSchema,
  productId: facilityProductIdSchema,
  source: entitlementSourceSchema,
  /** The grant being redeemed, when the source issues one (FAC-04/FAC-05). */
  entitlementLedgerId: uuidSchema.optional(),
  addonIds: addonIds.optional(),
  /** Breakfast order held and fired before the session ends (FAC-10). */
  linkedOrder: z
    .strictObject({
      orderId: ulidSchema,
      fireOffsetMinutes: z.number().int().min(0).max(240),
    })
    .optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type BookAccessTicketInput = z.infer<typeof bookAccessTicketSchema>;

/**
 * A cash sale at the POS or an offline edge sale (PRD §3 Penjualan Fasilitas,
 * FAC-03). The cashier names the customer; the API still resolves the tenant.
 */
export const staffSellTicketSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
  unitId: facilityUnitIdSchema.optional(),
  productId: facilityProductIdSchema,
  customerProfileId: uuidSchema,
  timing: bookingTimingSchema,
  addonIds: addonIds.optional(),
  /** Sold by the edge node while the outlet had no internet (FAC-03). */
  issuedOffline: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type StaffSellTicketInput = z.infer<typeof staffSellTicketSchema>;

export const cancelAccessTicketSchema = clientInputSchema({
  reason: z.string().trim().min(3).max(500),
});
export type CancelAccessTicketInput = z.infer<typeof cancelAccessTicketSchema>;

export const listAccessTicketsQuerySchema = cursorPageQuerySchema.extend({
  facilityId: facilityIdSchema.optional(),
  status: accessTicketStatusSchema.optional(),
});

export const listAvailabilityQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
  /** Business date in the outlet time zone (D-CORE-6). */
  date: businessDateSchema,
  areaId: facilityAreaIdSchema.optional(),
});

// ---- Wait queue -------------------------------------------------------------

export const joinFacilityQueueSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
});
export type JoinFacilityQueueInput = z.infer<typeof joinFacilityQueueSchema>;

export const leaveFacilityQueueParamsSchema = z.strictObject({
  entryId: facilityQueueEntryIdSchema,
});

// ---- Staff board, cleaning, incidents ---------------------------------------

export const createCleaningTaskSchema = clientInputSchema({
  unitId: facilityUnitIdSchema,
  /** The finished session that dirtied the unit (null for a deep clean). */
  accessTicketId: ulidSchema.optional(),
});
export type CreateCleaningTaskInput = z.infer<typeof createCleaningTaskSchema>;

export const completeCleaningTaskSchema = clientInputSchema({
  checklist: cleaningChecklistSchema,
  mediaIds: z.array(uuidSchema).max(10).optional(),
});
export type CompleteCleaningTaskInput = z.infer<
  typeof completeCleaningTaskSchema
>;

export const startCleaningTaskSchema = clientInputSchema({
  assignedTo: uuidSchema.optional(),
});

export const updateFacilityUnitSchema = clientInputSchema({
  action: z.enum(["flag_maintenance", "release_maintenance"]),
  note: z.string().trim().max(500).optional(),
});
export type UpdateFacilityUnitInput = z.infer<typeof updateFacilityUnitSchema>;

export const raiseFacilityIncidentSchema = clientInputSchema({
  unitId: facilityUnitIdSchema.optional(),
  accessTicketId: ulidSchema.optional(),
  type: z.enum(["panic", "assist", "damage"]),
  note: z.string().trim().max(500).optional(),
});
export type RaiseFacilityIncidentInput = z.infer<
  typeof raiseFacilityIncidentSchema
>;

export const respondFacilityIncidentSchema = clientInputSchema({
  resolution: z.string().trim().min(3).max(500),
});

export const facilityUnitsQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
  status: facilityUnitStatusSchema.optional(),
});

// ---- Wi-Fi ------------------------------------------------------------------

export const startWifiSessionSchema = clientInputSchema({
  zoneId: uuidSchema,
  /**
   * A stable fingerprint of the device as the portal sees it. The API hashes
   * it (SHA-256) before storing it; the raw value is never persisted.
   */
  deviceFingerprint: z.string().min(8).max(512),
});
export type StartWifiSessionInput = z.infer<typeof startWifiSessionSchema>;

export const wifiPolicyQuerySchema = z.strictObject({
  zoneId: uuidSchema,
});

/** Optional spend refresh: the portal asks after a payment lands (FAC-12). */
export const refreshWifiQuotaSchema = clientInputSchema({
  sameDaySpendIdr: nonnegativeIdr,
});

export const wifiSessionParamsSchema = z.strictObject({
  sessionId: wifiSessionIdSchema,
});

// ---- Subscriptions ----------------------------------------------------------

export const startSubscriptionSchema = clientInputSchema({
  planId: subscriptionPlanIdSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type StartSubscriptionInput = z.infer<typeof startSubscriptionSchema>;

export const updateSubscriptionSchema = clientInputSchema({
  action: z.enum(["pause", "resume", "cancel"]),
});
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const subscriptionParamsSchema = z.strictObject({
  subscriptionId: facilitySubscriptionIdSchema,
});

// ---- Admin configuration ----------------------------------------------------

/** PATCH bodies must change something; an empty object is a client bug. */
function nonEmptyUpdate<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
) {
  return schema.refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });
}

export const updateFacilitySchema = nonEmptyUpdate(
  clientInputSchema({
    name: z.string().trim().min(1).max(150).optional(),
    type: z.enum(["shower", "locker", "meeting_room", "coworking"]).optional(),
    sessionMinutes: z.number().int().min(1).max(480).optional(),
    cleaningMinutes: minuteCount.optional(),
    arrivalGraceMinutes: minuteCount.optional(),
    operatingHours: facilityHoursSchema.optional(),
    overtimePolicy: overtimePolicySchema.optional(),
    cancellationPolicy: cancellationPolicySchema.optional(),
  }),
);
export type UpdateFacilityInput = z.infer<typeof updateFacilitySchema>;

export const createFacilityAreaSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  name: z.string().trim().min(1).max(150),
  entranceLockDeviceId: uuidSchema.nullable().optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateFacilityAreaInput = z.infer<typeof createFacilityAreaSchema>;

export const updateFacilityAreaSchema = nonEmptyUpdate(
  clientInputSchema({
    name: z.string().trim().min(1).max(150).optional(),
    entranceLockDeviceId: uuidSchema.nullable().optional(),
    sortOrder: sortOrder.optional(),
  }),
);

export const createFacilityUnitSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
  code: z.string().trim().min(1).max(20),
  lockDeviceId: uuidSchema.nullable().optional(),
  panicDeviceId: uuidSchema.nullable().optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateFacilityUnitInput = z.infer<typeof createFacilityUnitSchema>;

export const createFacilityProductSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  name: z.string().trim().min(1).max(150),
  type: facilityProductTypeSchema,
  priceIdr: nonnegativeIdr,
  taxRuleId: uuidSchema.nullable().optional(),
  sessions: positiveInt.max(100),
  maxPerDay: positiveInt.max(10).nullable().optional(),
  menuItemId: uuidSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CreateFacilityProductInput = z.infer<
  typeof createFacilityProductSchema
>;

export const updateFacilityProductSchema = nonEmptyUpdate(
  clientInputSchema({
    name: z.string().trim().min(1).max(150).optional(),
    priceIdr: nonnegativeIdr.optional(),
    taxRuleId: uuidSchema.nullable().optional(),
    sessions: positiveInt.max(100).optional(),
    maxPerDay: positiveInt.max(10).nullable().optional(),
    menuItemId: uuidSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  }),
);

export const createFacilityAddonSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  name: z.string().trim().min(1).max(150),
  priceIdr: nonnegativeIdr,
  inventoryItemId: uuidSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: sortOrder.optional(),
});
export type CreateFacilityAddonInput = z.infer<
  typeof createFacilityAddonSchema
>;

export const updateFacilityAddonSchema = nonEmptyUpdate(
  clientInputSchema({
    name: z.string().trim().min(1).max(150).optional(),
    priceIdr: nonnegativeIdr.optional(),
    inventoryItemId: uuidSchema.nullable().optional(),
    isEnabled: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  }),
);

const entitlementRuleInputBase = {
  facilityId: facilityIdSchema,
  sessions: positiveInt.max(100),
  validity: entitlementValiditySchema,
  isEnabled: z.boolean(),
};

/**
 * PUT replaces one entitlement rule wholesale: the condition is required and
 * is fixed per type, so a rule cannot lose its threshold by accident.
 */
export const putEntitlementRuleSchema = z.discriminatedUnion("type", [
  clientInputSchema({
    ...entitlementRuleInputBase,
    type: z.literal("min_spend"),
    condition: z.strictObject({
      minSpendIdr: idrSchema.refine((value) => value > 0),
    }),
  }),
  clientInputSchema({
    ...entitlementRuleInputBase,
    type: z.literal("tier_benefit"),
    condition: z.strictObject({
      tierKeys: z.array(z.string().trim().min(1).max(30)).min(1).max(20),
    }),
  }),
  clientInputSchema({
    ...entitlementRuleInputBase,
    type: z.literal("package"),
    condition: z.strictObject({ menuItemId: uuidSchema }),
  }),
]);
export type PutEntitlementRuleInput = z.infer<typeof putEntitlementRuleSchema>;

export const createSubscriptionPlanSchema = clientInputSchema({
  facilityId: facilityIdSchema,
  name: z.string().trim().min(1).max(150),
  priceIdr: nonnegativeIdr,
  quotaPerPeriod: positiveInt.max(100),
  interval: subscriptionIntervalSchema,
  maxPerDay: positiveInt.max(10).nullable().optional(),
  providerPlanId: z.string().min(1).max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CreateSubscriptionPlanInput = z.infer<
  typeof createSubscriptionPlanSchema
>;

export const updateSubscriptionPlanSchema = nonEmptyUpdate(
  clientInputSchema({
    name: z.string().trim().min(1).max(150).optional(),
    priceIdr: nonnegativeIdr.optional(),
    quotaPerPeriod: positiveInt.max(100).optional(),
    interval: subscriptionIntervalSchema.optional(),
    maxPerDay: positiveInt.max(10).nullable().optional(),
    providerPlanId: z.string().min(1).max(100).nullable().optional(),
    isActive: z.boolean().optional(),
  }),
);

/** PUT replaces the Wi-Fi policy of a zone (FAC-14: applies without redeploy). */
export const putWifiPolicySchema = clientInputSchema({
  zoneId: uuidSchema,
  facilityId: facilityIdSchema.optional(),
  freeMinutes: minuteCount,
  peakFreeMinutes: minuteCount,
  spendPerExtraHourIdr: nonnegativeIdr,
  extraMinutes: z.number().int().min(1).max(1440),
  maxDevices: z.number().int().min(1).max(20),
  peakSchedule: z.array(peakWindowSchema).max(14),
  baseSpeedKbps: z.number().int().min(1).max(1_000_000),
  fullSpeedKbps: z.number().int().min(1).max(1_000_000),
  minSpendPerHourIdr: nonnegativeIdr.nullable(),
  tierBonusMinutes: z.record(z.string(), z.number().int().min(0).max(720)),
});
export type PutWifiPolicyInput = z.infer<typeof putWifiPolicySchema>;

export const wifiPolicyParamsSchema = z.strictObject({
  policyId: wifiPolicyIdSchema,
});

export const facilityConfigQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
});
