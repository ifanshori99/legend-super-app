// legend-n039 guard: every HRIS idempotency replay must compare the stored
// fingerprint through `hrisFingerprintMatches` (any supported blind-index
// version). A direct `existing.fingerprint !== fingerprint` would answer
// IDEMPOTENCY_KEY_REUSED for every retry of a request stored before the
// cutover. Replay behaviour itself is covered in blind-index-writers-db.test.ts
// (employee path) and hris-pii.test.ts (hrisFingerprintMatches); leave,
// holiday and payslip keep their own copy of the replay code, so each is
// checked here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const services = [
  "hris-employee.service.ts",
  "hris-leave.service.ts",
  "hris-holiday.service.ts",
  "hris-payslip.service.ts",
];

describe("legend-n039 fingerprint compare sites", () => {
  for (const file of services) {
    const source = readFileSync(
      new URL(`../services/${file}`, import.meta.url),
      "utf8",
    );
    it(`[HR-03] ${file} compares stored fingerprints with hrisFingerprintMatches`, () => {
      expect(source).not.toMatch(/\.fingerprint\s*!==?\s*fingerprint/);
      expect(source).not.toMatch(/fingerprint\s*!==?\s*existing\.fingerprint/);
      expect(source).toContain("hrisFingerprintMatches");
    });
  }
});
