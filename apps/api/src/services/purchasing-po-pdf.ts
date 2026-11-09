// Minimal PDF 1.4 renderer for a purchase order (legend-9yz, PRD purchasing).
// No dependency: Helvetica (WinAnsi), one content stream per page, a classic
// xref table. A pure function of its input, so a re-send of the same order is
// byte-identical.

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

const PAGE = { width: 595, height: 842, margin: 40 };
const SIZE = 9;

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

export function textWidth(text: string, size: number): number {
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    total +=
      code >= 32 && code <= 126 ? (HELVETICA_WIDTHS[code - 32] ?? 556) : 556;
  }
  return (total * size) / 1000;
}

/** Cut text with an ellipsis-free trim so it fits `maxWidth`. */
function fit(text: string, size: number, maxWidth: number): string {
  let out = text;
  while (out.length > 1 && textWidth(out, size) > maxWidth)
    out = out.slice(0, -1);
  return out;
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
      const head = fit(rest, size, maxWidth);
      lines.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

function escapePdf(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
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

type PageOps = string[];

/** Lay the document out into pages of PDF drawing operators. */
function paginate(input: PurchaseOrderPdfInput): string[] {
  const pages: PageOps[] = [[]];
  const usable = PAGE.width - PAGE.margin * 2;
  let y = PAGE.height - PAGE.margin;
  const current = () => pages[pages.length - 1] as PageOps;
  const ensure = (height: number) => {
    if (y - height < PAGE.margin) {
      pages.push([]);
      y = PAGE.height - PAGE.margin;
      return true;
    }
    return false;
  };
  const put = (
    font: "F1" | "F2",
    size: number,
    x: number,
    value: string,
    align: "left" | "right" = "left",
    width = 0,
  ) => {
    const safe = winAnsi(value);
    let drawSize = size;
    if (align === "right" && width > 0) {
      const natural = textWidth(safe, size);
      if (natural > width)
        drawSize = Math.max(
          MIN_CELL_SIZE,
          Math.floor((size * width * 100) / natural) / 100,
        );
    }
    const left =
      align === "right"
        ? PAGE.margin + x + width - textWidth(safe, drawSize)
        : PAGE.margin + x;
    current().push(
      `BT /${font} ${drawSize} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(safe)}) Tj ET`,
    );
  };
  const rule = () => {
    ensure(8);
    y -= 4;
    current().push(
      `0.5 w ${PAGE.margin} ${y.toFixed(2)} m ${PAGE.width - PAGE.margin} ${y.toFixed(2)} l S`,
    );
    y -= 4;
  };
  const line = (
    font: "F1" | "F2",
    size: number,
    value: string,
    x = 0,
    width = usable,
  ) => {
    for (const piece of wrap(winAnsi(value), size, width - x)) {
      ensure(size * 1.4);
      y -= size;
      put(font, size, x, piece);
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
    const nameLines = wrap(winAnsi(row.itemName), SIZE, COLUMNS.item.width);
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
          fit(winAnsi(row.uomCode), SIZE, COLUMNS.unit.width),
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
  return pages.map((operators) => operators.join("\n"));
}

/** A complete PDF file for one purchase order; starts with `%PDF-1.4`. */
export function renderPurchaseOrderPdf(input: PurchaseOrderPdfInput): Buffer {
  const contents = paginate(input);

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
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
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
