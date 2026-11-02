// One typed caller per loyalty back-office endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Components never call these directly: they use
// the hooks in ./hooks.ts, which own cache keys and invalidation.
//
// The loyalty contract (bead legend-zk25) already ships these endpoints:
// getLoyaltyProgram / updateLoyaltyProgram, listLoyaltyTiers /
// createLoyaltyTier / updateLoyaltyTier, listRewards / createReward /
// updateReward and listMissions / createMission / updateMission. The reward
// form reads the menu catalog through the WS-03 contract so an item reward
// names a real menu item.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createLoyaltyTier as createTierEndpoint,
  createMission as createMissionEndpoint,
  createReward as createRewardEndpoint,
  getLoyaltyProgram,
  listLoyaltyTiers,
  listMissions,
  listRewards,
  updateLoyaltyProgram,
  updateLoyaltyTier as updateTierEndpoint,
  updateMission as updateMissionEndpoint,
  updateReward as updateRewardEndpoint,
} from "@starter/shared/crm";
import { listItems } from "@starter/shared/menu";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Program --------------------------------------------------------------

export async function fetchProgram(signal?: AbortSignal) {
  const response = await callEndpoint(getLoyaltyProgram, {}, { signal });
  return response.data;
}

export const saveProgram = (body: Body<typeof updateLoyaltyProgram>) =>
  callEndpoint(updateLoyaltyProgram, { body }).then(
    (response) => response.data,
  );

// ---- Tiers ----------------------------------------------------------------

export async function fetchTiers(signal?: AbortSignal) {
  const response = await callEndpoint(listLoyaltyTiers, {}, { signal });
  return response.data;
}

export const createTier = (body: Body<typeof createTierEndpoint>) =>
  callEndpoint(createTierEndpoint, { body }).then((response) => response.data);

export const updateTier = (
  params: Params<typeof updateTierEndpoint>,
  body: Body<typeof updateTierEndpoint>,
) =>
  callEndpoint(updateTierEndpoint, { params, body }).then(
    (response) => response.data,
  );

// ---- Rewards --------------------------------------------------------------

export async function fetchRewards(
  query: Query<typeof listRewards>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(listRewards, { query }, { signal });
  return response;
}

export const createReward = (body: Body<typeof createRewardEndpoint>) =>
  callEndpoint(createRewardEndpoint, { body }).then(
    (response) => response.data,
  );

export const updateReward = (
  params: Params<typeof updateRewardEndpoint>,
  body: Body<typeof updateRewardEndpoint>,
) =>
  callEndpoint(updateRewardEndpoint, { params, body }).then(
    (response) => response.data,
  );

// ---- Missions -------------------------------------------------------------

export async function fetchMissions(
  query: Query<typeof listMissions>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(listMissions, { query }, { signal });
  return response;
}

export const createMission = (body: Body<typeof createMissionEndpoint>) =>
  callEndpoint(createMissionEndpoint, { body }).then(
    (response) => response.data,
  );

export const updateMission = (
  params: Params<typeof updateMissionEndpoint>,
  body: Body<typeof updateMissionEndpoint>,
) =>
  callEndpoint(updateMissionEndpoint, { params, body }).then(
    (response) => response.data,
  );

// ---- Menu catalog (reward item picker) ------------------------------------

export async function fetchMenuItems(signal?: AbortSignal) {
  const response = await callEndpoint(
    listItems,
    { query: { limit: 100 } },
    { signal },
  );
  return response.data;
}
