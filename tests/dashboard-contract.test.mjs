import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../packages/shared/src/core/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as metrics from "../packages/shared/src/metrics/index.ts";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";

const fixtures = dashboard.cafeLegendReportFixtures;
const tenant = core.cafeLegendFixtures.tenant;
const outlet = core.cafeLegendFixtures.outlets[0];

/** One registry for every number the dashboards and reports cite. */
const registry = [
  ...metrics.cafeLegendMetricDefinitions,
  ...dashboard.dashboardMetricDefinitions,
];
const registryByCode = new Map(registry.map((metric) => [metric.code, metric]));
const reportCodes = new Set(
  dashboard.reportCatalog.map((report) => report.code),
);

test("DASH-01: every dashboard tile cites a registered metric definition, a period and a source report", () => {
  const tiles = dashboard.DASHBOARD_CATALOG;
  assert.ok(tiles.length >= 30, "the three dashboards carry their tiles");
  const keys = new Set();
  for (const tile of tiles) {
    assert.equal(keys.has(tile.key), false, `duplicate tile key ${tile.key}`);
    keys.add(tile.key);
    assert.ok(dashboard.dashboardTileSchema.safeParse(tile).success, tile.key);
    if (tile.kind === "metric") {
      const report = dashboard.reportByCode(tile.reportCode);
      assert.ok(report, `${tile.key} cites ${tile.reportCode}`);
      for (const code of tile.metricCodes) {
        assert.ok(registryByCode.has(code), `${tile.key} cites ${code}`);
        assert.ok(
          report.metrics.includes(code),
          `${tile.key}: ${code} is missing from ${report.code}`,
        );
      }
      assert.ok(
        report.periodPresets.includes(tile.period),
        `${tile.key} period ${tile.period} is offered by ${report.code}`,
      );
      assert.ok(
        dashboard.dashboardTilePath(tile, {
          startDate: "2026-11-01",
          endDate: "2026-11-01",
        }),
      );
    }
    if (tile.kind === "queue" && tile.reportCode !== null)
      assert.ok(reportCodes.has(tile.reportCode), tile.key);
  }
  assert.ok(dashboard.DASHBOARD_CATALOG.some((tile) => tile.kind === "queue"));
  assert.ok(
    dashboard.DASHBOARD_CATALOG.some((tile) => tile.kind === "personal_share"),
  );
  assert.ok(dashboard.DASHBOARD_CATALOG.some((tile) => tile.kind === "link"));
});

test("DASH-01: the report catalog carries 100+ standard reports with unique codes, routes and resolvable definitions", () => {
  assert.ok(
    dashboard.reportCatalog.length >= 100,
    `only ${dashboard.reportCatalog.length} reports`,
  );
  const codes = new Set();
  const routes = new Set();
  for (const report of dashboard.reportCatalog) {
    assert.equal(codes.has(report.code), false, report.code);
    codes.add(report.code);
    assert.equal(routes.has(report.route), false, report.route);
    routes.add(report.route);
    assert.equal(report.route, dashboard.reportRouteForCode(report.code));
    assert.ok(report.metrics.length >= 1, report.code);
    for (const code of report.metrics)
      assert.ok(registryByCode.has(code), `${report.code} cites ${code}`);
    for (const dimension of report.dimensions)
      assert.ok(
        metrics.CORE_METRIC_DIMENSIONS.includes(dimension),
        `${report.code} dimension ${dimension}`,
      );
    assert.ok(report.periodPresets.includes(report.defaultPeriod));
    assert.ok(report.exportFormats.length >= 1);
    if (report.containsPersonalData)
      assert.ok(report.exportFormats.includes("csv"), report.code);
  }
  // Every dashboard/report metric drills down to a catalog report route.
  for (const definition of registry) {
    const report = dashboard.reportByCode(definition.sourceReport.reportCode);
    assert.ok(
      report,
      `${definition.code} source ${definition.sourceReport.reportCode}`,
    );
    assert.equal(report.route, definition.sourceReport.route, definition.code);
  }
  // The additions never shadow a metrics-layer code.
  const baseCodes = new Set(
    metrics.cafeLegendMetricDefinitions.map((definition) => definition.code),
  );
  for (const definition of dashboard.dashboardMetricDefinitions)
    assert.equal(baseCodes.has(definition.code), false, definition.code);
});

test("DASH-01: dashboard metric definitions parse and cover every tile family", () => {
  assert.ok(dashboard.dashboardMetricDefinitions.length >= 40);
  for (const definition of dashboard.dashboardMetricDefinitions)
    metrics.metricDefinitionSchema.parse(definition);
  for (const family of dashboard.REPORT_FAMILIES)
    assert.ok(
      dashboard.reportsByFamily(family).length >= 1,
      `family ${family} is empty`,
    );
});

test("DASH-02: a tile drill-down opens its source report with the same period, outlets and group-by", () => {
  const tile = dashboard.DASHBOARD_CATALOG.find(
    (candidate) => candidate.key === "owner.today_sales",
  );
  assert.ok(tile && tile.kind === "metric");
  const params = {
    startDate: "2026-11-01",
    endDate: "2026-11-01",
    outletIds: [outlet.id],
    groupBy: "channel",
  };
  const report = dashboard.reportByCode(tile.reportCode);
  assert.equal(
    dashboard.dashboardTilePath(tile, params),
    `${report.route}?startDate=2026-11-01&endDate=2026-11-01&outletId=${outlet.id}&groupBy=channel`,
  );
  assert.equal(
    dashboard.dashboardTilePath(tile, params),
    metrics.metricSourceReportPath(report, params),
    "tile and source report build the drill-down with one helper",
  );
  const shareTile = dashboard.DASHBOARD_CATALOG.find(
    (candidate) => candidate.key === "shareholder.profit_share",
  );
  assert.equal(dashboard.dashboardTilePath(shareTile, params), null);
});

test("DASH-02: report run rows keep groupBy order and one typed value per definition", () => {
  assert.ok(dashboard.reportResultSchema.parse(fixtures.runResult));
  const result = fixtures.runResult;
  for (const patch of [
    {
      rows: [
        {
          ...result.rows[0],
          dimensions: [{ key: "outlet", value: outlet.id }],
        },
      ],
    },
    {
      rows: [
        {
          ...result.rows[0],
          values: [result.rows[0].values[0]],
        },
      ],
    },
    {
      rows: [
        {
          ...result.rows[0],
          values: [
            result.rows[0].values[0],
            {
              metricCode: "pax",
              value: { unit: "count", value: 412 },
              finality: "final",
            },
          ],
        },
      ],
    },
    {
      rows: [
        {
          ...result.rows[0],
          values: [
            {
              ...result.rows[0].values[0],
              value: { unit: "count", value: 18450 },
            },
            result.rows[0].values[1],
          ],
        },
      ],
    },
  ])
    assert.equal(
      dashboard.reportResultSchema.safeParse({ ...result, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});

test("SH-02: shareholder official tiles stay closed-period only and open periods are estimates", () => {
  const metricTiles = dashboard.SHAREHOLDER_DASHBOARD_TILES.filter(
    (tile) => tile.kind === "metric",
  );
  assert.ok(metricTiles.length >= 8);
  for (const tile of metricTiles)
    assert.equal(tile.closedPeriodOnly, true, tile.key);
  const closed = { periodClosed: true, accountingPeriodClosed: true };
  assert.equal(
    dashboard.dashboardTileFinality(metricTiles[0], closed),
    "final",
  );
  assert.equal(
    dashboard.dashboardTileFinality(metricTiles[0], {
      periodClosed: true,
      accountingPeriodClosed: false,
    }),
    "estimate",
  );
  assert.equal(
    dashboard.dashboardTileFinality(metricTiles[0], {
      periodClosed: false,
      accountingPeriodClosed: false,
    }),
    "estimate",
  );
  const ownerProfit = dashboard.DASHBOARD_CATALOG.find(
    (tile) => tile.key === "owner.income_statement",
  );
  assert.equal(ownerProfit.closedPeriodOnly, false, "running P&L is labelled");
  assert.equal(
    registryByCode.get("net_profit").officiality,
    "closed_period_only",
  );
  assert.equal(
    dashboard.dashboardTileFinality(
      dashboard.DASHBOARD_CATALOG.find((tile) => tile.key === "owner.alerts"),
      closed,
    ),
    null,
  );
});

test("DASH-04: personal-data exports never leave the server without an approved approval request", () => {
  const report = dashboard.reportByCode("crm.customers");
  assert.equal(report.containsPersonalData, true);
  const base = {
    containsPersonalData: true,
    hasExportPermission: true,
    format: "xlsx",
    supportedFormats: report.exportFormats,
  };
  assert.deepEqual(dashboard.reportExportGate({ ...base, approval: "none" }), {
    action: "request_approval",
  });
  assert.deepEqual(
    dashboard.reportExportGate({ ...base, approval: "pending" }),
    { action: "request_approval" },
  );
  assert.deepEqual(
    dashboard.reportExportGate({ ...base, approval: "approved" }),
    { action: "queue" },
  );
  assert.deepEqual(
    dashboard.reportExportGate({ ...base, approval: "rejected" }),
    { action: "reject", code: "EXPORT_PII_APPROVAL_REQUIRED" },
  );
  assert.deepEqual(
    dashboard.reportExportGate({
      ...base,
      containsPersonalData: false,
      approval: "none",
    }),
    { action: "queue" },
  );
  assert.deepEqual(
    dashboard.reportExportGate({ ...base, hasExportPermission: false }),
    { action: "reject", code: "REPORT_NOT_PERMITTED" },
  );
  assert.deepEqual(
    dashboard.reportExportGate({
      ...base,
      format: "xlsx",
      supportedFormats: ["csv", "pdf"],
    }),
    { action: "reject", code: "EXPORT_FORMAT_NOT_SUPPORTED" },
  );

  const pending = fixtures.exportPendingApproval;
  assert.equal(pending.containsPersonalData, true);
  assert.equal(pending.approvalRequestId, null);
  assert.ok(dashboard.reportExportSchema.parse(pending));
  for (const status of ["queued", "generating", "ready", "failed"]) {
    assert.equal(
      dashboard.reportExportSchema.safeParse({ ...pending, status }).success,
      false,
      `unapproved personal-data export cannot be ${status}`,
    );
  }
  assert.ok(dashboard.reportExportSchema.parse(fixtures.exportReady));
  assert.throws(
    () =>
      dashboard.assertReportExportMayGenerate({
        containsPersonalData: true,
        approvalRequestId: null,
        status: "queued",
      }),
    /DASH-04/,
  );
  assert.throws(
    () =>
      dashboard.assertReportExportMayGenerate({
        containsPersonalData: false,
        approvalRequestId: null,
        status: "generating",
      }),
    /queued/,
  );
  assert.doesNotThrow(() =>
    dashboard.assertReportExportMayGenerate({
      containsPersonalData: true,
      approvalRequestId: "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      status: "queued",
    }),
  );
});

test("DASH-01: the report builder only offers splits every selected metric declares", () => {
  const query = dashboard.reportBuilderQuerySchema.parse(fixtures.builderQuery);
  assert.deepEqual(dashboard.checkReportBuilderQuery(query, registry), {
    ok: true,
  });
  const mixed = dashboard.reportBuilderQuerySchema.parse({
    metricCodes: ["net_sales", "void_rate_pct"],
    period: { startDate: "2026-10-01", endDate: "2026-10-31" },
    groupBy: ["employee"],
  });
  const rejected = dashboard.checkReportBuilderQuery(mixed, registryByCode);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "REPORT_FILTER_NOT_SUPPORTED");
  assert.equal(rejected.field, "groupBy.0");
  const unknown = dashboard.checkReportBuilderQuery(
    dashboard.reportBuilderQuerySchema.parse({
      metricCodes: ["nope"],
      period: { startDate: "2026-10-01", endDate: "2026-10-31" },
    }),
    registry,
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "REPORT_NOT_FOUND");
  assert.equal(unknown.field, "metricCodes.0");
  for (const patch of [
    { metricCodes: ["net_sales", "net_sales"] },
    { groupBy: ["hour", "hour"] },
    { groupBy: ["hour", "channel", "zone", "employee"] },
    { sort: { column: "avg_ticket", direction: "desc" } },
    { sort: { column: "net_sales", direction: "up" } },
  ])
    assert.equal(
      dashboard.reportBuilderQuerySchema.safeParse({
        ...query,
        ...patch,
      }).success,
      false,
      JSON.stringify(patch),
    );
});

test("tenant scope: saved reports and schedules reject client tenant fields and bad delivery settings", () => {
  assert.ok(
    dashboard.createSavedReportInputSchema.parse(
      fixtures.createSavedReportInput,
    ),
  );
  assert.equal(
    dashboard.createSavedReportInputSchema.safeParse({
      ...fixtures.createSavedReportInput,
      tenantId: tenant.id,
    }).success,
    false,
  );
  assert.equal(
    dashboard.savedReportSchema.safeParse({
      ...fixtures.savedReport,
      tenantId: undefined,
    }).success,
    false,
  );
  assert.equal(
    dashboard.savedReportSchema.safeParse({
      ...fixtures.savedReport,
      updatedAt: "2026-10-24T02:00:00.000Z",
    }).success,
    false,
  );

  const schedule = fixtures.schedule;
  assert.ok(dashboard.reportScheduleSchema.parse(schedule));
  for (const patch of [
    { dayOfWeek: null },
    { dayOfMonth: 1 },
    { frequency: "daily" },
    { recipients: ["owner@cafelegend.id", "OWNER@cafelegend.id"] },
    { recipients: ["not-an-email"] },
    { timeOfDay: "7:30" },
  ])
    assert.equal(
      dashboard.reportScheduleSchema.safeParse({ ...schedule, ...patch })
        .success,
      false,
      JSON.stringify(patch),
    );
  const daily = { ...schedule, frequency: "daily", dayOfWeek: null };
  assert.ok(dashboard.reportScheduleSchema.parse(daily));
  const monthly = {
    ...schedule,
    frequency: "monthly",
    dayOfWeek: null,
    dayOfMonth: 15,
  };
  assert.ok(dashboard.reportScheduleSchema.parse(monthly));
});

test("export state machine and saved-report lifecycle allow only declared transitions", () => {
  assert.equal(
    dashboard.canTransitionReportExport("pending_approval", "queued"),
    true,
  );
  assert.equal(
    dashboard.canTransitionReportExport("pending_approval", "generating"),
    false,
  );
  assert.equal(
    dashboard.transitionReportExport("queued", "generating"),
    "generating",
  );
  assert.throws(
    () => dashboard.transitionReportExport("ready", "generating"),
    /CONFLICT|cannot move/,
  );
  assert.equal(dashboard.canTransitionSavedReport("active", "archived"), true);
  assert.equal(
    dashboard.transitionSavedReportStatus("archived", "active"),
    "active",
  );
  assert.throws(
    () => dashboard.transitionSavedReportStatus("active", "active"),
    /cannot move/,
  );
});

test("report.generated is registered in the WS-11 event catalog and its envelope validates", () => {
  const entry = events.eventCatalogByName.get("report.generated");
  assert.ok(entry);
  assert.equal(entry.workstream, "WS-11");
  assert.equal(entry.payloadSchemaRef, "report.generated.v1");
  const envelope = dashboard.reportGeneratedEvent.envelopeSchema.parse(
    fixtures.generatedEvent,
  );
  assert.equal(envelope.payload.reportCode, "sales.daily");
  assert.equal(envelope.payload.trigger, "export");
  assert.ok(dashboard.DASHBOARD_EVENT_PAYLOAD_SCHEMAS["report.generated"]);
  const payload = envelope.payload;
  for (const patch of [
    { trigger: "scheduled", format: "pdf" },
    { trigger: "export", format: "csv", exportId: null },
    { trigger: "manual", format: "pdf" },
    { trigger: "manual", format: "screen", exportId: outlet.id },
    { period: { startDate: "2026-11-02", endDate: "2026-11-01" } },
  ])
    assert.equal(
      dashboard.reportGeneratedPayloadSchema.safeParse({ ...payload, ...patch })
        .success,
      false,
      JSON.stringify(patch),
    );
  assert.ok(
    dashboard.reportGeneratedPayloadSchema.parse({
      ...payload,
      trigger: "scheduled",
      format: "pdf",
      exportId: null,
      savedReportId: fixtures.savedReport.id,
    }),
  );
});

test("dashboard layout fixture and endpoints expose the WS-11 surface", () => {
  const layout = dashboard.dashboardLayoutSchema.parse(
    fixtures.dashboard.ownerLayout,
  );
  assert.equal(layout.dashboard, "owner");
  assert.ok(layout.tiles.length >= 30);
  assert.equal(layout.monitoringPeriod.status, "open");
  assert.equal(
    dashboard.dashboardQuerySchema.safeParse({ tenantId: tenant.id }).success,
    false,
  );
  assert.equal(
    dashboard
      .dashboardTilesFor("management", "gm")
      .every((tile) => tile.managerRole === null || tile.managerRole === "gm"),
    true,
  );
  for (const endpoint of Object.values(dashboard.DASHBOARD_ENDPOINTS)) {
    assert.ok(endpoint.path.startsWith("/api/"));
    assert.ok(endpoint.id.includes(endpoint.path));
  }
  assert.equal(
    dashboard.DASHBOARD_ENDPOINTS.createReportExport.path,
    "/api/reports/exports",
  );
  assert.ok(dashboard.dashboardErrorFixtures);
});
