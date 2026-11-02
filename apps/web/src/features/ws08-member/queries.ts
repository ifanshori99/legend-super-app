import { queryOptions } from "@tanstack/react-query";
import {
  fetchMemberFavorites,
  fetchMemberMissions,
  fetchMemberOverview,
  fetchMemberPoints,
  fetchMemberRewards,
  fetchMemberVisits,
  fetchMemberVouchers,
  MEMBER_PAGE_SIZE,
  type PageInput,
} from "./api";

// One namespace for everything the member PWA reads: a redemption invalidates
// `memberKeys.all`, a consent change only the overview.
export const memberKeys = {
  all: ["member"] as const,
  overview: () => [...memberKeys.all, "overview"] as const,
  points: (limit: number) => [...memberKeys.all, "points", limit] as const,
  rewards: () => [...memberKeys.all, "rewards"] as const,
  missions: () => [...memberKeys.all, "missions"] as const,
  vouchers: () => [...memberKeys.all, "vouchers"] as const,
  visits: (limit: number) => [...memberKeys.all, "visits", limit] as const,
  favorites: () => [...memberKeys.all, "favorites"] as const,
};

export function memberOverviewQuery() {
  return queryOptions({
    queryKey: memberKeys.overview(),
    queryFn: ({ signal }) => fetchMemberOverview(signal),
  });
}

export function memberPointsQuery(input: PageInput) {
  return queryOptions({
    queryKey: memberKeys.points(input.limit),
    queryFn: ({ signal }) => fetchMemberPoints(input, signal),
  });
}

export function memberRewardsQuery() {
  return queryOptions({
    queryKey: memberKeys.rewards(),
    queryFn: ({ signal }) => fetchMemberRewards(signal),
  });
}

export function memberMissionsQuery() {
  return queryOptions({
    queryKey: memberKeys.missions(),
    queryFn: ({ signal }) => fetchMemberMissions(signal),
  });
}

export function memberVouchersQuery() {
  return queryOptions({
    queryKey: memberKeys.vouchers(),
    queryFn: ({ signal }) => fetchMemberVouchers(signal),
  });
}

export function memberVisitsQuery(input: PageInput) {
  return queryOptions({
    queryKey: memberKeys.visits(input.limit),
    queryFn: ({ signal }) => fetchMemberVisits(input, signal),
  });
}

export function memberFavoritesQuery() {
  return queryOptions({
    queryKey: memberKeys.favorites(),
    queryFn: ({ signal }) => fetchMemberFavorites(signal),
  });
}

export const MEMBER_DEFAULT_PAGE = { limit: MEMBER_PAGE_SIZE } as const;
