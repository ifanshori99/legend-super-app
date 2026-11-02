// Typed calls of the management home (WS-11 dashboard & report contract,
// `@starter/shared/dashboard`, PRD v1.7 §3.36). Responses are unwrapped to
// their payload so components and query options never see `{ data }`.
import { callEndpoint } from "@/lib/api/endpoint";
import {
  getDashboardEndpoint,
  runReportEndpoint,
  type DashboardQuery,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";

/**
 * The caller's management layout: tiles the server composed for the caller's
 * role and outlet scope, the business date the numbers describe, and the
 * outlets it actually queried (TEN-03, applied server-side).
 */
export async function fetchManagementLayout(
  query: DashboardQuery,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getDashboardEndpoint,
    { params: { dashboard: "management" }, query },
    { signal },
  );
  return response.data;
}

/**
 * One KPI tile's source report, run with the dashboard's period and outlets
 * (DASH-02: the tile and its drill-down read one result).
 */
export async function runManagementReport(
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
