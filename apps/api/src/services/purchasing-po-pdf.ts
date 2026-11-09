// PO PDF renderer on pdf-lib (legend-9yz, PRD purchasing; legend-uokb). Text is
// set in an embedded Noto Sans subset (Latin, Latin Extended, Greek, Cyrillic;
// SIL OFL, see apps/api/assets/fonts), so supplier and item names are never
// reduced to `?`. A glyph outside that subset draws the font's .notdef box.
// Widths come from the font itself. The creation date is the order's issue
// date and object streams are off, so a re-send of the same order is
// byte-identical and the file keeps a classic xref table.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type {
  PurchaseOrder,
  PurchaseOrderLine,
} from "@starter/shared/inventory";

export type PurchaseOrderPdfInput = {
  tenantName: string;
  outletName: string;
  supplier: { name: string; address: string | null; phone: string | null };
  order: PurchaseOrder;
  lines: (PurchaseOrderLine & { itemName: string; uomCode: string })[];
  issuedAt: Date;
};

const PAGE = { width: 595, height: 842, margin: 40 };
const SIZE = 9;

const FONT_FILES = {
  regular: "NotoSans-Regular-subset.ttf",
  bold: "NotoSans-Bold-subset.ttf",
} as const;
type FontWeight = keyof typeof FONT_FILES;

/**
 * Font bytes. The production bundle copies `assets/` next to the server files
 * (tsup `publicDir`, so `dist/fonts/`); from source (tests, tsx) the files sit
 * in `apps/api/assets/fonts/`.
 */
function fontBytes(weight: FontWeight): Buffer {
  const file = FONT_FILES[weight];
  const candidates = [
    new URL(`./fonts/${file}`, import.meta.url),
    new URL(`../../assets/fonts/${file}`, import.meta.url),
  ];
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`PO PDF font missing: ${file}`);
  return readFileSync(found);
}

type MeasureFont = ReturnType<typeof fontkit.create>;
const bytesCache = new Map<FontWeight, Buffer>();
const measureCache = new Map<FontWeight, MeasureFont>();

function bytesOf(weight: FontWeight): Buffer {
  let bytes = bytesCache.get(weight);
  if (!bytes) {
    bytes = fontBytes(weight);
    bytesCache.set(weight, bytes);
  }
  return bytes;
}

function measureFont(weight: FontWeight): MeasureFont {
  let font = measureCache.get(weight);
  if (!font) {
    font = fontkit.create(bytesOf(weight));
    measureCache.set(weight, font);
  }
  return font;
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

/** Advance width in points, summed over glyphs as pdf-lib draws them. */
export function textWidth(text: string, size: number, bold = false): number {
  const font = measureFont(bold ? "bold" : "regular");
  const { glyphs } = font.layout(clean(text));
  let total = 0;
  for (const glyph of glyphs) total += glyph.advanceWidth;
  return (total * size) / font.unitsPerEm;
}

/** Cut text with an ellipsis-free trim so it fits `maxWidth`. */
function fit(text: string, size: number, maxWidth: number, bold = false) {
  const chars = Array.from(text);
  while (chars.length > 1 && textWidth(chars.join(""), size, bold) > maxWidth)
    chars.pop();
  return chars.join("");
}

/** Greedy word wrap; a word longer than the line is cut by character. */
function wrap(
  text: string,
  size: number,
  maxWidth: number,
  bold = false,
): string[] {
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
    current = "";
    let rest = word;
    while (
      textWidth(rest, size, bold) > maxWidth &&
      Array.from(rest).length > 1
    ) {
      const head = fit(rest, size, maxWidth, bold);
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** `Rp 1.234.567`; a negative amount is `-Rp 500`. */
export function formatRupiah(amount: number): string {
  const digits = groupThousands(Math.abs(Math.trunc(amount)).toString());
  return `${amount < 0 ? "-" : ""}Rp ${digits}`;
}

/** NUMERIC(14,4) string to `1.234,5`; trailing fraction zeros are dropped. */
function formatDecimal(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupThousands(whole)}${trimmed === "" ? "" : `,${trimmed}`}`;
}

/** Per-unit price keeps its fraction (`Rp 12.500,5`); whole prices are plain. */
function formatUnitPrice(value: string): string {
  return `Rp ${formatDecimal(value)}`;
}

/** `08/11/2026` in Jakarta time. */
function formatIssued(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")}`;
}

function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

// Table columns, left x offset from the margin and width. Amount columns hold
// a 10-digit rupiah figure (`Rp 9.999.999.999`, ~72pt at 9pt) and a NUMERIC
// (14,4) unit price (`Rp 9.999.999.999,9999`, ~94pt); anything wider shrinks
// its font in `put` instead of running into the neighbouring column.
export const COLUMNS = {
  no: { x: 0, width: 20 },
  item: { x: 24, width: 142 },
  qty: { x: 170, width: 70 },
  unit: { x: 244, width: 34 },
  price: { x: 282, width: 112 },
  total: { x: 398, width: 117 },
} as const;

/** Smallest font a right-aligned cell may shrink to. */
const MIN_CELL_SIZE = 5;

type Face = "F1" | "F2";

/** Lay the document out onto pdf-lib pages. */
function paginate(
  pdf: PDFDocument,
  fonts: Record<Face, PDFFont>,
  input: PurchaseOrderPdfInput,
): void {
  const usable = PAGE.width - PAGE.margin * 2;
  const newPage = () => pdf.addPage([PAGE.width, PAGE.height]);
  let page: PDFPage = newPage();
  let y = PAGE.height - PAGE.margin;
  const ensure = (height: number) => {
    if (y - height < PAGE.margin) {
      page = newPage();
      y = PAGE.height - PAGE.margin;
      return true;
    }
    return false;
  };
  const put = (
    face: Face,
    size: number,
    x: number,
    value: string,
    align: "left" | "right" = "left",
    width = 0,
  ) => {
    const safe = clean(value);
    const bold = face === "F2";
    let drawSize = size;
    if (align === "right" && width > 0) {
      const natural = textWidth(safe, size, bold);
      if (natural > width)
        drawSize = Math.max(
          MIN_CELL_SIZE,
          Math.floor((size * width * 100) / natural) / 100,
        );
    }
    const left =
      align === "right"
        ? PAGE.margin + x + width - textWidth(safe, drawSize, bold)
        : PAGE.margin + x;
    page.drawText(safe, { x: left, y, size: drawSize, font: fonts[face] });
  };
  const rule = () => {
    ensure(8);
    y -= 4;
    page.drawLine({
      start: { x: PAGE.margin, y },
      end: { x: PAGE.width - PAGE.margin, y },
      thickness: 0.5,
    });
    y -= 4;
  };
  const line = (
    face: Face,
    size: number,
    value: string,
    x = 0,
    width = usable,
  ) => {
    for (const piece of wrap(value, size, width - x, face === "F2")) {
      ensure(size * 1.4);
      y -= size;
      put(face, size, x, piece);
      y -= size * 0.4;
    }
  };
  const pair = (label: string, value: string, bold = false, size = SIZE) => {
    ensure(size * 1.4);
    y -= size;
    put(bold ? "F2" : "F1", size, 0, label);
    put(bold ? "F2" : "F1", size, 0, value, "right", usable);
    y -= size * 0.4;
  };
  const tableHeader = () => {
    ensure(SIZE * 1.4);
    y -= SIZE;
    put("F2", SIZE, COLUMNS.no.x, "No");
    put("F2", SIZE, COLUMNS.item.x, "Barang");
    put("F2", SIZE, COLUMNS.qty.x, "Jumlah", "right", COLUMNS.qty.width);
    put("F2", SIZE, COLUMNS.unit.x, "Satuan");
    put("F2", SIZE, COLUMNS.price.x, "Harga", "right", COLUMNS.price.width);
    put("F2", SIZE, COLUMNS.total.x, "Total", "right", COLUMNS.total.width);
    y -= SIZE * 0.4;
    rule();
  };

  const { order, supplier } = input;
  line("F2", 18, "PURCHASE ORDER");
  line("F2", 11, input.tenantName);
  line("F1", SIZE, input.outletName);
  y -= 4;
  rule();
  pair("No. PO", order.number);
  pair("Tanggal terbit", formatIssued(input.issuedAt));
  pair("Tanggal dibutuhkan", formatDate(order.expectedDate));
  y -= 6;
  line("F2", SIZE, "Pemasok");
  line("F1", SIZE, supplier.name, 8);
  if (supplier.address) line("F1", SIZE, supplier.address, 8);
  if (supplier.phone) line("F1", SIZE, `Telp ${supplier.phone}`, 8);
  y -= 4;
  rule();

  tableHeader();
  input.lines.forEach((row, index) => {
    const nameLines = wrap(row.itemName, SIZE, COLUMNS.item.width);
    if (ensure(SIZE * 1.4 * nameLines.length)) tableHeader();
    nameLines.forEach((piece, lineIndex) => {
      y -= SIZE;
      if (lineIndex === 0) {
        put("F1", SIZE, COLUMNS.no.x, String(index + 1));
        put(
          "F1",
          SIZE,
          COLUMNS.qty.x,
          formatDecimal(row.quantity),
          "right",
          COLUMNS.qty.width,
        );
        put(
          "F1",
          SIZE,
          COLUMNS.unit.x,
          fit(row.uomCode, SIZE, COLUMNS.unit.width),
        );
        put(
          "F1",
          SIZE,
          COLUMNS.price.x,
          formatUnitPrice(row.unitPriceIdr),
          "right",
          COLUMNS.price.width,
        );
        put(
          "F1",
          SIZE,
          COLUMNS.total.x,
          formatRupiah(row.lineTotalIdr),
          "right",
          COLUMNS.total.width,
        );
      }
      put("F1", SIZE, COLUMNS.item.x, piece);
      y -= SIZE * 0.4;
    });
  });
  rule();

  ensure(SIZE * 1.4 * 3 + 16);
  pair("Subtotal", formatRupiah(order.subtotalIdr));
  pair("Pajak", formatRupiah(order.taxIdr));
  pair("TOTAL", formatRupiah(order.totalIdr), true, SIZE + 2);
  if (order.note) {
    y -= 8;
    line("F2", SIZE, "Catatan");
    line("F1", SIZE, order.note, 8);
  }
}

/** A complete PDF file for one purchase order; starts with `%PDF-`. */
export async function renderPurchaseOrderPdf(
  input: PurchaseOrderPdfInput,
): Promise<Buffer> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setProducer("Legend");
  pdf.setCreator("Legend");
  pdf.setCreationDate(input.issuedAt);
  pdf.setModificationDate(input.issuedAt);
  const fonts = {
    F1: await pdf.embedFont(bytesOf("regular"), { subset: true }),
    F2: await pdf.embedFont(bytesOf("bold"), { subset: true }),
  };
  paginate(pdf, fonts, input);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
