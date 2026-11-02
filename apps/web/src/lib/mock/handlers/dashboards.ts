// One mock for GET /api/dashboards/:dashboard. The owner, shareholder and
// management screens read the same endpoint with a different `dashboard`
// param, so each feature registers the layouts it serves here instead of
// calling registerMock itself (bead legend-jzud: one owner per endpoint).
//
// A request for a dashboard nobody registered fails honestly (404) rather than
// answering with another screen's layout.
import {
  getDashboardEndpoint,
  type DashboardKind,
  type DashboardLayout,
} from "@starter/shared/dashboard";
import { ApiError } from "../../api/errors.ts";
import { registerMock } from "../registry.ts";

export type DashboardMock = {
  readonly normal: DashboardLayout;
  /** Layout for `?mock=empty` when it differs from the normal one. */
  readonly empty?: DashboardLayout;
};

const dashboards = new Map<DashboardKind, DashboardMock>();

/** Registers one screen's dashboard layout (last registration wins for the kind). */
export function registerMockDashboard(
  kind: DashboardKind,
  mock: DashboardMock,
): void {
  dashboards.set(kind, mock);
}

registerMock(getDashboardEndpoint, ({ params, scenario }) => {
  const mock = dashboards.get(params.dashboard);
  if (mock === undefined)
    throw new ApiError(
      404,
      "NOT_FOUND",
      `Mock dashboard "${params.dashboard}" belum didaftarkan.`,
    );
  return {
    data: scenario === "empty" ? (mock.empty ?? mock.normal) : mock.normal,
  };
});
