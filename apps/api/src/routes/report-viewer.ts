// Who may read report data, shared by the report run/preview routes
// (routes/reports.routes.ts) and the metric query route
// (routes/metrics.routes.ts; WS-11, bead legend-svrzc). A metric is read under
// the permissions of its source report, so a metric query and a report run
// over the same metric admit the same callers for the same outlets.
//
// A permission granted at outlet or brand scope admits the caller for the
// outlets it reaches; a tenant grant reaches the whole tenant. The outlets of
// a read needing several permissions are the outlets all of them reach; an
// empty intersection is 403, never a tenant-wide read.

import type { Request } from "express";
import { outletReachOf, type PermissionCode } from "@starter/shared/access";
import {
  userIdSchema,
  type OutletScopeData,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  reportAcceptsAggregateView,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import { getAuth } from "../middleware/auth";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext } from "../middleware/tenant";
import { loadTenantAccess } from "../services/permission-resolver";
import type { MetricViewer } from "../services/metrics-query.service";
import { reportHttpError } from "../services/report-run.service";

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
    now: data.clock ?? new Date(),
    permission: permission as PermissionCode,
  });
}

/** Outlets both scopes reach; null when they share none. */
function intersectScopes(
  a: OutletScopeData,
  b: OutletScopeData,
): OutletScopeData | null {
  if (a.kind === "tenant") return b;
  if (b.kind === "tenant") return a;
  const reach = new Set<string>(b.outletIds);
  const outletIds = a.outletIds.filter((id) => reach.has(id));
  return outletIds.length === 0 ? null : { kind: "outlets", outletIds };
}

/**
 * Outlets every one of `permissions` reaches. `missing`: the caller holds one
 * of them with no reach at all; `empty`: each reaches outlets but no outlet is
 * reached by all (never widened to the tenant).
 */
async function commonScope(
  req: Request,
  permissions: readonly string[],
): Promise<OutletScopeData | "missing" | "empty"> {
  let common: OutletScopeData = { kind: "tenant" };
  for (const permission of permissions) {
    const scope = await scopeOf(req, permission);
    if (scope === null) return "missing";
    const next = intersectScopes(common, scope);
    if (next === null) return "empty";
    common = next;
  }
  return common;
}

/**
 * What admits a read: a catalog report (its rule below), or, for a metric
 * with no catalog source report, the first of `anyOf` the caller holds (viewer
 * `full`, no aggregate fallback).
 */
export type ViewerSource =
  | {
      kind: "report";
      report: ReportDefinition;
      /**
       * Q59: the aggregate fallback also applies though the report does not
       * accept the aggregate view. Set only for a request asking just the
       * total of `AGGREGATE_TOTAL_METRIC_CODES` metrics (no `groupBy`).
       */
      aggregateTotal?: boolean;
    }
  | { kind: "permission"; anyOf: readonly PermissionCode[] };

/**
 * Context and viewer for a read whose data comes from `sources`. Per source
 * report: the caller's outlets for the permissions it requires (viewer
 * `full`); when the caller lacks them, the `report.aggregate.view` reach, but
 * only for a report that accepts the aggregate view (SH-01,
 * `reportAcceptsAggregateView`) or a total-only metric source
 * (`aggregateTotal`, Q59). Otherwise 403. The read covers the outlets
 * every source allows, and is `aggregate` as soon as one source needed the
 * aggregate permission. An empty intersection is 403, never a tenant-wide
 * read.
 */
export async function resolveViewer(
  req: Request,
  sources: readonly ViewerSource[],
): Promise<{ context: ScopedTenantContext; viewer: MetricViewer }> {
  if (sources.length === 0) throw reportHttpError("REPORT_NOT_PERMITTED");
  let scope: OutletScopeData | null = { kind: "tenant" };
  let viewer: MetricViewer = "full";
  let aggregate: OutletScopeData | null | undefined;
  for (const source of sources) {
    let reach: OutletScopeData | null = null;
    if (source.kind === "permission") {
      for (const permission of source.anyOf) {
        reach = await scopeOf(req, permission);
        if (reach) break;
      }
    } else {
      const full = await commonScope(req, source.report.requiredPermissions);
      if (typeof full === "object") reach = full;
      else if (
        full === "missing" &&
        (source.aggregateTotal === true ||
          reportAcceptsAggregateView(source.report))
      ) {
        aggregate ??= await scopeOf(req, "report.aggregate.view");
        reach = aggregate;
        viewer = "aggregate";
      }
    }
    if (reach === null) throw reportHttpError("REPORT_NOT_PERMITTED");
    scope = intersectScopes(scope, reach);
    if (scope === null) throw reportHttpError("REPORT_NOT_PERMITTED");
  }
  return {
    context: establishScopedTenantContext(getTenantContext(req), scope),
    viewer,
  };
}

/** `resolveViewer` for reads whose metrics come from catalog reports. */
export function resolveReportViewer(
  req: Request,
  sources: readonly ReportDefinition[],
): Promise<{ context: ScopedTenantContext; viewer: MetricViewer }> {
  return resolveViewer(
    req,
    sources.map((report) => ({ kind: "report", report })),
  );
}
