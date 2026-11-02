// Hooks are the only way components touch this feature's data; they own cache
// updates and invalidation (docs/frontend.md, "Custom hooks").
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  capacityRulesQuery,
  kitchenConfigKeys,
  kitchenStationsQuery,
  menuStationsQuery,
  orderIssuesQuery,
  pacingQuery,
  servingTimeSummaryQuery,
} from "./queries.ts";
import { saveCapacityRules, type CapacityRulesBody } from "./api.ts";
import type { OrderIssueQuery, ServingSummaryQuery } from "./api.ts";

export function useKitchenStations() {
  return useQuery(kitchenStationsQuery());
}

export function useMenuStations() {
  return useQuery(menuStationsQuery());
}

export function useCapacityRules() {
  return useQuery(capacityRulesQuery());
}

export function usePacing() {
  return useQuery(pacingQuery());
}

export function useServingTimeSummary(
  query: ServingSummaryQuery,
  enabled = true,
) {
  return useQuery(servingTimeSummaryQuery(query, enabled));
}

export function useOrderIssues(query: OrderIssueQuery) {
  return useQuery(orderIssuesQuery(query));
}

export function useUpdateCapacityRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      stationId,
      rules,
    }: {
      stationId: string;
      rules: CapacityRulesBody["rules"];
    }) => saveCapacityRules(stationId, rules),
    onSuccess: () =>
      // The pacing snapshot carries the active capacity per station; refresh
      // it together with the rules the user just replaced (KDS-05).
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: kitchenConfigKeys.capacityRules(),
        }),
        queryClient.invalidateQueries({
          queryKey: kitchenConfigKeys.pacing(),
        }),
      ]),
  });
}
