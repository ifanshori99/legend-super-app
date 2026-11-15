// Dashboard contract decisions (WS-11, bead legend-spks; PRD v1.7 DASH-04,
// SH-01): shareholder-linked reports take report.aggregate.view as aggregates
// only, scheduled exports never carry personal data, schedule recipients are
// tenant user ids, and one constant names the identity splits. No database.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as board from "../apps/web/src/features/ws11-shareholder/board.ts";
import * as builder from "../apps/web/src/features/ws11-report-builder/builder.ts";
import "../apps/web/src/features/ws11-report-builder/mock.ts";
import { shareholderLayoutFixture as layout } from "../apps/web/src/features/ws11-shareholder/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

afterEach(() => {
  resetMocks();
  setScenario("normal");
});

const AGGREGATE = ["report.aggregate.view"];
const USER_A = "0d0c4f6a-5a39-4c0a-9f43-2f1d8e5b7a01";
const USER_B = "5b7e2c91-6d84-4e1b-8a52-9c3f0d4e6b02";
const IDENTITY_SPLITS = ["employee", "customer", "member"];

const tileReports = () =>
  layout.tiles
    .filter((tile) => tile.kind === "metric")
    .map((tile) => dashboard.reportByCode(tile.reportCode));

describe("decision 4: one constant for identity splits", () => {
  test("employee, customer and member are the identity splits", () => {
    assert.deepEqual([...dashboard.PERSONAL_DATA_DIMENSIONS], IDENTITY_SPLITS);
  });

  test("a group-by or filter on any identity split is personal data", () => {
    for (const key of IDENTITY_SPLITS) {
      assert.equal(
        dashboard.selectionContainsPersonalData({
          groupBy: [key],
          filters: [],
        }),
        true,
        `groupBy ${key}`,
      );
      assert.equal(
        dashboard.selectionContainsPersonalData({
          groupBy: [],
          filters: [{ key }],
        }),
        true,
        `filter ${key}`,
      );
    }
    assert.equal(
      dashboard.selectionContainsPersonalData({
        groupBy: ["customer_tier", "hour"],
        filters: [],
      }),
      false,
    );
  });

  test("the export gate, the builder and the shareholder guard read it", () => {
    for (const key of IDENTITY_SPLITS) {
      const query = { groupBy: [key], filters: [] };
      assert.equal(
        dashboard.reportExportContainsPersonalData({ report: null, query }),
        true,
      );
      assert.equal(builder.queryHasPersonalData(query), true);
      assert.equal(dashboard.builderQueryPermittedFor(query, AGGREGATE), false);
    }
  });
});

describe("decision 1: shareholder-linked reports take report.aggregate.view, aggregates only", () => {
  test("every report a shareholder tile links to accepts report.aggregate.view", () => {
    const reports = tileReports();
    assert.ok(reports.length > 0);
    for (const report of reports) {
      assert.ok(report, "tile report is in the catalog");
      assert.equal(
        dashboard.reportPermittedFor(report, AGGREGATE),
        true,
        report.code,
      );
    }
    // The link opens with or without the kelola area permission (legend-5bjh).
    const opened = [...AGGREGATE, board.REPORT_AREA_PERMISSION];
    for (const tile of layout.tiles)
      if (tile.kind === "metric") {
        assert.ok(board.permittedReportPath(tile, opened) !== null, tile.key);
        assert.ok(
          board.permittedReportPath(tile, AGGREGATE) !== null,
          tile.key,
        );
      }
  });

  test("those reports are aggregates: no personal flag, no identity split offered", () => {
    for (const report of tileReports()) {
      assert.equal(report.containsPersonalData, false, report.code);
      for (const key of IDENTITY_SPLITS)
        assert.equal(report.dimensions.includes(key), false, report.code);
    }
  });

  test("report.aggregate.view opens no other report", () => {
    const linked = new Set(dashboard.AGGREGATE_VIEW_REPORT_CODES);
    for (const report of dashboard.reportCatalog) {
      if (linked.has(report.code)) continue;
      assert.equal(
        dashboard.reportPermittedFor(report, AGGREGATE),
        false,
        report.code,
      );
    }
    for (const report of dashboard.reportCatalog.filter(
      (item) => item.containsPersonalData,
    ))
      assert.equal(dashboard.reportAcceptsAggregateView(report), false);
  });

  test("a linked report that turns personal or gains an identity split loses the shortcut", () => {
    const [report] = tileReports();
    assert.equal(
      dashboard.reportPermittedFor(
        { ...report, containsPersonalData: true },
        AGGREGATE,
      ),
      false,
    );
    assert.equal(
      dashboard.reportPermittedFor(
        { ...report, dimensions: [...report.dimensions, "member"] },
        AGGREGATE,
      ),
      false,
    );
  });

  test("the normal permissions still open a report and nothing opens it without them", () => {
    const report = dashboard.reportByCode("sales.daily");
    assert.equal(
      dashboard.reportPermittedFor(report, report.requiredPermissions),
      true,
    );
    assert.equal(dashboard.reportPermittedFor(report, []), false);
    assert.equal(
      dashboard.reportPermittedFor(report, ["report.operational.view"]),
      false,
    );
  });

  test("export stays closed to a shareholder: no personal split, no personal report", () => {
    const withExport = new Set([
      ...AGGREGATE,
      dashboard.REPORT_EXPORT_PERMISSION,
    ]);
    const aggregate = dashboard.reportByCode("sales.daily");
    assert.equal(
      dashboard.reportExportGate({
        report: aggregate,
        query: { groupBy: ["employee"], filters: [] },
        permissions: withExport,
        format: "csv",
        approval: "approved",
      }).action,
      "reject",
    );
    const personal = dashboard.reportCatalog.find(
      (item) => item.containsPersonalData,
    );
    assert.deepEqual(
      dashboard.reportExportGate({
        report: personal,
        query: { groupBy: [], filters: [] },
        permissions: withExport,
        format: "csv",
        approval: "approved",
      }),
      { action: "reject", code: "REPORT_NOT_PERMITTED" },
    );
  });

  test("the builder offers an aggregate-only caller no person split or filter", () => {
    assert.equal(dashboard.aggregateOnlyCaller(AGGREGATE), true);
    assert.equal(builder.aggregateOnlyCaller, dashboard.aggregateOnlyCaller);
    assert.equal(
      dashboard.aggregateOnlyCaller([...AGGREGATE, "report.sales.view"]),
      false,
    );
    assert.equal(dashboard.aggregateOnlyCaller(["report.sales.view"]), false);
    // Any permission of a report family ends aggregate-only, not just three.
    assert.equal(
      dashboard.aggregateOnlyCaller([...AGGREGATE, "payroll.view"]),
      false,
    );
    const metrics = builder.usableMetrics(AGGREGATE);
    assert.ok(metrics.length > 0);
    for (const metric of metrics)
      assert.equal(
        dashboard.reportAcceptsAggregateView(
          dashboard.reportByCode(metric.sourceReport.reportCode),
        ),
        true,
        metric.code,
      );
    // net_sales offers an employee split; hiding it is the caller's rule.
    const codes = ["net_sales"];
    assert.ok(builder.sharedDimensions(codes).includes("employee"));
    for (const key of IDENTITY_SPLITS) {
      assert.equal(builder.sharedDimensions(codes, true).includes(key), false);
      assert.equal(
        builder.filterableDimensions(codes, true).includes(key),
        false,
      );
    }
    const reconciled = builder.reconcileDraft(
      {
        ...builder.emptyDraft("2026-11-01"),
        metricCodes: codes.slice(0, 1),
        groupBy: ["employee"],
      },
      true,
    );
    assert.deepEqual(reconciled.draft.groupBy, []);
  });
});

describe("decision 1 (negative): an aggregate-only caller cannot reach a person through the builder", () => {
  const withExport = new Set([
    ...AGGREGATE,
    dashboard.REPORT_EXPORT_PERMISSION,
  ]);
  const personalQueries = [
    { groupBy: ["employee"], filters: [] },
    { groupBy: ["customer"], filters: [] },
    { groupBy: [], filters: [{ key: "member" }] },
    { groupBy: ["hour"], filters: [{ key: "employee" }] },
  ];

  test("preview and save: net_sales split or filtered by an identity is refused", () => {
    const [aggregateMetric] = ["net_sales"].map((code) =>
      dashboard.reportMetricByCode.get(code),
    );
    assert.ok(aggregateMetric.dimensions.includes("employee"));
    for (const query of personalQueries)
      assert.equal(
        dashboard.builderQueryPermittedFor(
          { ...query, metricCodes: ["net_sales"] },
          AGGREGATE,
        ),
        false,
        JSON.stringify(query),
      );
    assert.equal(
      dashboard.builderQueryPermittedFor(
        { groupBy: ["hour"], filters: [], metricCodes: ["net_sales"] },
        AGGREGATE,
      ),
      true,
    );
  });

  test("preview: a metric whose report the caller cannot open is refused", () => {
    assert.equal(
      dashboard.builderQueryPermittedFor(
        { groupBy: [], filters: [], metricCodes: ["active_members"] },
        AGGREGATE,
      ),
      false,
    );
    assert.equal(
      dashboard.builderQueryPermittedFor(
        { groupBy: [], filters: [], metricCodes: ["not_a_metric"] },
        AGGREGATE,
      ),
      false,
    );
  });

  test("a caller with a full report permission is not limited by this rule", () => {
    const manager = ["report.sales.view", "report.aggregate.view"];
    for (const query of personalQueries)
      assert.equal(
        dashboard.builderQueryPermittedFor(
          { ...query, metricCodes: ["net_sales"] },
          manager,
        ),
        true,
      );
  });

  test("export: a saved builder query (report null) is gated on its splits", () => {
    for (const query of personalQueries)
      assert.deepEqual(
        dashboard.reportExportGate({
          report: null,
          query,
          permissions: withExport,
          format: "csv",
          approval: "approved",
        }),
        { action: "reject", code: "REPORT_NOT_PERMITTED" },
        JSON.stringify(query),
      );
    assert.equal(
      dashboard.reportExportGate({
        report: null,
        query: { groupBy: ["hour"], filters: [] },
        permissions: withExport,
        format: "csv",
        approval: "none",
      }).action,
      "queue",
    );
  });

  test("schedule: every identity split is refused whoever asks", () => {
    for (const query of personalQueries)
      assert.equal(dashboard.reportScheduleGate(query).action, "reject");
  });
});

describe("decision 2: scheduled export with personal data stays refused", () => {
  const refused = {
    action: "reject",
    code: "EXPORT_PII_APPROVAL_REQUIRED",
  };

  test("a saved query split or filtered by an identity cannot be scheduled", () => {
    for (const key of IDENTITY_SPLITS) {
      assert.deepEqual(
        dashboard.reportScheduleGate({ groupBy: [key], filters: [] }),
        refused,
        `groupBy ${key}`,
      );
      assert.deepEqual(
        dashboard.reportScheduleGate({ groupBy: [], filters: [{ key }] }),
        refused,
        `filter ${key}`,
      );
    }
  });

  test("a catalog report flagged personal cannot be scheduled even without a split", () => {
    const personal = dashboard.reportCatalog.find(
      (item) => item.containsPersonalData,
    );
    assert.deepEqual(
      dashboard.reportScheduleGate({ groupBy: [], filters: [] }, personal),
      refused,
    );
  });

  test("an aggregate query is queued", () => {
    assert.deepEqual(
      dashboard.reportScheduleGate({ groupBy: ["hour"], filters: [] }),
      { action: "queue", containsPersonalData: false },
    );
  });
});

describe("decision 3: schedule recipients are tenant user ids", () => {
  const schedule = dashboard.reportScheduleFixture;
  const input = {
    savedReportId: dashboard.savedReportIdFixture,
    frequency: "daily",
    timeOfDay: "07:00",
    format: "csv",
    recipientUserIds: [USER_A],
  };

  test("the schedule row and the create and update inputs take recipientUserIds", () => {
    assert.ok(dashboard.reportScheduleSchema.parse(schedule));
    assert.ok(Array.isArray(schedule.recipientUserIds));
    assert.equal("recipients" in schedule, false);
    assert.ok(dashboard.createReportScheduleInputSchema.parse(input));
    const settings = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "savedReportId"),
    );
    assert.ok(
      dashboard.updateReportScheduleInputSchema.parse({
        ...settings,
        isEnabled: true,
      }),
    );
  });

  test("email addresses, the old field, empty and repeated lists are refused", () => {
    const refusals = [
      { recipientUserIds: ["owner@cafelegend.id"] },
      { recipientUserIds: ["not-a-uuid"] },
      { recipientUserIds: [] },
      { recipientUserIds: [USER_A, USER_A] },
      { recipientUserIds: [USER_A, USER_A.toUpperCase()] },
      {
        recipientUserIds: Array.from(
          { length: 21 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      },
      { recipients: ["owner@cafelegend.id"], recipientUserIds: undefined },
      { recipients: ["owner@cafelegend.id"] },
    ];
    for (const patch of refusals) {
      assert.equal(
        dashboard.createReportScheduleInputSchema.safeParse({
          ...input,
          ...patch,
        }).success,
        false,
        JSON.stringify(patch),
      );
      assert.equal(
        dashboard.reportScheduleSchema.safeParse({ ...schedule, ...patch })
          .success,
        false,
        JSON.stringify(patch),
      );
    }
    assert.equal(
      dashboard.createReportScheduleInputSchema.safeParse({
        ...input,
        recipientUserIds: [USER_A, USER_B],
      }).success,
      true,
    );
  });

  test("the form picks users: the draft holds ids and the settings dedupe them", () => {
    assert.deepEqual(builder.toggleRecipient([], USER_A), [USER_A]);
    assert.deepEqual(builder.toggleRecipient([USER_A, USER_B], USER_A), [
      USER_B,
    ]);
    const settings = builder.scheduleSettings({
      ...builder.emptyScheduleDraft(),
      recipientUserIds: [USER_A, USER_B, USER_A],
    });
    assert.deepEqual(settings.recipientUserIds, [USER_A, USER_B]);
    assert.equal("recipients" in settings, false);
    assert.equal(builder.parseRecipients, undefined);
  });

  test("the user list endpoint offers names and roles, never an email", async () => {
    const page = await dispatchMock({
      method: "GET",
      path: "/api/reports/schedule-recipients",
      query: { limit: 25 },
    });
    assert.ok(page.data.length > 0);
    assert.ok(dashboard.reportScheduleRecipientPageSchema.parse(page));
    for (const user of page.data) {
      assert.deepEqual(Object.keys(user).sort(), [
        "name",
        "roleName",
        "userId",
      ]);
    }
  });

  test("a schedule created with picked users is stored with those ids", async () => {
    const created = await dispatchMock({
      method: "POST",
      path: "/api/reports/schedules",
      body: input,
    });
    assert.deepEqual(created.data.recipientUserIds, [USER_A]);
    assert.equal("recipients" in created.data, false);
  });
});
