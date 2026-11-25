// Brief 1270 W1: a WFC product is never a promo reward. A reward would hand out
// a seat and menu credit without payment, so every promo door (save, evaluate,
// redeem) refuses it, whatever the status of the promotion.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { Promotion } from "@starter/shared/crm";
import { facilityProducts } from "../db/schema/facility.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./facility-shared.ts";

/** The ids among `productIds` that are WFC products of the tenant. */
export async function wfcProductIds(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  productIds: readonly string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: facilityProducts.id })
    .from(facilityProducts)
    .where(
      and(
        eq(facilityProducts.tenantId, tenantId),
        isNotNull(facilityProducts.wfcKind),
        inArray(facilityProducts.id, [...new Set(productIds)]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export const wfcProductNotReward = () =>
  new HttpError(
    409,
    "WFC_PRODUCT_NOT_REWARD",
    "Produk WFC tidak bisa dijadikan hadiah promo.",
  );

/** Throws WFC_PRODUCT_NOT_REWARD when the benefit grants a WFC product. */
export async function assertPromoBenefitNotWfc(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  benefit: Promotion["benefit"],
): Promise<void> {
  if (benefit.kind !== "facility_entitlement") return;
  if ((await wfcProductIds(tx, tenantId, [benefit.facilityProductId])).size > 0)
    throw wfcProductNotReward();
}
