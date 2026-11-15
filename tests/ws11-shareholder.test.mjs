// Shareholder dashboard (WS-11 FE, bead legend-ik9g; PRD v1.7 §3 F35, §4 Alur
// O; SH-01, SH-02, DASH-02). Loads the screen's view model and mock with Node
// type stripping; the screen itself is exercised in e2e/legend-ik9g.mock.spec.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import { roleTemplate } from "../packages/shared/src/access/roles.ts";
import * as board from "../apps/web/src/features/ws11-shareholder/board.ts";
// The browser glob registers feature mocks in folder order, so the owner
// insights and the report viewer own their runs before the shareholder mock;
// load them the same way so DASH-02 is checked across screens.
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
import "../apps/web/src/features/ws11-reports/mock.ts";
import { cafeLegendAccountingFixtures } from "../packages/shared/src/accounting/index.ts";
import { shareholderLayoutFixture as layout } from "../apps/web/src/features/ws11-shareholder/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

afterEach(() => {
  resetMocks();
  setScenario("normal");
});

const post = (input) =>
  dispatchMock({ method: "POST", path: "/api/reports/run", body: input });

describe("shareholder dashboard · SH-01 closed official, running estimate", () => {
  test("SH-01: business tiles run over closed periods only; the running period is a separate estimate run", async () => {
    const closed = board.closedPeriodOf(layout);
    const running = board.runningPeriodOf(layout);
    assert.deepEqual(closed, {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    assert.ok(running && running.startDate > closed.endDate);
    for (const input of board.shareholderRunInputs(layout)) {
      const isRunning = input.period.startDate === running.startDate;
      const result = (await post(input)).data;
      assert.equal(board.isOfficial(result), !isRunning, input.reportCode);
      if (!isRunning) assert.ok(input.period.endDate <= closed.endDate);
    }
  });

  test("SH-01: year-to-date ends with the last closed month", () => {
    assert.deepEqual(board.ytdPeriodOf(layout), {
      startDate: "2026-01-01",
      endDate: "2026-10-31",
    });
  });

  test("SH-01: a closed-looking run whose books are open is not official", async () => {
    const [input] = board.shareholderRunInputs(layout);
    const result = (await post(input)).data;
    const notClosed = {
      ...result,
      period: { ...result.period, accountingPeriodClosed: false },
    };
    assert.equal(board.isOfficial(notClosed), false);
  });

  test("SH-01: period labels read as month, range, or year-to-date", () => {
    assert.equal(
      board.formatPeriod({ startDate: "2026-10-01", endDate: "2026-10-31" }),
      "Oktober 2026",
    );
    assert.match(
      board.formatPeriod({ startDate: "2026-01-01", endDate: "2026-10-31" }),
      /Jan.*Okt 2026/,
    );
    assert.match(
      board.formatPeriod({ startDate: "2026-11-01", endDate: "2026-11-05" }),
      /^1 – 5 Nov 2026$/,
    );
    assert.match(
      board.formatPeriod({ startDate: "2026-11-01", endDate: "2026-11-01" }),
      /^1 Nov 2026$/,
    );
  });
});

describe("shareholder dashboard · SH-02 own data only", () => {
  test("SH-02: the personal view holds only the caller's rows and no other person", async () => {
    const mine = (
      await dispatchMock({
        method: "GET",
        path: "/api/accounting/my-profit-share",
      })
    ).data;
    assert.ok(mine.distributionHistory.length > 0);
    for (const row of mine.distributionHistory) {
      assert.equal(row.shareholderId, mine.shareholderId);
    }
    assert.ok(!board.isMyProfitShareEmpty(mine));
    const others = cafeLegendAccountingFixtures.profitShare.shareholders.filter(
      (row) => row.id !== mine.shareholderId,
    );
    assert.ok(others.length > 0);
    const json = JSON.stringify(mine);
    for (const other of others) {
      assert.ok(!json.includes(other.id), other.id);
      assert.ok(!json.includes(other.name), other.name);
    }
  });

  test("SH-02: documents are published for shareholders only", async () => {
    const page = await dispatchMock({
      method: "GET",
      path: "/api/accounting/shareholder-documents",
      query: { limit: 20 },
    });
    assert.ok(page.data.length > 0);
    assert.equal(board.visibleDocuments(page.data).length, page.data.length);
    assert.equal(
      board.visibleDocuments([
        { ...page.data[0], publishedAt: null, publishedBy: null },
        { ...page.data[0], visibility: "management" },
      ]).length,
      0,
    );
  });

  test("SH-02: no tile run is split by a person-level dimension", () => {
    for (const input of board.shareholderRunInputs(layout)) {
      assert.equal(
        dashboard.selectionContainsPersonalData(input),
        false,
        input.reportCode,
      );
    }
  });

  test("SH-01: a shareholder links only to aggregate reports, without the kelola permission (legend-5bjh)", () => {
    const permissions = roleTemplate("shareholder").permissions;
    assert.deepEqual(
      permissions.filter((code) => code.startsWith("report.")),
      ["report.aggregate.view"],
    );
    assert.equal(permissions.includes(board.REPORT_AREA_PERMISSION), false);
    for (const tile of layout.tiles) {
      const path = board.permittedReportPath(tile, permissions);
      const report =
        tile.kind === "metric" ? dashboard.reportByCode(tile.reportCode) : null;
      if (report === null) assert.equal(path, null, tile.key);
      else if (dashboard.reportAcceptsAggregateView(report))
        assert.equal(path, report.route, tile.key);
      else assert.equal(path, null, tile.key);
    }
  });

  test("SH-01: once the report area opens, a tile links only to an aggregate report", () => {
    const permissions = [
      ...roleTemplate("shareholder").permissions,
      board.REPORT_AREA_PERMISSION,
    ];
    for (const tile of layout.tiles) {
      const path = board.permittedReportPath(tile, permissions);
      if (tile.kind !== "metric") {
        assert.equal(path, null, tile.key);
        continue;
      }
      const report = dashboard.reportByCode(tile.reportCode);
      assert.equal(path, report.route, tile.key);
      assert.equal(report.containsPersonalData, false, tile.key);
      assert.equal(
        dashboard.selectionContainsPersonalData({
          groupBy: report.dimensions,
          filters: [],
        }),
        false,
        tile.key,
      );
    }
  });
});

describe("shareholder dashboard · DASH-02 / DASH-03 states", () => {
  test("DASH-02: every business tile has a served run for its own period", async () => {
    for (const tile of layout.tiles) {
      if (tile.kind !== "metric") continue;
      const input = board.runInput(
        layout,
        tile.reportCode,
        board.tilePeriod(layout, tile),
      );
      const result = (await post(input)).data;
      for (const code of tile.metricCodes) {
        // The API answers some metrics unavailable (ebitda, ...): the run
        // carries that entry and no number (brief 284 T4).
        const entry = result.availability.find((e) => e.metricCode === code);
        if (entry?.status === "unavailable") {
          assert.equal(
            board.metricCell(result, code),
            null,
            `${tile.key} ${code}`,
          );
          continue;
        }
        assert.notEqual(
          board.metricCell(result, code),
          null,
          `${tile.key} ${code}`,
        );
      }
    }
  });

  test("DASH-03: ?mock=empty keeps the layout and returns empty runs, profit share and documents", async () => {
    setScenario("empty");
    const [input] = board.shareholderRunInputs(layout);
    assert.ok(board.isReportResultEmpty((await post(input)).data));
    const mine = (
      await dispatchMock({
        method: "GET",
        path: "/api/accounting/my-profit-share",
      })
    ).data;
    assert.ok(board.isMyProfitShareEmpty(mine));
    const docs = await dispatchMock({
      method: "GET",
      path: "/api/accounting/shareholder-documents",
      query: { limit: 20 },
    });
    assert.equal(docs.data.length, 0);
  });
});

describe("shareholder dashboard · DASH-02 one key, one number across screens", () => {
  const closed = () => board.closedPeriodOf(layout);
  const cell = async (reportCode, metricCode, period = closed()) =>
    board.metricCell(
      (await post(board.runInput(layout, reportCode, period))).data,
      metricCode,
    );

  test("DASH-02: closed-month guests and spend per guest equal the report viewer's sales.per_pax", async () => {
    const pax = await cell("traffic.pax", "pax");
    const perPax = await cell("traffic.pax", "avg_spend_per_pax");
    assert.deepEqual(pax, await cell("sales.per_pax", "pax"));
    assert.deepEqual(perPax, await cell("sales.per_pax", "avg_spend_per_pax"));
    assert.deepEqual(pax, { unit: "count", value: 8_222 });
    // avg_spend_per_pax has no source in the API yet (registry
    // source_not_built): both runs carry no number (brief 284 T4).
    assert.equal(perPax, null);
  });

  test("DASH-02: closed-month net sales tie across sales.daily, sales.per_pax and the income statement", async () => {
    const net = await cell("sales.daily", "net_sales");
    assert.deepEqual(net, { unit: "idr", valueIdr: 412_800_000 });
    assert.deepEqual(await cell("sales.per_pax", "net_sales"), net);
    assert.deepEqual(await cell("finance.income_statement", "net_sales"), net);
    const gross = await cell("sales.daily", "gross_sales");
    const discount = await cell("sales.daily", "discount_amount");
    const refund = await cell("sales.daily", "refund_amount");
    assert.equal(
      gross.valueIdr - discount.valueIdr - refund.valueIdr,
      net.valueIdr,
    );
  });

  test("DASH-02: closed-month gross profit and net profit agree with the owner income statement and the profit-share run", async () => {
    const statementGross = await cell(
      "finance.income_statement",
      "gross_profit",
    );
    assert.deepEqual(
      await cell("finance.gross_margin", "gross_profit"),
      statementGross,
    );
    assert.deepEqual(statementGross, { unit: "idr", valueIdr: 273_686_400 });
    const octoberNet = Number(
      cafeLegendAccountingFixtures.profitShare.runs.october.periodNetProfitIdr,
    );
    for (const code of ["finance.income_statement", "finance.ebitda"])
      assert.deepEqual(await cell(code, "net_profit"), {
        unit: "idr",
        valueIdr: octoberNet,
      });
  });

  test("DASH-02: the running estimate's net profit is the profit-share estimate's basis", async () => {
    const running = board.runningPeriodOf(layout);
    // The mock rebuilds the fixture's whole-month estimate as month to date
    // (legend-zc3g), so the basis is the served estimate, not the fixture row.
    const estimate = (
      await dispatchMock({
        method: "GET",
        path: "/api/accounting/my-profit-share",
      })
    ).data.estimates[0];
    assert.deepEqual(
      await cell(board.RUNNING_ESTIMATE_REPORT, "net_profit", running),
      { unit: "idr", valueIdr: Number(estimate.estimatedNetProfitIdr) },
    );
  });
});
