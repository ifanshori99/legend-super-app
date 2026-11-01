// Domain events for loyalty and CRM, registered in the WS-00 catalog
// (packages/shared/src/events/catalog.ts). Envelopes follow the WS-00 event
// contract: ULID id, tenant, aggregate, sequence, actor, idempotency key.
// Points payloads carry the positive magnitude; the event name gives the
// direction (earned/reversed/redeemed/expired), so consumers never add signed
// numbers by mistake. `balanceAfter` is the customer's balance after the row.

import {
  z,
  uuidSchema,
  ulidIdSchema,
  idrSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import {
  eventEnvelopeSchema,
  eventCatalogEntrySchema,
} from "../events/index.ts";

const safeInt = (value: number) => Number.isSafeInteger(value);
const positivePointsSchema = z
  .number()
  .int()
  .refine(safeInt, "Points exceed the safe integer range")
  .refine((value) => value > 0, "Points are a positive magnitude");
const nonnegativePointsSchema = z
  .number()
  .int()
  .refine(safeInt, "Points exceed the safe integer range")
  .refine((value) => value >= 0, "Balance cannot be negative");
const positiveIdr = idrSchema.refine((value) => value > 0);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

export const crmEventNames = [
  "points.earned",
  "points.reversed",
  "points.redeemed",
  "points.expired",
  "tier.changed",
] as const;
export type CrmEventName = (typeof crmEventNames)[number];

export const pointsEarnedPayloadSchema = z.strictObject({
  customerProfileId: uuidSchema,
  points: positivePointsSchema,
  /** PRD §3.20: earn comes from a paid order, a mission, referral or birthday. */
  sourceType: z.enum(["order", "mission", "referral", "birthday"]),
  /** Order ids are ULIDs, mission/referral rows are UUIDs. */
  sourceId: z
    .union([uuidSchema, ulidIdSchema<"PointsEventSourceId">()])
    .nullable(),
  expiresAt: isoDateTimeSchema,
  liabilityIdr: positiveIdr,
  balanceAfter: nonnegativePointsSchema,
});
export type PointsEarnedPayload = z.infer<typeof pointsEarnedPayloadSchema>;

export const pointsReversedPayloadSchema = z.strictObject({
  customerProfileId: uuidSchema,
  /** Magnitude of the points removed by the refund (LOY-02). */
  points: positivePointsSchema,
  sourceType: z.literal("refund"),
  sourceId: z.union([uuidSchema, ulidIdSchema<"PointsEventSourceId">()]),
  /** The earn row this reversal cancels. */
  reversesLedgerId: ulidIdSchema<"PointLedgerEntryId">(),
  liabilityIdr: positiveIdr,
  balanceAfter: nonnegativePointsSchema,
});
export type PointsReversedPayload = z.infer<typeof pointsReversedPayloadSchema>;

export const pointsRedeemedPayloadSchema = z.strictObject({
  customerProfileId: uuidSchema,
  points: positivePointsSchema,
  rewardId: uuidSchema,
  redemptionId: uuidSchema,
  liabilityIdr: positiveIdr,
  balanceAfter: nonnegativePointsSchema,
});
export type PointsRedeemedPayload = z.infer<typeof pointsRedeemedPayloadSchema>;

export const pointsExpiredPayloadSchema = z.strictObject({
  customerProfileId: uuidSchema,
  points: positivePointsSchema,
  liabilityIdr: positiveIdr,
  balanceAfter: nonnegativePointsSchema,
});
export type PointsExpiredPayload = z.infer<typeof pointsExpiredPayloadSchema>;

export const tierChangedPayloadSchema = z.strictObject({
  customerProfileId: uuidSchema,
  fromTierId: uuidSchema.nullable(),
  toTierId: uuidSchema.nullable(),
  reason: z.enum(["evaluation", "manual"]),
  rollingSpendIdr: nonnegativeIdr,
  rollingVisits: z.number().int().nonnegative().refine(safeInt),
  changedAt: isoDateTimeSchema,
});
export type TierChangedPayload = z.infer<typeof tierChangedPayloadSchema>;

const payloadSchemas: Record<CrmEventName, z.ZodType> = {
  "points.earned": pointsEarnedPayloadSchema,
  "points.reversed": pointsReversedPayloadSchema,
  "points.redeemed": pointsRedeemedPayloadSchema,
  "points.expired": pointsExpiredPayloadSchema,
  "tier.changed": tierChangedPayloadSchema,
};

/** Payload schema for a CRM event name, or null for any other event. */
export function crmEventPayloadSchema(name: string): z.ZodType | null {
  return (payloadSchemas as Record<string, z.ZodType>)[name] ?? null;
}

export const crmEventCatalogEntries = crmEventNames.map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-08",
  }),
);

/**
 * An event envelope that must be one of the CRM events with a payload that
 * matches its registered schema.
 */
export const crmEventSchema = eventEnvelopeSchema.refine(
  (event) => {
    const schema = crmEventPayloadSchema(event.name);
    return schema !== null && schema.safeParse(event.payload).success;
  },
  {
    message: "CRM event name and payload must match a registered schema",
    path: ["payload"],
  },
);
