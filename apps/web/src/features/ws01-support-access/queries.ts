// Query keys and options for support access. Grant lists refetch on a slow
// poll so an expiry or an "end now" from another tab shows up.
import { queryOptions } from "@tanstack/react-query";
import { fetchOrgGrants, fetchPlatformGrants, fetchTenants } from "./api.ts";

export const supportAccessKeys = {
  all: ["support-access"] as const,
  platform: () => [...supportAccessKeys.all, "platform"] as const,
  org: () => [...supportAccessKeys.all, "org"] as const,
  tenants: () => [...supportAccessKeys.all, "tenants"] as const,
};

export function platformGrantsQuery() {
  return queryOptions({
    queryKey: supportAccessKeys.platform(),
    queryFn: ({ signal }) => fetchPlatformGrants(signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function orgGrantsQuery() {
  return queryOptions({
    queryKey: supportAccessKeys.org(),
    queryFn: ({ signal }) => fetchOrgGrants(signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function tenantsQuery() {
  return queryOptions({
    queryKey: supportAccessKeys.tenants(),
    queryFn: ({ signal }) => fetchTenants(signal),
    staleTime: 5 * 60_000,
  });
}
