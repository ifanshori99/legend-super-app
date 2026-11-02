// Report builder (WS-11 FE, bead legend-x9r2; PRD v1.7 §3 F36 "Report
// Builder", DASH-01, DASH-02, DASH-04). No database: loads the shared
// dashboard contract, the builder's pure rules and its mock endpoints with
// Node type stripping. The screen is exercised in e2e/legend-x9r2.mock.spec.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as builder from "../apps/web/src/features/ws11-report-builder/builder.ts";
import "../apps/web/src/features/ws11-report-builder/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

afterEach(() => {
  resetMocks();
  setScenario("normal");
});

const post = (path, body) => dispatchMock({ method: "POST", path, body });
const get = (path, query = {}) => dispatchMock({ method: "GET", path, query });
const patch = (path, body) => dispatchMock({ method: "PATCH", path, body });
const failure = (promise) =>
  promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );

const ALL = [...dashboard.reportCatalog.flatMap((r) => r.requiredPermissions)];
const draftWith = (patch) => ({
  ...builder.emptyDraft("2026-11-01"),
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  preset: "custom",
  ...patch,
});

describe("builder rules · DASH-01", () => {
  test("DASH-01: only metrics whose source report the caller's permissions open are offered", () => {
    assert.equal(builder.usableMetrics([]).length, 0);
    const everything = builder.usableMetrics(ALL);
    assert.equal(everything.length, dashboard.reportMetricDefinitions.length);
    const one = builder.usableMetrics(["report.sales.view"]);
    assert.ok(one.length > 0 && one.length < everything.length);
    for (const metric of one)
      assert.ok(
        dashboard
          .reportByCode(metric.sourceReport.reportCode)
          .requiredPermissions.every((code) => code === "report.sales.view"),
      );
  });

  test("DASH-01: dimensions are those every selected metric declares, and dropping a metric drops unsupported splits", () => {
    const shared = builder.sharedDimensions(["net_sales", "pax"]);
    assert.ok(shared.includes("hour") && shared.includes("channel"));
    assert.ok(!shared.includes("menu_item"));
    assert.ok(!builder.filterableDimensions(["net_sales"]).includes("outlet"));
    const reconciled = builder.reconcileDraft(
      draftWith({
        metricCodes: ["pax"],
        groupBy: ["hour", "menu_item"],
        filters: [{ key: "menu_item", valuesText: "Kopi" }],
        sortColumn: "net_sales",
      }),
    );
    assert.deepEqual(reconciled.draft.groupBy, ["hour"]);
    assert.deepEqual(reconciled.draft.filters, []);
    assert.equal(reconciled.draft.sortColumn, null);
    assert.deepEqual(reconciled.dropped, ["menu_item"]);
  });

  test("DASH-01: the draft is validated with the contract and invalid combinations name a report error code", () => {
    const ok = builder.validateDraft(
      draftWith({ metricCodes: ["net_sales", "pax"], groupBy: ["hour"] }),
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(builder.validateDraft(draftWith({})).issues, [
      { kind: "draft", key: "noMetric" },
    ]);
    const unsupported = builder.validateDraft(
      draftWith({ metricCodes: ["pax"], groupBy: ["menu_item"] }),
    );
    assert.deepEqual(unsupported.issues, [
      { kind: "contract", code: "REPORT_FILTER_NOT_SUPPORTED" },
    ]);
    const emptyFilter = builder.validateDraft(
      draftWith({
        metricCodes: ["pax"],
        filters: [{ key: "channel", valuesText: " , " }],
      }),
    );
    assert.deepEqual(emptyFilter.issues, [
      { kind: "draft", key: "filterValues" },
    ]);
    const reversed = builder.validateDraft(
      draftWith({
        metricCodes: ["pax"],
        startDate: "2026-11-02",
        endDate: "2026-11-01",
      }),
    );
    assert.deepEqual(reversed.issues, [{ kind: "draft", key: "periodRange" }]);
  });

  test("DASH-01: period presets resolve against the outlet business date", () => {
    const today = "2026-11-03";
    assert.deepEqual(builder.resolvePreset("last_7_days", today), {
      startDate: "2026-10-28",
      endDate: "2026-11-03",
    });
    assert.deepEqual(builder.resolvePreset("last_month", today), {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    assert.deepEqual(builder.resolvePreset("yesterday", "2026-03-01"), {
      startDate: "2026-02-28",
      endDate: "2026-02-28",
    });
    assert.equal(
      builder.todayIn("Asia/Jakarta", new Date("2026-11-02T20:00:00Z")),
      "2026-11-03",
    );
  });

  test("DASH-04: a split or filter by a person is flagged as personal data", () => {
    assert.equal(
      builder.draftHasPersonalData(draftWith({ groupBy: ["employee"] })),
      true,
    );
    assert.equal(
      builder.draftHasPersonalData(
        draftWith({ filters: [{ key: "employee", valuesText: "x" }] }),
      ),
      true,
    );
    assert.equal(
      builder.draftHasPersonalData(draftWith({ groupBy: ["hour"] })),
      false,
    );
  });

  test("DASH-01: schedule settings carry only the day field of their frequency", () => {
    const base = {
      ...builder.emptyScheduleDraft(),
      recipientsText: "A@x.id; a@x.id, b@x.id",
    };
    assert.deepEqual(
      builder.scheduleSettings({ ...base, frequency: "daily" }),
      {
        frequency: "daily",
        timeOfDay: "07:00",
        dayOfWeek: null,
        dayOfMonth: null,
        format: "pdf",
        recipients: ["a@x.id", "b@x.id"],
      },
    );
    const weekly = builder.scheduleSettings({ ...base, frequency: "weekly" });
    assert.ok(
      dashboard.createReportScheduleInputSchema.safeParse({
        savedReportId: dashboard.savedReportIdFixture,
        ...weekly,
      }).success,
    );
  });
});

describe("builder mock · DASH-02", () => {
  test("DASH-02: the preview is a contract-valid table following the requested split and metrics", async () => {
    const query = dashboard.reportBuilderQueryFixture;
    const { data } = await post("/api/reports/builder/preview", query);
    assert.equal(data.reportCode, null);
    assert.deepEqual(data.groupBy, query.groupBy);
    assert.deepEqual(
      data.definitions.map((definition) => definition.code),
      query.metricCodes,
    );
    assert.ok(data.rows.length > 0);
    assert.equal(data.rows[0].dimensions[0].key, "hour");
    // Sorted by net_sales desc as asked.
    const sales = data.rows.map((row) => row.values[0].value.valueIdr);
    assert.deepEqual(
      sales,
      [...sales].sort((a, b) => b - a),
    );
    // The same query always shows the same table.
    const again = await post("/api/reports/builder/preview", query);
    assert.deepEqual(again.data.rows, data.rows);
  });

  test("DASH-02: an open period only reports estimates (SH-02)", async () => {
    const { data } = await post("/api/reports/builder/preview", {
      ...dashboard.reportBuilderQueryFixture,
      period: { startDate: "2026-11-01", endDate: "2026-11-01" },
    });
    assert.equal(data.period.status, "open");
    for (const row of data.rows)
      for (const cell of row.values) assert.equal(cell.finality, "estimate");
  });

  test("the empty scenario returns a preview without rows", async () => {
    setScenario("empty");
    const { data } = await post(
      "/api/reports/builder/preview",
      dashboard.reportBuilderQueryFixture,
    );
    assert.equal(data.rows.length, 0);
  });
});

describe("saved reports and schedules · F36", () => {
  test("F36: a saved report is created, listed, updated and archived", async () => {
    const created = await post("/api/reports/saved", {
      name: "Tamu per kanal",
      query: dashboard.reportBuilderQueryFixture,
    });
    assert.equal(created.data.status, "active");
    const list = await get("/api/reports/saved", { limit: 25 });
    assert.equal(list.data[0].id, created.data.id);
    assert.equal(list.data.length, 2);
    const renamed = await patch(`/api/reports/saved/${created.data.id}`, {
      name: "Tamu per kanal 2",
      status: "archived",
    });
    assert.equal(renamed.data.status, "archived");
    assert.equal(renamed.data.name, "Tamu per kanal 2");
    const missing = await failure(
      patch("/api/reports/saved/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        name: "x",
      }),
    );
    assert.equal(missing.code, "SAVED_REPORT_NOT_FOUND");
  });

  test("F36: a schedule is created, listed and paused", async () => {
    const created = await post("/api/reports/schedules", {
      savedReportId: dashboard.savedReportIdFixture,
      frequency: "monthly",
      timeOfDay: "08:00",
      dayOfMonth: 1,
      format: "xlsx",
      recipients: ["owner@cafelegend.id"],
    });
    assert.equal(created.data.isEnabled, true);
    assert.ok(created.data.nextRunAt);
    const list = await get("/api/reports/schedules", { limit: 25 });
    assert.equal(list.data.length, 2);
    const paused = await patch(`/api/reports/schedules/${created.data.id}`, {
      frequency: "monthly",
      timeOfDay: "08:00",
      dayOfMonth: 1,
      format: "xlsx",
      recipients: ["owner@cafelegend.id"],
      isEnabled: false,
    });
    assert.equal(paused.data.isEnabled, false);
    assert.equal(paused.data.nextRunAt, null);
  });

  test("DASH-04: a schedule for a report that splits by person is refused until approval", async () => {
    const personal = await post("/api/reports/saved", {
      name: "Penjualan per karyawan",
      query: {
        ...dashboard.reportBuilderQueryFixture,
        metricCodes: ["net_sales", "transaction_count"],
        groupBy: ["employee"],
        filters: [],
        sort: undefined,
      },
    });
    const error = await failure(
      post("/api/reports/schedules", {
        savedReportId: personal.data.id,
        frequency: "daily",
        timeOfDay: "07:00",
        format: "csv",
        recipients: ["owner@cafelegend.id"],
      }),
    );
    assert.equal(error.code, "EXPORT_PII_APPROVAL_REQUIRED");
    assert.equal(error.status, 403);
  });
});
