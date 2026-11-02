// Typed calls of the report viewer (WS-11 dashboard & report contract, bead
// legend-mmjb; PRD v1.7 §3 F36). Responses are unwrapped to their payload.
import { callEndpoint } from "@/lib/api/endpoint";
import {
  createReportExportEndpoint,
  getDashboardEndpoint,
  getReportEndpoint,
  getReportExportEndpoint,
  listReportExportsEndpoint,
  listReportsEndpoint,
  runReportEndpoint,
  type CreateReportExportInput,
  type DashboardLayout,
  type ReportCatalogPage,
  type ReportCatalogQuery,
  type ReportDefinition,
  type ReportExport,
  type ReportExportPage,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";

export async function fetchReportDefinition(
  reportCode: string,
  signal?: AbortSignal,
): Promise<ReportDefinition> {
  const response = await callEndpoint(
    getReportEndpoint,
    { params: { reportCode } },
    { signal },
  );
  return response.data;
}

export function fetchReportCatalog(
  query: ReportCatalogQuery,
  signal?: AbortSignal,
): Promise<ReportCatalogPage> {
  return callEndpoint(listReportsEndpoint, { query }, { signal });
}

/**
 * The management layout is where the contract exposes the outlet business date
 * and the caller's outlet scope; the viewer never guesses "today".
 */
export async function fetchBusinessScope(
  signal?: AbortSignal,
): Promise<DashboardLayout> {
  const response = await callEndpoint(
    getDashboardEndpoint,
    { params: { dashboard: "management" }, query: {} },
    { signal },
  );
  return response.data;
}

export async function runReport(
  input: ReportRunInput,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const response = await callEndpoint(
    runReportEndpoint,
    { body: input },
    { signal },
  );
  return response.data;
}

export async function createReportExport(
  input: CreateReportExportInput,
): Promise<ReportExport> {
  const response = await callEndpoint(createReportExportEndpoint, {
    body: input,
  });
  return response.data;
}

export async function fetchReportExport(
  reportExportId: string,
  signal?: AbortSignal,
): Promise<ReportExport> {
  const response = await callEndpoint(
    getReportExportEndpoint,
    { params: { reportExportId } },
    { signal },
  );
  return response.data;
}

export function fetchReportExports(
  limit: number,
  signal?: AbortSignal,
): Promise<ReportExportPage> {
  return callEndpoint(
    listReportExportsEndpoint,
    { query: { limit } },
    { signal },
  );
}
