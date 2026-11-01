// Query keys and options for the loyalty back office. Keyed by the endpoint id
// through `endpointQueryOptions`, so `invalidateQueries({ queryKey:
// [endpoint.id] })` refreshes every screen that reads the same rows.
import { queryOptions } from "@tanstack/react-query";
import {
  getLoyaltyProgram,
  listLoyaltyTiers,
  listMissions,
  listRewards,
} from "@starter/shared/crm";
import { listItems } from "@starter/shared/menu";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { fetchMenuItems } from "./api";

export const programQuery = () => endpointQueryOptions(getLoyaltyProgram);

export const tiersQuery = () => endpointQueryOptions(listLoyaltyTiers);

export const rewardsQuery = (active?: "true" | "false") =>
  endpointQueryOptions(listRewards, {
    query: active === undefined ? { limit: 100 } : { limit: 100, active },
  });

export const missionsQuery = (active?: "true" | "false") =>
  endpointQueryOptions(listMissions, {
    query: active === undefined ? { limit: 100 } : { limit: 100, active },
  });

/** Menu items a reward can be tied to (WS-03 master menu). */
export const menuItemsQuery = () =>
  queryOptions({
    queryKey: [listItems.id, "loyalty-picker"],
    queryFn: ({ signal }) => fetchMenuItems(signal),
  });
