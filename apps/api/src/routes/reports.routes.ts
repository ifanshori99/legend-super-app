// Report catalog, run and builder preview routes (WS-11 foundation, bead
// legend-5wzoc; design §2.6). Paths and schemas are the endpoints in
// `@starter/shared/dashboard`. Tenant comes from the server-minted context
// (TEN-02); the outlet reach of the permissions that admitted the caller is the
// TEN-03 scope the service intersects with the requested outlets.
//
// Who may open a report (`reportPermittedFor`): every permission the report
// requires (viewer `full`), or `report.aggregate.view` for an aggregate report
// (viewer `aggregate`, never split by a person, SH-01). A permission granted at
// outlet or brand scope admits the caller for the outlets it reaches; the scope
// of a report needing several permissions is the outlets all of them reach.
// Same resolution as routes/metrics.routes.ts.
//
// Exported as a factory; app.ts mounts it at /api/reports.

import { Router, type Request } from "express";
import { outletReachOf, type PermissionCode } from "@starter/shared/access";
import {
  userIdSchema,
  type OutletScopeData,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  aggregateOnlyCaller,
  builderQueryPermittedFor,
  getReportEndpoint,
  listReportsEndpoint,
  previewReportBuilderEndpoint,
  reportByCode,
  reportMetricByCode,
  reportPermittedFor,
  runReportEndpoint,
  selectionContainsPersonalData,
} from "@starter/shared/dashboard";
import { jsonBody } from "../middleware/body";
import { requireAuth, getAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { loadTenantAccess } from "../services/permission-resolver";
import type { MetricViewer } from "../services/metrics-query.service";
import {
  getReportDefinition,
  listReportCatalog,
  previewReport,
  reportHttpError,
  runReport,
} from "../services/report-run.service";

const BASE = "/api/reports";
const route = (path: string) => path.slice(BASE.length) || "/";

/** The caller's outlet reach for `permission`, null when it grants none. */
async function scopeOf(
  req: Request,
  permission: string,
): Promise<OutletScopeData | null> {
  const snapshot = await loadRequestAccess(req);
  if (!snapshot.permissions.includes(permission as PermissionCode)) return null;
  if (snapshot.contextFor(permission as PermissionCode, { type: "tenant" }))
    return { kind: "tenant" };
  const tenant = getTenantContext(req);
  const userId = userIdSchema.parse(getAuth(req).user.id);
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userId,
  );
  return outletReachOf({
    principal: {
      tenantId: tenant.tenantId,
      userId,
      assignments: data.assignments,
    },
    roles: data.roles,
    org: data.org,
    now: new Date(),
    permission: permission as PermissionCode,
  });
}

/** Outlets every one of `permissions` reaches; null when one reaches none. */
async function commonScope(
  req: Request,
  permissions: readonly string[],
): Promise<OutletScopeData | null> {
  let common: OutletScopeData = { kind: "tenant" };
  for (const permission of permissions) {
    const scope = await scopeOf(req, permission);
    if (scope === null) return null;
    if (scope.kind === "tenant") continue;
    if (common.kind === "tenant") {
      common = scope;
      continue;
    }
    const reach = new Set<string>(scope.outletIds);
    const outletIds = common.outletIds.filter((id) => reach.has(id));
    if (outletIds.length === 0) return null;
    common = { kind: "outlets", outletIds };
  }
  return common;
}

/**
 * Context and viewer for a query whose metrics live in reports needing
 * `required`: `full` when the caller holds them all, else the aggregate
 * permission (the caller was already admitted by `reportPermittedFor`).
 */
async function resolveReportViewer(
  req: Request,
  required: readonly string[],
): Promise<{ context: ScopedTenantContext; viewer: MetricViewer }> {
  const tenant = getTenantContext(req);
  const full = await commonScope(req, required);
  if (full !== null)
    return {
      context: establishScopedTenantContext(tenant, full),
      viewer: "full",
    };
  const aggregate = await scopeOf(req, "report.aggregate.view");
  if (aggregate === null) throw reportHttpError("REPORT_NOT_PERMITTED");
  return {
    context: establishScopedTenantContext(tenant, aggregate),
    viewer: "aggregate",
  };
}

export function createReportsRouter() {
  const router = Router();
  // Mounted outside apiRouter, so it applies apiRouter's no-store itself.
  router.use(noStore);
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.get(route(listReportsEndpoint.path), async (req, res) => {
    const query = listReportsEndpoint.query.parse(req.query);
    const { permissions } = await loadRequestAccess(req);
    res.json(listReportCatalog({ permissions }, query));
  });

  router.post(route(runReportEndpoint.path), jsonBody, async (req, res) => {
    // An unknown code is a 404, not a schema error: look before parsing.
    const code = (req.body as { reportCode?: unknown } | undefined)?.reportCode;
    const report = typeof code === "string" ? reportByCode(code) : undefined;
    if (report === undefined) throw reportHttpError("REPORT_NOT_FOUND");
    const { permissions } = await loadRequestAccess(req);
    if (!reportPermittedFor(report, permissions))
      throw reportHttpError("REPORT_NOT_PERMITTED");
    const input = runReportEndpoint.body.parse(req.body);
    if (
      aggregateOnlyCaller(permissions) &&
      selectionContainsPersonalData(input)
    )
      throw reportHttpError("REPORT_NOT_PERMITTED");
    const { context, viewer } = await resolveReportViewer(
      req,
      report.requiredPermissions,
    );
    res.json({ data: await runReport(context, input, { viewer }) });
  });

  router.post(
    route(previewReportBuilderEndpoint.path),
    jsonBody,
    async (req, res) => {
      const query = previewReportBuilderEndpoint.body.parse(req.body);
      const { permissions } = await loadRequestAccess(req);
      if (!builderQueryPermittedFor(query, permissions))
        throw reportHttpError("REPORT_NOT_PERMITTED");
      // Every metric's source report must be open to the caller; the viewer
      // is full only when the caller holds what all of them require.
      const required = new Set<string>();
      for (const metricCode of query.metricCodes) {
        const source = reportByCode(
          reportMetricByCode.get(metricCode)?.sourceReport.reportCode ?? "",
        );
        for (const permission of source?.requiredPermissions ?? [])
          required.add(permission);
      }
      const { context, viewer } = await resolveReportViewer(req, [...required]);
      res.json({ data: await previewReport(context, query, { viewer }) });
    },
  );

  // Registered last so "/:reportCode" never shadows a fixed path.
  router.get(route(getReportEndpoint.path), async (req, res) => {
    const { permissions } = await loadRequestAccess(req);
    res.json({
      data: getReportDefinition({ permissions }, String(req.params.reportCode)),
    });
  });

  return router;
}
