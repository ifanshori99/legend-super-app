import type { QueryClient } from "@tanstack/react-query";
import { currentAuthQuery } from "@/features/ws01-login/queries";
import { MEMBER_PAGE_SIZE } from "./api";
import {
  memberFavoritesQuery,
  memberMissionsQuery,
  memberOverviewQuery,
  memberPointsQuery,
  memberRewardsQuery,
  memberVouchersQuery,
  memberVisitsQuery,
} from "./queries";

// Route loaders preload into the query cache so SSR renders real data instead
// of skeletons. A failing secondary query is swallowed: the section shows its
// own error state and the rest of the page still renders.
const settle = (promise: Promise<unknown>) => promise.catch(() => undefined);

// The WhatsApp link prompt (legend-vnvg) reads the identity view; preloading it
// lets a linked member's first paint carry no prompt slot to collapse later.
const preloadCurrentAuth = (queryClient: QueryClient) =>
  settle(queryClient.ensureQueryData(currentAuthQuery()));

export function preloadMemberOverview(queryClient: QueryClient) {
  return Promise.all([
    preloadCurrentAuth(queryClient),
    settle(queryClient.ensureQueryData(memberOverviewQuery())),
    settle(queryClient.ensureQueryData(memberMissionsQuery())),
    settle(queryClient.ensureQueryData(memberRewardsQuery())),
    settle(queryClient.ensureQueryData(memberVouchersQuery())),
    settle(
      queryClient.ensureQueryData(
        memberVisitsQuery({ limit: MEMBER_PAGE_SIZE }),
      ),
    ),
    settle(queryClient.ensureQueryData(memberFavoritesQuery())),
  ]);
}

export function preloadMemberOverviewOnly(queryClient: QueryClient) {
  return Promise.all([
    preloadCurrentAuth(queryClient),
    settle(queryClient.ensureQueryData(memberOverviewQuery())),
  ]);
}

export function preloadMemberPoints(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(
      queryClient.ensureQueryData(
        memberPointsQuery({ limit: MEMBER_PAGE_SIZE }),
      ),
    ),
  ]);
}

export function preloadMemberVisits(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(
      queryClient.ensureQueryData(
        memberVisitsQuery({ limit: MEMBER_PAGE_SIZE }),
      ),
    ),
  ]);
}

export function preloadMemberMissions(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(queryClient.ensureQueryData(memberMissionsQuery())),
  ]);
}

export function preloadMemberRewards(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(queryClient.ensureQueryData(memberRewardsQuery())),
  ]);
}

export function preloadMemberVouchers(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(queryClient.ensureQueryData(memberVouchersQuery())),
  ]);
}

export function preloadMemberFavorites(queryClient: QueryClient) {
  return Promise.all([
    preloadMemberOverviewOnly(queryClient),
    settle(queryClient.ensureQueryData(memberFavoritesQuery())),
  ]);
}
