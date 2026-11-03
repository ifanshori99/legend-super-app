// Tax recap & Coretax exports (bead legend-5fdy; PRD v1.7 §3 F19 "Pajak [P0] —
// Rekap PBJT, PPh 21 (dari payroll), PPh 23 (jasa supplier), dan PPN masukan
// bila badan usaha PKP, dengan ekspor dalam format yang siap diunggah ke
// Coretax DJP").
//
// Pure-lib tests with relative imports and no database: they load the shared
// accounting contract and the screen's pure helpers with Node type stripping.
// The screen itself is exercised in e2e/legend-5fdy.mock.spec.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as tax from "../apps/web/src/features/ws07-tax/lib.ts";
import * as i18n from "../packages/shared/src/i18n/index.ts";
import * as accounting from "../packages/shared/src/accounting/index.ts";

const fixtures = accounting.cafeLegendAccountingFixtures;
const reports = fixtures.taxReports;

function accountingCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

describe("F19-Pajak tax recap", () => {
  test("F19-Pajak: period helpers open on the latest recap and shift business months", () => {
    assert.equal(tax.latestTaxPeriod(reports), "2026-11");
    assert.equal(tax.defaultTaxPeriod(reports, "2026-11-03"), "2026-11");
    assert.equal(tax.defaultTaxPeriod([], "2026-11-03"), "2026-11");
    assert.equal(tax.latestTaxPeriod([]), null);

    // 18:00 UTC is already the next day in Asia/Jakarta (UTC+7).
    assert.equal(
      tax.businessPeriodToday(new Date("2026-10-31T18:00:00.000Z")),
      "2026-11",
    );
    assert.equal(
      tax.businessPeriodToday(new Date("2026-11-30T16:59:59.000Z")),
      "2026-11",
    );

    assert.equal(tax.shiftTaxPeriod("2026-11", -1), "2026-10");
    assert.equal(tax.shiftTaxPeriod("2026-01", -1), "2025-12");
    assert.equal(tax.shiftTaxPeriod("2026-12", 1), "2027-01");
    assert.equal(tax.shiftTaxPeriod("2026-11", 0), "2026-11");
    // Invalid input is returned unchanged instead of inventing a month.
    assert.equal(tax.shiftTaxPeriod("2026-13", 1), "2026-13");

    assert.equal(tax.isTaxPeriodKey("2026-11"), true);
    assert.equal(tax.isTaxPeriodKey("2026-13"), false);
    assert.equal(tax.isTaxPeriodKey("2026-1"), false);

    assert.equal(tax.formatTaxPeriod("2026-11"), "November 2026");
    assert.equal(tax.formatTaxPeriod("2026-01"), "Januari 2026");
  });

  test("F19-Pajak: PBJT, PPh 21, PPh 23 and PPN masukan each have a label and explanation", () => {
    assert.deepEqual(accounting.TAX_REPORT_TYPES, [
      "pbjt",
      "pph21",
      "pph23",
      "ppn",
    ]);
    assert.deepEqual(tax.TAX_TYPES, accounting.TAX_REPORT_TYPES);
    assert.equal(tax.taxTypeLabelKey("pbjt"), "accounting.tax.types.pbjt");
    assert.equal(tax.taxTypeLabelKey("pph21"), "accounting.tax.types.pph21");
    assert.equal(tax.taxTypeLabelKey("pph23"), "accounting.tax.types.pph23");
    assert.equal(tax.taxTypeLabelKey("ppn"), "accounting.tax.types.ppn");
    assert.equal(tax.taxTypeHintKey("ppn"), "accounting.tax.types.hints.ppn");
    // A hint exists for every type, so no card renders without its one-line
    // explanation (PRD §3 F19: PPN only when the entity is PKP).
    for (const type of accounting.TAX_REPORT_TYPES) {
      assert.match(
        tax.taxTypeHintKey(type),
        /^accounting\.tax\.types\.hints\./,
      );
      assert.match(tax.taxTypeLabelKey(type), /^accounting\.tax\.types\./);
    }
  });

  test("F19-Pajak: every tax catalog key resolves in the Indonesian catalog", () => {
    const t = i18n.createTranslator(i18n.messagesId);
    const keys = [
      ...Object.values(tax.TAX_TYPE_KEYS),
      ...Object.values(tax.TAX_TYPE_HINT_KEYS),
      ...Object.values(tax.TAX_STATUS_KEYS),
      ...Object.values(tax.TAX_SUBJECT_KEYS),
      "accounting.tax.title",
      "accounting.tax.subtitle",
      "accounting.tax.period.label",
      "accounting.tax.summary.totalTax",
      "accounting.tax.report.emptyTitle",
      "accounting.tax.report.linesTitle",
      "accounting.tax.report.totalTax",
      "accounting.tax.history.final",
      "accounting.tax.ppnGate.title",
      "accounting.tax.actions.generate",
      "accounting.tax.actions.finalize",
      "accounting.tax.actions.export",
      "accounting.tax.generateDialog.title",
      "accounting.tax.finalizeDialog.title",
      "accounting.tax.exportDialog.title",
      "accounting.tax.errors.generic",
    ];
    for (const key of keys) assert.notEqual(t(key), key, key);
    assert.equal(t("accounting.tax.types.ppn"), "PPN masukan");
    assert.equal(
      t("accounting.tax.report.title", {
        type: "PBJT",
        period: "November 2026",
      }),
      "PBJT · November 2026",
    );
  });

  test("F19-Pajak: status machine is draft → final → exported; finalize is terminal after final", () => {
    const closed = { status: "closed" };
    const open = { status: "open" };

    assert.equal(
      accounting.transitionTaxReport({ status: "draft" }, "regenerate", open),
      "draft",
    );
    assert.equal(
      accounting.transitionTaxReport({ status: "draft" }, "finalize", closed),
      "final",
    );
    assert.equal(
      accounting.transitionTaxReport({ status: "final" }, "export", closed),
      "exported",
    );
    // Export may repeat (the contract says so); it stays exported.
    assert.equal(
      accounting.transitionTaxReport({ status: "exported" }, "export", closed),
      "exported",
    );

    // Finalising a draft needs a closed fiscal period; otherwise the API says
    // PERIOD_NOT_CLOSED and the draft stays a draft.
    assert.equal(
      accountingCode(() =>
        accounting.transitionTaxReport({ status: "draft" }, "finalize", open),
      ),
      "PERIOD_NOT_CLOSED",
    );
    // final/exported are locked: no second finalize, no regenerate.
    assert.equal(
      accountingCode(() =>
        accounting.transitionTaxReport({ status: "final" }, "finalize", closed),
      ),
      "INVALID_TRANSITION",
    );
    assert.equal(
      accountingCode(() =>
        accounting.transitionTaxReport(
          { status: "exported" },
          "finalize",
          closed,
        ),
      ),
      "INVALID_TRANSITION",
    );
    assert.equal(
      accountingCode(() =>
        accounting.transitionTaxReport(
          { status: "exported" },
          "regenerate",
          closed,
        ),
      ),
      "INVALID_TRANSITION",
    );
    // A draft cannot be exported before it is final.
    assert.equal(
      accountingCode(() =>
        accounting.transitionTaxReport({ status: "draft" }, "export", closed),
      ),
      "INVALID_TRANSITION",
    );
  });

  test("F19-Pajak: PPN masukan applies only to a PKP legal entity", () => {
    assert.equal(tax.taxTypeApplicable("ppn", false), false);
    assert.equal(tax.taxTypeApplicable("ppn", true), true);
    for (const type of ["pbjt", "pph21", "pph23"])
      assert.equal(tax.taxTypeApplicable(type, false), true);

    // The screen mirrors the contract assertion instead of re-deriving it.
    assert.equal(
      accountingCode(() =>
        accounting.assertTaxTypeApplicable("ppn", { isPkp: false }),
      ),
      "TAX_REPORT_NOT_APPLICABLE",
    );
    assert.doesNotThrow(() =>
      accounting.assertTaxTypeApplicable("ppn", { isPkp: true }),
    );
    assert.doesNotThrow(() =>
      accounting.assertTaxTypeApplicable("pbjt", { isPkp: false }),
    );
  });

  test("F19-Pajak: report lookup and period totals come from the stored reports", () => {
    const pbjt = tax.reportOfType(reports, "pbjt", "2026-11");
    assert.equal(pbjt?.status, "draft");
    assert.equal(pbjt?.amountIdr, 37_500);
    assert.equal(tax.reportOfType(reports, "pph21", "2026-11"), undefined);
    assert.equal(tax.reportOfType(reports, "ppn", "2026-11"), undefined);

    const november = tax.taxPeriodSummary(reports, "2026-11");
    assert.deepEqual(november, {
      totalTaxIdr: 37_500,
      finalCount: 0,
      draftCount: 1,
      reportCount: 1,
    });

    // Exported reports are locked too, so they count as final; none is a draft.
    const october = tax.taxPeriodSummary(reports, "2026-10");
    assert.deepEqual(october, {
      totalTaxIdr: 630_000,
      finalCount: 1,
      draftCount: 0,
      reportCount: 1,
    });

    assert.deepEqual(
      tax.reportsInPeriod(reports, "2026-10").map((report) => report.type),
      ["pph21"],
    );
    assert.deepEqual(tax.reportsInPeriod(reports, "2025-01"), []);
    const empty = tax.taxPeriodSummary([], "2026-11");
    assert.equal(empty.totalTaxIdr, 0);
    assert.equal(empty.reportCount, 0);
  });

  test("F19-Pajak: the effective rate is a display ratio and blank without a basis", () => {
    assert.equal(
      tax.taxLineRateBp({ baseIdr: 375_000, taxIdr: 37_500 }),
      1_000,
    );
    assert.equal(
      tax.formatTaxLineRate({ baseIdr: 375_000, taxIdr: 37_500 }),
      "10%",
    );
    assert.equal(
      tax.formatTaxLineRate({ baseIdr: 18_000_000, taxIdr: 540_000 }),
      "3%",
    );
    // 21/1000 → 2,1% (id-ID decimal comma).
    assert.equal(tax.formatTaxLineRate({ baseIdr: 1_000, taxIdr: 21 }), "2,1%");
    // A zero basis has no rate to show: never divide by zero, never guess.
    assert.equal(tax.taxLineRateBp({ baseIdr: 0, taxIdr: 500 }), null);
    assert.equal(tax.formatTaxLineRate({ baseIdr: 0, taxIdr: 500 }), "—");
  });

  test("F19-Pajak: the Coretax recap CSV writes stored values unchanged and without recalculation", () => {
    const pbjt = tax.reportOfType(reports, "pbjt", "2026-11");
    assert.ok(pbjt);
    const headers = {
      subjectType: "Tipe subjek",
      subjectTypes: {
        outlet: "Outlet",
        employee: "Karyawan",
        supplier: "Supplier",
      },
      subjectName: "Subjek",
      taxId: "NPWP",
      base: "Basis (DPP)",
      tax: "Pajak",
      references: "Referensi",
      total: "Total pajak",
    };
    const csv = tax.toTaxRecapCsv(pbjt, headers);
    const rows = csv.trimEnd().split("\r\n");
    assert.equal(rows.length, pbjt.lines.length + 2);
    assert.equal(
      rows[0],
      "Tipe subjek,Subjek,NPWP,Basis (DPP),Pajak,Referensi",
    );
    const first = pbjt.lines[0];
    assert.ok(rows[1].includes(String(first.baseIdr)));
    assert.ok(rows[1].includes(String(first.taxIdr)));
    assert.ok(rows[1].startsWith("Outlet,"));
    assert.equal(rows.at(-1), `Total pajak,,,,${pbjt.amountIdr},`);

    // The total is the report's own amount, never a fresh sum of the lines.
    const altered = tax.toTaxRecapCsv(
      { lines: pbjt.lines, amountIdr: 1 },
      headers,
    );
    assert.equal(altered.trimEnd().split("\r\n").at(-1), "Total pajak,,,,1,");

    // Tenant text cannot inject a spreadsheet formula.
    const guarded = tax.toTaxRecapCsv(
      {
        lines: [{ ...first, subjectName: "=SUM(A1:A9)" }],
        amountIdr: pbjt.amountIdr,
      },
      headers,
    );
    assert.ok(guarded.includes("'=SUM(A1:A9)"));

    assert.equal(tax.taxRecapCsvFileName(pbjt), "rekap-pbjt-2026-11.csv");
  });

  test("F19-Pajak: refusal codes map to catalog messages and unknown codes fall back", () => {
    assert.equal(
      tax.taxErrorMessageKey("PERIOD_NOT_CLOSED"),
      "accounting.tax.errors.periodNotClosed",
    );
    assert.equal(
      tax.taxErrorMessageKey("INVALID_TRANSITION"),
      "accounting.tax.errors.invalidTransition",
    );
    assert.equal(
      tax.taxErrorMessageKey("TAX_REPORT_NOT_APPLICABLE"),
      "accounting.tax.errors.notApplicable",
    );
    assert.equal(
      tax.taxErrorMessageKey(undefined),
      "accounting.tax.errors.generic",
    );
    assert.equal(
      tax.taxErrorMessageKey("SOMETHING_ELSE"),
      "accounting.tax.errors.generic",
    );
  });
});
