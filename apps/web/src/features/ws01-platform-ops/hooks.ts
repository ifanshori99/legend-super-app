// The only way components touch platform data: queries keep endpoint keys,
// the package mutation invalidates every read a tenant change can affect.
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { platformEndpoints } from "@starter/shared/platform";
import * as api from "./api";
import type { ListAuditEventsQuery } from "./contract-gap";
import { listPlatformAuditEvents } from "./contract-gap";
import {
  packagesQuery,
  tenantQuery,
  tenantsQuery,
  usageQuery,
} from "./queries";

export const AUDIT_PAGE_SIZE = 20;

export const usePackages = () => useQuery(packagesQuery());
export const useTenants = () => useQuery(tenantsQuery());

export function useTenant(tenantId: string | null) {
  return useQuery({
    ...tenantQuery(tenantId ?? ""),
    enabled: tenantId !== null,
  });
}

export function useUsage(tenantId: string | null) {
  return useQuery({
    ...usageQuery(tenantId ?? ""),
    enabled: tenantId !== null,
  });
}

/** One usage read per tenant, for the fleet health tiles. */
export function useFleetUsage(tenantIds: readonly string[]) {
  return useQueries({
    queries: tenantIds.map((id) => usageQuery(id)),
  });
}

export function useSetTenantPackage(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.SetTenantPackageBody) =>
      api.setTenantPackage(tenantId, body),
    onSuccess: () =>
      Promise.all(
        [
          platformEndpoints.getTenant.id,
          platformEndpoints.listTenants.id,
          platformEndpoints.getTenantUsage.id,
          listPlatformAuditEvents.id,
        ].map((id) => queryClient.invalidateQueries({ queryKey: [id] })),
      ),
  });
}

export type AuditFilters = Omit<ListAuditEventsQuery, "cursor" | "limit">;

/** Cursor-paginated audit list (D-CORE-5): pages append, filters reset. */
export function useAuditEvents(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: [listPlatformAuditEvents.id, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.fetchAuditPage(
        { ...filters, limit: AUDIT_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Debounces free-text filters so typing does not fire a request per key. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
