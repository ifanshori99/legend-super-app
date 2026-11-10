// Coretax export file name (legend-z6a5): deterministic, header-safe name for
// the Content-Disposition of the signed download. Plain Node ESM.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coretaxExportFileName,
  TAX_REPORT_TYPES,
} from "../packages/shared/src/accounting/index.ts";

describe("coretaxExportFileName", () => {
  test("builds coretax-<type>-<period>-r<n>.xml for every report type", () => {
    for (const type of TAX_REPORT_TYPES)
      assert.equal(
        coretaxExportFileName(type, "2026-03", 0),
        `coretax-${type}-2026-03-r0.xml`,
      );
  });

  test("output only uses [a-z0-9-] before the .xml extension and stays short", () => {
    for (const type of TAX_REPORT_TYPES) {
      const name = coretaxExportFileName(type, "2026-12", 1);
      assert.match(name, /^[a-z0-9-]+\.xml$/);
      assert.ok(name.length <= 40);
    }
  });

  test("accepts every revision the smallint column can hold (0..32767)", () => {
    assert.equal(
      coretaxExportFileName("ppn", "2026-03", 32767),
      "coretax-ppn-2026-03-r32767.xml",
    );
    assert.throws(() => coretaxExportFileName("ppn", "2026-03", 32768));
  });

  test("rejects unknown type and malformed period", () => {
    const invalid = [
      ["PBJT", "2026-03"],
      ["pbjt/../x", "2026-03"],
      ["pbjt\r\nSet-Cookie: a=b", "2026-03"],
      ["", "2026-03"],
      [undefined, "2026-03"],
      ["pbjt", "2026-13"],
      ["pbjt", "2026-3"],
      ["pbjt", "2026-03\r\n"],
      ["pbjt", '2026-03"; x="'],
      ["pbjt", ""],
      ["pbjt", undefined],
      ["pbjt", "../2026-03"],
    ];
    for (const [type, period] of invalid)
      assert.throws(
        () => coretaxExportFileName(type, period, 0),
        `${String(type)} / ${String(period)}`,
      );
  });
});
