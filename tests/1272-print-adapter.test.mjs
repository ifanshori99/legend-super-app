// P2 (docs/design/cloud-only-release.md section 3, legend-wasr7.3): the cashier
// tablet sends the cloud's ESC/POS bytes to its own printer through RawBT
// ("rawbt:base64,<bytes>"), or prints the same text with window.print on 58/80
// mm paper. The printer choice is kept per tablet. Status is "sent to
// printer", never "printed".
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TABLET_PRINTER,
  paperWidthOf,
  readTabletPrinter,
  writeTabletPrinter,
} from "../apps/web/src/features/ws04-pos-kasir/print/printer-settings.ts";
import {
  escposLines,
  receiptHtml,
} from "../apps/web/src/features/ws04-pos-kasir/print/escpos-text.ts";
import {
  rawbtUrl,
  sendToPrinter,
} from "../apps/web/src/features/ws04-pos-kasir/print/send-to-printer.ts";
import { posKasirCommonMessages } from "../packages/shared/src/i18n/messages/pos-kasir-common.ts";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
// Same commands as apps/api/src/edge/print/escpos.ts: init, code page, centre,
// bold, double size, text, feed, cut.
const job = Uint8Array.from([
  ESC,
  0x40,
  ESC,
  0x74,
  0x00,
  ESC,
  0x61,
  1,
  ESC,
  0x45,
  1,
  ...ascii("** CETAK ULANG **"),
  LF,
  ESC,
  0x45,
  0,
  ESC,
  0x61,
  0,
  GS,
  0x21,
  0x11,
  ...ascii("Kopi <Legend>"),
  LF,
  GS,
  0x21,
  0x00,
  ...ascii("Total      Rp 25.000"),
  LF,
  ESC,
  0x64,
  3,
  GS,
  0x56,
  66,
  3,
]);
const base64 = Buffer.from(job).toString("base64");
const payload = { paperWidth: 32, escposBase64: base64, reprint: true };

test("a tablet without a choice prints with the browser on 58 mm paper", () => {
  const storage = memoryStorage();
  assert.deepEqual(readTabletPrinter(storage), DEFAULT_TABLET_PRINTER);
  assert.deepEqual(DEFAULT_TABLET_PRINTER, {
    method: "browser",
    paperWidth: 32,
  });
});

test("the printer choice survives a reload; a broken entry is the default", () => {
  const storage = memoryStorage();
  writeTabletPrinter({ method: "rawbt", paperWidth: 48 }, storage);
  assert.deepEqual(readTabletPrinter(storage), {
    method: "rawbt",
    paperWidth: 48,
  });
  for (const raw of [
    "{",
    '{"method":"epson","paperWidth":32}',
    '{"method":"rawbt","paperWidth":40}',
  ])
    assert.deepEqual(
      readTabletPrinter({ ...storage, getItem: () => raw }),
      DEFAULT_TABLET_PRINTER,
      raw,
    );
});

test("only a tablet with a printer asks the cloud for bytes", () => {
  assert.equal(paperWidthOf({ method: "rawbt", paperWidth: 48 }), 48);
  assert.equal(paperWidthOf({ method: "browser", paperWidth: 32 }), 32);
  assert.equal(paperWidthOf({ method: "none", paperWidth: 32 }), undefined);
});

test("RawBT receives the bytes unchanged as its base64 intent", () => {
  assert.equal(rawbtUrl(base64), `rawbt:base64,${base64}`);
});

test("the ESC/POS job reads back as its lines with alignment, bold and size", () => {
  const lines = escposLines(base64);
  assert.deepEqual(lines.slice(0, 3), [
    { text: "** CETAK ULANG **", align: "center", bold: true, size: "normal" },
    { text: "Kopi <Legend>", align: "left", bold: false, size: "double" },
    {
      text: "Total      Rp 25.000",
      align: "left",
      bold: false,
      size: "normal",
    },
  ]);
  assert.ok(lines.slice(3).every((line) => line.text === ""));
});

test("the browser copy is sized for the paper and escapes text", () => {
  const html58 = receiptHtml(escposLines(base64), 32);
  assert.match(html58, /size:\s*58mm auto/);
  assert.match(html58, /CETAK ULANG/);
  assert.match(html58, /Kopi &lt;Legend&gt;/);
  assert.doesNotMatch(html58, /<Legend>/);
  assert.match(receiptHtml([], 48), /size:\s*80mm auto/);
});

test("sending dispatches to the chosen printer and never claims paper came out", () => {
  const calls = [];
  const io = {
    openUrl: (url) => calls.push(["url", url]),
    printHtml: (html) => calls.push(["html", html]),
  };
  assert.equal(sendToPrinter(payload, "rawbt", io), "sent");
  assert.deepEqual(calls.at(-1), ["url", `rawbt:base64,${base64}`]);
  assert.equal(sendToPrinter(payload, "browser", io), "sent");
  assert.equal(calls.at(-1)[0], "html");
  assert.match(calls.at(-1)[1], /CETAK ULANG/);
  assert.equal(sendToPrinter(payload, "none", io), "skipped");
  assert.equal(calls.length, 2);
});

test("the printer settings copy says sent to printer, not printed", () => {
  const printer = posKasirCommonMessages.printer;
  assert.ok(printer, "posKasirCommon.printer catalog group");
  const all = JSON.stringify(printer);
  assert.match(all, /RawBT/);
  assert.match(all, /dikirim ke printer/i);
  assert.doesNotMatch(all, /\btercetak\b/i);
});
