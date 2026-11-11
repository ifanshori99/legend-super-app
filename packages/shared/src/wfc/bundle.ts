// WFC bundles, e.g. "Pagi Produktif" = shower single + WFC day pass (PRD v1.7
// §3 F25/F39; bead legend-bz9h; money rules M1-M4).
//
// - The client never sends a price for a purchase: `purchaseWfcBundleSchema`
//   carries the amount the payment provider captured (`paidIdr`), and the
//   service compares it with the price stored on the bundle (M1).
// - A bundle price is a discount only: > 0 and <= sum(list price x quantity)
//   of its components (M3). `allocateBundlePrice` splits the price paid over
//   the components pro-rata (largest remainder), so the parts add up to the
//   rupiah (M3).
// Every input is strict: an unknown field is rejected, and the tenant comes
// from the domain or token, never from the body.

import {
  z,
  allocateIdr,
  clientInputSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  uuidSchema,
  type Idr,
} from "../core/index.ts";

export const wfcBundleStatusSchema = z.enum(["active", "inactive"]);
export type WfcBundleStatus = z.infer<typeof wfcBundleStatusSchema>;

export const wfcBundlePurchaseStatusSchema = z.enum(["paid", "refunded"]);
export type WfcBundlePurchaseStatus = z.infer<
  typeof wfcBundlePurchaseStatusSchema
>;

export const WFC_BUNDLE_MAX_ITEMS = 20;
/** Entitlement sessions of one grant stay within the ledger limit (1..100). */
export const WFC_BUNDLE_MAX_SESSIONS_PER_ITEM = 100;

const positiveIdr = idrSchema.refine((value) => value > 0);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const quantity = z.number().int().min(1).max(100);

// ---- Inputs -------------------------------------------------------------------

/** One component: a single-ticket product xor a subscription plan. */
export const wfcBundleItemInputSchema = z
  .strictObject({
    facilityId: uuidSchema,
    productId: uuidSchema.optional(),
    planId: uuidSchema.optional(),
    quantity,
  })
  .refine(
    (item) => (item.productId === undefined) !== (item.planId === undefined),
    {
      message: "A bundle item needs exactly one of productId and planId",
    },
  );
export type WfcBundleItemInput = z.infer<typeof wfcBundleItemInputSchema>;

export const createWfcBundleSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150),
  priceIdr: positiveIdr,
  /** Days the issued entitlements stay valid after the purchase. */
  validityDays: z.number().int().min(1).max(366).optional(),
  items: z.array(wfcBundleItemInputSchema).min(1).max(WFC_BUNDLE_MAX_ITEMS),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateWfcBundleInput = z.infer<typeof createWfcBundleSchema>;

export const listWfcBundlesQuerySchema = clientInputSchema({
  outletId: uuidSchema,
  status: wfcBundleStatusSchema.optional(),
});
export type ListWfcBundlesQuery = z.infer<typeof listWfcBundlesQuerySchema>;

export const purchaseWfcBundleSchema = clientInputSchema({
  bundleId: uuidSchema,
  customerProfileId: uuidSchema,
  /** Amount the payment provider captured; must equal the bundle price. */
  paidIdr: positiveIdr,
  /** Payment reference, unique per tenant; a replay returns the first purchase. */
  paymentRef: z.string().trim().min(1).max(64),
});
export type PurchaseWfcBundleInput = z.infer<typeof purchaseWfcBundleSchema>;

export const refundWfcBundleSchema = clientInputSchema({
  purchaseId: uuidSchema,
  refundIdr: positiveIdr,
});
export type RefundWfcBundleInput = z.infer<typeof refundWfcBundleSchema>;

// ---- Outputs ------------------------------------------------------------------

export const wfcBundleItemSchema = z.strictObject({
  id: uuidSchema,
  bundleId: uuidSchema,
  facilityId: uuidSchema,
  productId: uuidSchema.nullable(),
  planId: uuidSchema.nullable(),
  quantity,
});
export type WfcBundleItem = z.infer<typeof wfcBundleItemSchema>;

export const wfcBundleSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  name: z.string(),
  priceIdr: positiveIdr,
  validityDays: z.number().int().min(1).max(366),
  status: wfcBundleStatusSchema,
  items: z.array(wfcBundleItemSchema),
  createdAt: isoDateTimeSchema,
});
export type WfcBundle = z.infer<typeof wfcBundleSchema>;

export const wfcBundleAllocationSchema = z.strictObject({
  id: uuidSchema,
  purchaseId: uuidSchema,
  itemId: uuidSchema,
  allocatedIdr: nonnegativeIdr,
});
export type WfcBundleAllocation = z.infer<typeof wfcBundleAllocationSchema>;

export const wfcBundlePurchaseSchema = z.strictObject({
  id: uuidSchema,
  tenantId: uuidSchema,
  outletId: uuidSchema,
  bundleId: uuidSchema,
  customerProfileId: uuidSchema,
  pricePaidIdr: positiveIdr,
  refundedIdr: nonnegativeIdr,
  status: wfcBundlePurchaseStatusSchema,
  paymentRef: z.string(),
  allocations: z.array(wfcBundleAllocationSchema),
  createdAt: isoDateTimeSchema,
});
export type WfcBundlePurchase = z.infer<typeof wfcBundlePurchaseSchema>;

// ---- Money rules --------------------------------------------------------------

/**
 * M3: a bundle price is a discount only. True when 0 < price <= the sum of the
 * component list prices (`listPriceIdr x quantity`, summed by the caller).
 */
export function isValidBundlePrice(
  priceIdr: number,
  componentListTotalIdr: number,
): boolean {
  return (
    Number.isSafeInteger(priceIdr) &&
    Number.isSafeInteger(componentListTotalIdr) &&
    priceIdr > 0 &&
    priceIdr <= componentListTotalIdr
  );
}

/**
 * M3: splits the price paid over the components in proportion to their list
 * price x quantity (largest remainder), so the allocations add up to exactly
 * `pricePaidIdr`. One entry per weight, in the same order.
 */
export function allocateBundlePrice(
  pricePaidIdr: Idr,
  componentListTotalsIdr: readonly number[],
): Idr[] {
  return allocateIdr(pricePaidIdr, componentListTotalsIdr);
}
