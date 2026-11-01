// Custom hooks of the Wi-Fi portal: the only way components touch its data.
// Query keys, cache updates and invalidation live here (docs/frontend.md).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StartWifiSessionInput } from "@starter/shared/facility";
import { requestWifiSession } from "./api";
import {
  currentWifiSessionQuery,
  wfcPlansQuery,
  wifiKeys,
  wifiPolicyQuery,
} from "./queries";

export function useWifiPolicy(zoneId: string) {
  return useQuery(wifiPolicyQuery(zoneId));
}

export function useCurrentWifiSession(enabled: boolean) {
  return useQuery(currentWifiSessionQuery(enabled));
}

export function useWfcPlans(facilityId: string | undefined) {
  return useQuery(wfcPlansQuery(facilityId));
}

export function useStartWifiSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartWifiSessionInput) => requestWifiSession(input),
    onSuccess: (view) => {
      queryClient.setQueryData(wifiKeys.session(), view);
      return queryClient.invalidateQueries({ queryKey: wifiKeys.all });
    },
  });
}
