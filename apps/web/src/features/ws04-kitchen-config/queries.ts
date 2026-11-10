// Query keys and options for kitchen config & analytics. Keys are
// hierarchical, so a save refreshes the rules and the pacing that depends on
// them without touching the serving-time report (docs/frontend.md). Every key
// carries the outlet, so switching outlet in the shell never shows another
// outlet's data. A null outlet (none selected) leaves the query disabled.
import { queryOptions, skipToken } from "@tanstack/react-query";
import type { OutletId } from "@starter/shared/core";
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

type Outlet = OutletId | null;

export const kitchenConfigKeys = {
  all: ["kitchen-config"] as const,
  outlet: (outletId: Outlet) =>
    [...kitchenConfigKeys.all, outletId ?? "none"] as const,
  stations: (outletId: Outlet) =>
    [...kitchenConfigKeys.outlet(outletId), "stations"] as const,
  menuStations: (outletId: Outlet) =>
    [...kitchenConfigKeys.outlet(outletId), "menu-stations"] as const,
  capacityRules: (outletId: Outlet) =>
    [...kitchenConfigKeys.outlet(outletId), "capacity-rules"] as const,
  pacing: (outletId: Outlet) =>
    [...kitchenConfigKeys.outlet(outletId), "pacing"] as const,
  serving: (outletId: Outlet, query: ServingSummaryQuery) =>
    [
      ...kitchenConfigKeys.outlet(outletId),
      "serving",
      query.group,
      query.startDate,
      query.endDate,
    ] as const,
  issues: (outletId: Outlet, query: OrderIssueQuery) =>
    [
      ...kitchenConfigKeys.outlet(outletId),
      "issues",
      query.type ?? "all",
      query.stationId ?? "all",
      query.cursor ?? "first",
      query.limit,
    ] as const,
};

export function kitchenStationsQuery(outletId: Outlet) {
  return queryOptions({
    queryKey: kitchenConfigKeys.stations(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchKitchenStations(outletId, signal)
      : skipToken,
    staleTime: 60_000,
  });
}

export function menuStationsQuery(outletId: Outlet) {
  return queryOptions({
    queryKey: kitchenConfigKeys.menuStations(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchMenuStations(outletId, signal)
      : skipToken,
    staleTime: 5 * 60_000,
  });
}

export function capacityRulesQuery(outletId: Outlet) {
  return queryOptions({
    queryKey: kitchenConfigKeys.capacityRules(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchCapacityRules(outletId, signal)
      : skipToken,
    staleTime: 60_000,
  });
}

export function pacingQuery(outletId: Outlet) {
  return queryOptions({
    queryKey: kitchenConfigKeys.pacing(outletId),
    queryFn: outletId
      ? ({ signal }) => fetchPacing(outletId, signal)
      : skipToken,
    staleTime: 30_000,
  });
}

export function servingTimeSummaryQuery(
  outletId: Outlet,
  query: ServingSummaryQuery,
  enabled = true,
) {
  return queryOptions({
    queryKey: kitchenConfigKeys.serving(outletId, query),
    queryFn: outletId
      ? ({ signal }) => fetchServingTimeSummary(outletId, query, signal)
      : skipToken,
    staleTime: 60_000,
    enabled,
  });
}

export function orderIssuesQuery(outletId: Outlet, query: OrderIssueQuery) {
  return queryOptions({
    queryKey: kitchenConfigKeys.issues(outletId, query),
    queryFn: outletId
      ? ({ signal }) => fetchOrderIssues(outletId, query, signal)
      : skipToken,
    staleTime: 30_000,
  });
}
