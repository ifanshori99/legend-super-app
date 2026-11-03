// The only way components touch the audit log's data.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditFilters } from "./lib";
import { auditEventsInfiniteQuery, auditKeys } from "./queries";

export function useAuditEvents(filters: AuditFilters) {
  return useInfiniteQuery(auditEventsInfiniteQuery(filters));
}

/** Pull fresh pages (the toolbar's "Muat ulang"). */
export function useRefreshAudit() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: auditKeys.all });
}
