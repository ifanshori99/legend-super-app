// Report builder (WS-11 FE, bead legend-x9r2; PRD v1.7 §3 F36 "Report
// Builder", DASH-01, DASH-02, DASH-04). No database: loads the shared
// dashboard contract, the builder's pure rules and its mock endpoints with
// Node type stripping. The screen is exercised in e2e/legend-x9r2.mock.spec.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as builder from "../apps/web/src/features/ws11-report-builder/builder.ts";
import "../apps/web/src/features/ws11-report-builder/mock.ts";
// Read-only: the viewer's runs are the reference figures (DASH-02).
import {
  buildReportRuns,
  buildSalesRuns,
} from "../apps/web/src/features/ws11-reports/mock.ts";
import { buildPreviewResult } from "../apps/web/src/features/ws11-report-builder/mock-preview.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

// Tenant user ids a schedule is sent to (the server resolves their emails).
const USER_A = "0d0c4f6a-5a39-4c0a-9f43-2f1d8e5b7a01";
const USER_B = "5b7e2c91-6d84-4e1b-8a52-9c3f0d4e6b02";

afterEach(() => {
  resetMocks();
  setScenario("normal");
});

const post = (path, body) => dispatchMock({ method: "POST", path, body });
const get = (path, query = {}) => dispatchMock({ method: "GET", path, query });
const patch = (path, body) => dispatchMock({ method: "PATCH", path, body });
const postKeyed = (path, body, key) =>
  dispatchMock({
    method: "POST",
    path,
    body,
    headers: { "Idempotency-Key": key },
  });
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
      recipientUserIds: [USER_A, USER_A, USER_B],
    };
    assert.deepEqual(
      builder.scheduleSettings({ ...base, frequency: "daily" }),
      {
        frequency: "daily",
        timeOfDay: "07:00",
        dayOfWeek: null,
        dayOfMonth: null,
        format: "pdf",
        recipientUserIds: [USER_A, USER_B],
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
    // Day buckets run in date order; net_sales sorts desc inside each bucket.
    assert.equal(data.bucket, "day");
    const starts = data.rows.map((row) => row.bucketStart);
    assert.deepEqual(starts, [...starts].sort());
    for (const row of data.rows) assert.equal(row.bucketStart, row.bucketEnd);
    for (const start of new Set(starts)) {
      const sales = data.rows
        .filter((row) => row.bucketStart === start)
        .map((row) => row.values[0].value.valueIdr);
      assert.deepEqual(
        sales,
        [...sales].sort((x, y) => y - x),
      );
    }
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

describe("builder mock · same figures as the viewer · DASH-02", () => {
  test("DASH-02: the open business day previews the owner board's net sales, guests and transactions", () => {
    const { rows } = buildPreviewResult({
      metricCodes: ["net_sales", "pax", "transaction_count"],
      period: { startDate: "2026-11-01", endDate: "2026-11-01" },
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    assert.deepEqual(
      rows[0].values.map((cell) => cell.value),
      [
        { unit: "idr", valueIdr: 7_420_000 },
        { unit: "count", value: 148 },
        { unit: "count", value: 96 },
      ],
    );
  });

  test("DASH-02: every viewer run with one split previews the same cells in the builder", () => {
    let compared = 0;
    for (const run of buildSalesRuns()) {
      // The viewer labels the outlet split by name, the builder by id.
      if (run.groupBy.includes("outlet")) continue;
      const parsed = dashboard.reportBuilderQuerySchema.safeParse({
        metricCodes: run.definitions.map((definition) => definition.code),
        period: {
          startDate: run.period.startDate,
          endDate: run.period.endDate,
        },
        outletIds: run.outletFilter.outletIds,
        groupBy: run.groupBy,
        filters: [],
        bucket: "total",
        limit: 1000,
      });
      if (!parsed.success) continue;
      const preview = buildPreviewResult(parsed.data);
      // The viewer shows no number for a metric the API answers unavailable
      // (brief 284 T4); the preview's own list is not this test's concern.
      const shown = (_, index) =>
        run.availability[index].status === "available";
      assert.deepEqual(
        preview.rows.map((row) => ({
          dimensions: row.dimensions,
          values: row.values.filter(shown).map((cell) => cell.value),
        })),
        run.rows.map((row) => ({
          dimensions: row.dimensions,
          values: row.values.filter(shown).map((cell) => cell.value),
        })),
        `${run.reportCode} ${run.groupBy.join(",")} ${run.period.startDate}..${run.period.endDate}`,
      );
      compared += 1;
    }
    assert.ok(compared >= 10, `compared only ${compared} runs`);
  });

  test("legend-yf2b: every viewer run of batch A/B previews the same cells and availability in the builder", () => {
    const salesCodes = new Set(buildSalesRuns().map((run) => run.reportCode));
    let compared = 0;
    for (const run of buildReportRuns()) {
      if (salesCodes.has(run.reportCode)) continue;
      if (run.groupBy.includes("outlet")) continue;
      const parsed = dashboard.reportBuilderQuerySchema.safeParse({
        metricCodes: run.definitions.map((definition) => definition.code),
        period: {
          startDate: run.period.startDate,
          endDate: run.period.endDate,
        },
        outletIds: run.outletFilter.outletIds,
        groupBy: run.groupBy,
        filters: [],
        bucket: "total",
        limit: 1000,
      });
      if (!parsed.success) continue;
      const preview = buildPreviewResult(parsed.data);
      const label = `${run.reportCode} ${run.groupBy.join(",")} ${run.period.startDate}..${run.period.endDate}`;
      assert.deepEqual(preview.availability, run.availability, label);
      assert.deepEqual(
        preview.rows.map((row) => ({
          dimensions: row.dimensions,
          values: row.values.map((cell) => cell.value),
        })),
        run.rows.map((row) => ({
          dimensions: row.dimensions,
          values: row.values.map((cell) => cell.value),
        })),
        label,
      );
      compared += 1;
    }
    assert.ok(compared >= 30, `compared only ${compared} runs`);
  });

  test("legend-yf2b: a payments metric previews its share of the open day's net sales", () => {
    const { rows } = buildPreviewResult({
      metricCodes: ["tax_collected", "failed_payment_count"],
      period: { startDate: "2026-11-01", endDate: "2026-11-01" },
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    assert.deepEqual(
      rows[0].values.map((cell) => cell.value),
      [
        { unit: "idr", valueIdr: 742_000 },
        { unit: "count", value: 3 },
      ],
    );
  });

  test("DASH-02: a metric the mock model has no source for is no data, never an invented number", () => {
    const code = dashboard.reportMetricDefinitions.find(
      (metric) => metric.code === "shower_sessions",
    )?.code;
    if (code === undefined) return;
    const { rows } = buildPreviewResult({
      metricCodes: [code],
      period: { startDate: "2026-10-01", endDate: "2026-10-31" },
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    for (const row of rows) assert.equal(row.values[0].value, null);
  });

  test("DASH-02: a filter keeps the share of its values, so parts add up to the total", () => {
    const base = {
      metricCodes: ["net_sales"],
      period: { startDate: "2026-10-01", endDate: "2026-10-31" },
      filters: [],
      bucket: "total",
      limit: 100,
    };
    const byChannel = buildPreviewResult({ ...base, groupBy: ["channel"] });
    const filtered = buildPreviewResult({
      ...base,
      groupBy: [],
      filters: [{ key: "channel", values: ["qr", "pos"] }],
    });
    const sum = byChannel.rows
      .filter((row) => ["qr", "pos"].includes(row.dimensions[0].value))
      .reduce((total, row) => total + row.values[0].value.valueIdr, 0);
    assert.equal(filtered.rows[0].values[0].value.valueIdr, sum);
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
      recipientUserIds: [USER_A],
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
      recipientUserIds: [USER_A],
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
        recipientUserIds: [USER_A],
      }),
    );
    assert.equal(error.code, "EXPORT_PII_APPROVAL_REQUIRED");
    assert.equal(error.status, 403);
  });
});

describe("DASH-04 on every path that mails a report", () => {
  const schedule = {
    frequency: "daily",
    timeOfDay: "07:00",
    format: "csv",
    recipientUserIds: [USER_A],
  };
  const personalQuery = {
    ...dashboard.reportBuilderQueryFixture,
    metricCodes: ["net_sales", "transaction_count"],
    groupBy: ["employee"],
    filters: [],
    sort: undefined,
  };

  test("DASH-04: a report with an enabled schedule cannot be changed into a person split", async () => {
    const error = await failure(
      patch(`/api/reports/saved/${dashboard.savedReportIdFixture}`, {
        query: personalQuery,
      }),
    );
    assert.equal(error.code, "EXPORT_PII_APPROVAL_REQUIRED");
    assert.equal(error.status, 403);
  });

  test("DASH-04: a paused schedule of a report that became personal cannot be re-enabled", async () => {
    const id = dashboard.reportScheduleIdFixture;
    const fixture = dashboard.reportScheduleFixture;
    const settings = {
      frequency: fixture.frequency,
      timeOfDay: fixture.timeOfDay,
      dayOfWeek: fixture.dayOfWeek,
      dayOfMonth: fixture.dayOfMonth,
      format: fixture.format,
      recipientUserIds: [...fixture.recipientUserIds],
    };
    await patch(`/api/reports/schedules/${id}`, {
      ...settings,
      isEnabled: false,
    });
    await patch(`/api/reports/saved/${dashboard.savedReportIdFixture}`, {
      query: personalQuery,
    });
    const error = await failure(
      patch(`/api/reports/schedules/${id}`, { ...settings, isEnabled: true }),
    );
    assert.equal(error.code, "EXPORT_PII_APPROVAL_REQUIRED");
  });

  test("DASH-04: the gate reads the stored query; a filter by person is refused too", async () => {
    const saved = await post("/api/reports/saved", {
      name: "Omzet Rani",
      query: {
        ...personalQuery,
        groupBy: [],
        filters: [{ key: "employee", values: ["Rani"] }],
      },
    });
    const error = await failure(
      post("/api/reports/schedules", {
        savedReportId: saved.data.id,
        ...schedule,
      }),
    );
    assert.equal(error.code, "EXPORT_PII_APPROVAL_REQUIRED");
  });
});

describe("idempotent creates", () => {
  const KEY = "0b8f2b8e-6f1d-4c3a-9d2e-1f0a9b8c7d6e";

  test("a repeated save with the same Idempotency-Key makes one report", async () => {
    const body = {
      name: "Omzet per jam",
      query: dashboard.reportBuilderQueryFixture,
    };
    const first = await postKeyed("/api/reports/saved", body, KEY);
    const again = await postKeyed("/api/reports/saved", body, KEY);
    assert.equal(again.data.id, first.data.id);
    const list = await get("/api/reports/saved", { limit: 25 });
    assert.equal(list.data.length, 2);
    const reused = await failure(
      postKeyed("/api/reports/saved", { ...body, name: "Lain" }, KEY),
    );
    assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
  });
});
