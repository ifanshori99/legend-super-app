// Query keys and options for the promo admin. Keyed by the endpoint id through
// `endpointQueryOptions`, so `invalidateQueries({ queryKey: [endpoint.id] })`
// refreshes every screen that reads the same rows.
import {
  getPromoStackingPolicy,
  getPromotionRoi,
  listLoyaltyTiers,
  listPromotions,
  listVouchers,
  type PromotionStatus,
  type VoucherStatus,
} from "@starter/shared/crm";
import { listItems } from "@starter/shared/menu";
import { endpointQueryOptions } from "@/lib/api/endpoint";

export const promotionsQuery = (status?: PromotionStatus) =>
  endpointQueryOptions(listPromotions, {
    query: status === undefined ? { limit: 100 } : { limit: 100, status },
  });

export const stackingPolicyQuery = () =>
  endpointQueryOptions(getPromoStackingPolicy);

export const vouchersQuery = (status?: VoucherStatus) =>
  endpointQueryOptions(listVouchers, {
    query: status === undefined ? { limit: 100 } : { limit: 100, status },
  });

export const roiQuery = (promotionId: string) =>
  endpointQueryOptions(getPromotionRoi, { params: { promotionId } });

/** Tiers a member condition can target (WS-08 loyalty contract). */
export const tiersQuery = () => endpointQueryOptions(listLoyaltyTiers);

/** Menu items for item/bundle conditions and benefits (WS-03 master menu). */
export const menuItemsQuery = () =>
  endpointQueryOptions(listItems, { query: { limit: 100 } });
