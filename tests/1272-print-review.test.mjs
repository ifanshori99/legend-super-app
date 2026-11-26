// Review P2 cetak tablet (docs/qa/1272-cetak-p2-review.md, legend-wasr7.3):
// 1 the correction screen's reprint goes to the tablet printer too; 2 after a
// print the screen stays with "dikirim ke printer" and a reprint path; 7 a
// failing printer never throws away the issued receipt, and the print frame
// never lingers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { componentHarness } from "./844-component-harness.mjs";
import {
  deliverToTabletPrinter,
  printHtmlInFrame,
} from "../apps/web/src/features/ws04-pos-kasir/print/send-to-printer.ts";
import { testPrintPayload } from "../apps/web/src/features/ws04-pos-kasir/print/test-page.ts";
import { escposLines } from "../apps/web/src/features/ws04-pos-kasir/print/escpos-text.ts";
import { posKasirCommonMessages } from "../packages/shared/src/i18n/messages/pos-kasir-common.ts";

const web = "apps/web/src/features/";
const read = (file) => readFileSync(web + file, "utf8");
const payload = { paperWidth: 32, escposBase64: "G0A=", reprint: false };
const rawbt = { method: "rawbt", paperWidth: 32 };

test("7 a printer that throws is a failed send, not a failed receipt", () => {
  const io = {
    openUrl: () => {
      throw new Error("no handler for rawbt:");
    },
    printHtml: () => {},
  };
  assert.deepEqual(deliverToTabletPrinter(payload, rawbt, io), {
    outcome: "failed",
  });
  const ok = { openUrl: () => {}, printHtml: () => {} };
  assert.deepEqual(deliverToTabletPrinter(payload, rawbt, ok), {
    outcome: "sent",
  });
  // Edge or mock: no bytes, the server's own result stands.
  assert.deepEqual(deliverToTabletPrinter(null, rawbt, ok), {
    outcome: "skipped",
  });
  assert.deepEqual(
    deliverToTabletPrinter(undefined, { method: "none", paperWidth: 32 }, ok),
    { outcome: "none" },
  );
});

test("7 the print frame is removed when it has no window", () => {
  const frame = {
    contentWindow: null,
    style: {},
    removed: false,
    setAttribute() {},
    remove() {
      this.removed = true;
    },
  };
  const doc = {
    createElement: () => frame,
    body: { append: () => {} },
  };
  printHtmlInFrame("<p>x</p>", doc);
  frame.onload();
  assert.equal(frame.removed, true);
});

test("1 the correction reprint asks for this tablet's bytes and sends them", () => {
  const api = read("ws04-pos-correction/api.ts");
  assert.match(
    api,
    /printOrderReceipt\([\s\S]{0,200}paperWidth[\s\S]{0,400}deliveries: \["print"\][\s\S]{0,80}paperWidth/,
  );
  const hooks = read("ws04-pos-correction/hooks.ts");
  assert.match(hooks, /readTabletPrinter\(\)/);
  assert.match(hooks, /deliverToTabletPrinter\(/);
});

test("2 a print never leaves the paid screen on its own", () => {
  for (const file of [
    "ws04-pos-kasir/components/payment/success-panel.tsx",
    "ws04-pos-kasir/components/payment/dp-lunas-panel.tsx",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /wasQueued\(result\)\) toNewTransaction/, file);
    assert.match(source, /<ReceiptSent\b/, file);
  }
});

const harness = componentHarness((specifier, parent) => {
  if (specifier === "../shared" && parent.includes("ws04-pos-kasir"))
    return `const R = globalThis.__844React;
      export const Notice = ({title, children}) => R.createElement("section", null, title, children);`;
});
after(() => harness.close());
const { ReceiptSent } =
  await import("../apps/web/src/features/ws04-pos-kasir/components/payment/receipt-sent-notice.tsx");

test("2 the sent notice is announced politely and offers a reprint", () => {
  const html = harness.render(ReceiptSent, {
    receiptNo: "S-001",
    onReprint: () => {},
    onNext: () => {},
  });
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /posKasirCommon\.printer\.sentTitle/);
  assert.match(html, /posKasirCommon\.printer\.sentNote/);
  assert.match(html, /posKasirCommon\.printer\.reprint/);
  assert.match(html, /posKasirCommon\.printer\.next/);
});

test("6 the test page fits the paper and says it is a test", () => {
  for (const width of [32, 48]) {
    const test = testPrintPayload(width);
    assert.equal(test.paperWidth, width);
    const lines = escposLines(test.escposBase64);
    assert.ok(lines.some((line) => /TES PRINTER/.test(line.text)));
    assert.ok(lines.every((line) => line.text.length <= width));
    assert.ok(lines.some((line) => line.text.length === width));
  }
});

test("3-5 copy: cause of a missed print, saved printer, test print", () => {
  const p = posKasirCommonMessages.printer;
  assert.match(p.description, /Struk dikirim ke printer ini/);
  assert.doesNotMatch(p.description, /laporan/i);
  assert.match(p.saved, /^Printer disimpan: \{summary\}$/);
  assert.ok(p.notSent.none.title && p.notSent.failed.title);
  assert.match(p.notSent.failed.body, /RawBT/);
  assert.ok(p.testPrint && p.testSent && p.testFailed);
});
