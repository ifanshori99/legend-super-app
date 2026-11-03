// Query keys and options of the tax recap screen. Hierarchical under
// "accounting-tax" so one invalidation refreshes every view of the reports.
import { queryOptions } from "@tanstack/react-query";
import { fetchTaxReports } from "./api";

export const taxKeys = {
  all: ["accounting-tax"] as const,
  reports: (legalEntityId: string) =>
    [...taxKeys.all, "reports", legalEntityId] as const,
};

/** All reports of one legal entity, every period (the screen groups them). */
export function taxReportsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: taxKeys.reports(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchTaxReports(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
    staleTime: 30 * 1000,
  });
}
