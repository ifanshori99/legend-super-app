// Gelombang 2 (brief 1267 Bagian B): source-level guards for audit findings
// that have no runtime harness. Each test names its finding.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const web = "apps/web/src/features/";
const read = (file) => readFileSync(file, "utf8");

test("F3 the PTKP dialog shows the day the server saves (today), not 1 January", () => {
  const source = read(
    web + "ws10-employee-master/components/ptkp-correction-dialog.tsx",
  );
  assert.doesNotMatch(source, /nextYearStart/);
  assert.match(
    source,
    /effectiveNextYear[\s\S]{0,120}formatBusinessDate\(today\)/,
  );
  // The server accepts only the anchor day or today; keep both choices sending those.
  assert.match(source, /effectiveFrom: day === "anchor" \? anchor : today/);
});
