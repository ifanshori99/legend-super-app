// Payslip detail: the PDF download button shows only with a signed fileUrl
// (bead legend-07eg: no PDF generator yet, so fileUrl is null; no dead button).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { componentHarness } from "./844-component-harness.mjs";

const harness = componentHarness(() => undefined);
after(() => harness.close());
const { PayslipFileActions } =
  await import("../apps/web/src/features/ws10-payslip/components/payslip-file-actions.tsx");

test("1253 no fileUrl: no download link, a working print button instead", () => {
  const html = harness.render(PayslipFileActions, { fileUrl: null });
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /payslip\.detail\.download/);
  assert.match(html, /payslip\.detail\.print /);
  assert.equal(typeof harness.lastAction()?.onClick, "function");
});

test("1253 with fileUrl: download link opens the signed URL", () => {
  const html = harness.render(PayslipFileActions, {
    fileUrl: "https://files.example/slip.pdf",
  });
  assert.match(html, /href="https:\/\/files\.example\/slip\.pdf"/);
  assert.match(html, /payslip\.detail\.download /);
  assert.doesNotMatch(html, /payslip\.detail\.print /);
});
