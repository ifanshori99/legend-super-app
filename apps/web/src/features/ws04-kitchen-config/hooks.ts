// Hooks are the only way components touch this feature's data; they own cache
// updates and invalidation (docs/frontend.md, "Custom hooks").
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OutletId } from "@starter/shared/core";
import {
  capacityRulesQuery,
  kitchenConfigKeys,
  kitchenStationsQuery,
  menuStationsQuery,
  orderIssuesQuery,
  pacingQuery,
  servingTimeSummaryQuery,
} from "./queries.ts";
import {
  saveCapacityRules,
  saveKitchenStations,
  type CapacityRulesBody,
} from "./api.ts";
import { kdsKeys } from "../ws04-kds/queries.ts";
import type { StationUpdate } from "./station-order.ts";
import type { OrderIssueQuery, ServingSummaryQuery } from "./api.ts";

// The outlet is the one the shell selected (useTenantContext().outlet); null
// leaves the query disabled.
type Outlet = OutletId | null;

export function useKitchenStations(outletId: Outlet) {
  return useQuery(kitchenStationsQuery(outletId));
}

export function useMenuStations(outletId: Outlet) {
  return useQuery(menuStationsQuery(outletId));
}

export function useCapacityRules(outletId: Outlet) {
  return useQuery(capacityRulesQuery(outletId));
}

export function usePacing(outletId: Outlet) {
  return useQuery(pacingQuery(outletId));
}

export function useServingTimeSummary(
  outletId: Outlet,
  query: ServingSummaryQuery,
  enabled = true,
) {
  return useQuery(servingTimeSummaryQuery(outletId, query, enabled));
}

export function useOrderIssues(outletId: Outlet, query: OrderIssueQuery) {
  return useQuery(orderIssuesQuery(outletId, query));
}

export function useUpdateCapacityRules(outletId: Outlet) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      stationId,
      rules,
    }: {
      stationId: string;
      rules: CapacityRulesBody["rules"];
    }) => {
      if (!outletId) throw new Error("No outlet selected");
      return saveCapacityRules(outletId, stationId, rules);
    },
    onSuccess: () =>
      // The pacing snapshot carries the active capacity per station; refresh
      // it together with the rules the user just replaced (KDS-05).
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: kitchenConfigKeys.capacityRules(outletId),
        }),
        queryClient.invalidateQueries({
          queryKey: kitchenConfigKeys.pacing(outletId),
        }),
      ]),
  });
}

export function useUpdateKitchenStations(outletId: Outlet) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stations: StationUpdate[]) => {
      if (!outletId) throw new Error("No outlet selected");
      return saveKitchenStations(outletId, stations);
    },
    // The saved order is what the KDS tabs and the capacity cards read too.
    onSuccess: (saved) => {
      queryClient.setQueryData(kitchenConfigKeys.stations(outletId), saved);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: kitchenConfigKeys.stations(outletId),
        }),
        // The KDS station tabs read the same order and active flags.
        queryClient.invalidateQueries({
          queryKey: kdsKeys.stations(outletId ?? undefined),
        }),
      ]);
    },
  });
}
