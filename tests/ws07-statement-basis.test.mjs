// Statement data basis (bead legend-6mla; PRD v1.7 §3.19 Tutup Periode):
// every statement says `closed_snapshot` or `live` and the months it covers.
// Pure contract, no database.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import { cafeLegendAccountingFixtures as fixtures } from "../packages/shared/src/accounting/fixtures.ts";
import * as web from "../apps/web/src/features/ws07-statements/lib.ts";

const { statementBasisFor, monthsInRange } = accounting;
const entity = fixtures.legalEntity.id;
const row = (period, status) => ({ period, status });
const sep = row("2026-09", "closed");
const oct = row("2026-10", "closed");
const nov = row("2026-11", "open");

describe("statementBasisFor", () => {
  test("closed_snapshot when every month in range is closed", () => {
    const result = statementBasisFor([sep, oct, nov], {
      from: "2026-09-01",
      to: "2026-10-31",
    });
    assert.deepEqual(result, {
      basis: "closed_snapshot",
      periodKeys: ["2026-09", "2026-10"],
      closedPeriodKeys: ["2026-09", "2026-10"],
      openPeriodKeys: [],
    });
  });

  test("live when one month in range is open", () => {
    const result = statementBasisFor([sep, oct, nov], {
      from: "2026-10-01",
      to: "2026-11-30",
    });
    assert.equal(result.basis, "live");
    assert.deepEqual(result.periodKeys, ["2026-10", "2026-11"]);
    assert.deepEqual(result.closedPeriodKeys, ["2026-10"]);
    assert.deepEqual(result.openPeriodKeys, ["2026-11"]);
  });

  test("a month with no fiscal period row is live", () => {
    const result = statementBasisFor([sep], {
      from: "2026-09-01",
      to: "2026-10-31",
    });
    assert.equal(result.basis, "live");
    assert.deepEqual(result.openPeriodKeys, ["2026-10"]);
  });

  test("cumulative also depends on earlier open months", () => {
    const periods = [row("2026-08", "open"), sep, oct];
    const range = { from: "2026-10-01", to: "2026-10-31" };
    assert.equal(statementBasisFor(periods, range).basis, "closed_snapshot");
    const cumulative = statementBasisFor(periods, {
      ...range,
      cumulative: true,
    });
    assert.equal(cumulative.basis, "live");
    assert.deepEqual(cumulative.periodKeys, ["2026-10"]);
    assert.deepEqual(cumulative.closedPeriodKeys, ["2026-10"]);
    assert.deepEqual(cumulative.openPeriodKeys, ["2026-08"]);
  });

  test("invalid or capped range is live with no keys", () => {
    for (const range of [
      { from: "bad", to: "2026-10-31" },
      { from: "2026-10-31", to: "2026-09-01" },
      { from: "1900-01-01", to: "2026-10-31" },
    ]) {
      const result = statementBasisFor([sep, oct], range);
      assert.equal(result.basis, "live");
      assert.deepEqual(result.periodKeys, []);
    }
    assert.equal(
      monthsInRange("2025-12-15", "2026-01-02").join(),
      "2025-12,2026-01",
    );
  });

  test("web statementBasis uses the same rule", () => {
    const periods = [sep, oct, nov];
    for (const [from, to, cumulative] of [
      ["2026-09-01", "2026-10-31", false],
      ["2026-10-01", "2026-11-30", false],
      ["2026-11-01", "2026-11-30", true],
    ]) {
      const shared = statementBasisFor(periods, { from, to, cumulative });
      const mapped = web.statementBasis(periods, from, to, { cumulative });
      assert.equal(
        mapped.basis,
        shared.basis === "closed_snapshot" ? "official" : "estimate",
      );
      assert.deepEqual(mapped.closed, shared.closedPeriodKeys);
      assert.deepEqual(mapped.open, shared.openPeriodKeys);
    }
  });
});

describe("statement responses carry basis and periods", () => {
  const periods = fixtures.fiscalPeriods;

  test("closed P&L is closed_snapshot with its months", () => {
    const pl = accounting.buildProfitAndLoss(
      fixtures.accounts,
      fixtures.ledgerLines,
      {
        legalEntityId: entity,
        from: "2026-09-01",
        to: "2026-10-31",
        periods,
      },
    );
    assert.equal(pl.basis, "closed_snapshot");
    assert.deepEqual(pl.periodKeys, ["2026-09", "2026-10"]);
    assert.deepEqual(pl.closedPeriodKeys, ["2026-09", "2026-10"]);
  });

  test("November fixtures are live; no periods given is live", () => {
    const { statements } = fixtures;
    for (const report of [
      statements.trialBalance,
      statements.profitAndLossNovember,
      statements.balanceSheet,
      statements.cashFlowNovember,
    ]) {
      assert.equal(report.basis, "live");
      assert.deepEqual(report.periodKeys, ["2026-11"]);
      assert.deepEqual(report.closedPeriodKeys, []);
    }
    const bare = accounting.buildBalanceSheet(
      fixtures.accounts,
      fixtures.ledgerLines,
      {
        legalEntityId: entity,
        asOf: "2026-10-31",
      },
    );
    assert.equal(bare.basis, "live");
  });

  test("closed as-of balance sheet is closed_snapshot", () => {
    const bs = accounting.buildBalanceSheet(
      fixtures.accounts,
      fixtures.ledgerLines,
      {
        legalEntityId: entity,
        asOf: "2026-10-31",
        periods,
      },
    );
    assert.equal(bs.basis, "closed_snapshot");
    assert.deepEqual(bs.periodKeys, ["2026-10"]);
    const tb = accounting.buildTrialBalance(
      fixtures.accounts,
      fixtures.ledgerLines,
      entity,
      "2026-10-31",
      periods,
    );
    assert.equal(tb.basis, "closed_snapshot");
  });

  test("equity October fixture is closed_snapshot", () => {
    const eq = fixtures.statements.equityChangesOctober;
    assert.equal(eq.basis, "closed_snapshot");
    assert.deepEqual(eq.periodKeys, ["2026-10"]);
  });

  test("schema rejects inconsistent basis", () => {
    const pl = fixtures.statements.profitAndLossNovember;
    const bad = (patch) =>
      accounting.profitAndLossSchema.safeParse({ ...pl, ...patch }).success;
    assert.equal(bad({}), true);
    assert.equal(
      bad({ basis: "closed_snapshot" }),
      false,
      "open month claimed closed",
    );
    assert.equal(bad({ periodKeys: ["2026-10"] }), false, "wrong months");
    assert.equal(bad({ periodKeys: [] }), false);
    assert.equal(
      bad({ closedPeriodKeys: ["2026-10"] }),
      false,
      "closed not in periodKeys",
    );
    assert.equal(bad({ periodKeys: ["2026-13"] }), false, "bad period key");
    const { basis, ...missing } = pl;
    assert.equal(
      accounting.profitAndLossSchema.safeParse(missing).success,
      false,
    );
    assert.equal(basis, "live");
  });

  test("multi-entity basis is closed_snapshot only if every entity is", () => {
    const closed = accounting.buildProfitAndLoss(
      fixtures.accounts,
      fixtures.ledgerLines,
      {
        legalEntityId: entity,
        from: "2026-10-01",
        to: "2026-10-31",
        periods,
      },
    );
    const live = fixtures.statements.profitAndLossNovember;
    const parse = (basis, entities, to) =>
      accounting.multiEntityProfitAndLossSchema.safeParse({
        from: entities[0].from,
        to,
        basis,
        periodKeys: entities[0].periodKeys,
        entities,
        combinedNetProfitIdr: entities.reduce((t, e) => t + e.netProfitIdr, 0),
      }).success;
    assert.equal(parse("closed_snapshot", [closed], closed.to), true);
    assert.equal(parse("live", [closed], closed.to), false);
    assert.equal(parse("live", [live], live.to), true);
    assert.equal(parse("closed_snapshot", [live], live.to), false);
  });
});
