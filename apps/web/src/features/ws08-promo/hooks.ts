// The only way components touch promo data: queries keep their endpoint keys,
// mutations invalidate every endpoint whose rows a write can change.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getPromoStackingPolicy,
  getPromotionRoi,
  listPromotions,
  listVouchers,
  type Promotion,
  type PromotionStatus,
  type VoucherStatus,
} from "@starter/shared/crm";
import * as api from "./api";
import {
  menuItemsQuery,
  promotionsQuery,
  roiQuery,
  stackingPolicyQuery,
  tiersQuery,
  vouchersQuery,
} from "./queries";

function useInvalidateOnSuccess<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  endpoints: readonly AnyEndpoint[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all(
        endpoints.map((endpoint) =>
          queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
  });
}

// ---- Reads ----------------------------------------------------------------

export const usePromotions = (status?: PromotionStatus) =>
  useQuery(promotionsQuery(status));
export const useStackingPolicy = () => useQuery(stackingPolicyQuery());
export const useVouchers = (status?: VoucherStatus) =>
  useQuery(vouchersQuery(status));
export const useTiers = () => useQuery(tiersQuery());
export const useMenuItems = () => useQuery(menuItemsQuery());

/** ROI is one request per promotion (GET /api/promotions/:id/roi). */
export function usePromotionRois(promotions: readonly Promotion[]) {
  return useQueries({
    queries: promotions.map((promotion) => roiQuery(promotion.id)),
  });
}

// ---- Writes ---------------------------------------------------------------

export function useCreatePromotion() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createPromotion>[0]) =>
      api.createPromotion(body),
    [listPromotions, getPromotionRoi],
  );
}

export function useUpdatePromotion() {
  return useInvalidateOnSuccess(
    (variables: {
      promotionId: Promotion["id"];
      body: Parameters<typeof api.updatePromotion>[1];
    }) =>
      api.updatePromotion(
        { promotionId: variables.promotionId },
        variables.body,
      ),
    [listPromotions, getPromotionRoi],
  );
}

export function useSaveStackingPolicy() {
  return useInvalidateOnSuccess(api.saveStackingPolicy, [
    getPromoStackingPolicy,
  ]);
}

export function useIssueVoucher() {
  return useInvalidateOnSuccess(api.issueVoucher, [listVouchers]);
}

/** Read-only check: it changes nothing, so it invalidates nothing. */
export function useValidateVoucher() {
  return useMutation({ mutationFn: api.validateVoucher });
}
