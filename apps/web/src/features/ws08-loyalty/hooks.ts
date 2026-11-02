// The only way components touch loyalty data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getLoyaltyProgram,
  listLoyaltyTiers,
  listMissions,
  listRewards,
  type LoyaltyTier,
  type Mission,
  type Reward,
} from "@starter/shared/crm";
import * as api from "./api";
import {
  menuItemsQuery,
  missionsQuery,
  programQuery,
  rewardsQuery,
  tiersQuery,
} from "./queries";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function useInvalidateOnSuccess<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  endpoints: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate(endpoints);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

// ---- Reads ----------------------------------------------------------------

export const useProgram = () => useQuery(programQuery());

export const useTiers = () => useQuery(tiersQuery());

export const useRewards = (active?: "true" | "false") =>
  useQuery(rewardsQuery(active));

export const useMissions = (active?: "true" | "false") =>
  useQuery(missionsQuery(active));

export const useMenuItems = () => useQuery(menuItemsQuery());

// ---- Writes ---------------------------------------------------------------

export function useUpdateProgram() {
  return useInvalidateOnSuccess(api.saveProgram, [
    getLoyaltyProgram,
    listLoyaltyTiers,
  ]);
}

export function useCreateTier() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createTier>[0]) => api.createTier(body),
    [listLoyaltyTiers, getLoyaltyProgram],
  );
}

export function useUpdateTier() {
  return useInvalidateOnSuccess(
    (variables: {
      tierId: LoyaltyTier["id"];
      body: Parameters<typeof api.updateTier>[1];
    }) => api.updateTier({ tierId: variables.tierId }, variables.body),
    [listLoyaltyTiers, getLoyaltyProgram],
  );
}

export function useCreateReward() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createReward>[0]) => api.createReward(body),
    [listRewards],
  );
}

export function useUpdateReward() {
  return useInvalidateOnSuccess(
    (variables: {
      rewardId: Reward["id"];
      body: Parameters<typeof api.updateReward>[1];
    }) => api.updateReward({ rewardId: variables.rewardId }, variables.body),
    [listRewards],
  );
}

export function useCreateMission() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createMission>[0]) => api.createMission(body),
    [listMissions],
  );
}

export function useUpdateMission() {
  return useInvalidateOnSuccess(
    (variables: {
      missionId: Mission["id"];
      body: Parameters<typeof api.updateMission>[1];
    }) => api.updateMission({ missionId: variables.missionId }, variables.body),
    [listMissions],
  );
}
