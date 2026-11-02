// Query keys and options for kitchen config & analytics. Keys are
// hierarchical, so a save refreshes the rules and the pacing that depends on
// them without touching the serving-time report (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import {
  fetchCapacityRules,
  fetchKitchenStations,
  fetchMenuStations,
  fetchOrderIssues,
  fetchPacing,
  fetchServingTimeSummary,
  type OrderIssueQuery,
  type ServingSummaryQuery,
} from "./api.ts";

export const kitchenConfigKeys = {
  all: ["kitchen-config"] as const,
  stations: () => [...kitchenConfigKeys.all, "stations"] as const,
  menuStations: () => [...kitchenConfigKeys.all, "menu-stations"] as const,
  capacityRules: () => [...kitchenConfigKeys.all, "capacity-rules"] as const,
  pacing: () => [...kitchenConfigKeys.all, "pacing"] as const,
  serving: (query: ServingSummaryQuery) =>
    [
      ...kitchenConfigKeys.all,
      "serving",
      query.group,
      query.startDate,
      query.endDate,
    ] as const,
  issues: (query: OrderIssueQuery) =>
    [
      ...kitchenConfigKeys.all,
      "issues",
      query.type ?? "all",
      query.stationId ?? "all",
      query.cursor ?? "first",
      query.limit,
    ] as const,
};

export function kitchenStationsQuery() {
  return queryOptions({
    queryKey: kitchenConfigKeys.stations(),
    queryFn: ({ signal }) => fetchKitchenStations(signal),
    staleTime: 60_000,
  });
}

export function menuStationsQuery() {
  return queryOptions({
    queryKey: kitchenConfigKeys.menuStations(),
    queryFn: ({ signal }) => fetchMenuStations(signal),
    staleTime: 5 * 60_000,
  });
}

export function capacityRulesQuery() {
  return queryOptions({
    queryKey: kitchenConfigKeys.capacityRules(),
    queryFn: ({ signal }) => fetchCapacityRules(signal),
    staleTime: 60_000,
  });
}

export function pacingQuery() {
  return queryOptions({
    queryKey: kitchenConfigKeys.pacing(),
    queryFn: ({ signal }) => fetchPacing(signal),
    staleTime: 30_000,
  });
}

export function servingTimeSummaryQuery(
  query: ServingSummaryQuery,
  enabled = true,
) {
  return queryOptions({
    queryKey: kitchenConfigKeys.serving(query),
    queryFn: ({ signal }) => fetchServingTimeSummary(query, signal),
    staleTime: 60_000,
    enabled,
  });
}

export function orderIssuesQuery(query: OrderIssueQuery) {
  return queryOptions({
    queryKey: kitchenConfigKeys.issues(query),
    queryFn: ({ signal }) => fetchOrderIssues(query, signal),
    staleTime: 30_000,
  });
}
