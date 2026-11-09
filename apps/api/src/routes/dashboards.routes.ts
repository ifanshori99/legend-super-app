// Dashboard routes (WS-11 F11, bead legend-flb8f, absorbs legend-1ye3 and
// legend-5bjh; PRD v1.7 §3.34-3.36). Paths and schemas are the dashboard
// endpoints in `@starter/shared/dashboard`. Tenant comes from the server-minted
// context (TEN-02); the outlet reach of the permissions that admitted the
// caller is the TEN-03 scope the service intersects with the requested outlets.
//
// Who may open a dashboard: `dashboard.<kind>.view`. Which tiles they get: the
// ones whose permissions and source reports are open to them
// (`services/dashboard-run.service.ts`). A shareholder is admitted through
// `report.aggregate.view` and reads every figure as an aggregate (SH-01); the
// shareholder area never needs `dashboard.management.view` (legend-5bjh).
// Same viewer/scope resolution as the report run (routes/report-viewer.ts).
//
// Exported as a factory; app.ts mounts it at /api/dashboards.

import { Router } from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  getDashboardEndpoint,
  getDashboardFacilityScopeEndpoint,
  getDashboardQueueRowsEndpoint,
  getDashboardValuesEndpoint,
  type DashboardKind,
  type DashboardTile,
} from "@starter/shared/dashboard";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  admittedTiles,
  getDashboardFacilityScope,
  getDashboardLayout,
  getDashboardQueueRows,
  getDashboardValues,
  queueTileFor,
  viewerReportsOf,
} from "../services/dashboard-run.service";
import { reportHttpError } from "../services/report-run.service";
import { resolveViewer, type ViewerSource } from "./report-viewer";

const BASE = "/api/dashboards";
const route = (path: string) => path.slice(BASE.length) || "/";

/**
 * Express hands a repeated query key as an array but a single one as a string;
 * the contract wants an array either way, so one `outletIds=` is wrapped here.
 */
function queryOf(query: unknown): unknown {
  const raw = (query ?? {}) as Record<string, unknown>;
  return typeof raw.outletIds === "string"
    ? { ...raw, outletIds: [raw.outletIds] }
    : raw;
}

/** Context and viewer for a read over `tiles`; 403 when nothing is open. */
async function resolveTiles(
  req: Parameters<typeof resolveViewer>[0],
  dashboard: DashboardKind,
  tiles: readonly DashboardTile[],
) {
  const sources: ViewerSource[] = [
    {
      kind: "permission",
      anyOf: [`dashboard.${dashboard}.view` as PermissionCode],
    },
    ...viewerReportsOf(tiles).map((report): ViewerSource => ({
      kind: "report",
      report,
    })),
  ];
  return resolveViewer(req, sources);
}

export function createDashboardsRouter() {
  const router = Router();
  // Mounted outside apiRouter, so it applies apiRouter's no-store itself.
  router.use(noStore);
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  /** The dashboard's tiles the caller may see; 403 without the dashboard permission. */
  async function admit(
    req: Parameters<typeof resolveViewer>[0],
    dashboard: DashboardKind,
  ) {
    const { permissions } = await loadRequestAccess(req);
    if (!permissions.includes(`dashboard.${dashboard}.view` as PermissionCode))
      throw reportHttpError("REPORT_NOT_PERMITTED");
    return admittedTiles(dashboard, permissions);
  }

  // Fixed paths first so "/:dashboard" never shadows them.
  router.get(
    route(getDashboardFacilityScopeEndpoint.path),
    async (req, res) => {
      const query = getDashboardFacilityScopeEndpoint.query.parse(
        queryOf(req.query),
      );
      const { permissions } = await loadRequestAccess(req);
      const tile = queueTileFor("facility_units", permissions);
      if (tile === undefined) throw reportHttpError("REPORT_NOT_PERMITTED");
      const { context } = await resolveTiles(req, tile.dashboard, [tile]);
      res.json({ data: await getDashboardFacilityScope(context, query) });
    },
  );

  router.get(route(getDashboardQueueRowsEndpoint.path), async (req, res) => {
    const { queue } = getDashboardQueueRowsEndpoint.params.parse(req.params);
    const query = getDashboardQueueRowsEndpoint.query.parse(queryOf(req.query));
    const { permissions } = await loadRequestAccess(req);
    const tile = queueTileFor(queue, permissions);
    if (tile === undefined) throw reportHttpError("REPORT_NOT_PERMITTED");
    const { context } = await resolveTiles(req, tile.dashboard, [tile]);
    res.json({
      data: await getDashboardQueueRows(context, { queue, ...query }),
    });
  });

  router.get(route(getDashboardValuesEndpoint.path), async (req, res) => {
    const { dashboardCode } = getDashboardValuesEndpoint.params.parse(
      req.params,
    );
    const query = getDashboardValuesEndpoint.query.parse(queryOf(req.query));
    const tiles = await admit(req, dashboardCode);
    const { context, viewer } = await resolveTiles(req, dashboardCode, tiles);
    res.json({
      data: await getDashboardValues(context, {
        dashboard: dashboardCode,
        viewer,
        tiles,
        query,
      }),
    });
  });

  router.get(route(getDashboardEndpoint.path), async (req, res) => {
    const { dashboard } = getDashboardEndpoint.params.parse(req.params);
    const query = getDashboardEndpoint.query.parse(queryOf(req.query));
    const tiles = await admit(req, dashboard);
    const { context } = await resolveTiles(req, dashboard, tiles);
    res.json({
      data: await getDashboardLayout(context, {
        dashboard,
        tiles,
        outletIds: query.outletIds,
      }),
    });
  });

  return router;
}
