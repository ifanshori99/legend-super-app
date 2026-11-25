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

test("F9 queue decision form and owner card take their text from the catalog", () => {
  const form = read(web + "hris-requests/components/queue-decision-form.tsx");
  assert.doesNotMatch(form, /Alasan penolakan|Jelaskan alasan/);
  const card = read(web + "hris-owner-support/owner-request-card.tsx");
  assert.doesNotMatch(card, /"Tim dukungan"/);
});

test("F10 rejecting a support access request asks for a confirmation first", () => {
  const card = read(web + "hris-owner-support/owner-request-card.tsx");
  // The reject button only opens the confirmation; onReject runs from its action.
  assert.doesNotMatch(card, /onClick=\{\(\) => onReject\(request\.id\)\}/);
  assert.match(card, /setConfirmingReject\(true\)/);
  assert.match(card, /rejectConfirmAction/);
});
