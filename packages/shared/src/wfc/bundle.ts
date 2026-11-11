// WFC bundles, e.g. "Pagi Produktif" = shower single + WFC day pass (PRD v1.7
// §3 F25/F39; bead legend-bz9h; money rules M1-M4).
//
// - The client never sends a price or an amount for a purchase:
//   `purchaseWfcBundleSchema` carries only the payment reference. The service
//   finds the captured POS tender itself (an order line for the bundle's menu
//   item), checks that it covers the price stored on the bundle and that no
//   other sale used it (M1).
// - A bundle price is a discount only: > 0 and <= sum(list price x quantity)
//   of its components, and at least `WFC_BUNDLE_MIN_PRICE_BP` of that sum (M3). `allocateBundlePrice` splits the price paid over
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
/** Bundle price floor in basis points of the component list total (5000 = 50%). */
export const WFC_BUNDLE_MIN_PRICE_BP = 5_000;

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
  /**
   * POS menu item the bundle is sold as. A bundle without one cannot be
   * purchased (the payment is proven by a POS tender for this menu item).
   */
  menuItemId: uuidSchema.optional(),
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
  /**
   * Reference of a captured payment (payment intent id or provider ref), unique
   * per tenant; a replay returns the first purchase.
   */
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
  menuItemId: uuidSchema.nullable(),
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
 * M3: lowest allowed bundle price for a component list total, rounded up to
 * the rupiah: ceil(total x WFC_BUNDLE_MIN_PRICE_BP / 10000).
 */
export function bundleMinPriceIdr(componentListTotalIdr: number): number {
  // Not a safe integer: no price can be proven to clear the floor, so none does.
  if (!Number.isSafeInteger(componentListTotalIdr))
    return Number.POSITIVE_INFINITY;
  // BigInt: total x bp can pass 2^53 even when the total itself is safe.
  const bp = BigInt(WFC_BUNDLE_MIN_PRICE_BP);
  return Number((BigInt(componentListTotalIdr) * bp + 9_999n) / 10_000n);
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
