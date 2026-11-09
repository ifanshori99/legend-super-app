// Metric query route (PRD v1.7 §5 "Lapisan metrik baku", DASH-01/02, SH-01,
// SH-02; bead legend-cdta). Path and schemas are `queryMetricsEndpoint` from
// `@starter/shared/metrics`. Tenant comes from the server-minted context
// (TEN-02); the outlet reach of the permission that admitted the caller is the
// TEN-03 scope the service intersects with the requested outlets.
//
// Who may ask (bead legend-svrzc): the report-run rule (routes/report-viewer.ts)
// applied per metric to the catalog report that owns it
// (`definition.sourceReport`). Holding that report's permissions reads the
// metric in full on the outlets they reach; lacking them, `report.aggregate.view`
// reads it as aggregates (never split or filtered by a person, SH-01; enforced
// by the service) only when the source report accepts the aggregate view
// (`reportAcceptsAggregateView`). Otherwise 403 REPORT_NOT_PERMITTED. The query
// reads the outlets every metric allows; an empty intersection is 403, never a
// tenant-wide read.
// A code with no catalog source report (unknown code: the service answers 404)
// keeps the old rule without the aggregate fallback: money metrics need
// `report.financial.view`, others any of financial, operational or sales view.
//
// Exported as a factory; app.ts mounts it at /api/metrics.

import { Router } from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  reportByCode,
  reportMetricByCode,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import {
  parseMetricQueryParams,
  queryMetricsEndpoint,
} from "@starter/shared/metrics";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { requireTenantContext } from "../middleware/tenant";
import { queryMetrics } from "../services/metrics-query.service";
import { GL_METRIC_SOURCES } from "../services/metrics-gl-sources";
import { resolveViewer, type ViewerSource } from "./report-viewer";

const BASE = "/api/metrics";

/** Money metrics: rupiah values or ratios computed from the ledger. */
function isMoneyMetric(code: string): boolean {
  const definition = reportMetricByCode.get(code);
  return definition?.unit === "idr" || code in GL_METRIC_SOURCES;
}

/** Permissions for a metric with no catalog source report (no aggregate). */
const FALLBACK_MONEY: readonly PermissionCode[] = ["report.financial.view"];
const FALLBACK_OTHER: readonly PermissionCode[] = [
  "report.financial.view",
  "report.operational.view",
  "report.sales.view",
];

/** What admits each requested metric: its source report, once per report. */
function viewerSourcesOf(codes: readonly string[]): ViewerSource[] {
  const reports = new Map<string, ReportDefinition>();
  let fallback: readonly PermissionCode[] | null = null;
  for (const code of codes) {
    const reportCode = reportMetricByCode.get(code)?.sourceReport.reportCode;
    const report =
      reportCode === undefined ? undefined : reportByCode(reportCode);
    if (report !== undefined) reports.set(report.code, report);
    else if (isMoneyMetric(code)) fallback = FALLBACK_MONEY;
    else fallback ??= FALLBACK_OTHER;
  }
  const sources: ViewerSource[] = [...reports.values()].map((report) => ({
    kind: "report",
    report,
  }));
  if (fallback) sources.push({ kind: "permission", anyOf: fallback });
  return sources;
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
      const { context, viewer } = await resolveViewer(
        req,
        viewerSourcesOf(request.metricCodes),
      );
      res.json(await queryMetrics(context, request, { viewer }));
    },
  );

  return router;
}
