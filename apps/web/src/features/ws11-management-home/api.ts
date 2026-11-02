// Typed calls of the management home: one function per endpoint of the WS-11
// dashboard contract (`@starter/shared/dashboard`, PRD v1.7 §3.36). The
// response is unwrapped to the layout payload so components and query options
// never see the `{ data }` envelope.
import { callEndpoint } from "@/lib/api/endpoint";
import {
  getDashboardEndpoint,
  type DashboardQuery,
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
