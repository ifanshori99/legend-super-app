// Metric query route (PRD v1.7 §5 "Lapisan metrik baku", DASH-01/02, SH-01,
// SH-02; bead legend-cdta). Path and schemas are `queryMetricsEndpoint` from
// `@starter/shared/metrics`. Tenant comes from the server-minted context
// (TEN-02); the outlet reach of the permission that admitted the caller is the
// TEN-03 scope the service intersects with the requested outlets.
//
// Who may ask, tried in order:
// 1. `report.financial.view`: every metric, full splits;
// 2. `report.operational.view` / `report.sales.view`: non-money metrics only;
// 3. `report.aggregate.view` (shareholder): every metric as aggregates, never
//    split or filtered by a person (SH-01; enforced by the service).
// A permission granted at outlet or brand scope admits the caller for the
// outlets it reaches; a tenant grant reaches the whole tenant.
//
// Exported as a factory; app.ts mounts it at /api/metrics.

import { Router, type Request } from "express";
import {
  AccessError,
  outletReachOf,
  type PermissionCode,
} from "@starter/shared/access";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { reportMetricByCode } from "@starter/shared/dashboard";
import {
  parseMetricQueryParams,
  queryMetricsEndpoint,
} from "@starter/shared/metrics";
import { requireAuth, getAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import {
  type MetricViewer,
  queryMetrics,
} from "../services/metrics-query.service";
import { GL_METRIC_SOURCES } from "../services/metrics-gl-sources";
import { loadTenantAccess } from "../services/permission-resolver";

const BASE = "/api/metrics";

/** Money metrics: rupiah values or ratios computed from the ledger. */
function isMoneyMetric(code: string): boolean {
  const definition = reportMetricByCode.get(code);
  return definition?.unit === "idr" || code in GL_METRIC_SOURCES;
}

/** The caller's context for `permission`: tenant-wide, else its outlet reach. */
async function contextForReach(
  req: Request,
  permission: PermissionCode,
): Promise<ScopedTenantContext | null> {
  const snapshot = await loadRequestAccess(req);
  if (!snapshot.permissions.includes(permission)) return null;
  const tenantWide = snapshot.contextFor(permission, { type: "tenant" });
  if (tenantWide) return tenantWide;
  const tenant = getTenantContext(req);
  const userId = userIdSchema.parse(getAuth(req).user.id);
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userId,
  );
  const reach = outletReachOf({
    principal: {
      tenantId: tenant.tenantId,
      userId,
      assignments: data.assignments,
    },
    roles: data.roles,
    org: data.org,
    now: new Date(),
    permission,
  });
  return reach === null ? null : establishScopedTenantContext(tenant, reach);
}

async function resolveMetricViewer(
  req: Request,
  money: boolean,
): Promise<{ context: ScopedTenantContext; viewer: MetricViewer }> {
  const full: PermissionCode[] = money
    ? ["report.financial.view"]
    : ["report.financial.view", "report.operational.view", "report.sales.view"];
  for (const permission of full) {
    const context = await contextForReach(req, permission);
    if (context) return { context, viewer: "full" };
  }
  const aggregate = await contextForReach(req, "report.aggregate.view");
  if (aggregate) return { context: aggregate, viewer: "aggregate" };
  throw new AccessError(
    "PERMISSION_DENIED",
    "Akun Anda tidak dapat melihat metrik ini.",
  );
}

export function createMetricsRouter() {
  const router = Router();
  // Mounted outside apiRouter, so it applies apiRouter's no-store itself.
  router.use(noStore);

  router.get(
    queryMetricsEndpoint.path.slice(BASE.length),
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    async (req, res) => {
      const request = parseMetricQueryParams(
        req.query as Record<string, unknown>,
      );
      const { context, viewer } = await resolveMetricViewer(
        req,
        request.metricCodes.some(isMoneyMetric),
      );
      res.json(await queryMetrics(context, request, { viewer }));
    },
  );

  return router;
}
