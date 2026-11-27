// Minimal PDF 1.4 renderer for receipts, kuitansi and invoices (POS-07, PRD
// v1.7 §3 F11). No dependency: Helvetica (WinAnsi), one content stream per
// page, a classic xref table. A pure function of the document, so a reprint of
// the same document is byte-identical (the "CETAK ULANG" mark is a document
// field, not render state).

import { messagesId } from "@starter/shared/i18n";
import type { InvoiceDocument, ReceiptDocument } from "@starter/shared/pos";

type Document = ReceiptDocument | InvoiceDocument;

type Row =
  | { kind: "center"; text: string; size: number; bold: boolean }
  | { kind: "left"; text: string; size: number; indent: number }
  | { kind: "pair"; left: string; right: string; size: number }
  | { kind: "rule" }
  | { kind: "gap"; height: number };

/** Helvetica advance widths (1/1000 em) for ASCII 32..126. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const RECEIPT_PAGE = { width: 227, height: 700, margin: 14 };
const A4_PAGE = { width: 595, height: 842, margin: 40 };

const TITLES = {
  receipt: "STRUK",
  kuitansi: "KUITANSI",
  invoice: "INVOICE",
} as const;

const METHOD_LABELS: Record<string, string> = {
  cash: "Tunai",
  qris: "QRIS",
  va: "Virtual Account",
  ewallet: "E-wallet",
  card: "Kartu",
  edc_card: "Kartu (EDC)",
  edc_qris: "QRIS (EDC)",
  points: "Poin",
};

const PAYMENT_STATUS_LABELS = {
  unpaid: "Belum dibayar",
  paid: "Lunas",
  refunded: "Dikembalikan",
} as const;

/** WinAnsi-safe text: printable ASCII and Latin-1 only, anything else is `?`. */
function winAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code === 9 || code === 10 || code === 13) out += " ";
    else if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255))
      out += char;
    else out += "?";
  }
  return out;
}

function charWidth(char: string): number {
  const code = char.charCodeAt(0);
  return code >= 32 && code <= 126 ? (HELVETICA_WIDTHS[code - 32] ?? 556) : 556;
}

function textWidth(text: string, size: number): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return (total * size) / 1000;
}

/** Greedy word wrap; a word longer than the line is cut by character. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = "";
    let rest = word;
    while (textWidth(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size) > maxWidth)
        cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

function escapePdf(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** `Rp 12.000`; a negative amount is `-Rp 500`. */
export function formatRupiah(amount: number): string {
  const digits = Math.abs(Math.trunc(amount))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${amount < 0 ? "-" : ""}Rp ${digits}`;
}

function formatRate(rateBp: number): string {
  const percent = rateBp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toString().replace(".", ",")}%`;
}

/** `08/11/2026 14:30` in Jakarta time; the document carries no outlet zone. */
function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function buildRows(doc: Document): Row[] {
  const size = doc.documentKind === "invoice" ? 10 : 9;
  const rows: Row[] = [];
  const center = (text: string, big = false, bold = false) =>
    rows.push({ kind: "center", text, size: big ? size + 5 : size, bold });
  const left = (text: string, indent = 0, textSize = size) =>
    rows.push({ kind: "left", text, size: textSize, indent });
  const pair = (leftText: string, right: string) =>
    rows.push({ kind: "pair", left: leftText, right, size });
  const rule = () => rows.push({ kind: "rule" });
  const gap = (height = 4) => rows.push({ kind: "gap", height });

  center(TITLES[doc.documentKind], true, true);
  if (doc.status === "voided") center("DIBATALKAN", false, true);
  if (doc.reprint) center("CETAK ULANG", false, true);
  gap();
  center(doc.outletName, false, true);
  center(doc.outletAddress);
  gap();
  rule();
  pair("No. struk", doc.receiptNumber);
  pair("No. pesanan", doc.orderNumber);
  pair("Tanggal", formatDateTime(doc.issuedAt));
  if (doc.cashierName) pair("Kasir", doc.cashierName);
  if (doc.customerName) pair("Pelanggan", doc.customerName);
  if ("billedTo" in doc) {
    gap();
    left("Ditagihkan kepada:");
    left(doc.billedTo.name, 8);
    left(doc.billedTo.address, 8);
    if (doc.billedTo.npwp) left(`NPWP ${doc.billedTo.npwp}`, 8);
    pair("Jatuh tempo", formatDate(doc.dueDate));
    pair("Status", PAYMENT_STATUS_LABELS[doc.paymentStatus]);
  }
  rule();

  for (const line of doc.items) {
    pair(`${line.quantity} x ${line.name}`, formatRupiah(line.lineTotalIdr));
    if (line.quantity > 1 || line.modifiersTotalIdr > 0) {
      const modifiers =
        line.modifiersTotalIdr > 0
          ? ` + tambahan ${formatRupiah(line.modifiersTotalIdr)}`
          : "";
      left(`@ ${formatRupiah(line.unitPriceIdr)}${modifiers}`, 10, size - 1);
    }
    if (line.note) left(`Catatan: ${line.note}`, 10, size - 1);
  }
  rule();

  // legend-npnh: an inclusive bill's subtotal already holds service and tax.
  const included = doc.pricesIncludeTax ? "Termasuk " : "";
  pair("Subtotal", formatRupiah(doc.subtotalIdr));
  for (const discount of doc.discounts)
    pair(discount.label, formatRupiah(-discount.amountIdr));
  if (doc.serviceCharge)
    pair(
      `${included}Layanan (${formatRate(doc.serviceCharge.rateBp)})`,
      formatRupiah(doc.serviceCharge.amountIdr),
    );
  for (const tax of doc.taxLines)
    pair(
      `${included}${tax.name} (${formatRate(tax.rateBp)})`,
      formatRupiah(tax.amountIdr),
    );
  if (doc.roundingIdr !== 0) pair("Pembulatan", formatRupiah(doc.roundingIdr));
  rows.push({
    kind: "pair",
    left: "TOTAL",
    right: formatRupiah(doc.totalIdr),
    size: size + 2,
  });
  rule();

  if (doc.depositAppliedIdr > 0)
    pair("Uang muka (DP)", formatRupiah(doc.depositAppliedIdr));
  for (const tender of doc.tenders) {
    const label = METHOD_LABELS[tender.method] ?? tender.method;
    pair(
      tender.reference ? `${label} (${tender.reference})` : label,
      formatRupiah(tender.amountIdr),
    );
  }
  // 1272 K4: the guest service fee is not part of the order total.
  if (doc.guestFeeIdr && doc.paidTotalIdr) {
    const labels = messagesId.deviceRegistry.receiptPrintLabels;
    pair(labels.guestFee, formatRupiah(doc.guestFeeIdr));
    pair(labels.paidTotal, formatRupiah(doc.paidTotalIdr));
  }

  if (doc.documentKind === "kuitansi") {
    gap(8);
    left(
      `Telah diterima pembayaran sebesar ${formatRupiah(doc.totalIdr)} untuk pesanan ${doc.orderNumber}.`,
    );
  }
  if ("billedTo" in doc && doc.notes) {
    gap(8);
    left(`Catatan: ${doc.notes}`);
  }
  gap(8);
  center("Terima kasih");
  return rows;
}

type PageSpec = { width: number; height: number; margin: number };

/** Lay the rows out into pages of PDF drawing operators. */
function paginate(rows: Row[], page: PageSpec): string[] {
  const pages: string[][] = [[]];
  const usable = page.width - page.margin * 2;
  let y = page.height - page.margin;
  const current = () => pages[pages.length - 1] as string[];
  const ensure = (height: number) => {
    if (y - height < page.margin) {
      pages.push([]);
      y = page.height - page.margin;
    }
  };
  const text = (font: string, size: number, x: number, value: string) =>
    current().push(
      `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(value)}) Tj ET`,
    );

  for (const row of rows) {
    if (row.kind === "gap") {
      y -= row.height;
      continue;
    }
    if (row.kind === "rule") {
      ensure(8);
      y -= 4;
      current().push(
        `0.5 w ${page.margin} ${y.toFixed(2)} m ${page.width - page.margin} ${y.toFixed(2)} l S`,
      );
      y -= 4;
      continue;
    }
    const lineHeight = row.size * 1.4;
    if (row.kind === "center") {
      const font = row.bold ? "F2" : "F1";
      for (const line of wrap(winAnsi(row.text), row.size, usable)) {
        ensure(lineHeight);
        y -= row.size;
        const x = page.margin + (usable - textWidth(line, row.size)) / 2;
        text(font, row.size, Math.max(page.margin, x), line);
        y -= lineHeight - row.size;
      }
    } else if (row.kind === "left") {
      for (const line of wrap(
        winAnsi(row.text),
        row.size,
        usable - row.indent,
      )) {
        ensure(lineHeight);
        y -= row.size;
        text("F1", row.size, page.margin + row.indent, line);
        y -= lineHeight - row.size;
      }
    } else {
      const right = winAnsi(row.right);
      const rightWidth = textWidth(right, row.size);
      const lines = wrap(
        winAnsi(row.left),
        row.size,
        Math.max(40, usable - rightWidth - 8),
      );
      lines.forEach((line, index) => {
        ensure(lineHeight);
        y -= row.size;
        text("F1", row.size, page.margin, line);
        if (index === 0)
          text("F1", row.size, page.width - page.margin - rightWidth, right);
        y -= lineHeight - row.size;
      });
    }
  }
  return pages.map((operators) => operators.join("\n"));
}

/** A complete PDF file for one document; starts with `%PDF-`. */
export function renderDocumentPdf(doc: Document): Buffer {
  const page = doc.documentKind === "receipt" ? RECEIPT_PAGE : A4_PAGE;
  const contents = paginate(buildRows(doc), page);

  // Objects: 1 catalog, 2 page tree, 3 Helvetica, 4 Helvetica-Bold, then a
  // page object and a content stream per page.
  const objects: string[] = [];
  const pageObjectIds = contents.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${contents.length} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  contents.forEach((stream, index) => {
    const pageId = 5 + index * 2;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: Buffer[] = [
    Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1"),
  ];
  const offsets: number[] = [];
  let length = chunks[0]?.length ?? 0;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const chunk = Buffer.from(
      `${id} 0 obj\n${objects[id]}\nendobj\n`,
      "latin1",
    );
    chunks.push(chunk);
    length += chunk.length;
  }
  const xref =
    `xref\n0 ${objects.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}
