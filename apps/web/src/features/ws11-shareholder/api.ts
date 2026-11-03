// Typed calls of the shareholder dashboard (bead legend-ik9g). Layout and tile
// values follow the WS-11 dashboard contract (DASH-02: tile = source report
// run); the personal part follows the accounting profit-share contract (SH-01).
import { callEndpoint } from "@/lib/api/endpoint";
import {
  getMyProfitShare,
  listShareholderDocuments,
  type MyProfitShare,
  type ShareholderDocument,
} from "@starter/shared/accounting";
import {
  getDashboardEndpoint,
  runReportEndpoint,
  type DashboardLayout,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";

export async function fetchShareholderDashboard(
  signal?: AbortSignal,
): Promise<DashboardLayout> {
  const response = await callEndpoint(
    getDashboardEndpoint,
    { params: { dashboard: "shareholder" }, query: {} },
    { signal },
  );
  return response.data;
}

export async function runShareholderReport(
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

export async function fetchMyProfitShare(
  signal?: AbortSignal,
): Promise<MyProfitShare> {
  const response = await callEndpoint(getMyProfitShare, {}, { signal });
  return response.data;
}

export type DocumentsPage = {
  data: ShareholderDocument[];
  nextCursor: string | null;
};

export async function fetchShareholderDocuments(
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<DocumentsPage> {
  const response = await callEndpoint(
    listShareholderDocuments,
    { query: { limit: 20, ...(cursor ? { cursor } : {}) } },
    { signal },
  );
  return { data: response.data, nextCursor: response.meta.nextCursor };
}
