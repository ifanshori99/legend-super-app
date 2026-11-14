// Tax and service-charge contracts (PRD v1.7 §3 item 14 "Pajak & Service
// Charge", F11, D13; §6.C `tax_rules` / `service_charge_rules`).
//
// Versioning model: a rule is identified by (outletId | tenant-wide, code).
// Every change is a new version row with its own effectiveFrom business date.
// Published versions are immutable; past transactions are corrected with an
// adjustment journal, never by rewriting a rule (PRD R21). A version with
// `isActive: false` is a tombstone: from its effective date the code no longer
// applies. Rates, increments and rounding modes are tenant data, never code.
//
// Price display (owner decision, 2026-11-01): menu prices EXCLUDE tax and
// service charge; both are added at checkout (QR web + POS). The tenant/outlet
// calculation setting `pricesIncludeTax: false` is the default; inclusive
// ("harga nett") stays an opt-in configuration, per tenant or per rule.

import {
  z,
  uuidIdSchema,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  roundingModeSchema,
} from "../core/index.ts";
import { channelSchema } from "../menu/schemas.ts";

export const taxRuleIdSchema = uuidIdSchema<"TaxRuleId">();
export const serviceChargeRuleIdSchema = uuidIdSchema<"ServiceChargeRuleId">();
export const taxSettingsIdSchema = uuidIdSchema<"TaxSettingsId">();
export type TaxRuleId = z.infer<typeof taxRuleIdSchema>;
export type ServiceChargeRuleId = z.infer<typeof serviceChargeRuleIdSchema>;
export type TaxSettingsId = z.infer<typeof taxSettingsIdSchema>;

/** Sales channel / order type (shared with price lists, menu contract). */
export const taxChannelSchema = channelSchema;
export type TaxChannel = z.infer<typeof taxChannelSchema>;

/**
 * What a sold line is, for tax purposes. F&B lines fall under PBJT makanan
 * dan/atau minuman; facility services (shower, room) may carry their own rule
 * (PRD §3.14 "Layanan fasilitas dapat memakai aturan pajak tersendiri").
 */
export const ITEM_TAX_CLASSES = ["food_beverage", "facility"] as const;
export const itemTaxClassSchema = z.enum(ITEM_TAX_CLASSES);
export type ItemTaxClass = z.infer<typeof itemTaxClassSchema>;

/** pbjt = Pajak Barang dan Jasa Tertentu (regional); ppn = VAT; other = any
 * further levy the tenant configures. Exempt = a rule with rateBp 0. */
export const taxTypeSchema = z.enum(["pbjt", "ppn", "other"]);
export type TaxType = z.infer<typeof taxTypeSchema>;

export const RULE_VERSION_STATUSES = [
  "draft",
  "published",
  "archived",
] as const;
export const ruleVersionStatusSchema = z.enum(RULE_VERSION_STATUSES);
export type RuleVersionStatus = z.infer<typeof ruleVersionStatusSchema>;

/** Stable rule identity across versions, e.g. "PBJT-FNB". */
export const ruleCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9][A-Z0-9_-]{1,39}$/,
    "Rule codes are 2-40 chars: A-Z, 0-9, _ and -",
  );
/** Region (wilayah) code: ISO 3166-2 province + BPS regency code, e.g.
 * "ID-JB-3273" for Kota Bandung. Null = every region. */
export const regionCodeSchema = z
  .string()
  .regex(/^ID-[A-Z]{2}(-\d{4})?$/, "Expected ID-<province>[-<BPS code>]");

const name = z.string().trim().min(1).max(150);
const versionMeta = {
  version: z.number().int().positive().safe(),
  effectiveFrom: businessDateSchema,
  status: ruleVersionStatusSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: userIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
};

function checkPublishedMeta(
  value: {
    status: RuleVersionStatus;
    publishedAt: string | null;
    publishedBy: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const published = value.status === "published";
  const hasAt = value.publishedAt !== null;
  const hasBy = value.publishedBy !== null;
  if (hasAt !== published || hasBy !== published)
    ctx.addIssue({
      code: "custom",
      path: ["publishedAt"],
      message:
        "publishedAt/publishedBy are set exactly when status is published",
    });
}

/** Which lines a tax rule covers. A line matches if its item, its category or
 * its tax class is listed; the most specific match wins (item > category >
 * class). At least one list must be non-empty. */
export const taxAppliesToSchema = z
  .strictObject({
    itemClasses: z.array(itemTaxClassSchema).max(ITEM_TAX_CLASSES.length),
    categoryIds: z.array(uuidSchema).max(500),
    itemIds: z.array(uuidSchema).max(2000),
  })
  .refine(
    (v) => v.itemClasses.length + v.categoryIds.length + v.itemIds.length > 0,
    {
      message: "A tax rule must apply to at least one class, category or item",
    },
  );
export type TaxAppliesTo = z.infer<typeof taxAppliesToSchema>;

const taxRuleFields = {
  name,
  taxType: taxTypeSchema,
  rateBp: basisPointsSchema,
  regionCode: regionCodeSchema.nullable(),
  /** Empty = every channel. */
  channels: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
  appliesTo: taxAppliesToSchema,
  /** Rule-level price mode: prices of covered items already include this tax
   * and the service charge ("harga nett") and the engine backs them out.
   * Created without it, a rule inherits the tenant/outlet setting
   * `pricesIncludeTax` (exclusive by default, owner decision 2026-11-01). */
  priceIncludesTax: z.boolean(),
  /** Service charge is part of the tax base (DPP) for this rule. */
  includeServiceInBase: z.boolean(),
  /** false = tombstone version that ends this code from effectiveFrom. */
  isActive: z.boolean(),
};

/** One version of a tax rule (§6.C `tax_rules`). */
export const taxRuleSchema = z
  .strictObject({
    id: taxRuleIdSchema,
    tenantId: tenantIdSchema,
    /** Null = tenant-wide; an outlet version overrides the tenant-wide code. */
    outletId: outletIdSchema.nullable(),
    code: ruleCodeSchema,
    ...taxRuleFields,
    ...versionMeta,
  })
  .superRefine(checkPublishedMeta);
export type TaxRule = z.infer<typeof taxRuleSchema>;

/** One version of a service-charge rule (§6.C `service_charge_rules`):
 * percentage per zone or order type (PRD §3.14 "Service Charge"). */
const serviceChargeRuleFields = {
  name,
  rateBp: basisPointsSchema,
  /** Null = any zone. */
  zoneId: uuidSchema.nullable(),
  /** Empty = every order type. */
  orderTypes: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
  /** Line classes the charge applies to (e.g. F&B only). */
  itemClasses: z.array(itemTaxClassSchema).min(1).max(ITEM_TAX_CLASSES.length),
  isActive: z.boolean(),
};
export const serviceChargeRuleSchema = z
  .strictObject({
    id: serviceChargeRuleIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    code: ruleCodeSchema,
    ...serviceChargeRuleFields,
    ...versionMeta,
  })
  .superRefine(checkPublishedMeta);
export type ServiceChargeRule = z.infer<typeof serviceChargeRuleSchema>;

/** Order of calculation (PRD §3.14 "Opsi Perhitungan"). v1 supports the PRD's
 * discount -> service charge -> tax; the enum leaves room for more. */
export const calculationOrderSchema = z.enum(["discount_service_tax"]);

/** How a mixed package price is split over its components before tax
 * (PRD §3.14 "Paket Campuran"; method pending tax consultant, A20). */
export const packageAllocationMethodSchema = z.enum([
  /** Each component carries a configured allocationBp (sum 10,000). */
  "fixed_bp",
  /** Pro rata to each component's standalone price. */
  "standalone_price_ratio",
]);
export type PackageAllocationMethod = z.infer<
  typeof packageAllocationMethodSchema
>;

const settingsFields = {
  calculationOrder: calculationOrderSchema,
  /**
   * Tenant/outlet default for menu display and new rules: prices already
   * include their tax and service charge ("harga nett"). Owner decision
   * (2026-11-01): false — menu prices exclude both and checkout adds them
   * (QR web + POS). True is the opt-in inclusive mode.
   */
  pricesIncludeTax: z.boolean(),
  /** Rounding of service charge to whole rupiah. */
  serviceRoundingMode: roundingModeSchema,
  /** Rounding of tax to whole rupiah (exclusive prices). */
  taxRoundingMode: roundingModeSchema,
  /** Rounding of the backed-out base for tax-inclusive prices; the tax is the
   * remainder so base + service + tax equals the price exactly. */
  inclusiveBaseRoundingMode: roundingModeSchema,
  /** Cash rounding of the bill total (orders.rounding_idr); null = none. */
  billRounding: z
    .strictObject({
      incrementIdr: z.number().int().positive().max(100_000),
      mode: roundingModeSchema,
    })
    .nullable(),
  packageAllocation: packageAllocationMethodSchema,
};
/** Versioned calculation options per tenant (outletId null) or outlet. */
export const taxSettingsSchema = z
  .strictObject({
    id: taxSettingsIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    ...settingsFields,
    ...versionMeta,
  })
  .superRefine(checkPublishedMeta);
export type TaxSettings = z.infer<typeof taxSettingsSchema>;

// ---- Calculation input / output ------------------------------------------

const nonNegativeIdr = idrSchema.refine((n) => n >= 0, "Must not be negative");

/** One component of a mixed package (e.g. Paket Sarapan + Shower). */
export const packageComponentSchema = z.strictObject({
  componentId: uuidSchema,
  itemId: uuidSchema,
  categoryId: uuidSchema.nullable(),
  itemClass: itemTaxClassSchema,
  /** Required for `fixed_bp`. */
  allocationBp: basisPointsSchema.nullable(),
  /** Required for `standalone_price_ratio`. */
  standalonePriceIdr: nonNegativeIdr.nullable(),
});
export type PackageComponent = z.infer<typeof packageComponentSchema>;

export const taxableLineSchema = z
  .strictObject({
    lineId: z.string().min(1).max(64),
    itemId: uuidSchema,
    categoryId: uuidSchema.nullable(),
    itemClass: itemTaxClassSchema,
    /** Unit price x quantity incl. modifiers, as shown on the menu. */
    grossIdr: nonNegativeIdr,
    /** Line-level discount. */
    discountIdr: nonNegativeIdr,
    /** Non-empty for a mixed package: tax is computed per component. */
    components: z.array(packageComponentSchema).max(20),
  })
  .refine((l) => l.discountIdr <= l.grossIdr, {
    path: ["discountIdr"],
    message: "Discount cannot exceed the line amount",
  })
  .refine((l) => l.components.length !== 1, {
    path: ["components"],
    message: "A package needs at least two components",
  });
export type TaxableLine = z.infer<typeof taxableLineSchema>;

/** Server-side calculation request (ORD-03: totals are always computed by the
 * server). The tenant comes from the trusted context, never from this body. */
export const taxCalculationInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    businessDate: businessDateSchema,
    channel: taxChannelSchema,
    zoneId: uuidSchema.nullable(),
    regionCode: regionCodeSchema.nullable(),
    lines: z.array(taxableLineSchema).min(1).max(500),
    /** Bill-level discount, spread over lines pro rata to their net amount. */
    orderDiscountIdr: nonNegativeIdr,
  })
  .refine(
    (v) =>
      v.orderDiscountIdr <=
      v.lines.reduce((sum, l) => sum + l.grossIdr - l.discountIdr, 0),
    {
      path: ["orderDiscountIdr"],
      message: "Order discount cannot exceed the bill",
    },
  )
  .refine(
    (v) => new Set(v.lines.map((l) => l.lineId)).size === v.lines.length,
    {
      path: ["lines"],
      message: "Line ids must be unique",
    },
  );
export type TaxCalculationInput = z.infer<typeof taxCalculationInputSchema>;

export const taxedLineSchema = z.strictObject({
  lineId: z.string(),
  componentId: uuidSchema.nullable(),
  itemId: uuidSchema,
  itemClass: itemTaxClassSchema,
  taxRuleId: taxRuleIdSchema,
  serviceChargeRuleId: serviceChargeRuleIdSchema.nullable(),
  grossIdr: idrSchema,
  /** Line discount + share of the order discount. */
  discountIdr: idrSchema,
  /** Sales amount excluding service charge and tax (DPP before service). */
  baseIdr: idrSchema,
  serviceChargeIdr: idrSchema,
  taxIdr: idrSchema,
  /** base + service + tax. */
  totalIdr: idrSchema,
});
export type TaxedLine = z.infer<typeof taxedLineSchema>;

export const taxSummarySchema = z.strictObject({
  taxRuleId: taxRuleIdSchema,
  code: ruleCodeSchema,
  version: z.number().int().positive(),
  taxType: taxTypeSchema,
  rateBp: basisPointsSchema,
  priceIncludesTax: z.boolean(),
  /** DPP: base, plus service charge when the rule includes it. */
  taxBaseIdr: idrSchema,
  taxIdr: idrSchema,
});
export type TaxSummary = z.infer<typeof taxSummarySchema>;

export const taxCalculationResultSchema = z.strictObject({
  settingsId: taxSettingsIdSchema,
  lines: z.array(taxedLineSchema),
  taxes: z.array(taxSummarySchema),
  grossIdr: idrSchema,
  discountIdr: idrSchema,
  baseIdr: idrSchema,
  serviceChargeIdr: idrSchema,
  taxIdr: idrSchema,
  /** Cash rounding line (orders.rounding_idr); never part of the tax base. */
  roundingIdr: idrSchema,
  totalIdr: idrSchema,
});
export type TaxCalculationResult = z.infer<typeof taxCalculationResultSchema>;

// ---- PBJT monthly recap (PRD §3.14 "Laporan Pajak") -----------------------

export const taxPeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

export const pbjtRecapRowSchema = z.strictObject({
  taxRuleCode: ruleCodeSchema,
  rateBp: basisPointsSchema,
  /**
   * Price mode of the sales in this row. Gross of an inclusive sale contains
   * its tax and gross of an exclusive sale does not, so the two are never
   * summed into one row (one row per rule, rate and price mode).
   */
  priceIncludesTax: z.boolean(),
  transactionCount: z.number().int().nonnegative(),
  grossSalesIdr: idrSchema,
  taxBaseIdr: idrSchema,
  serviceChargeIdr: idrSchema,
  taxIdr: idrSchema,
});
export const pbjtMonthlyRecapSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    period: taxPeriodSchema,
    regionCode: regionCodeSchema.nullable(),
    generatedAt: isoDateTimeSchema,
    rows: z.array(pbjtRecapRowSchema),
    totalTaxBaseIdr: idrSchema,
    totalTaxIdr: idrSchema,
  })
  .refine(
    (r) =>
      r.totalTaxIdr === r.rows.reduce((sum, row) => sum + row.taxIdr, 0) &&
      r.totalTaxBaseIdr ===
        r.rows.reduce((sum, row) => sum + row.taxBaseIdr, 0),
    { path: ["totalTaxIdr"], message: "Totals must equal the sum of rows" },
  );
export type PbjtMonthlyRecap = z.infer<typeof pbjtMonthlyRecapSchema>;

// ---- Write inputs (client) -------------------------------------------------

export { taxRuleFields, serviceChargeRuleFields, settingsFields };
