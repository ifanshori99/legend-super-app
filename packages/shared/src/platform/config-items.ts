// Strict item schemas of the bundle sections whose domain has a codec
// (TEN-09, bead legend-tct8): tax_rules, service_charge_rules, zones,
// checklists, facilities, wifi_policies. They live here, not in config.ts, so
// `config-section-codecs.ts` can use them without an import cycle
// (config.ts -> config-codecs.ts -> codecs). Every item has a `key`;
// references to other rows are `*Key` fields (the importer resolves them),
// never ids. Field names must not match the identifier scan in config.ts.

import { basisPointsSchema, roundingModeSchema, z } from "../core/index.ts";
import {
  cancellationPolicySchema,
  entitlementRuleSchema,
  entitlementValiditySchema,
  facilityTypeSchema,
  facilityUnitStatusSchema,
  overtimePolicySchema,
  peakWindowSchema,
  subscriptionIntervalSchema,
} from "../facility/schemas.ts";
import { facilityHoursSchema } from "../facility/slots.ts";
import { checklistTemplateTypeSchema } from "../operations/schemas.ts";
import {
  paymentModeSchema,
  zoneHoursSchema,
  zoneStatusSchema,
} from "../qr-order/schemas.ts";
import {
  calculationOrderSchema,
  itemTaxClassSchema,
  packageAllocationMethodSchema,
  taxChannelSchema,
  taxTypeSchema,
} from "../tax/schemas.ts";

export const jsonObject = z.record(z.string(), z.json());
const UUID_SHAPE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Business key, never a row id: UUID-shaped keys are refused (TEN-09). */
export const itemKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/)
  .refine((key) => !UUID_SHAPE.test(key), "Item keys must not look like an id");
/** Lower-cased source outlet code; resolved to a target outlet by code. */
export const outletKeySchema = itemKey;
export const money = z.number().int().min(0);
export const minutes = z.number().int().min(0).max(1440);
export const sortOrder = z.number().int().min(0);
/** DB checks: sessions 1..100, per-day cap 1..10 (facility_products,
 * entitlement_rules, facility_subscription_plans). */
export const sessionCount = z.number().int().min(1).max(100);
export const maxPerDay = z.number().int().min(1).max(10).nullable();
export const shortName = z.string().trim().min(1).max(150);

export const taxItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    key: itemKey,
    kind: z.literal("rule"),
    /** null = tenant default rule. */
    outletKey: outletKeySchema.nullable(),
    code: z.string().min(1).max(40),
    name: shortName,
    taxType: taxTypeSchema,
    rateBp: basisPointsSchema,
    regionCode: z.string().min(1).max(20).nullable(),
    channels: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
    /** Tax classes only: category and menu-item targets are menu data and do
     * not travel, so a rule that covers no class cannot be exported. */
    appliesTo: z.strictObject({
      itemClasses: z
        .array(itemTaxClassSchema)
        .min(1)
        .max(itemTaxClassSchema.options.length),
    }),
    priceIncludesTax: z.boolean(),
    includeServiceInBase: z.boolean(),
    isActive: z.boolean(),
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("settings"),
    outletKey: outletKeySchema.nullable(),
    calculationOrder: calculationOrderSchema,
    pricesIncludeTax: z.boolean(),
    serviceRoundingMode: roundingModeSchema,
    taxRoundingMode: roundingModeSchema,
    inclusiveBaseRoundingMode: roundingModeSchema,
    billRounding: z
      .strictObject({
        incrementIdr: z.number().int().positive().max(100_000),
        mode: roundingModeSchema,
      })
      .nullable(),
    packageAllocation: packageAllocationMethodSchema,
  }),
]);

export const serviceChargeItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema.nullable(),
  code: z.string().min(1).max(40),
  name: shortName,
  rateBp: basisPointsSchema,
  /** Zone the charge is bound to (a `zones` item key); null = outlet-wide. */
  zoneKey: itemKey.nullable(),
  orderTypes: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
  itemClasses: z
    .array(itemTaxClassSchema)
    .min(1)
    .max(itemTaxClassSchema.options.length),
  isActive: z.boolean(),
});

export const zoneItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  name: shortName,
  paymentMode: paymentModeSchema,
  serviceChargeBp: basisPointsSchema,
  minimumSpendIdr: money,
  hours: z.array(zoneHoursSchema).max(50),
  status: zoneStatusSchema,
  sortOrder,
});

const checklistItemEntrySchema = z.strictObject({
  label: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(1000).nullable(),
  requiredEvidence: z.array(z.enum(["photo", "number", "signature"])).max(3),
});
export const checklistItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  name: shortName,
  type: checklistTemplateTypeSchema,
  /** Entries without ids; the importer mints fresh ones. */
  items: z.array(checklistItemEntrySchema).min(1).max(100),
  /** Shift and station references are dropped; the zone travels as a key. */
  schedule: z.strictObject({
    dueTime: z.iso.time({ precision: -1 }),
    zoneKey: itemKey.nullable(),
  }),
  /** Source role as a `roles` item key; null = any role. */
  roleKey: itemKey.nullable(),
});

/** Condition shape per entitlement type, from the facility contract. `package`
 * rules point at a menu item (not portable) and are refused in a bundle. */
const entitlementConditionSchemas = {
  min_spend: entitlementRuleSchema.options[0].shape.condition,
  tier_benefit: entitlementRuleSchema.options[1].shape.condition,
} as const;

export const facilityItemSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      key: itemKey,
      kind: z.literal("facility"),
      outletKey: outletKeySchema,
      name: shortName,
      type: facilityTypeSchema,
      sessionMinutes: z.number().int().min(1).max(480),
      cleaningMinutes: z.number().int().min(0).max(240),
      arrivalGraceMinutes: minutes,
      operatingHours: facilityHoursSchema,
      overtimePolicy: overtimePolicySchema,
      cancellationPolicy: cancellationPolicySchema,
    })
    .refine((item) => item.sessionMinutes + item.cleaningMinutes <= 720, {
      path: ["cleaningMinutes"],
      message: "sessionMinutes + cleaningMinutes must be at most 720",
    }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("area"),
    facilityKey: itemKey,
    name: shortName,
    sortOrder,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("unit"),
    facilityKey: itemKey,
    areaKey: itemKey,
    code: z.string().min(1).max(20),
    status: facilityUnitStatusSchema,
    sortOrder,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("product"),
    facilityKey: itemKey,
    name: shortName,
    type: z.enum(["single", "package_component", "subscription_plan"]),
    priceIdr: money,
    sessions: sessionCount,
    isActive: z.boolean(),
    /** A `tax_rules` rule key; null = default tax. */
    taxRuleKey: itemKey.nullable(),
    maxPerDay,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("addon"),
    facilityKey: itemKey,
    name: shortName,
    priceIdr: money,
    isEnabled: z.boolean(),
    sortOrder,
  }),
  z
    .strictObject({
      key: itemKey,
      kind: z.literal("entitlement"),
      facilityKey: itemKey,
      type: z.enum(["min_spend", "tier_benefit"]),
      condition: jsonObject,
      sessions: sessionCount,
      validity: entitlementValiditySchema,
      isEnabled: z.boolean(),
    })
    .superRefine((item, ctx) => {
      const result = entitlementConditionSchemas[item.type].safeParse(
        item.condition,
      );
      if (!result.success)
        ctx.addIssue({
          code: "custom",
          path: ["condition"],
          message: `Invalid condition for a ${item.type} entitlement`,
        });
    }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("subscription_plan"),
    facilityKey: itemKey,
    name: shortName,
    priceIdr: money,
    quotaPerPeriod: sessionCount,
    interval: subscriptionIntervalSchema,
    maxPerDay,
    isActive: z.boolean(),
  }),
]);

export const wifiPolicyItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  zoneKey: itemKey,
  facilityKey: itemKey.nullable(),
  freeMinutes: minutes,
  peakFreeMinutes: minutes,
  spendPerExtraHourIdr: money,
  extraMinutes: z.number().int().min(1).max(1440),
  maxDevices: z.number().int().min(1).max(20),
  peakSchedule: z.array(peakWindowSchema).max(14),
  baseSpeedKbps: z.number().int().min(1).max(1_000_000),
  fullSpeedKbps: z.number().int().min(1).max(1_000_000),
  minSpendPerHourIdr: money.nullable(),
  // Same 1-30 character tier keys as the facility domain (facility/schemas.ts).
  tierBonusMinutes: z.record(
    z.string().trim().min(1).max(30),
    z.number().int().min(0).max(720),
  ),
});
