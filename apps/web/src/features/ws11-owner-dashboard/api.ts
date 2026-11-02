// Typed calls of the owner dashboard (WS-11 dashboard & report contract,
// bead legend-mmjb). The screen reads the dashboard layout from
// GET /api/dashboards/owner and every tile value by running that tile's source
// report (DASH-02: a tile and the report it drills into cannot disagree).
// Responses are unwrapped to their payload.
import { callEndpoint } from "@/lib/api/endpoint";
import { listFeedback, type Feedback } from "@starter/shared/crm";
import {
  getDashboardEndpoint,
  runReportEndpoint,
  type DashboardLayout,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";

/** The owner dashboard layout: tiles, period, outlets (DASH-01). */
export async function fetchOwnerDashboard(
  signal?: AbortSignal,
): Promise<DashboardLayout> {
  const response = await callEndpoint(
    getDashboardEndpoint,
    { params: { dashboard: "owner" } },
    { signal },
  );
  return response.data;
}

/** Run one source report with the dashboard's period and outlet scope. */
export async function runOwnerReport(
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

/**
 * Latest customer ratings for the "Ulasan terbaru" tile queue (PRD §3 F34
 * "Operasional"). The dashboard contract has no queue payload yet, so this
 * reads the CRM feedback queue that already exists; complaints stay in the CRM
 * inbox and are not mixed into a rating list.
 */
export async function fetchLatestRatings(signal?: AbortSignal): Promise<Feedback[]> {
  const response = await callEndpoint(
    listFeedback,
    { query: { kind: "rating", limit: 3 } },
    { signal },
  );
  return response.data;
}
