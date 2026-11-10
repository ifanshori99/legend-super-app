// WS-11 demo fixtures agree with each other (I4, DASH-02; beads legend-wr5z and
// legend-zc3g): one metric, one outlet and one period have one value in every
// fixture (owner board, management home, shareholder, owner insights, report
// viewer, metric registry, tile values). Loads the mocks with Node type
// stripping the same way the browser glob registers them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as metrics from "../packages/shared/src/metrics/index.ts";
import { cafeLegendAccountingFixtures } from "../packages/shared/src/accounting/index.ts";
import {
  ownerInsightRuns,
  ownerMonthIncomes,
} from "../apps/web/src/features/ws11-owner-dashboard/insights-mock.ts";
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
import "../apps/web/src/features/ws11-management-home/mock.ts";
import "../apps/web/src/features/ws11-reports/mock.ts";
import { shareholderLayoutFixture as shareholderLayout } from "../apps/web/src/features/ws11-shareholder/mock.ts";
import * as shareholderBoard from "../apps/web/src/features/ws11-shareholder/board.ts";
import { dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";
import {
  hasMockReportRun,
  registerMockReportRuns,
} from "../apps/web/src/lib/mock/handlers/report-runs.ts";
import {
  periodFigures,
  runKey as viewerRunKey,
} from "../apps/web/src/features/ws11-reports/mock.ts";
import * as dayModel from "../apps/web/src/features/ws11-reports/mock-day-model.ts";

const ownerLayout = dashboard.cafeLegendDashboardFixtures.ownerLayout;
const managementLayout = dashboard.cafeLegendManagementLayoutFixture;

const post = (body) =>
  dispatchMock({ method: "POST", path: "/api/reports/run", body }).then(
    (response) => response.data,
    () => null,
  );

/** Every unsplit run any fixture serves, as { run, source } entries. */
async function collectRuns() {
  const collected = [];
  const add = (source, run) => {
    if (run.reportCode !== null && run.groupBy.length === 0)
      collected.push({ source, run });
  };
  for (const run of Object.values(dashboard.ownerDashboardBoardRuns))
    add("owner board", run);
  for (const run of Object.values(dashboard.managementDashboardKpiRuns))
    add("management home", run);
  for (const run of Object.values(ownerInsightRuns)) add("owner insights", run);
  add("contract fixture", dashboard.reportRunResultFixture);
  for (const input of shareholderBoard.shareholderRunInputs(
    shareholderLayout,
  )) {
    const run = await post(input);
    if (run !== null) add("shareholder", run);
  }
  // The report viewer: every catalog report, over the periods the screens use.
  const periods = [
    { startDate: ownerLayout.businessDate, endDate: ownerLayout.businessDate },
    { startDate: dayModel.MONTH_START, endDate: ownerLayout.businessDate },
    { startDate: dayModel.LAST_MONTH.start, endDate: dayModel.LAST_MONTH.end },
  ];
  for (const report of dashboard.reportCatalog)
    for (const period of periods) {
      const run = await post({
        reportCode: report.code,
        period,
        outletIds: [...ownerLayout.availableOutlets],
        groupBy: [],
        filters: [],
        bucket: "total",
        limit: 100,
      });
      if (run !== null) add("report viewer", run);
    }
  return collected;
}

function cellsOf({ source, run }) {
  const outlets =
    run.outletFilter.kind === "outlets"
      ? [...run.outletFilter.outletIds].sort().join(",")
      : run.outletFilter.kind;
  return run.rows
    .filter((row) => row.dimensions.length === 0)
    .flatMap((row) =>
      row.values
        .filter((cell) => cell.value !== null)
        .map((cell) => ({
          key: `${cell.metricCode}|${outlets}|${run.period.startDate}|${run.period.endDate}`,
          value: JSON.stringify(cell.value),
          label: `${source}:${run.reportCode}`,
        })),
    );
}

describe("ws11 fixtures · one metric, outlet and period, one value (I4)", () => {
  test("every unsplit cell with the same metric, outlet and period has the same value", async () => {
    const byKey = new Map();
    for (const entry of await collectRuns())
      for (const cell of cellsOf(entry)) {
        const seen = byKey.get(cell.key);
        if (seen === undefined) byKey.set(cell.key, cell);
        else
          assert.equal(
            cell.value,
            seen.value,
            `${cell.key}: ${cell.label} says ${cell.value}, ${seen.label} says ${seen.value}`,
          );
      }
    assert.ok(byKey.size > 40, "the collector found the fixtures");
  });

  test("wr5z: the open day's net sales is Rp7.420.000 on the owner board, the management home and the day model", () => {
    const net = (run) =>
      run.rows[0].values.find((cell) => cell.metricCode === "net_sales").value;
    const expected = { unit: "idr", valueIdr: 7_420_000 };
    assert.deepEqual(
      net(dashboard.ownerDashboardBoardRuns["sales.target"]),
      expected,
    );
    assert.deepEqual(
      net(dashboard.managementDashboardKpiRuns["sales.per_channel"]),
      expected,
    );
    assert.equal(
      dayModel.periodAtoms({
        startDate: ownerLayout.businessDate,
        endDate: ownerLayout.businessDate,
      }).net,
      7_420_000,
    );
    assert.deepEqual(
      metrics.estimateQueryResponseFixture.data.series[0].points[0].value,
      expected,
    );
    assert.deepEqual(
      dashboard.ownerTodaySalesValuesFixture.values[0].value,
      expected,
    );
  });

  test("wr5z: no metric name in the registry fixtures is the English 'Table turnover'", () => {
    const row = metrics.cafeLegendMetricDefinitions.find(
      (definition) => definition.code === "table_turnover",
    );
    assert.equal(row.name, "Perputaran meja");
  });
});

describe("ws11 fixtures · one business day and instant on every screen (zc3g)", () => {
  test("owner, management and shareholder describe 1 Nov 2026 at the same instant", () => {
    for (const layout of [ownerLayout, managementLayout, shareholderLayout]) {
      assert.equal(layout.businessDate, "2026-11-01", layout.dashboard);
      assert.equal(
        layout.generatedAt,
        dashboard.ownerBoardGeneratedAt,
        layout.dashboard,
      );
    }
  });

  test("zc3g: the running accounting period is month to date and an estimate, never a projection", () => {
    const running = shareholderBoard.runningPeriodOf(shareholderLayout);
    assert.deepEqual(running, {
      startDate: "2026-11-01",
      endDate: shareholderLayout.businessDate,
    });
    assert.equal(shareholderLayout.monitoringPeriod.status, "open");
    // Month to date on 1 Nov is the day itself: 7.420.000 net sales.
    return post(
      shareholderBoard.runInput(
        shareholderLayout,
        shareholderBoard.RUNNING_ESTIMATE_REPORT,
        running,
      ),
    ).then((run) => {
      assert.equal(run.rows[0].values[0].finality, "estimate");
      assert.deepEqual(
        run.rows[0].values.find((cell) => cell.metricCode === "net_sales")
          .value,
        { unit: "idr", valueIdr: 7_420_000 },
      );
    });
  });

  test("zc3g: the personal profit-share estimate is the same month-to-date net profit", async () => {
    const running = shareholderBoard.runningPeriodOf(shareholderLayout);
    const run = await post(
      shareholderBoard.runInput(
        shareholderLayout,
        shareholderBoard.RUNNING_ESTIMATE_REPORT,
        running,
      ),
    );
    const netProfit = run.rows[0].values.find(
      (cell) => cell.metricCode === "net_profit",
    ).value;
    const mine = (
      await dispatchMock({
        method: "GET",
        path: "/api/accounting/my-profit-share",
      })
    ).data;
    assert.equal(mine.estimates.length > 0, true);
    for (const estimate of mine.estimates) {
      assert.equal(estimate.label, "estimate");
      assert.equal(Number(estimate.estimatedNetProfitIdr), netProfit.valueIdr);
    }
    // The raw accounting fixture is a whole-month figure; the demo no longer
    // serves it for the running period.
    assert.notEqual(
      Number(
        cafeLegendAccountingFixtures.profitShare.myProfitShare.estimates[0]
          .estimatedNetProfitIdr,
      ),
      netProfit.valueIdr,
    );
  });

  test("zc3g: year to date is January..July plus the owner's closed August..October", async () => {
    const ytd = shareholderBoard.ytdPeriodOf(shareholderLayout);
    const statement = await post(
      shareholderBoard.runInput(
        shareholderLayout,
        "finance.income_statement",
        ytd,
      ),
    );
    const value = (code) =>
      statement.rows[0].values.find((cell) => cell.metricCode === code).value
        .valueIdr;
    const closedMonths = ownerInsightRuns;
    let ownerNet = 0;
    let ownerProfit = 0;
    for (const run of Object.values(closedMonths)) {
      if (
        run.reportCode !== "finance.income_statement" ||
        !run.period.accountingPeriodClosed
      )
        continue;
      assert.ok(run.period.startDate >= "2026-08-01");
      ownerNet += run.rows[0].values.find(
        (cell) => cell.metricCode === "net_sales",
      ).value.valueIdr;
      ownerProfit += run.rows[0].values.find(
        (cell) => cell.metricCode === "net_profit",
      ).value.valueIdr;
    }
    assert.ok(value("net_sales") > ownerNet);
    assert.ok(value("net_profit") > ownerProfit);
    assert.equal(
      value("net_sales") - value("cogs"),
      value("gross_profit"),
      "net - COGS = gross",
    );
    assert.equal(value("net_sales"), 2_305_000_000 + ownerNet);
  });

  test("zc3g: promo cost and discount stay two clearly named metrics", () => {
    const run = Object.values(ownerInsightRuns).find(
      (entry) => entry.reportCode === "crm.promo_cost",
    );
    const names = Object.fromEntries(
      run.definitions.map((definition) => [definition.code, definition.name]),
    );
    assert.equal(names.promo_cost, "Biaya promo");
    assert.equal(names.discount_amount, "Nilai diskon");
    for (const entry of Object.values(ownerInsightRuns)) {
      if (entry.reportCode !== "crm.promo_cost") continue;
      const [promo, discount] = ["promo_cost", "discount_amount"].map(
        (code) =>
          entry.rows[0].values.find((cell) => cell.metricCode === code).value
            .valueIdr,
      );
      // Promo cost is the promo-driven part of all discounts.
      assert.ok(promo <= discount);
    }
  });
});

describe("ws11 fixtures · metric registry and tile values agree with the reports (I4)", () => {
  test("October net sales, guests and food cost are the closed month of every screen", () => {
    const [netSales, pax, foodCost] = ["net_sales", "pax", "food_cost_pct"].map(
      (code) =>
        metrics.queryResponseFixture.data.series.find(
          (series) => series.metricCode === code,
        ).points[0].value,
    );
    assert.deepEqual(netSales, { unit: "idr", valueIdr: 412_800_000 });
    assert.deepEqual(pax, { unit: "count", value: 8_222 });
    assert.deepEqual(foodCost, { unit: "percent", value: "33.7000" });
    assert.deepEqual(
      dashboard.closedMonthSalesValuesFixture.values[0].value,
      netSales,
    );
  });

  test("the daily series and daily rows are the report viewer's day model", () => {
    for (const point of metrics.netSalesDailySeries.points)
      assert.equal(
        point.value.valueIdr,
        dayModel.periodAtoms({
          startDate: point.bucketStart,
          endDate: point.bucketEnd,
        }).net,
        point.bucketStart,
      );
    const channelRow = metrics.metricDailyRows.find(
      (row) => row.dimension !== null,
    );
    const total = metrics.metricDailyRows.find((row) => row.dimension === null);
    const split = dayModel.distribute(
      total.value.valueIdr,
      dayModel.SPLITS.channel.weights.net,
    );
    assert.equal(channelRow.dimension.value, dayModel.SPLITS.channel.values[0]);
    assert.equal(channelRow.value.valueIdr, split[0]);
  });

  test("the closed October channel split of the contract run is the day model's and adds up to the month", () => {
    const run = dashboard.reportRunResultFixture;
    const october = dayModel.periodAtoms({
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    const net = dayModel.distribute(
      october.net,
      dayModel.SPLITS.channel.weights.net,
    );
    const tx = dayModel.distribute(
      october.tx,
      dayModel.SPLITS.channel.weights.tx,
    );
    run.rows.forEach((row, index) => {
      assert.equal(
        row.dimensions[0].value,
        dayModel.SPLITS.channel.values[index],
      );
      assert.equal(row.values[0].value.valueIdr, net[index]);
      assert.equal(row.values[1].value.value, tx[index]);
    });
    assert.equal(
      run.rows.reduce((sum, row) => sum + row.values[0].value.valueIdr, 0),
      412_800_000,
    );
  });

  test("the tile value fixture: target is the owner's sales.target and the comparison is the previous day", () => {
    const [entry] = dashboard.ownerTodaySalesValuesFixture.values;
    const target = dashboard.ownerDashboardBoardRuns[
      "sales.target"
    ].rows[0].values.find((cell) => cell.metricCode === "sales_target").value;
    assert.deepEqual(entry.target, target);
    assert.deepEqual(
      entry.comparison,
      metrics.compareMetricValues(entry.value, {
        unit: "idr",
        valueIdr: dayModel.periodAtoms({
          startDate: "2026-10-31",
          endDate: "2026-10-31",
        }).net,
      }),
    );
    assert.equal(entry.finality, "estimate");
  });

  test("the schedule sample picks tenant users by UUID, not by email", () => {
    const schedule = dashboard.reportScheduleFixture;
    assert.equal("recipients" in schedule, false);
    assert.ok(schedule.recipientUserIds.length >= 1);
    for (const id of schedule.recipientUserIds)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });
});

describe("ws11 fixtures · wave 2 (legend-3nuv)", () => {
  const october = {
    startDate: dayModel.LAST_MONTH.start,
    endDate: dayModel.LAST_MONTH.end,
  };
  const cell = (run, code) =>
    run.rows[0].values.find((entry) => entry.metricCode === code).value;

  test("3nuv: October guests are one number on the shareholder board and the report viewer", async () => {
    const viewer = await post({
      reportCode: "sales.per_pax",
      period: october,
      outletIds: [...ownerLayout.availableOutlets],
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    const shareholder = await post(
      shareholderBoard.runInput(
        shareholderLayout,
        "sales.per_pax",
        shareholderBoard.closedPeriodOf(shareholderLayout),
      ),
    );
    assert.deepEqual(cell(viewer, "pax"), { unit: "count", value: 8_222 });
    assert.deepEqual(cell(shareholder, "pax"), cell(viewer, "pax"));
  });

  test("3nuv: the viewer's October cost structure is the owner insights' month table", async () => {
    const viewer = await post({
      reportCode: "finance.income_statement",
      period: october,
      outletIds: [...ownerLayout.availableOutlets],
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    const month = ownerMonthIncomes.find(
      (entry) => entry.startDate === october.startDate,
    );
    assert.deepEqual(cell(viewer, "cogs"), {
      unit: "idr",
      valueIdr: month.cogs,
    });
    assert.deepEqual(cell(viewer, "net_profit"), {
      unit: "idr",
      valueIdr: month.netProfit,
    });
  });

  test("a business day's purchases are a fraction of its net sales and match the viewer", async () => {
    const day = {
      startDate: ownerLayout.businessDate,
      endDate: ownerLayout.businessDate,
    };
    const management =
      dashboard.managementDashboardKpiRuns["purchasing.supplier_due"];
    const purchase = cell(management, "purchase_total").valueIdr;
    assert.ok(
      purchase < 7_420_000,
      "one day of purchases below a day of sales",
    );
    const viewer = await post({
      reportCode: "purchasing.supplier_due",
      period: day,
      outletIds: [...ownerLayout.availableOutlets],
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    assert.deepEqual(cell(viewer, "purchase_total"), {
      unit: "idr",
      valueIdr: purchase,
    });
  });
});

describe("ws11 mock report runs · the run key carries the outlet (legend-3nuv)", () => {
  const outletA = ownerLayout.availableOutlets[0];
  const outletB = "b7d2c1a0-4e3f-4a5b-8c6d-0e1f2a3b4c5d";
  const day = { startDate: "2031-03-03", endDate: "2031-03-03" };
  const run = (outletId, valueIdr) =>
    dashboard.reportResultSchema.parse({
      reportCode: "sales.target",
      period: {
        ...day,
        bucket: "total",
        status: "open",
        accountingPeriodClosed: false,
      },
      bucket: "total",
      outletFilter: { kind: "outlets", outletIds: [outletId] },
      definitions: [dashboard.reportMetricByCode.get("net_sales")].map(
        (definition) =>
          metrics.metricDefinitionRefSchema.parse({
            id: definition.id,
            code: definition.code,
            version: definition.version,
            name: definition.name,
            ownerModule: definition.ownerModule,
            formula: definition.formula,
            unit: definition.unit,
            aggregation: definition.aggregation,
            dimensions: definition.dimensions,
            grain: definition.grain,
            officiality: definition.officiality,
            sourceReport: definition.sourceReport,
          }),
      ),
      availability: [{ metricCode: "net_sales", status: "available" }],
      groupBy: [],
      rows: [
        {
          bucketStart: day.startDate,
          bucketEnd: day.endDate,
          dimensions: [],
          values: [
            {
              metricCode: "net_sales",
              value: { unit: "idr", valueIdr },
              finality: "estimate",
            },
          ],
        },
      ],
      generatedAt: dashboard.ownerBoardGeneratedAt,
      rowLimit: 100,
      truncated: false,
    });
  const body = (outletIds) => ({
    reportCode: "sales.target",
    period: day,
    ...(outletIds === undefined ? {} : { outletIds }),
    groupBy: [],
    filters: [],
    bucket: "total",
    limit: 100,
  });
  const net = (result) => result.rows[0].values[0].value.valueIdr;

  test("two outlets can register different numbers for one report, split and period", async () => {
    registerMockReportRuns({ a: run(outletA, 1_000), b: run(outletB, 2_000) });
    assert.equal(net(await post(body([outletA]))), 1_000);
    assert.equal(net(await post(body([outletB]))), 2_000);
    assert.equal(hasMockReportRun("sales.target", [], day, [outletA]), true);
    assert.equal(
      hasMockReportRun("sales.target", [], day, [
        "c0000000-0000-4000-8000-000000000000",
      ]),
      false,
    );
  });

  test("a request without outlets is still answered, by the first run of the question", async () => {
    assert.equal(net(await post(body(undefined))), 1_000);
    assert.equal(hasMockReportRun("sales.target", [], day), true);
  });

  test("the same outlet registered twice with different numbers fails loudly (DASH-02)", () => {
    assert.throws(
      () => registerMockReportRuns({ again: run(outletA, 9_999) }),
      /registered twice with different numbers/,
    );
  });

  test("an outlet nobody registered gets the contract's filter error, not another outlet's number", async () => {
    const error = await dispatchMock({
      method: "POST",
      path: "/api/reports/run",
      body: body(["c0000000-0000-4000-8000-000000000000"]),
    }).then(
      () => null,
      (reason) => reason,
    );
    assert.equal(error?.code, "REPORT_FILTER_NOT_SUPPORTED");
  });
});

describe("ws11 mock report runs · the run key carries the bucket (legend-e0fhh)", () => {
  const outletA = ownerLayout.availableOutlets[0];
  const period = { startDate: "2031-05-05", endDate: "2031-05-07" };
  const days = ["2031-05-05", "2031-05-06", "2031-05-07"];
  const run = (bucket, rows) =>
    dashboard.reportResultSchema.parse({
      reportCode: "sales.target",
      period: {
        ...period,
        bucket,
        status: "open",
        accountingPeriodClosed: false,
      },
      bucket,
      outletFilter: { kind: "outlets", outletIds: [outletA] },
      definitions: [dashboard.reportMetricByCode.get("net_sales")].map(
        (definition) =>
          metrics.metricDefinitionRefSchema.parse({
            id: definition.id,
            code: definition.code,
            version: definition.version,
            name: definition.name,
            ownerModule: definition.ownerModule,
            formula: definition.formula,
            unit: definition.unit,
            aggregation: definition.aggregation,
            dimensions: definition.dimensions,
            grain: definition.grain,
            officiality: definition.officiality,
            sourceReport: definition.sourceReport,
          }),
      ),
      availability: [{ metricCode: "net_sales", status: "available" }],
      groupBy: [],
      rows: rows.map(([bucketStart, bucketEnd, valueIdr]) => ({
        bucketStart,
        bucketEnd,
        dimensions: [],
        values: [
          {
            metricCode: "net_sales",
            value: { unit: "idr", valueIdr },
            finality: "estimate",
          },
        ],
      })),
      generatedAt: dashboard.ownerBoardGeneratedAt,
      rowLimit: 100,
      truncated: false,
    });
  const totalRun = run("total", [[period.startDate, period.endDate, 6_000]]);
  const dayRun = run(
    "day",
    days.map((date, index) => [date, date, (index + 1) * 1_000]),
  );
  const body = (bucket) => ({
    reportCode: "sales.target",
    period,
    outletIds: [outletA],
    groupBy: [],
    filters: [],
    bucket,
    limit: 100,
  });
  const nets = (result) =>
    result.rows.map((row) => row.values[0].value.valueIdr);

  test("a total run and a day run of one question register side by side", () => {
    registerMockReportRuns({ total: totalRun, day: dayRun });
  });

  test("a day request gets the daily rows", async () => {
    const result = await post(body("day"));
    assert.equal(result.bucket, "day");
    assert.deepEqual(nets(result), [1_000, 2_000, 3_000]);
    assert.deepEqual(
      result.rows.map((row) => row.bucketStart),
      days,
    );
  });

  test("a total request gets the total, and a request without bucket defaults to total", async () => {
    const result = await post(body("total"));
    assert.equal(result.bucket, "total");
    assert.deepEqual(nets(result), [6_000]);
    const withoutBucket = body("total");
    delete withoutBucket.bucket;
    assert.deepEqual(nets(await post(withoutBucket)), [6_000]);
  });

  test("a bucket nobody registered gets the contract's filter error, not a silent total", async () => {
    const error = await dispatchMock({
      method: "POST",
      path: "/api/reports/run",
      body: body("week"),
    }).then(
      () => null,
      (reason) => reason,
    );
    assert.equal(error?.code, "REPORT_FILTER_NOT_SUPPORTED");
  });

  test("hasMockReportRun takes an optional bucket, default total", () => {
    assert.equal(
      hasMockReportRun("sales.target", [], period, [outletA], "day"),
      true,
    );
    assert.equal(hasMockReportRun("sales.target", [], period, [outletA]), true);
    assert.equal(
      hasMockReportRun("sales.target", [], period, [outletA], "week"),
      false,
    );
    assert.equal(
      hasMockReportRun("sales.target", [], period, undefined, "day"),
      true,
    );
  });
});

describe("ws11 mock reports · review findings (legend-3nuv)", () => {
  const outletA = ownerLayout.availableOutlets[0];
  const outletB = "b7d2c1a0-4e3f-4a5b-8c6d-0e1f2a3b4c5d";

  test("1: the viewer's own run key carries the outlet, so another outlet's run never hides it", () => {
    const base = dashboard.reportRunResultFixture;
    const withOutlet = (outletIds) => ({
      ...base,
      outletFilter: { kind: "outlets", outletIds },
    });
    assert.notEqual(
      viewerRunKey(withOutlet([outletA])),
      viewerRunKey(withOutlet([outletB])),
    );
    assert.equal(
      viewerRunKey(withOutlet([outletA, outletB])),
      viewerRunKey(withOutlet([outletB, outletA])),
    );
    assert.notEqual(
      viewerRunKey(withOutlet([outletA])),
      viewerRunKey({ ...base, outletFilter: { kind: "all" } }),
    );
  });

  test("2: an all-outlet run answers only a request naming every outlet of the tenant", async () => {
    const day = { startDate: "2031-04-07", endDate: "2031-04-07" };
    const served = await post({
      reportCode: "sales.target",
      period: {
        startDate: dayModel.BUSINESS_DATE,
        endDate: dayModel.BUSINESS_DATE,
      },
      outletIds: [outletA],
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    const allRun = dashboard.reportResultSchema.parse({
      ...served,
      period: {
        ...day,
        bucket: "total",
        status: "open",
        accountingPeriodClosed: false,
      },
      outletFilter: { kind: "all" },
      rows: served.rows.map((row) => ({
        ...row,
        bucketStart: day.startDate,
        bucketEnd: day.endDate,
      })),
    });
    registerMockReportRuns({ all: allRun });
    const request = (outletIds) => ({
      reportCode: "sales.target",
      period: day,
      outletIds,
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    const tenantOutlets = cafeLegendFixtures.outlets.map((entry) => entry.id);
    assert.ok(tenantOutlets.length > 1, "the demo tenant has several outlets");
    // Naming every outlet of the tenant (in any order) gets the all-outlet run.
    for (const ids of [tenantOutlets, [...tenantOutlets].reverse()])
      assert.equal((await post(request(ids))).outletFilter.kind, "all");
    // A narrower or foreign request never gets all-outlet figures.
    assert.equal(await post(request([tenantOutlets[0]])), null);
    assert.equal(await post(request([outletB])), null);
    assert.equal(await post(request([...tenantOutlets, outletB])), null);
  });

  test("3: a range inside the closed October carries October's cost structure", () => {
    const share = (figures, key) => figures[key] / figures.net;
    const month = periodFigures({
      startDate: dayModel.LAST_MONTH.start,
      endDate: dayModel.LAST_MONTH.end,
    });
    const week = periodFigures({
      startDate: "2026-10-25",
      endDate: "2026-10-31",
    });
    assert.ok(Math.abs(share(week, "cogs") - 0.337) < 0.0005);
    assert.ok(Math.abs(share(week, "labor") - 0.245) < 0.0005);
    assert.ok(Math.abs(share(week, "cogs") - share(month, "cogs")) < 0.0005);
    assert.ok(week.net < month.net);
    // The running month keeps its own structure (COGS 31,2%).
    const today = periodFigures({
      startDate: dayModel.BUSINESS_DATE,
      endDate: dayModel.BUSINESS_DATE,
    });
    assert.ok(Math.abs(share(today, "cogs") - 0.312) < 0.0005);
  });
});
