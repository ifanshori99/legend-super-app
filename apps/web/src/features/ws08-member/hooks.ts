import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsentPurpose } from "@starter/shared/crm";
import { errorCode } from "@/features/ws01-login/flow";
import { useCurrentAuth } from "@/features/ws01-login/hooks";
import { MEMBER_PAGE_SIZE, requestRedemption, saveMemberConsent } from "./api";
import {
  memberFavoritesQuery,
  memberKeys,
  memberMissionsQuery,
  memberOverviewQuery,
  memberPointsQuery,
  memberRewardsQuery,
  memberVouchersQuery,
  memberVisitsQuery,
} from "./queries";

// Components only touch member data through these hooks; keys, cache updates
// and invalidation live here. Lists use `useQuery` (not suspense) so every
// section can show its own loading, empty and error states.

export type WhatsAppLinkState =
  | { status: "checking" }
  | { status: "error"; retry: () => void }
  | { status: "unlinked" }
  | { status: "linked" };

/**
 * Whether the signed-in member has a verified WhatsApp number (AUTH-07). A
 * visitor without a session gets "linked": the prompt would only lead to the
 * sign-in screen, and the member screens already handle that case themselves.
 */
export function useWhatsAppLink(): WhatsAppLinkState {
  const auth = useCurrentAuth();
  if (auth.isPending) return { status: "checking" };
  if (auth.isError) {
    return errorCode(auth.error) === "UNAUTHORIZED"
      ? { status: "linked" }
      : { status: "error", retry: () => void auth.refetch() };
  }
  return { status: auth.data.whatsAppVerified ? "linked" : "unlinked" };
}

export function useMemberOverview() {
  return useQuery(memberOverviewQuery());
}

/** First `limit` rows; "load more" raises the limit (cursor pagination under the hood). */
export function useMemberPoints(limit = MEMBER_PAGE_SIZE) {
  return useQuery(memberPointsQuery({ limit }));
}

export function useMemberRewards() {
  return useQuery(memberRewardsQuery());
}

export function useMemberMissions() {
  return useQuery(memberMissionsQuery());
}

export function useMemberVouchers() {
  return useQuery(memberVouchersQuery());
}

export function useMemberVisits(limit = MEMBER_PAGE_SIZE) {
  return useQuery(memberVisitsQuery({ limit }));
}

export function useMemberFavorites() {
  return useQuery(memberFavoritesQuery());
}

/**
 * LOY-03: one idempotency key per attempt, reused on retry, so a double tap or
 * a retried request never spends points twice. The mock enforces it like the
 * real API (unique per tenant).
 */
export function useRedeemReward() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      rewardId,
      idempotencyKey,
    }: {
      rewardId: string;
      idempotencyKey: string;
    }) => requestRedemption(rewardId, idempotencyKey),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: memberKeys.all }),
  });
}

export function useUpdateConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      purpose,
      granted,
      policyVersion,
    }: {
      purpose: ConsentPurpose;
      granted: boolean;
      policyVersion: string;
    }) => saveMemberConsent({ purpose, granted, policyVersion }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: memberKeys.overview() }),
  });
}
