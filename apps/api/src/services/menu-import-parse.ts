// Menu bulk import parsing (bead legend-dmi; PRD v1.7 §3 F8 "Impor Massal").
// Pure functions, no database: CSV and XLSX bytes in, validated rows out.
//
// Safety rules (all enforced here, covered by menu-import-parse.test.ts):
// - hard limits on file size, rows, columns, cell length and (XLSX) the
//   decompressed size, so a zip bomb or a million-row sheet is refused early;
// - XLSX is read by a minimal, linear (indexOf, no backtracking regex) reader
//   that never evaluates formulas: a cell that holds a formula becomes a row
//   error, its cached value is ignored;
// - XML with a DOCTYPE / ENTITY declaration is refused (no entity expansion);
// - CSV/formula injection: a text cell that starts with = + - @ (or a control
//   character) is refused instead of stored, so a later CSV export of the menu
//   cannot carry a formula. `csvSafeCell` is the matching export-side guard;
// - every row is validated with the contract's strict `importRowSchema`
//   (packages/shared/src/menu/schemas.ts); errors carry the spreadsheet row
//   number (header = row 1).

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  importRowSchema,
  MENU_IMPORT_MAX_FILE_BYTES,
  type MenuImportRow,
} from "@starter/shared/menu";

export const IMPORT_MAX_FILE_BYTES = MENU_IMPORT_MAX_FILE_BYTES;
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_COLUMNS = 20;
export const IMPORT_MAX_CELL_CHARS = 1000;
export const IMPORT_MAX_XLSX_ENTRIES = 100;
export const IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

export type ImportFormat = "csv" | "xlsx";

export type ImportRowError = {
  /** Canonical column, or `row` for a whole-row problem. */
  field: string;
  code:
    | "REQUIRED"
    | "INVALID"
    | "FORMULA_NOT_ALLOWED"
    | "DUPLICATE_IN_FILE"
    | "DUPLICATE_EXISTING"
    | "TOO_LONG";
  message: string;
};

export type ParsedImportRow = {
  /** Spreadsheet row number; the header is row 1. */
  rowNumber: number;
  data: MenuImportRow | null;
  errors: ImportRowError[];
};

export type ParsedImport = {
  format: ImportFormat;
  /** sha256 hex of the uploaded bytes. */
  fileHash: string;
  rows: ParsedImportRow[];
};

/** A whole-file failure (not a row error): the request is refused. */
export class ImportFileError extends Error {
  constructor(
    public code:
      | "FILE_TOO_LARGE"
      | "FILE_EMPTY"
      | "FILE_UNSUPPORTED"
      | "FILE_CORRUPT"
      | "TOO_MANY_ROWS"
      | "TOO_MANY_COLUMNS"
      | "HEADER_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "ImportFileError";
  }
}

// ------------------------------------------------------------------ columns

type Column =
  | "category"
  | "name"
  | "description"
  | "type"
  | "priceIdr"
  | "station"
  | "course"
  | "labels"
  | "allergens";

const REQUIRED_COLUMNS: readonly Column[] = [
  "category",
  "name",
  "priceIdr",
  "station",
];

/** Header aliases (Indonesian template first), compared case-insensitively. */
const HEADER_ALIASES: Record<Column, readonly string[]> = {
  category: ["kategori", "category"],
  name: ["nama", "nama item", "name", "item"],
  description: ["deskripsi", "description", "keterangan"],
  type: ["tipe", "jenis", "type"],
  priceIdr: ["harga", "harga (rp)", "price", "priceidr", "price_idr"],
  station: ["stasiun", "station", "stasiun produksi"],
  course: ["course", "kursus", "urutan sajian"],
  labels: ["label", "labels"],
  allergens: ["alergen", "allergens", "allergen"],
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function columnOf(header: string): Column | null {
  const normalized = normalizeHeader(header);
  for (const column of Object.keys(HEADER_ALIASES) as Column[])
    if (HEADER_ALIASES[column].includes(normalized)) return column;
  return null;
}

// -------------------------------------------------------------- CSV safety

/** Characters that make a spreadsheet application treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Export-side guard: neutralise a cell that a spreadsheet would run. */
export function csvSafeCell(value: string): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

// --------------------------------------------------------------------- CSV

/** RFC 4180 reader. Delimiter is detected from the header line (, ; or tab). */
export function parseCsvText(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => ({
    d,
    n: firstLine.split(d).length,
  }));
  const delimiter = counts.sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    if (rows.length > IMPORT_MAX_ROWS + 1)
      throw new ImportFileError(
        "TOO_MANY_ROWS",
        `Berkas melebihi ${IMPORT_MAX_ROWS} baris.`,
      );
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      if (cell.length > IMPORT_MAX_CELL_CHARS * 4)
        throw new ImportFileError("FILE_CORRUPT", "Sel terlalu panjang.");
      continue;
    }
    if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === delimiter) endCell();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += ch;
      cellStarted = true;
      if (cell.length > IMPORT_MAX_CELL_CHARS * 4)
        throw new ImportFileError("FILE_CORRUPT", "Sel terlalu panjang.");
    }
  }
  if (quoted)
    throw new ImportFileError("FILE_CORRUPT", "Tanda kutip tidak ditutup.");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

// -------------------------------------------------------------------- XLSX

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  flags: number;
};

/** Central-directory reader; zip64, encryption and multi-disk are refused. */
function readZipEntries(bytes: Buffer): Map<string, ZipEntry> {
  const corrupt = () =>
    new ImportFileError("FILE_CORRUPT", "Berkas XLSX tidak valid.");
  if (bytes.length < 22) throw corrupt();
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw corrupt();
  const count = bytes.readUInt16LE(eocd + 10);
  const dirSize = bytes.readUInt32LE(eocd + 12);
  const dirOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff)
    throw corrupt();
  if (count > IMPORT_MAX_XLSX_ENTRIES)
    throw new ImportFileError(
      "FILE_CORRUPT",
      "Berkas XLSX memuat terlalu banyak bagian.",
    );
  const entries = new Map<string, ZipEntry>();
  let pos = dirOffset;
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50)
      throw corrupt();
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const compressedSize = bytes.readUInt32LE(pos + 20);
    const size = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28);
    const extraLength = bytes.readUInt16LE(pos + 30);
    const commentLength = bytes.readUInt16LE(pos + 32);
    const offset = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + nameLength > bytes.length) throw corrupt();
    const name = bytes.toString("utf8", pos + 46, pos + 46 + nameLength);
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      offset === 0xffffffff
    )
      throw corrupt();
    entries.set(name, { name, method, compressedSize, size, offset, flags });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipText(
  bytes: Buffer,
  entry: ZipEntry,
  budget: { remaining: number },
): string {
  const corrupt = () =>
    new ImportFileError("FILE_CORRUPT", "Berkas XLSX tidak valid.");
  if (entry.flags & 1) throw corrupt(); // encrypted
  if (entry.size > budget.remaining)
    throw new ImportFileError(
      "FILE_TOO_LARGE",
      "Isi berkas XLSX terlalu besar.",
    );
  const header = entry.offset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50)
    throw corrupt();
  const start =
    header +
    30 +
    bytes.readUInt16LE(header + 26) +
    bytes.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw corrupt();
  const raw = bytes.subarray(start, end);
  let content: Buffer;
  if (entry.method === 0) content = raw;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
    } catch {
      throw corrupt();
    }
  } else throw corrupt();
  if (content.length !== entry.size || content.length > budget.remaining)
    throw new ImportFileError(
      "FILE_TOO_LARGE",
      "Isi berkas XLSX terlalu besar.",
    );
  budget.remaining -= content.length;
  const text = content.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new ImportFileError(
      "FILE_UNSUPPORTED",
      "Berkas XLSX memuat deklarasi XML yang tidak diizinkan.",
    );
  return text;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_, e) => {
      switch (e) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      const code =
        e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

/**
 * Linear scan of `<tag ...>inner</tag>` and `<tag .../>` elements (the tag must
 * not nest inside itself). indexOf only, never a backtracking regex over the
 * whole part: a crafted sheet of unclosed tags would otherwise make the scan
 * quadratic and block the event loop. An unclosed element is FILE_CORRUPT.
 */
function* xmlElements(
  xml: string,
  tag: string,
): Generator<{ attrs: string; inner: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const start = xml.indexOf(open, pos);
    if (start < 0) return;
    const next = xml[start + open.length];
    if (next !== ">" && next !== "/" && !/\s/.test(next ?? "")) {
      pos = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf(">", start + open.length);
    if (tagEnd < 0)
      throw new ImportFileError("FILE_CORRUPT", "Berkas XLSX tidak valid.");
    if (xml[tagEnd - 1] === "/") {
      yield { attrs: xml.slice(start + open.length, tagEnd - 1), inner: "" };
      pos = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd + 1);
    if (end < 0)
      throw new ImportFileError("FILE_CORRUPT", "Berkas XLSX tidak valid.");
    yield {
      attrs: xml.slice(start + open.length, tagEnd),
      inner: xml.slice(tagEnd + 1, end),
    };
    pos = end + close.length;
  }
}

function firstElement(
  xml: string,
  tag: string,
): { attrs: string; inner: string } | null {
  for (const element of xmlElements(xml, tag)) return element;
  return null;
}

/** Concatenated text of every <t> in a fragment (rich text safe). */
function textOf(fragment: string): string {
  let out = "";
  for (const t of xmlElements(fragment, "t")) out += decodeXml(t.inner);
  return out;
}

function sharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const out: string[] = [];
  for (const si of xmlElements(xml, "si")) {
    out.push(textOf(si.inner));
    if (out.length > 200_000)
      throw new ImportFileError("FILE_TOO_LARGE", "Berkas XLSX terlalu besar.");
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase())
    n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(
  entries: Map<string, ZipEntry>,
  workbook: string | null,
  rels: string | null,
): string {
  if (workbook !== null && rels !== null) {
    const sheet = firstElement(workbook, "sheet");
    const sheetRel = sheet ? /\br:id="([^"]+)"/.exec(sheet.attrs)?.[1] : null;
    if (sheetRel) {
      for (const rel of xmlElements(rels, "Relationship")) {
        const id = /\bId="([^"]+)"/.exec(rel.attrs)?.[1];
        const target = /\bTarget="([^"]+)"/.exec(rel.attrs)?.[1];
        if (id === sheetRel && target) {
          const path = target.startsWith("/")
            ? target.slice(1)
            : `xl/${target.replace(/^\.\//, "")}`;
          if (entries.has(path)) return path;
        }
      }
    }
  }
  const fallback = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort()[0];
  if (!fallback)
    throw new ImportFileError("FILE_CORRUPT", "Lembar kerja tidak ditemukan.");
  return fallback;
}

/** First worksheet as text rows. Formula cells come back as `=<formula>`. */
export function parseXlsxBytes(bytes: Buffer): string[][] {
  const entries = readZipEntries(bytes);
  const budget = { remaining: IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES };
  const read = (name: string): string | null => {
    const entry = entries.get(name);
    return entry ? readZipText(bytes, entry, budget) : null;
  };
  const sheetPath = firstSheetPath(
    entries,
    read("xl/workbook.xml"),
    read("xl/_rels/workbook.xml.rels"),
  );
  const strings = sharedStrings(read("xl/sharedStrings.xml"));
  const sheet = read(sheetPath);
  if (sheet === null)
    throw new ImportFileError("FILE_CORRUPT", "Lembar kerja tidak ditemukan.");
  const rows: string[][] = [];
  for (const row of xmlElements(sheet, "row")) {
    const rowNumber = Number(
      /\br="(\d+)"/.exec(row.attrs)?.[1] ?? rows.length + 1,
    );
    if (rowNumber > IMPORT_MAX_ROWS + 1)
      throw new ImportFileError(
        "TOO_MANY_ROWS",
        `Berkas melebihi ${IMPORT_MAX_ROWS} baris.`,
      );
    const cells: string[] = [];
    for (const cell of xmlElements(row.inner, "c")) {
      const attrs = cell.attrs;
      const inner = cell.inner;
      const ref = /\br="([A-Z]+)\d+"/i.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;
      if (index >= IMPORT_MAX_COLUMNS) {
        if (inner.trim() !== "")
          throw new ImportFileError(
            "TOO_MANY_COLUMNS",
            `Berkas melebihi ${IMPORT_MAX_COLUMNS} kolom.`,
          );
        continue;
      }
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      const formula = firstElement(inner, "f");
      if (formula) value = `=${decodeXml(formula.inner)}`;
      else if (type === "inlineStr") value = textOf(inner);
      else {
        const v = firstElement(inner, "v")?.inner;
        if (v !== undefined && v !== "") {
          if (type === "s") value = strings[Number(v)] ?? "";
          else if (type === "e") value = "";
          else value = decodeXml(v);
        }
      }
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  return rows;
}

// ------------------------------------------------------------------- format

export function sniffFormat(fileName: string, bytes: Buffer): ImportFormat {
  const isZip = bytes.length > 3 && bytes.readUInt32LE(0) === 0x04034b50;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (!isZip)
      throw new ImportFileError(
        "FILE_UNSUPPORTED",
        "Berkas bukan XLSX yang valid.",
      );
    return "xlsx";
  }
  if (lower.endsWith(".csv")) {
    if (isZip)
      throw new ImportFileError(
        "FILE_UNSUPPORTED",
        "Isi berkas tidak sesuai CSV.",
      );
    return "csv";
  }
  throw new ImportFileError(
    "FILE_UNSUPPORTED",
    "Gunakan berkas .csv atau .xlsx.",
  );
}

// -------------------------------------------------------------- cell values

/** "25000", "25.000", "25,000", "Rp 25.000" -> 25000. Decimals are refused. */
export function parsePriceIdr(raw: string): number | null {
  const text = raw
    .trim()
    .replace(/^rp\.?\s*/i, "")
    .replace(/\s/g, "");
  if (/^\d{1,15}$/.test(text)) return Number(text);
  if (/^\d{1,3}([.,]\d{3})+$/.test(text))
    return Number(text.replace(/[.,]/g, ""));
  if (/^\d{1,15}\.0+$/.test(text)) return Number(text.split(".")[0]); // Excel float
  return null;
}

function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[|,]/)) {
    const value = part.trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function typeOf(raw: string): "single" | "combo" | null {
  const text = raw.trim().toLowerCase();
  if (
    text === "" ||
    text === "single" ||
    text === "tunggal" ||
    text === "satuan"
  )
    return "single";
  if (text === "combo" || text === "paket") return "combo";
  return null;
}

/** Case/space-insensitive key used for duplicate detection. */
export function importKey(category: string, name: string): string {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return `${norm(category)}\u0000${norm(name)}`;
}

// ----------------------------------------------------------------- the file

export function parseMenuImportFile(file: {
  fileName: string;
  bytes: Buffer;
}): ParsedImport {
  const { bytes } = file;
  if (bytes.length === 0)
    throw new ImportFileError("FILE_EMPTY", "Berkas kosong.");
  if (bytes.length > IMPORT_MAX_FILE_BYTES)
    throw new ImportFileError(
      "FILE_TOO_LARGE",
      `Berkas melebihi ${Math.floor(IMPORT_MAX_FILE_BYTES / 1024)} KB.`,
    );
  const format = sniffFormat(file.fileName, bytes);
  const table =
    format === "csv"
      ? parseCsvText(bytes.toString("utf8"))
      : parseXlsxBytes(bytes);
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const headerRow = table[0] ?? [];
  if (headerRow.length > IMPORT_MAX_COLUMNS)
    throw new ImportFileError(
      "TOO_MANY_COLUMNS",
      `Berkas melebihi ${IMPORT_MAX_COLUMNS} kolom.`,
    );
  const columnAt = new Map<number, Column>();
  headerRow.forEach((header, index) => {
    const column = columnOf(header);
    if (column && ![...columnAt.values()].includes(column))
      columnAt.set(index, column);
  });
  const present = new Set(columnAt.values());
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0)
    throw new ImportFileError(
      "HEADER_MISSING",
      `Kolom wajib tidak ditemukan: ${missing.join(", ")}.`,
    );

  const rows: ParsedImportRow[] = [];
  const firstSeen = new Map<string, number>();
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue; // blank line
    if (cells.length > IMPORT_MAX_COLUMNS)
      throw new ImportFileError(
        "TOO_MANY_COLUMNS",
        `Berkas melebihi ${IMPORT_MAX_COLUMNS} kolom.`,
      );
    const rowNumber = i + 1;
    if (rows.length >= IMPORT_MAX_ROWS)
      throw new ImportFileError(
        "TOO_MANY_ROWS",
        `Berkas melebihi ${IMPORT_MAX_ROWS} baris.`,
      );
    const errors: ImportRowError[] = [];
    const value: Partial<Record<Column, string>> = {};
    for (const [index, column] of columnAt) {
      const cell = (cells[index] ?? "").replace(/\r?\n/g, " ").trim();
      if (cell.length > IMPORT_MAX_CELL_CHARS) {
        errors.push({
          field: column,
          code: "TOO_LONG",
          message: `Isi sel melebihi ${IMPORT_MAX_CELL_CHARS} karakter.`,
        });
        continue;
      }
      if (hasControlChars(cell)) {
        errors.push({
          field: column,
          code: "INVALID",
          message: "Sel memuat karakter kontrol.",
        });
        continue;
      }
      // Price may start with "-" only to be rejected as invalid below; every
      // other column must not look like a formula.
      if (column !== "priceIdr" && FORMULA_START.test(cell)) {
        errors.push({
          field: column,
          code: "FORMULA_NOT_ALLOWED",
          message:
            "Sel tidak boleh diawali = + - atau @ (rumus tidak diizinkan).",
        });
        continue;
      }
      if (column === "priceIdr" && cell.startsWith("=")) {
        errors.push({
          field: column,
          code: "FORMULA_NOT_ALLOWED",
          message: "Rumus tidak diizinkan pada kolom harga.",
        });
        continue;
      }
      value[column] = cell;
    }

    const price = parsePriceIdr(value.priceIdr ?? "");
    const type = typeOf(value.type ?? "");
    const candidate = {
      category: value.category ?? "",
      name: value.name ?? "",
      description: value.description ?? "",
      type: type ?? "invalid",
      priceIdr: price ?? -1,
      station: value.station ?? "",
      course: value.course ?? "",
      labels: splitList(value.labels ?? ""),
      allergens: splitList(value.allergens ?? ""),
    };
    const parsed = importRowSchema.safeParse(candidate);
    const failed = new Set(errors.map((e) => e.field));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "row");
        if (failed.has(field)) continue;
        failed.add(field);
        const empty =
          (field !== "priceIdr" &&
            candidate[field as keyof typeof candidate] === "") ||
          (field === "priceIdr" && (value.priceIdr ?? "") === "");
        errors.push({
          field,
          code: empty ? "REQUIRED" : "INVALID",
          message: rowMessage(field, empty),
        });
      }
    }
    if (errors.length === 0 && parsed.success) {
      const key = importKey(parsed.data.category, parsed.data.name);
      const first = firstSeen.get(key);
      if (first !== undefined)
        errors.push({
          field: "name",
          code: "DUPLICATE_IN_FILE",
          message: `Item ini sudah ada di baris ${first} berkas yang sama.`,
        });
      else firstSeen.set(key, rowNumber);
    }
    rows.push({
      rowNumber,
      data: errors.length === 0 && parsed.success ? parsed.data : null,
      errors,
    });
  }
  return { format, fileHash, rows };
}

const FIELD_LABEL: Record<string, string> = {
  category: "Kategori",
  name: "Nama",
  description: "Deskripsi",
  type: "Tipe",
  priceIdr: "Harga",
  station: "Stasiun",
  course: "Course",
  labels: "Label",
  allergens: "Alergen",
};

function rowMessage(field: string, empty: boolean): string {
  const label = FIELD_LABEL[field] ?? "Baris";
  if (empty) return `${label} wajib diisi.`;
  if (field === "priceIdr")
    return "Harga harus bilangan bulat rupiah (tanpa desimal), contoh 25000.";
  if (field === "type") return "Tipe harus single atau combo.";
  return `${label} tidak valid.`;
}
