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
  createReportExportEndpoint,
  createSavedReportEndpoint,
  getReportExportEndpoint,
  listReportExportsEndpoint,
  listSavedReportsEndpoint,
  reportExportIdSchema,
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
  createReportExport,
  downloadReportExport,
  gateExport,
  getReportExport,
  listReportExports,
  savedExportQuery,
  type ExportSource,
} from "../services/report-exports.service";
import {
  createSavedReport,
  getOwnSavedReport,
  listSavedReports,
  updateSavedReport,
} from "../services/report-saved.service";
import { requestAccess, resolveReportViewer } from "./report-viewer";

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

  // ---- Exports (DASH-04) ------------------------------------------------------

  router.get(route(listReportExportsEndpoint.path), async (req, res) => {
    const query = listReportExportsEndpoint.query.parse(req.query);
    res.json(
      await listReportExports(getTenantContext(req), callerId(req), query),
    );
  });

  router.post(
    route(createReportExportEndpoint.path),
    jsonBody,
    async (req, res) => {
      // An unknown report code is a 404, not a schema error.
      const code = (req.body as { reportCode?: unknown } | undefined)
        ?.reportCode;
      if (typeof code === "string" && reportByCode(code) === undefined)
        throw reportHttpError("REPORT_NOT_FOUND");
      const input = createReportExportEndpoint.body.parse(req.body);
      let source: ExportSource;
      if (input.reportCode !== undefined) {
        const report = reportByCode(input.reportCode);
        if (report === undefined) throw reportHttpError("REPORT_NOT_FOUND");
        source = { kind: "report", report };
      } else {
        const saved = await getOwnSavedReport(
          tenantWide(req),
          callerId(req),
          input.savedReportId ?? "",
        );
        source = {
          kind: "saved",
          savedReportId: saved.id,
          name: saved.name,
          query: saved.query,
        };
        savedExportQuery(saved.query, input.query);
      }
      const { gate } = await gateExport(
        await requestAccess(req),
        source,
        input.format,
        input.query,
        "none",
      );
      const { job } = await createReportExport(
        getTenantContext(req),
        callerId(req),
        {
          source,
          format: input.format,
          query: input.query,
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        },
        gate,
      );
      res.status(202).json({ data: job });
    },
  );

  // The download path of `reportExportFileSchema`; before "/exports/:id".
  router.get("/exports/:reportExportId/file", async (req, res) => {
    const id = reportExportIdSchema.parse(req.params.reportExportId);
    const file = await downloadReportExport(await requestAccess(req), id);
    res
      .status(200)
      .set("Content-Type", file.contentType)
      .set("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .set("X-Content-Type-Options", "nosniff")
      .send(file.content);
  });

  router.get(route(getReportExportEndpoint.path), async (req, res) => {
    const { reportExportId } = getReportExportEndpoint.params.parse(req.params);
    res.json({
      data: await getReportExport(
        getTenantContext(req),
        callerId(req),
        reportExportId,
      ),
    });
  });
}
