// AP/AR, fixed assets and budgets (bead legend-m4zn; PRD v1.7 §3.19
// "Utang & Piutang", "Aset Tetap", "Anggaran"). Runs with the root node:test
// suite, no database: it loads the shared accounting contract, the feature's
// pure helpers and its mock handlers with Node type stripping. The screens are
// exercised in e2e/legend-m4zn.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  agingBucketIndex,
  agingBucketLabels,
  budgetVariance,
  buildAgingReport,
  cafeLegendAccountingFixtures as fixtures,
  depreciationForPeriod,
  straightLineSchedule,
} from "../packages/shared/src/accounting/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
// Registers every handler of the feature.
import "../apps/web/src/features/ws07-ap-assets/mock.ts";
import * as ap from "../apps/web/src/features/ws07-ap-assets/lib.ts";

const entity = fixtures.legalEntity.id;
const outlet = fixtures.outletId;
const asOf = fixtures.asOf;
const limits = fixtures.agingBucketLimits;
/** Deterministic valid ULID for idempotency keys (26 Crockford chars). */
const ulid = (n) => `01JBQ9A2B3C4D5E6F7G8H9${String(n).padStart(6, "0")}`;

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}
async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}
async function put(path, body) {
  return dispatchMock({ method: "PUT", path, body });
}
function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

afterEach(resetMocks);

// ---- Aging ---------------------------------------------------------------

describe("F19-Utang: aging", () => {
  test("F19-Utang: bucket labels, descriptors and indexes follow the tenant limits", () => {
    assert.deepEqual(agingBucketLabels(limits), [
      "current",
      "1-30",
      "31-60",
      "61-90",
      ">90",
    ]);
    const descriptors = ap.agingBucketDescriptors(agingBucketLabels(limits));
    assert.deepEqual(
      descriptors.map((bucket) => bucket.kind),
      ["current", "range", "range", "range", "over"],
    );
    assert.equal(descriptors[1].from, 1);
    assert.equal(descriptors[1].to, 30);
    assert.equal(descriptors[3].from, 61);
    assert.equal(descriptors[3].to, 90);
    assert.equal(descriptors[4].days, 90);
    assert.equal(descriptors[4].index, 4);

    assert.equal(agingBucketIndex("2026-11-10", asOf, limits), 0);
    assert.equal(agingBucketIndex("2026-10-15", asOf, limits), 1);
    assert.equal(agingBucketIndex("2026-08-31", asOf, limits), 3);
    assert.equal(agingBucketIndex("2026-05-01", asOf, limits), 4);
  });

  test("F19-Utang: the report groups open items by counterparty and the filters narrow the view", () => {
    const report = buildAgingReport(
      fixtures.openItems,
      "payable",
      asOf,
      limits,
    );
    assert.equal(report.rows.length, 3);
    assert.equal(report.totalIdr, 8_725_000);
    assert.equal(report.bucketTotals[1], 4_850_000);
    assert.equal(report.bucketTotals[3], 2_600_000);

    const summary = ap.agingSummary(report);
    assert.equal(summary.totalIdr, 8_725_000);
    assert.equal(summary.currentIdr, 1_275_000);
    assert.equal(summary.overdueIdr, 7_450_000);
    assert.equal(summary.counterpartyCount, 3);
    assert.deepEqual(summary.bucketCounts, [1, 1, 0, 1, 0]);

    const search = ap.filterAgingRows(report.rows, {
      query: "susu",
      overdueOnly: false,
    });
    assert.equal(search.length, 1);
    assert.equal(search[0].counterpartyName, "PT Susu Segar Bandung (contoh)");
    assert.equal(search[0].totalIdr, 2_600_000);

    const overdue = ap.filterAgingRows(report.rows, {
      query: "",
      overdueOnly: true,
    });
    assert.equal(overdue.length, 2);
    assert.deepEqual(ap.agingRowsTotals(overdue), {
      buckets: [0, 4_850_000, 0, 2_600_000, 0],
      totalIdr: 7_450_000,
    });
    assert.equal(
      ap.filterAgingRows(report.rows, {
        query: "tidak ada",
        overdueOnly: false,
      }).length,
      0,
    );

    const receivable = buildAgingReport(
      fixtures.openItems,
      "receivable",
      asOf,
      limits,
    );
    assert.equal(receivable.totalIdr, 6_500_000);
    const receivableSummary = ap.agingSummary(receivable);
    assert.equal(receivableSummary.currentIdr, 6_500_000);
    assert.equal(receivableSummary.overdueIdr, 0);
  });

  test("F19-Utang: the mock aging endpoint builds the report from fixture open items", async () => {
    const result = await get("/api/accounting/aging", {
      legalEntityId: entity,
      kind: "payable",
      asOf,
      outletId: outlet,
    });
    assert.equal(result.data.rows.length, 3);
    assert.equal(result.data.totalIdr, 8_725_000);
    assert.deepEqual(result.data.bucketLabels, agingBucketLabels(limits));

    const receivable = await get("/api/accounting/aging", {
      legalEntityId: entity,
      kind: "receivable",
      asOf,
      outletId: outlet,
    });
    assert.equal(receivable.data.totalIdr, 6_500_000);
  });
});

// ---- Fixed assets --------------------------------------------------------

describe("F19-Aset: fixed assets", () => {
  test("F19-Aset: book value, display code and straight-line schedule add up", () => {
    const [espresso, chiller] = fixtures.fixedAssets;
    assert.equal(ap.assetCode(espresso), "AST-000001");
    assert.equal(ap.assetCode(chiller), "AST-000002");
    assert.equal(ap.assetBookValueIdr(espresso), 94_500_000);

    const totals = ap.assetTotals(fixtures.fixedAssets);
    assert.equal(totals.acquisitionIdr, 114_000_000);
    assert.equal(totals.accumulatedIdr, 1_875_000);
    assert.equal(totals.bookValueIdr, 112_125_000);
    assert.equal(totals.activeCount, 2);
    assert.equal(totals.totalCount, 2);

    const schedule = straightLineSchedule(espresso);
    assert.equal(schedule.length, 60);
    assert.equal(schedule[0].period, "2026-10");
    assert.equal(schedule[0].amountIdr, 1_500_000);
    assert.equal(
      schedule.reduce((sum, row) => sum + row.amountIdr, 0),
      90_000_000,
    );
    assert.equal(depreciationForPeriod(espresso, "2026-10"), 1_500_000);
    assert.equal(depreciationForPeriod(espresso, "2026-11"), 1_500_000);
    assert.equal(depreciationForPeriod(espresso, "2026-09"), 0);
    assert.equal(depreciationForPeriod(chiller, "2026-10"), 375_000);
  });

  test("F19-Aset: disposal result and filters use the contract rules", () => {
    const espresso = fixtures.fixedAssets[0];
    assert.equal(ap.disposalPreviewIdr(espresso, 100_000_000), 5_500_000);
    const disposed = {
      ...espresso,
      status: "disposed",
      disposedOn: "2026-11-05",
      disposalProceedsIdr: 90_000_000,
    };
    assert.equal(ap.disposedResultIdr(disposed), -4_500_000);
    assert.equal(ap.disposalPreviewIdr(disposed, 1), null);

    assert.equal(
      ap.filterAssets(fixtures.fixedAssets, {
        query: "chiller",
        status: "all",
      }).length,
      1,
    );
    assert.equal(
      ap.filterAssets(fixtures.fixedAssets, {
        query: "AST-000002",
        status: "active",
      }).length,
      1,
    );
    assert.equal(
      ap.filterAssets(fixtures.fixedAssets, {
        query: "",
        status: "disposed",
      }).length,
      0,
    );
  });

  test("F19-Aset: the mock registers, depreciates, revalues and disposes an asset", async () => {
    const created = await post("/api/accounting/fixed-assets", {
      legalEntityId: entity,
      outletId: outlet,
      name: "Mesin uji F19",
      acquiredOn: "2026-11-03",
      costIdr: 12_000_000,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-11",
      sourceDocumentId: null,
      idempotencyKey: ulid(10),
    });
    assert.equal(created.data.status, "active");
    assert.equal(created.data.method, "straight_line");
    assert.equal(created.data.accumulatedDepreciationIdr, 0);

    const replay = await post("/api/accounting/fixed-assets", {
      legalEntityId: entity,
      outletId: outlet,
      name: "Mesin uji F19",
      acquiredOn: "2026-11-03",
      costIdr: 12_000_000,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-11",
      sourceDocumentId: null,
      idempotencyKey: ulid(10),
    });
    assert.equal(replay.data.id, created.data.id);

    const detail = await get(`/api/accounting/fixed-assets/${created.data.id}`);
    assert.equal(detail.data.schedule.length, 12);
    assert.equal(detail.data.schedule[0].period, "2026-11");
    assert.equal(detail.data.schedule[0].amountIdr, 1_000_000);

    const run = await post("/api/accounting/depreciation-runs", {
      legalEntityId: entity,
      period: "2026-11",
      idempotencyKey: ulid(11),
    });
    assert.equal(run.data.lines.length, 3);
    assert.equal(run.data.amountIdr, 2_875_000);
    assert.ok(run.data.journalEntryId);
    const rerun = await post("/api/accounting/depreciation-runs", {
      legalEntityId: entity,
      period: "2026-11",
      idempotencyKey: ulid(12),
    });
    assert.equal(rerun.data.id, run.data.id);
    assert.equal(rerun.data.amountIdr, 2_875_000);

    const afterRun = await get(
      `/api/accounting/fixed-assets/${created.data.id}`,
    );
    assert.equal(afterRun.data.asset.accumulatedDepreciationIdr, 1_000_000);
    assert.equal(ap.assetBookValueIdr(afterRun.data.asset), 11_000_000);

    const revalued = await post(
      `/api/accounting/fixed-assets/${created.data.id}/revalue`,
      {
        revaluedOn: "2026-11-05",
        newCarryingAmountIdr: 11_500_000,
        reason: "Uji revaluasi F19",
        idempotencyKey: ulid(13),
      },
    );
    assert.equal(revalued.data.accumulatedDepreciationIdr, 500_000);
    assert.equal(ap.assetBookValueIdr(revalued.data), 11_500_000);

    const disposed = await post(
      `/api/accounting/fixed-assets/${created.data.id}/dispose`,
      {
        disposedOn: "2026-11-05",
        proceedsIdr: 15_000_000,
        reason: "Uji pelepasan F19",
        idempotencyKey: ulid(14),
      },
    );
    assert.equal(disposed.data.status, "disposed");
    assert.equal(disposed.data.disposalProceedsIdr, 15_000_000);
    assert.equal(ap.disposedResultIdr(disposed.data), 3_500_000);

    const again = await failure(
      post(`/api/accounting/fixed-assets/${created.data.id}/dispose`, {
        disposedOn: "2026-11-06",
        proceedsIdr: 1_000_000,
        reason: "Percobaan kedua",
        idempotencyKey: ulid(15),
      }),
    );
    assert.equal(again.status, 409);
    assert.equal(again.code, "ASSET_ALREADY_DISPOSED");
  });
});

// ---- Budgets -------------------------------------------------------------

describe("F19-Anggaran: budgets", () => {
  test("F19-Anggaran: variance formatting and classification follow basis points", () => {
    assert.deepEqual(budgetVariance(100_000_000, 110_000_000), {
      varianceIdr: 10_000_000,
      varianceBp: 1_000,
    });
    assert.equal(ap.formatVarianceBp(1_000), "+10,0%");
    assert.equal(ap.formatVarianceBp(-1_000), "−10,0%");
    assert.equal(ap.formatVarianceBp(125), "+1,3%");
    assert.equal(ap.formatVarianceBp(0), "0,0%");
    assert.equal(ap.formatVarianceBp(null), null);

    assert.equal(ap.varianceState(1), "over");
    assert.equal(ap.varianceState(0), "on");
    assert.equal(ap.varianceState(-1), "under");

    const totals = ap.budgetTotals([
      { budgetIdr: 200, actualIdr: 150 },
      { budgetIdr: 0, actualIdr: 10 },
    ]);
    assert.equal(totals.budgetIdr, 200);
    assert.equal(totals.actualIdr, 160);
    assert.equal(totals.varianceIdr, -40);
    assert.equal(totals.varianceBp, -2_000);
    assert.equal(ap.formatVarianceBp(totals.varianceBp), "−20,0%");
  });

  test("F19-Anggaran: the mock upserts budgets and reports variance against posted journals", async () => {
    const before = await get("/api/accounting/budgets/vs-actual", {
      legalEntityId: entity,
      period: "2026-11",
      outletId: outlet,
    });
    assert.equal(before.data.length, 4);
    const revenue = before.data.find((row) => row.accountCode === "4101");
    assert.equal(revenue.budgetIdr, 180_000_000);
    assert.equal(revenue.actualIdr, 375_000);
    assert.equal(revenue.varianceIdr, -179_625_000);

    const account = fixtures.accountByCode("6109").id;
    const upserted = await put("/api/accounting/budgets", {
      legalEntityId: entity,
      rows: [
        {
          outletId: outlet,
          accountId: account,
          period: "2026-11",
          amountIdr: 5_000_000,
        },
      ],
    });
    assert.equal(upserted.data.length, 1);
    assert.equal(upserted.data[0].amountIdr, 5_000_000);

    const budgets = await get("/api/accounting/budgets", {
      legalEntityId: entity,
      period: "2026-11",
      outletId: outlet,
    });
    assert.equal(budgets.data.length, 5);

    const after = await get("/api/accounting/budgets/vs-actual", {
      legalEntityId: entity,
      period: "2026-11",
      outletId: outlet,
    });
    const marketing = after.data.find((row) => row.accountCode === "6109");
    assert.ok(marketing);
    assert.equal(marketing.budgetIdr, 5_000_000);
    assert.equal(marketing.actualIdr, 0);
    assert.equal(marketing.varianceIdr, -5_000_000);
    assert.equal(marketing.varianceBp, -10_000);
    assert.equal(ap.varianceState(marketing.varianceIdr), "under");
  });
});
