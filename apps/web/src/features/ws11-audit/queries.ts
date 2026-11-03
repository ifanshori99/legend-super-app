// Query keys and options of the audit log. Hierarchical under "ws11-audit" so
// one invalidation ("Muat ulang") refreshes every filtered list.
import { infiniteQueryOptions } from "@tanstack/react-query";
import { retryOnceOnServerError } from "@/lib/api/retry";
import { fetchAuditEvents } from "./api";
import { toQuery, type AuditFilters } from "./lib";

export const auditKeys = {
  all: ["ws11-audit"] as const,
  list: (filters: AuditFilters) => [...auditKeys.all, "list", filters] as const,
};

export function auditEventsInfiniteQuery(filters: AuditFilters) {
  return infiniteQueryOptions({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      fetchAuditEvents(toQuery(filters, pageParam), signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    retry: retryOnceOnServerError,
  });
}
