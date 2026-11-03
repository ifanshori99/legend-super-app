// The only way components touch tax data: queries keep their endpoint keys,
// mutations invalidate the report list a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import type { generateTaxReport as generateTaxReportEndpoint } from "@starter/shared/accounting";
import type { EndpointInput } from "@starter/shared/api";
import * as api from "./api";
import { taxKeys, taxReportsQuery } from "./queries";

export type GenerateTaxReportBody = EndpointInput<
  typeof generateTaxReportEndpoint
>["body"];

/**
 * Generate/finalize/export need `accounting.tax_report.manage` (the API
 * re-checks). Fails closed without access in the route context, so a viewer
 * never sees an action the server would refuse.
 */
export function useCanManageTaxReports(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? holdsAny(context.access, ["accounting.tax_report.manage"])
    : false;
}

export function useTaxReports(legalEntityId: string | undefined) {
  return useQuery(taxReportsQuery(legalEntityId));
}

function useInvalidateReports(legalEntityId: string | undefined) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: taxKeys.reports(legalEntityId ?? "none"),
    });
}

export function useGenerateTaxReport(legalEntityId: string | undefined) {
  const invalidate = useInvalidateReports(legalEntityId);
  return useMutation({
    mutationFn: (body: GenerateTaxReportBody) => api.generateTaxReport(body),
    onSuccess: () => invalidate(),
  });
}

export function useFinalizeTaxReport(legalEntityId: string | undefined) {
  const invalidate = useInvalidateReports(legalEntityId);
  return useMutation({
    mutationFn: (taxReportId: string) => api.finalizeTaxReport(taxReportId),
    onSuccess: () => invalidate(),
  });
}

export function useExportTaxReport(legalEntityId: string | undefined) {
  const invalidate = useInvalidateReports(legalEntityId);
  return useMutation({
    mutationFn: (taxReportId: string) => api.exportTaxReport(taxReportId),
    onSuccess: () => invalidate(),
  });
}
