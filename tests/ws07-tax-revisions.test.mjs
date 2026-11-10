// Tax report revision chain contract (legend-r3i8w): schema CHECK mirrors,
// export refusal on a superseded report, revision-aware file name, and the
// finalize / list / download endpoint shapes. Plain Node ESM.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";

const exported = acc.cafeLegendAccountingFixtures.taxReports[0];
const draft = acc.cafeLegendAccountingFixtures.taxReports[1];
const ID_A = "7a000000-0000-4000-8000-0000000000a1";
const ID_B = "7a000000-0000-4000-8000-0000000000b2";

const correction = {
  ...exported,
  status: "final",
  exportFormat: null,
  fileKey: null,
  exportedAt: null,
  revisionNo: 1,
  supersedesId: ID_A,
  correctionReason: "Salah input PTKP",
};
const invalid = (row) => acc.taxReportSchema.safeParse(row).success === false;
const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error.code === code);

describe("tax report revision fields", () => {
  test("fixtures: exported revision 0 is current, draft has no revision", () => {
    assert.equal(exported.revisionNo, 0);
    assert.equal(exported.isCurrent, true);
    assert.equal(draft.revisionNo, null);
    assert.equal(draft.isCurrent, false);
  });

  test("a valid correction parses", () => {
    acc.taxReportSchema.parse({ ...correction, isCurrent: true });
  });

  test("each CHECK mirror rejects its bad case", () => {
    const ok = { ...correction, isCurrent: true };
    // draft <=> revisionNo null
    assert.ok(invalid({ ...draft, revisionNo: 0 }));
    assert.ok(invalid({ ...ok, revisionNo: null, status: "draft" }));
    // revision 0 <=> no supersedes
    assert.ok(invalid({ ...exported, supersedesId: ID_A }));
    assert.ok(invalid({ ...ok, supersedesId: null }));
    // revision >= 1 <=> reason present
    assert.ok(invalid({ ...ok, correctionReason: null }));
    assert.ok(invalid({ ...exported, correctionReason: "x" }));
    // blank reason, negative / fractional revision
    assert.ok(invalid({ ...ok, correctionReason: "   " }));
    assert.ok(invalid({ ...ok, revisionNo: -1 }));
    assert.ok(invalid({ ...ok, revisionNo: 1.5 }));
    // superseded pair set together, never self
    assert.ok(invalid({ ...ok, supersededAt: "2026-11-06T00:00:00.000Z" }));
    assert.ok(invalid({ ...ok, supersededById: ID_B }));
    assert.ok(
      invalid({
        ...ok,
        id: ID_B,
        supersededById: ID_B,
        supersededAt: "2026-11-06T00:00:00.000Z",
        isCurrent: false,
      }),
    );
    // isCurrent must match status / supersededAt
    assert.ok(invalid({ ...ok, isCurrent: false }));
    assert.ok(invalid({ ...draft, isCurrent: true }));
    assert.ok(invalid({ ...ok, fiscalPeriodVersion: 0 }));
  });

  test("a superseded row is not current", () => {
    const superseded = {
      ...exported,
      supersededById: ID_B,
      supersededAt: "2026-11-06T00:00:00.000Z",
      isCurrent: true,
    };
    assert.ok(invalid(superseded));
    acc.taxReportSchema.parse({ ...superseded, isCurrent: false });
  });
});

describe("transitionTaxReport on a superseded report", () => {
  const closed = { status: "closed" };
  const superseded = "2026-11-06T00:00:00.000Z";

  test("export throws TAX_REPORT_SUPERSEDED for final and exported", () => {
    for (const status of ["final", "exported"])
      throwsCode(
        () =>
          acc.transitionTaxReport(
            { status, supersededAt: superseded },
            "export",
            closed,
          ),
        "TAX_REPORT_SUPERSEDED",
      );
  });

  test("export still works when not superseded", () => {
    assert.equal(
      acc.transitionTaxReport(
        { status: "final", supersededAt: null },
        "export",
        closed,
      ),
      "exported",
    );
  });

  test("draft export stays INVALID_TRANSITION", () => {
    throwsCode(
      () =>
        acc.transitionTaxReport(
          { status: "draft", supersededAt: null },
          "export",
          closed,
        ),
      "INVALID_TRANSITION",
    );
  });
});

describe("coretaxExportFileName revisions", () => {
  test("carries the revision number", () => {
    assert.equal(
      acc.coretaxExportFileName("pbjt", "2026-10", 0),
      "coretax-pbjt-2026-10-r0.xml",
    );
    assert.equal(
      acc.coretaxExportFileName("pph21", "2026-10", 2),
      "coretax-pph21-2026-10-r2.xml",
    );
  });

  test("rejects an invalid revision number", () => {
    for (const bad of [-1, 1.5, "1", undefined, Number.NaN, 32768])
      assert.throws(() => acc.coretaxExportFileName("pbjt", "2026-10", bad));
  });
});

describe("tax report endpoints", () => {
  const key = "01JBQ9A2B3C4D5E6F7G8H9J0KM";

  test("finalize body: optional trimmed reason, 1..500, strict", () => {
    const body = acc.finalizeTaxReport.body;
    assert.deepEqual(body.parse({ idempotencyKey: key }), {
      idempotencyKey: key,
    });
    assert.equal(
      body.parse({ idempotencyKey: key, correctionReason: "  alasan  " })
        .correctionReason,
      "alasan",
    );
    for (const correctionReason of ["", "   ", "x".repeat(501)])
      assert.equal(
        body.safeParse({ idempotencyKey: key, correctionReason }).success,
        false,
      );
    assert.equal(
      body.safeParse({ idempotencyKey: key, extra: 1 }).success,
      false,
    );
  });

  test("list query coerces includeSuperseded from the query string", () => {
    const q = acc.listTaxReports.query;
    const base = { legalEntityId: exported.legalEntityId };
    assert.equal(q.parse(base).includeSuperseded, undefined);
    assert.equal(
      q.parse({ ...base, includeSuperseded: "true" }).includeSuperseded,
      true,
    );
    assert.equal(
      q.parse({ ...base, includeSuperseded: "false" }).includeSuperseded,
      false,
    );
    assert.equal(
      q.safeParse({ ...base, includeSuperseded: "maybe" }).success,
      false,
    );
  });

  test("download endpoint is a registered GET with a nullable chain", () => {
    assert.equal(acc.downloadTaxReport.method, "GET");
    assert.equal(
      acc.downloadTaxReport.path,
      "/api/accounting/tax-reports/:taxReportId/download",
    );
    assert.equal(
      acc.accountingEndpoints.downloadTaxReport,
      acc.downloadTaxReport,
    );
    const payload = {
      taxReportId: exported.id,
      fileKey: exported.fileKey,
      fileName: "coretax-pph21-2026-10-r0.xml",
      downloadUrl: "https://files.example.test/a.xml",
      expiresAt: "2026-11-06T00:15:00.000Z",
      revisionNo: 0,
      supersededById: null,
    };
    acc.taxReportDownloadSchema.parse(payload);
    assert.equal(
      acc.taxReportDownloadSchema.safeParse({
        ...payload,
        revisionNo: undefined,
      }).success,
      false,
    );
  });
});

describe("tax report error codes", () => {
  test("statuses and Indonesian messages", () => {
    const expected = {
      TAX_REPORT_SUPERSEDED: 409,
      TAX_REPORT_STALE: 409,
      TAX_REPORT_CORRECTION_REASON_REQUIRED: 400,
      TAX_REPORT_SOURCE_UNAVAILABLE: 422,
      TAX_REPORT_AMOUNT_MISMATCH: 422,
      TAX_REPORT_NOT_FOUND: 404,
      TAX_REPORT_NO_CHANGE: 409,
    };
    for (const [code, status] of Object.entries(expected)) {
      const error = new acc.AccountingError(code);
      assert.equal(error.status, status);
      assert.ok(error.message.length > 0);
    }
  });

  test("details travel with the error", () => {
    const error = new acc.AccountingError("TAX_REPORT_SUPERSEDED", undefined, {
      supersededById: ID_B,
    });
    assert.equal(error.details.supersededById, ID_B);
  });
});
