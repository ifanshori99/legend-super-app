// The only way components touch the management home's data.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DashboardQuery, ReportRunInput } from "@starter/shared/dashboard";
import {
  kpiRunQuery,
  managementHomeKeys,
  managementLayoutQuery,
} from "./queries";

/**
 * Key used while no KPI tile is selected. The query stays disabled, so the
 * input is only there to keep the hook's key stable across role switches.
 */
const IDLE_KPI_RUN: ReportRunInput = {
  reportCode: "sales.daily",
  period: { startDate: "2026-01-01", endDate: "2026-01-01" },
  groupBy: [],
  filters: [],
  bucket: "total",
  limit: 1,
};

export function useManagementLayout(query: DashboardQuery = {}) {
  return useQuery(managementLayoutQuery(query));
}

/**
 * The selected role's KPI report run. Kept separate from the layout: a report
 * failure must not blank the page — the strip reports "no data" instead.
 */
export function useRoleKpiRun(input: ReportRunInput | null) {
  return useQuery({
    ...kpiRunQuery(input ?? IDLE_KPI_RUN),
    enabled: input !== null,
  });
}

/** Pull a fresh layout and KPI run (the toolbar's "Perbarui" action). */
export function useRefreshManagementHome() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: managementHomeKeys.all });
}
