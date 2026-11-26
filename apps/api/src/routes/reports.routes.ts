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
// Same resolution as routes/metrics.routes.ts (routes/report-viewer.ts).
//
// Exported as a factory; app.ts mounts it at /api/reports.

import { Router } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  aggregateOnlyCaller,
  builderQueryPermittedFor,
  getReportEndpoint,
  listReportScheduleRecipientsEndpoint,
  listReportsEndpoint,
  previewReportBuilderEndpoint,
  reportByCode,
  reportCatalog,
  reportMetricByCode,
  reportPermittedFor,
  runReportEndpoint,
  selectionContainsPersonalData,
  type ReportDefinition,
} from "@starter/shared/dashboard";
import { jsonBody } from "../middleware/body";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { listReportScheduleRecipients } from "../services/report-schedule-recipients.service";
import {
  getReportDefinition,
  listReportCatalog,
  previewReport,
  reportHttpError,
  runReport,
} from "../services/report-run.service";
import { registerReportDeliveryRoutes } from "./report-delivery.routes";
import { resolveReportViewer } from "./report-viewer";

const BASE = "/api/reports";
const route = (path: string) => path.slice(BASE.length) || "/";

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

  // A fixed path, registered before "/:reportCode". Only a caller who may open
  // at least one report may list people to send one to; the list is the
  // caller's own tenant, name and role only (the server resolves emails).
  router.get(
    route(listReportScheduleRecipientsEndpoint.path),
    async (req, res) => {
      const query = listReportScheduleRecipientsEndpoint.query.parse(req.query);
      const { permissions } = await loadRequestAccess(req);
      if (
        !reportCatalog.some((report) => reportPermittedFor(report, permissions))
      )
        throw reportHttpError("REPORT_NOT_PERMITTED");
      const context = establishScopedTenantContext(getTenantContext(req), {
        kind: "tenant",
      });
      res.json(await listReportScheduleRecipients(context, query));
    },
  );

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
    const { context, viewer } = await resolveReportViewer(req, [report]);
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
      // Each metric is read under its source report's permissions.
      const sources = new Map<string, ReportDefinition>();
      for (const metricCode of query.metricCodes) {
        const source = reportByCode(
          reportMetricByCode.get(metricCode)?.sourceReport.reportCode ?? "",
        );
        if (source === undefined) throw reportHttpError("REPORT_NOT_PERMITTED");
        sources.set(source.code, source);
      }
      const { context, viewer } = await resolveReportViewer(req, [
        ...sources.values(),
      ]);
      res.json({ data: await previewReport(context, query, { viewer }) });
    },
  );

  // Saved reports, exports and schedules (F12): fixed paths, so before
  // "/:reportCode".
  registerReportDeliveryRoutes(router);

  // Registered last so "/:reportCode" never shadows a fixed path.
  router.get(route(getReportEndpoint.path), async (req, res) => {
    const { permissions } = await loadRequestAccess(req);
    res.json({
      data: getReportDefinition({ permissions }, String(req.params.reportCode)),
    });
  });

  return router;
}
