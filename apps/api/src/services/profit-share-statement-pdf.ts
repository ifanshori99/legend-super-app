// Shareholder statement PDF ("Pernyataan Bagi Hasil", PRD v1.7 §3.37, SH-01,
// SH-04; bead legend-2ljb). One paid line of one run: the statement object only
// ever holds this shareholder's figures (`buildDistributionStatement`), so no
// other shareholder's name, share or account can reach the page. Same pdf-lib
// and embedded Noto Sans setup as `purchasing-po-pdf.ts`; the creation date is
// the payment time, so rendering the same statement twice is byte-identical.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type { DistributionStatement } from "@starter/shared/accounting";
import { formatRupiah, textWidth } from "./purchasing-po-pdf.ts";

export type StatementPdfMeta = {
  tenantName: string;
  /** Creation date written into the file; defaults to the payment time. */
  issuedAt?: Date;
};

const PAGE = { width: 595, height: 842, margin: 40 };
const SIZE = 10;

const FONT_FILES = {
  regular: "NotoSans-Regular-subset.ttf",
  bold: "NotoSans-Bold-subset.ttf",
} as const;
type FontWeight = keyof typeof FONT_FILES;

/** Same lookup as the PO PDF: `dist/fonts/` in production, `assets/fonts/` from source. */
function fontBytes(weight: FontWeight): Buffer {
  const file = FONT_FILES[weight];
  const candidates = [
    new URL(`./fonts/${file}`, import.meta.url),
    new URL(`../../assets/fonts/${file}`, import.meta.url),
  ];
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`Statement PDF font missing: ${file}`);
  return readFileSync(found);
}

/** Tabs and line breaks print as a space; other control characters vanish. */
function clean(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) out += " ";
    else if (code >= 32 && !(code >= 0x7f && code <= 0x9f)) out += char;
  }
  return out;
}

/** Greedy word wrap; a word longer than the line is cut by character. */
function wrap(text: string, size: number, maxWidth: number, bold = false) {
  const lines: string[] = [];
  let current = "";
  for (const word of clean(text).split(" ")) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    let rest = word;
    while (
      textWidth(rest, size, bold) > maxWidth &&
      Array.from(rest).length > 1
    ) {
      const chars = Array.from(rest);
      while (
        chars.length > 1 &&
        textWidth(chars.join(""), size, bold) > maxWidth
      )
        chars.pop();
      const head = chars.join("");
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** `2026-10` -> `Oktober 2026`. */
function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : period;
}

/** `10/11/2026` in Jakarta time. */
function formatPaidDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(iso));
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")}`;
}

/** Basis points as a percentage: 3333 -> `33,33%`, 2500 -> `25%`. */
function formatShare(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `,${fraction}`}%`;
}

type Face = "F1" | "F2";

function draw(
  pdf: PDFDocument,
  fonts: Record<Face, PDFFont>,
  statement: DistributionStatement,
  meta: StatementPdfMeta,
): void {
  const usable = PAGE.width - PAGE.margin * 2;
  const page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const put = (
    face: Face,
    size: number,
    value: string,
    align: "left" | "right" = "left",
  ) => {
    const safe = clean(value);
    const x =
      align === "right"
        ? PAGE.margin + usable - textWidth(safe, size, face === "F2")
        : PAGE.margin;
    page.drawText(safe, { x, y, size, font: fonts[face] });
  };
  const rule = () => {
    y -= 4;
    page.drawLine({
      start: { x: PAGE.margin, y },
      end: { x: PAGE.width - PAGE.margin, y },
      thickness: 0.5,
    });
    y -= 6;
  };
  const line = (face: Face, size: number, value: string) => {
    for (const piece of wrap(value, size, usable, face === "F2")) {
      y -= size;
      put(face, size, piece);
      y -= size * 0.4;
    }
  };
  const pair = (label: string, value: string, bold = false, size = SIZE) => {
    y -= size;
    put(bold ? "F2" : "F1", size, label);
    put(bold ? "F2" : "F1", size, value, "right");
    y -= size * 0.5;
  };

  line("F2", 18, "Pernyataan Bagi Hasil");
  line("F2", 11, meta.tenantName);
  line("F1", SIZE, statement.profitEntityName);
  y -= 4;
  rule();
  pair("Pemegang saham", statement.shareholderName);
  pair("Periode", formatPeriod(statement.period));
  pair(
    "Jenis",
    statement.runType === "adjustment" ? "Penyesuaian" : "Pembagian reguler",
  );
  pair("Porsi kepemilikan", formatShare(statement.shareBp));
  y -= 4;
  rule();
  // The cut is read top to bottom: share before it, the cut, then the gross
  // share left (the stored gross is already net of the cut).
  if (statement.carryDeductedIdr > 0) {
    pair(
      "Bagian sebelum potongan",
      formatRupiah(statement.grossIdr + statement.carryDeductedIdr),
    );
    pair(
      "Potongan kekurangan koreksi",
      formatRupiah(statement.carryDeductedIdr),
    );
  }
  pair("Bagian kotor", formatRupiah(statement.grossIdr));
  pair("Pajak dipotong", formatRupiah(statement.taxWithheldIdr));
  pair("Bagian bersih", formatRupiah(statement.netIdr), true, SIZE + 2);
  y -= 4;
  rule();
  if (statement.paymentRef) pair("Referensi pembayaran", statement.paymentRef);
  if (statement.paidAt)
    pair("Tanggal pembayaran", formatPaidDate(statement.paidAt));
  if (statement.runType === "adjustment") {
    y -= 8;
    line(
      "F2",
      SIZE,
      statement.grossIdr < 0
        ? "Catatan penyesuaian (pengembalian)"
        : "Catatan penyesuaian",
    );
    line(
      "F1",
      SIZE,
      "Pernyataan ini mengoreksi pembagian periode sebelumnya. Pembagian yang sudah dibayar tidak diubah; selisihnya dibayarkan atau dikembalikan lewat penyesuaian ini.",
    );
  }
}

/** A complete PDF file for one paid line; starts with `%PDF-`. */
export async function renderDistributionStatementPdf(
  statement: DistributionStatement,
  meta: StatementPdfMeta,
): Promise<Uint8Array> {
  const issuedAt =
    meta.issuedAt ??
    (statement.paidAt ? new Date(statement.paidAt) : new Date(0));
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setProducer("Legend");
  pdf.setCreator("Legend");
  pdf.setTitle("Pernyataan Bagi Hasil");
  pdf.setCreationDate(issuedAt);
  pdf.setModificationDate(issuedAt);
  const fonts = {
    F1: await pdf.embedFont(fontBytes("regular"), { subset: true }),
    F2: await pdf.embedFont(fontBytes("bold"), { subset: true }),
  };
  draw(pdf, fonts, statement, meta);
  return pdf.save({ useObjectStreams: false });
}
