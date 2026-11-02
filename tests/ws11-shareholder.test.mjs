// Shareholder dashboard (WS-11 FE, bead legend-ik9g; PRD v1.7 §3 F35, §4 Alur
// O; SH-01, SH-02, DASH-02). Loads the screen's view model and mock with Node
// type stripping; the screen itself is exercised in e2e/legend-ik9g.mock.spec.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import { roleTemplate } from "../packages/shared/src/access/roles.ts";
import * as board from "../apps/web/src/features/ws11-shareholder/board.ts";
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

  test("SH-02: the shareholder role can open no source report, so no tile links to one", () => {
    const permissions = roleTemplate("shareholder").permissions;
    for (const tile of layout.tiles)
      assert.equal(
        board.permittedReportPath(tile, permissions),
        null,
        tile.key,
      );
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
      for (const code of tile.metricCodes)
        assert.notEqual(
          board.metricCell(result, code),
          null,
          `${tile.key} ${code}`,
        );
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
