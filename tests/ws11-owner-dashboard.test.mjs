// Owner dashboard, part 1 (WS-11 FE, bead legend-k8fk; PRD v1.7 §3 F34
// "Dashboard Owner": Ringkasan Real-time, Operasional, Shower Room, Kursi &
// WFC; DASH-01, DASH-03). Runs with the root node:test suite, no database: it
// loads the shared dashboard contract, the web app's mock runtime and the
// screen's own view model with Node type stripping.
//
// The screen itself is exercised in e2e/legend-k8fk.mock.spec.ts; this file
// proves the data path the screen depends on: every tile cites a registry
// metric, the dashboard period and a source report (DASH-01), and every number
// is a run of that same report with the same split (DASH-02). The shared mock
// owners (bead legend-ssu7) must serve both endpoints without double
// registration.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as insights from "../apps/web/src/features/ws11-owner-dashboard/insights.ts";
import * as board from "../apps/web/src/features/ws11-owner-dashboard/board.ts";
// Side effect: registers the owner layout and runs through the shared owners.
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
// GET /api/feedback has one mock owner: the CRM review queue (legend-i026).
import "../apps/web/src/features/ws08-crm-360/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

const layout = dashboard.cafeLegendDashboardFixtures.ownerLayout;
const runs = dashboard.ownerDashboardBoardRuns;
const period = { startDate: "2026-11-01", endDate: "2026-11-01" };

afterEach(() => {
  resetMocks();
  setScenario("normal");
});

async function get(path, query = {}) {
  return dispatchMock({ method: "GET", path, query });
}

async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}

function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

describe("owner dashboard part 1 · DASH-01", () => {
  test("DASH-01: every owner part-1 tile carries a registry definition, the dashboard period and a source-report link", () => {
    const tiles = board.ownerBoardTiles(layout);
    assert.ok(
      tiles.length >= 20,
      `expected the part-1 tiles, got ${tiles.length}`,
    );
    for (const tile of tiles) {
      assert.ok(
        board.OWNER_BOARD_SECTIONS.includes(tile.section),
        `tile ${tile.key} is not in a part-1 section`,
      );
      const reportName = board.ownerBoardTileReportName(tile);
      assert.ok(reportName, `tile ${tile.key} has no source report name`);
      const path = board.ownerBoardTilePath(tile, layout);
      assert.ok(path, `tile ${tile.key} has no drill-down path`);
      assert.match(path, /^\/reports\//);
      assert.match(path, /startDate=2026-11-01/);
      assert.match(path, /endDate=2026-11-01/);
      assert.match(path, /outletId=/);
      if (tile.kind === "metric")
        for (const code of tile.metricCodes)
          assert.ok(
            dashboard.reportMetricByCode.has(code),
            `metric ${code} of ${tile.key} is not a registry row`,
          );
    }
    // Part 2 (cost & margin, finance, alerts…) belongs to bead legend-gb03 and
    // must not leak into this screen.
    assert.ok(layout.tiles.some((tile) => tile.section === "finance"));
    assert.ok(tiles.every((tile) => tile.section !== "finance"));
  });

  test("DASH-01: the mocked dashboard endpoint answers with the owner layout", async () => {
    const response = await get("/api/dashboards/owner");
    assert.equal(response.data.dashboard, "owner");
    assert.equal(response.data.tiles.length, layout.tiles.length);
    assert.deepEqual(response.data.availableOutlets, layout.availableOutlets);
  });

  test("DASH-01: the mocked review queue serves only ratings, never complaints", async () => {
    const response = await get("/api/feedback", { kind: "rating", limit: 3 });
    assert.ok(response.data.length >= 1);
    assert.ok(response.data.every((item) => item.kind === "rating"));
    assert.ok(response.data.every((item) => item.rating !== null));
  });
});

describe("owner dashboard part 1 · DASH-02", () => {
  test("DASH-02: every part-1 tile reads its own source report with the dashboard period, outlets and split", () => {
    const inputs = board.ownerBoardRunInputs(layout);
    assert.equal(inputs.length, 18);
    for (const input of inputs) {
      const run = runs[input.reportCode];
      assert.ok(run, `no fixture run for ${input.reportCode}`);
      assert.deepEqual(input.period, period);
      assert.deepEqual(input.outletIds, layout.availableOutlets);
      assert.deepEqual(run.groupBy, input.groupBy);
      assert.deepEqual(run.outletFilter.outletIds, layout.availableOutlets);

      const report = dashboard.reportByCode(input.reportCode);
      assert.ok(report, `no catalog report for ${input.reportCode}`);
      assert.deepEqual(
        run.definitions.map((definition) => definition.code),
        report.metrics,
      );
      for (const row of run.rows) {
        assert.deepEqual(
          row.dimensions.map((dimension) => dimension.key),
          run.groupBy,
        );
        assert.equal(row.values.length, report.metrics.length);
      }
      // A run whose metrics the API answers unavailable has no number to show
      // (brief 284 T4): it reads as empty, every other run has rows.
      const allUnavailable = run.availability.every(
        (entry) => entry.status === "unavailable",
      );
      assert.equal(board.isReportResultEmpty(run), allUnavailable);
    }
  });

  test("DASH-02: the review tile exposes its available rating and count", () => {
    const run = runs["crm.reviews"];
    assert.deepEqual(
      run.availability.map(({ metricCode, status }) => ({
        metricCode,
        status,
      })),
      [
        { metricCode: "review_rating", status: "available" },
        { metricCode: "review_count", status: "available" },
      ],
    );
    assert.deepEqual(board.metricCell(run, "review_rating"), {
      unit: "decimal",
      value: "4.6000",
    });
    assert.deepEqual(board.metricCell(run, "review_count"), {
      unit: "count",
      value: 10,
    });
  });

  test("DASH-02: the channel split adds up to the same net sales the summary tile shows", () => {
    const summarySales = board.idrOf(
      board.metricCell(runs["sales.target"], "net_sales"),
    );
    const channelSales = runs["sales.per_channel"].rows.reduce((sum, row) => {
      const cell = row.values.find((value) => value.metricCode === "net_sales");
      return sum + (board.idrOf(cell?.value ?? null) ?? 0);
    }, 0);
    assert.equal(channelSales, summarySales);
    assert.equal(
      board.idrOf(board.metricCell(runs["sales.target"], "sales_target")),
      24_000_000,
    );
  });

  test("DASH-02: percentages, decimals and durations format from the registry value", () => {
    assert.equal(board.formatPercent("30.9167"), "30,9");
    assert.equal(board.formatPercent("62.5000"), "62,5");
    assert.equal(board.formatDecimal("1.8400"), "1,84");
    assert.equal(board.formatDecimal("42.7000"), "42,7");
    assert.equal(board.sharePercent(4_150_000, 7_420_000), 55.9);
    assert.deepEqual(board.durationParts(718), { minutes: 11, seconds: 58 });
    assert.deepEqual(board.durationParts(45), { minutes: 0, seconds: 45 });
  });

  test("DASH-02: running a source report over the mock returns its registry row values", async () => {
    const response = await post("/api/reports/run", {
      reportCode: "sales.target",
      period,
      groupBy: [],
      limit: 100,
    });
    assert.equal(response.data.reportCode, "sales.target");
    assert.deepEqual(
      response.data.rows[0].values.map((value) => value.metricCode),
      ["net_sales", "sales_target", "target_achievement_pct"],
    );
    assert.equal(response.data.rows[0].values[0].value.valueIdr, 7_420_000);
    assert.equal(response.data.rows[0].values[2].value.value, "30.9167");
  });

  test("DASH-02: a split the fixture was not built for fails like the API", async () => {
    const error = await failure(
      post("/api/reports/run", {
        reportCode: "sales.target",
        period,
        groupBy: ["outlet"],
        limit: 100,
      }),
    );
    assert.equal(error.status, 400);
    assert.equal(error.code, "REPORT_FILTER_NOT_SUPPORTED");
  });
});

describe("owner dashboard part 1 · DASH-03", () => {
  test("DASH-03: one dashboard load reads one period, one outlet scope and each source report once", () => {
    const inputs = board.ownerBoardRunInputs(layout);
    const codes = inputs.map((input) => input.reportCode);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual(codes, [...codes].sort());
    for (const input of inputs) {
      assert.deepEqual(input.period, period);
      assert.deepEqual(input.outletIds, layout.availableOutlets);
    }
    // The dashboard's own monitoring period is the open business day, so every
    // number carries the estimate label until the books close (SH-02).
    assert.equal(layout.monitoringPeriod.status, "open");
    assert.equal(layout.monitoringPeriod.startDate, period.startDate);
  });
});

describe("owner dashboard part 1 · mock owners (legend-ssu7)", () => {
  test("legend-ssu7: the shared dashboard owner serves the owner layout without a second registration", async () => {
    const response = await get("/api/dashboards/owner");
    assert.equal(response.data.dashboard, "owner");
    // Unregistered kinds fail honestly instead of answering another screen's
    // layout (this suite does not import the shareholder screen).
    const error = await failure(get("/api/dashboards/shareholder"));
    assert.equal(error.status, 404);
  });

  test("legend-ssu7: the shared report-run owner serves every part-1 report", async () => {
    for (const input of board.ownerBoardRunInputs(layout)) {
      const response = await post("/api/reports/run", input);
      assert.equal(response.data.reportCode, input.reportCode);
      assert.ok(response.data.rows.length >= 1);
    }
  });

  test("DASH-01: ?mock=empty keeps the layout and returns runs without rows", async () => {
    setScenario("empty");
    const layoutResponse = await get("/api/dashboards/owner");
    assert.equal(layoutResponse.data.tiles.length, layout.tiles.length);
    const run = await post("/api/reports/run", {
      reportCode: "sales.target",
      period,
      groupBy: [],
      limit: 100,
    });
    assert.deepEqual(run.data.rows, []);
    const reviews = await get("/api/feedback", { kind: "rating", limit: 3 });
    assert.deepEqual(reviews.data, []);
  });

  test("DASH-01: an unknown report code is a 404, not an empty table", async () => {
    const error = await failure(
      post("/api/reports/run", {
        reportCode: "sales.daily",
        period,
        groupBy: [],
        limit: 100,
      }),
    );
    assert.equal(error.status, 404);
    assert.equal(error.code, "REPORT_NOT_FOUND");
  });
});

describe("owner dashboard part 2 (legend-gb03)", () => {
  test("DASH-01: every part-2 tile cites a registry metric and a source report, with its own period", () => {
    for (const section of insights.OWNER_INSIGHT_SECTIONS) {
      const tiles = insights.insightTilesOf(layout, section);
      assert.ok(tiles.length > 0, `no tiles in ${section}`);
      for (const tile of tiles) {
        if (tile.kind === "metric")
          for (const code of tile.metricCodes)
            assert.ok(dashboard.reportMetricByCode.has(code), code);
        if (section === "daily_summary") continue;
        const path = board.ownerBoardTilePath(tile, layout);
        assert.match(path ?? "", /^\/reports\//, tile.key);
        assert.match(path, /startDate=2026-11-01/);
        assert.match(path, /endDate=2026-11-01/);
      }
    }
  });

  test("DASH-02: every part-2 tile run is served by the mock with the tile's period", async () => {
    for (const section of insights.OWNER_INSIGHT_SECTIONS)
      for (const tile of insights.insightTilesOf(layout, section)) {
        const input = insights.insightTileRunInput(tile, layout);
        if (input === null) continue;
        const response = await post("/api/reports/run", input);
        assert.equal(response.data.reportCode, input.reportCode);
        assert.ok(response.data.rows.length > 0, tile.key);
      }
  });

  test("DASH-02: the trend months run for every cost report and the running month is an estimate", async () => {
    const months = insights.monthPeriods(
      layout.businessDate,
      insights.TREND_MONTHS,
    );
    assert.equal(months.length, 4);
    assert.equal(months.at(-1).closed, false);
    for (const month of months) {
      const prime = await post(
        "/api/reports/run",
        insights.insightRunInput(layout, "finance.prime_cost", month),
      );
      const food = await post(
        "/api/reports/run",
        insights.insightRunInput(layout, "inventory.food_cost", month),
      );
      assert.deepEqual(
        board.metricCell(prime.data, "food_cost_pct"),
        board.metricCell(food.data, "food_cost_pct"),
      );
      assert.equal(
        insights.cellFinality(prime.data, "prime_cost_pct"),
        month.closed ? "final" : "estimate",
      );
    }
  });

  test("DASH-02: the multi-outlet total adds up the owner board's channel split of the same day", async () => {
    const tile = insights.insightTile(
      layout,
      insights.INSIGHT_TILE.multiOutlet,
    );
    const input = insights.insightTileRunInput(tile, layout);
    assert.deepEqual(input.groupBy, ["channel"]);
    assert.match(board.ownerBoardTilePath(tile, layout), /groupBy=channel/);
    const response = await post("/api/reports/run", input);
    const total = (code) => insights.summedCell(response.data, code);
    // Same day as the real-time tiles: Rp7.420.000, 96 transactions, 148 pax.
    assert.equal(
      board.idrOf(total("net_sales")),
      board.idrOf(board.metricCell(runs["sales.target"], "net_sales")),
    );
    assert.equal(
      board.countOf(total("transaction_count")),
      board.countOf(
        board.metricCell(runs["sales.transactions"], "transaction_count"),
      ),
    );
    assert.equal(
      board.countOf(total("pax")),
      board.countOf(board.metricCell(runs["traffic.pax"], "pax")),
    );
  });

  test("DASH-02: closed months tie to the books and the running month to the board day", async () => {
    const [, september, october, running] = insights.monthPeriods(
      layout.businessDate,
      insights.TREND_MONTHS,
    );
    const statement = async (month) =>
      (
        await post(
          "/api/reports/run",
          insights.insightRunInput(layout, "finance.income_statement", month),
        )
      ).data;
    const profitShare = (
      await import("../packages/shared/src/accounting/index.ts")
    ).cafeLegendAccountingFixtures.profitShare.runs;
    const sep = await statement(september);
    const oct = await statement(october);
    const now = await statement(running);
    assert.equal(
      board.idrOf(board.metricCell(sep, "net_profit")),
      Number(profitShare.september.periodNetProfitIdr),
    );
    assert.equal(
      board.idrOf(board.metricCell(oct, "net_profit")),
      Number(profitShare.october.periodNetProfitIdr),
    );
    assert.equal(board.idrOf(board.metricCell(oct, "net_sales")), 412_800_000);
    assert.equal(
      board.idrOf(board.metricCell(now, "net_sales")),
      board.idrOf(board.metricCell(runs["sales.target"], "net_sales")),
    );
    // Net profit never exceeds what is left after food and labor cost.
    for (const month of [sep, oct]) {
      const sales = board.idrOf(board.metricCell(month, "net_sales"));
      const gross = board.idrOf(board.metricCell(month, "gross_profit"));
      const net = board.idrOf(board.metricCell(month, "net_profit"));
      assert.ok(net < gross && gross < sales);
    }
  });
});
