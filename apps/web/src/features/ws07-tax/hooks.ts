// The only way components touch tax data: queries keep their endpoint keys,
// mutations invalidate the report list a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { generateTaxReport as generateTaxReportEndpoint } from "@starter/shared/accounting";
import type { EndpointInput } from "@starter/shared/api";
import * as api from "./api";
import { taxKeys, taxReportsQuery } from "./queries";

export type GenerateTaxReportBody = EndpointInput<
  typeof generateTaxReportEndpoint
>["body"];

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
