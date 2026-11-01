// Query keys and options of the Wi-Fi portal. Hierarchical under "wifi" so one
// invalidation refreshes the policy, the session and the WFC plans.
import { queryOptions } from "@tanstack/react-query";
import { fetchCurrentWifiSession, fetchWfcPlans, fetchWifiPolicy } from "./api";
import { WIFI_QUOTA_POLL_MS } from "./state.ts";

export const wifiKeys = {
  all: ["wifi"] as const,
  policy: (zoneId: string) => [...wifiKeys.all, "policy", zoneId] as const,
  session: () => [...wifiKeys.all, "session"] as const,
  plans: (facilityId: string) =>
    [...wifiKeys.all, "plans", facilityId] as const,
};

export function wifiPolicyQuery(zoneId: string) {
  return queryOptions({
    queryKey: wifiKeys.policy(zoneId),
    queryFn: ({ signal }) => fetchWifiPolicy(zoneId, signal),
  });
}

/**
 * Polled: FAC-12 wants the quota to rise within a minute of a paid
 * transaction, and the guest should see a spent quota turn into the base
 * speed without touching anything (FAC-13). Never fresh: the allowance is
 * live data, so returning to the tab re-reads it at once.
 */
export function currentWifiSessionQuery(enabled: boolean) {
  return queryOptions({
    queryKey: wifiKeys.session(),
    queryFn: ({ signal }) => fetchCurrentWifiSession(signal),
    enabled,
    staleTime: 0,
    refetchInterval: WIFI_QUOTA_POLL_MS,
  });
}

/** WFC monthly plans sold for one facility (PRD §3 "Produk WFC"). */
export function wfcPlansQuery(facilityId: string | undefined) {
  return queryOptions({
    queryKey: wifiKeys.plans(facilityId ?? "none"),
    queryFn: ({ signal }) => fetchWfcPlans(facilityId ?? "", signal),
    enabled: Boolean(facilityId),
  });
}
