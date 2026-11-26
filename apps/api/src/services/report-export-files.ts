// File rendering for report exports (WS-11 F12, bead legend-ay6e6): one
// `ReportResult` table to CSV, XLSX or PDF. Pure: no database, no clock.
//
// - Columns: bucket start/end when the result is split by time, then the
//   group-by dimensions, then one column per metric definition. A null value
//   stays an empty cell, never 0 (a missing figure is not zero).
// - CSV formula injection (OWASP "CSV Injection"): every TEXT cell that starts
//   with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`
//   so a spreadsheet shows it as text instead of running it. Numbers are
//   written by this module from typed values, never from user text, so a
//   negative amount keeps its sign. The same guard applies to XLSX text cells
//   (inline strings are literal in Excel, but a re-save to CSV would not be).
// - XLSX: a minimal Office Open XML workbook (one sheet, inline strings,
//   stored zip entries), no dependency.
import { crc32 } from "node:zlib";
import type { ReportResult } from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";
import { renderPdfDocument } from "./pdf/pdf-document";

export type ExportCell =
  | { kind: "text"; value: string }
  | { kind: "number"; value: string }
  | { kind: "empty" };

export type ExportTable = {
  readonly title: string;
  readonly subtitle: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly ExportCell[])[];
};

const FORMULA_START = /^[=+\-@\t\r]/;

/** Text a spreadsheet will never evaluate as a formula. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function numberCell(value: MetricValue): ExportCell {
  switch (value.unit) {
    case "idr":
      return { kind: "number", value: String(value.valueIdr) };
    case "count":
    case "seconds":
      return { kind: "number", value: String(value.value) };
    case "percent":
    case "decimal":
      return { kind: "number", value: String(value.value) };
  }
}

const UNIT_LABEL: Record<string, string> = {
  idr: "Rp",
  count: "jumlah",
  percent: "%",
  decimal: "angka",
  seconds: "detik",
};

/**
 * The table every format renders. `labels` maps a dimension value (an outlet
 * id) to a display name; unmapped values are shown as they are.
 */
export function exportTableOf(
  result: ReportResult,
  input: {
    readonly title: string;
    readonly labels?: ReadonlyMap<string, string>;
  },
): ExportTable {
  const split = result.bucket !== "total";
  const header = [
    ...(split ? ["Mulai", "Sampai"] : []),
    ...result.groupBy,
    ...result.definitions.map(
      (definition) =>
        `${definition.name} (${UNIT_LABEL[definition.unit] ?? definition.unit})`,
    ),
  ];
  const rows = result.rows.map((row): ExportCell[] => [
    ...(split
      ? [
          { kind: "text" as const, value: row.bucketStart },
          { kind: "text" as const, value: row.bucketEnd },
        ]
      : []),
    ...row.dimensions.map((dimension) => ({
      kind: "text" as const,
      value: input.labels?.get(dimension.value) ?? dimension.value,
    })),
    ...row.values.map((cell): ExportCell =>
      cell.value === null ? { kind: "empty" } : numberCell(cell.value),
    ),
  ]);
  const estimate = result.rows.some((row) =>
    row.values.some((cell) => cell.finality === "estimate"),
  );
  return {
    title: input.title,
    subtitle:
      `Periode ${result.period.startDate} s.d. ${result.period.endDate}` +
      (estimate ? " (sebagian angka masih estimasi)" : ""),
    header,
    rows,
  };
}

// ---- CSV ----------------------------------------------------------------------

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvCell(cell: ExportCell): string {
  if (cell.kind === "empty") return "";
  if (cell.kind === "number") return cell.value;
  return csvField(neutralizeFormula(cell.value));
}

/** RFC 4180 with CRLF and a UTF-8 BOM so spreadsheets read the accents. */
export function renderCsv(table: ExportTable): Buffer {
  const lines = [
    table.header.map((text) => csvField(neutralizeFormula(text))).join(","),
    ...table.rows.map((row) => row.map(csvCell).join(",")),
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

// ---- XLSX ---------------------------------------------------------------------

function xmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "");
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function xlsxCell(cell: ExportCell, ref: string): string {
  if (cell.kind === "empty") return "";
  if (cell.kind === "number") return `<c r="${ref}"><v>${cell.value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(neutralizeFormula(cell.value))}</t></is></c>`;
}

function sheetXml(table: ExportTable): string {
  const all: (readonly ExportCell[])[] = [
    table.header.map((value) => ({ kind: "text" as const, value })),
    ...table.rows,
  ];
  const rows = all
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((cell, c) => xlsxCell(cell, `${columnName(c)}${r + 1}`)).join("")}</row>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/** Stored (uncompressed) zip; enough for a workbook of at most 1000 rows. */
function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function renderXlsx(table: ExportTable): Buffer {
  const file = (name: string, text: string) => ({
    name,
    data: Buffer.from(text, "utf8"),
  });
  const sheetName = xmlText(table.title.replace(/[\\/?*[\]:]/g, " ")).slice(
    0,
    31,
  );
  return zip([
    file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName || "Laporan"}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    file("xl/worksheets/sheet1.xml", sheetXml(table)),
  ]);
}

// ---- PDF ----------------------------------------------------------------------

const idrFormat = new Intl.NumberFormat("id-ID");

export async function renderPdf(table: ExportTable): Promise<Buffer> {
  const width = 1 / Math.max(1, table.header.length);
  const text = (cell: ExportCell) =>
    cell.kind === "empty"
      ? "-"
      : cell.kind === "number"
        ? idrFormat.format(Number(cell.value))
        : cell.value;
  const bytes = await renderPdfDocument({
    title: table.title,
    header: { title: table.title, subtitle: table.subtitle },
    blocks: [
      {
        type: "table",
        columns: table.header.map((header, index) => ({
          header,
          width,
          align: table.rows[0]?.[index]?.kind === "number" ? "right" : "left",
        })),
        rows: table.rows.map((row) => row.map(text)),
      },
    ],
  });
  return Buffer.from(bytes);
}

export const EXPORT_CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export async function renderExportFile(
  format: "csv" | "xlsx" | "pdf",
  table: ExportTable,
): Promise<Buffer> {
  if (format === "csv") return renderCsv(table);
  if (format === "xlsx") return renderXlsx(table);
  return renderPdf(table);
}
