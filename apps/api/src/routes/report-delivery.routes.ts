// Saved reports, export jobs and delivery schedules (WS-11 F12, bead
// legend-ay6e6). Registered by routes/reports.routes.ts before its
// "/:reportCode" route, behind the same requireAuth, requireTrustedOrigin and
// requireTenantContext. Paths and schemas are the endpoints in
// `@starter/shared/dashboard`.
//
// Who may save a query: a caller who may preview it (`builderQueryPermittedFor`
// and the outlet reach of every metric's source report, the same rule as
// POST /api/reports/builder/preview). Requested outlets outside that reach
// answer 403 OUTLET_OUT_OF_SCOPE before anything is stored.
import type { Request, Router } from "express";
import { outletIdsForQuery, userIdSchema } from "@starter/shared/core";
import {
  builderQueryPermittedFor,
  createSavedReportEndpoint,
  listSavedReportsEndpoint,
  reportByCode,
  reportMetricByCode,
  updateSavedReportEndpoint,
  type ReportBuilderQuery,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import { getAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext } from "../middleware/tenant";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { reportHttpError } from "../services/report-run.service";
import {
  createSavedReport,
  listSavedReports,
  updateSavedReport,
} from "../services/report-saved.service";
import { resolveReportViewer } from "./report-viewer";

const BASE = "/api/reports";
const route = (path: string) => path.slice(BASE.length) || "/";

const callerId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);
const tenantWide = (req: Request) =>
  establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });

/** Source reports of a builder query's metrics; 403 for an unknown source. */
export function builderSources(
  query: Pick<ReportBuilderQuery, "metricCodes">,
): ReportDefinition[] {
  const sources = new Map<string, ReportDefinition>();
  for (const metricCode of query.metricCodes) {
    const source = reportByCode(
      reportMetricByCode.get(metricCode)?.sourceReport.reportCode ?? "",
    );
    if (source === undefined) throw reportHttpError("REPORT_NOT_PERMITTED");
    sources.set(source.code, source);
  }
  return [...sources.values()];
}

/** 403 unless the caller may preview `query` over its requested outlets. */
async function assertQueryReadable(
  req: Request,
  query: ReportBuilderQuery,
): Promise<void> {
  const { permissions } = await loadRequestAccess(req);
  if (!builderQueryPermittedFor(query, permissions))
    throw reportHttpError("REPORT_NOT_PERMITTED");
  const { context } = await resolveReportViewer(req, builderSources(query));
  outletIdsForQuery(context.outletScope, query.outletIds);
}

export function registerReportDeliveryRoutes(router: Router): void {
  router.get(route(listSavedReportsEndpoint.path), async (req, res) => {
    const query = listSavedReportsEndpoint.query.parse(req.query);
    res.json(await listSavedReports(tenantWide(req), callerId(req), query));
  });

  router.post(
    route(createSavedReportEndpoint.path),
    jsonBody,
    async (req, res) => {
      const input = createSavedReportEndpoint.body.parse(req.body);
      await assertQueryReadable(req, input.query);
      res.status(201).json({
        data: await createSavedReport(tenantWide(req), callerId(req), input),
      });
    },
  );

  router.patch(
    route(updateSavedReportEndpoint.path),
    jsonBody,
    async (req, res) => {
      const { savedReportId } = updateSavedReportEndpoint.params.parse(
        req.params,
      );
      const patch = updateSavedReportEndpoint.body.parse(req.body);
      if (patch.query !== undefined)
        await assertQueryReadable(req, patch.query);
      res.json({
        data: await updateSavedReport(
          tenantWide(req),
          callerId(req),
          savedReportId,
          patch,
        ),
      });
    },
  );
}
