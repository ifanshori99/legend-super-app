// Pure helpers for the menu bulk import (bead legend-b6r; PRD v1.7 §3 F8,
// §8 "Impor Massal"). No React and no `@/` alias so a Node test can import it;
// nothing in this file writes: the page commits through ./import-api.ts only
// after the explicit "Impor N baris" action.
//
// CSV parsing is hand-written because the app ships no parser dependency and
// adding one is out of scope (recorded as a follow-up): quoted fields, doubled
// quotes, CRLF/LF, comma or semicolon delimiter, BOM, and `;`-separated
// label/allergen lists inside one cell.
import { importRowSchema, menuItemVisibleToGuests } from "@starter/shared/menu";
import type {
  MenuImportReport,
  MenuImportRow,
  PriceList,
} from "@starter/shared/menu";

/** The nine template columns, in template order (`importRowSchema`). */
export const IMPORT_COLUMNS = [
  "category",
  "name",
  "description",
  "type",
  "priceIdr",
  "station",
  "course",
  "labels",
  "allergens",
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export type ImportDelimiter = "," | ";";

export type ImportIssueCode =
  | "required"
  | "tooLong"
  | "invalidType"
  | "invalidPrice"
  | "priceTooLarge"
  | "tooManyLabels"
  | "tooManyAllergens"
  | "unknownCategory"
  | "unknownStation"
  /** A message the server produced for an XLSX row (already Indonesian). */
  | "serverRow";

export type ImportIssue = {
  field: ImportColumn;
  code: ImportIssueCode;
  params?: Record<string, string | number>;
};

export type ImportFileIssueCode =
  "missingColumns" | "duplicateColumns" | "emptyFile" | "unterminatedQuote";

export type ImportFileIssue = {
  code: ImportFileIssueCode;
  params?: Record<string, string | number>;
};

/** The raw cell values exactly as typed in the file (trimmed). */
export type ImportRowRaw = Record<ImportColumn, string>;

export type ImportRowParsed = {
  categoryId?: string;
  stationId?: string;
  type?: MenuImportRow["type"];
  priceIdr?: number;
  labels: string[];
  allergens: string[];
  course: string | null;
};

export type ImportRowResult = {
  /** 1-based physical line in the file; the header is line 1. */
  rowNumber: number;
  raw: ImportRowRaw;
  parsed: ImportRowParsed;
  issues: ImportIssue[];
  valid: boolean;
};

export type ImportAnalysis = {
  delimiter: ImportDelimiter;
  fileIssues: ImportFileIssue[];
  rows: ImportRowResult[];
  counts: { total: number; valid: number; invalid: number };
};

export type ImportReference = {
  categories: readonly { id: string; name: string; sortOrder: number }[];
  stations: readonly { id: string; name: string }[];
};

const EMPTY_REFERENCE: ImportReference = { categories: [], stations: [] };

const MAX_NAME_LENGTH = 150;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_COURSE_LENGTH = 20;
const MAX_LABELS = 20;
const MAX_ALLERGENS = 30;

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

/** `;`-separated cell → trimmed, de-duplicated list (empty entries dropped). */
export function splitCellList(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of value.split(";")) {
    const entry = part.trim();
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export type PriceParseResult =
  | { ok: true; value: number }
  | { ok: false; code: "invalidPrice" | "priceTooLarge" };

/**
 * Whole rupiah per `idrSchema` (`Number.isSafeInteger`, no brand at parse
 * time). Indonesian thousands dots and an optional `Rp` prefix are accepted so
 * a spreadsheet-formatted price still imports; anything else is a per-field
 * error instead of a silent rounding.
 */
export function parsePriceIdr(value: string): PriceParseResult {
  const stripped = value.trim().replace(/^rp\.?\s*/i, "");
  // Dots are accepted only as thousands separators in groups of three, so a
  // decimal like "12.5" is rejected instead of silently becoming 125.
  if (!/^\d+$/.test(stripped) && !/^\d{1,3}(\.\d{3})+$/.test(stripped))
    return { ok: false, code: "invalidPrice" };
  const amount = Number(stripped.replace(/\./g, ""));
  if (!Number.isSafeInteger(amount))
    return { ok: false, code: "priceTooLarge" };
  return { ok: true, value: amount };
}

type CsvRecord = { cells: string[]; line: number };

/**
 * Picks the delimiter from the first physical line: the template header has
 * eight comma separators and no semicolon, so a semicolon-delimited export
 * still wins its own vote. Quotes are skipped while counting.
 */
function sniffDelimiter(source: string): ImportDelimiter {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "\r" || char === "\n") break;
    if (char === ",") commas += 1;
    if (char === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function parseCsv(source: string): {
  delimiter: ImportDelimiter;
  records: CsvRecord[];
  unterminatedQuote: boolean;
} {
  const text = source.replace(/^\uFEFF/, "");
  const delimiter = sniffDelimiter(text);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let unterminatedQuote = false;

  const pushRecord = () => {
    cells.push(field);
    if (cells.some((cell) => cell.trim() !== ""))
      records.push({ cells, line: recordLine });
    cells = [];
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(field);
      field = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    field += char;
  }
  if (inQuotes) unterminatedQuote = true;
  if (field !== "" || cells.length > 0) pushRecord();
  return { delimiter, records, unterminatedQuote };
}

/** RFC 4180 escaping for the generated template (comma delimiter). */
export function toCsvText(rows: readonly (readonly string[])[]): string {
  const escape = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${rows.map((cells) => cells.map(escape).join(",")).join("\r\n")}\r\n`;
}

/** One fixture row → the exact nine template cells. */
export function importRowToCells(row: MenuImportRow): string[] {
  return IMPORT_COLUMNS.map((column) => {
    const value = row[column];
    return Array.isArray(value) ? value.join(";") : String(value);
  });
}

type NamedRow = { id: string; name: string };

function indexByName(
  rows: readonly (NamedRow & { sortOrder?: number })[],
): Map<string, NamedRow> {
  const map = new Map<string, NamedRow>();
  const ordered = [...rows].sort(
    (left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
  );
  for (const row of ordered) {
    const key = normalizeName(row.name);
    // Duplicate display names are allowed by the contract; the first row in
    // display order wins so a file resolves deterministically.
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function mapHeader(cells: string[]): {
  positions?: Record<ImportColumn, number>;
  issues: ImportFileIssue[];
} {
  const normalized = cells.map((cell) => normalizeName(cell));
  const positions = {} as Record<ImportColumn, number>;
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const column of IMPORT_COLUMNS) {
    // Headers are matched case-insensitively, so `PriceIDR` works too; the
    // template still emits the exact camelCase names.
    const key = normalizeName(column);
    const indexes: number[] = [];
    normalized.forEach((value, index) => {
      if (value === key) indexes.push(index);
    });
    if (indexes.length === 0) missing.push(column);
    else {
      positions[column] = indexes[0];
      if (indexes.length > 1) duplicates.push(column);
    }
  }
  const issues: ImportFileIssue[] = [];
  if (missing.length > 0)
    issues.push({
      code: "missingColumns",
      params: { columns: missing.join(", ") },
    });
  if (duplicates.length > 0)
    issues.push({
      code: "duplicateColumns",
      params: { columns: duplicates.join(", ") },
    });
  return {
    positions:
      missing.length > 0 || duplicates.length > 0 ? undefined : positions,
    issues,
  };
}

function backstopIssues(issues: readonly unknown[]): ImportIssue[] {
  const mapped: ImportIssue[] = [];
  for (const item of issues) {
    const issue = item as {
      code?: string;
      path?: PropertyKey[];
      maximum?: number;
    };
    const field = issue.path?.[0];
    if (
      typeof field !== "string" ||
      !(IMPORT_COLUMNS as readonly string[]).includes(field)
    )
      continue;
    if (issue.code === "too_big")
      mapped.push({
        field: field as ImportColumn,
        code: "tooLong",
        params: { max: issue.maximum ?? 0 },
      });
    else if (field === "priceIdr")
      mapped.push({ field: "priceIdr", code: "invalidPrice" });
    else mapped.push({ field: field as ImportColumn, code: "required" });
  }
  return mapped;
}

function validateRow(
  record: CsvRecord,
  positions: Record<ImportColumn, number>,
  categories: Map<string, { id: string; name: string }>,
  stations: Map<string, { id: string; name: string }>,
): ImportRowResult {
  const raw = {} as ImportRowRaw;
  for (const column of IMPORT_COLUMNS)
    raw[column] = (record.cells[positions[column]] ?? "").trim();

  const issues: ImportIssue[] = [];
  const add = (
    field: ImportColumn,
    code: ImportIssueCode,
    params?: Record<string, string | number>,
  ) => {
    issues.push(params ? { field, code, params } : { field, code });
  };

  const categoryName = raw.category;
  let categoryId: string | undefined;
  if (categoryName === "") add("category", "required");
  else if (categoryName.length > MAX_NAME_LENGTH)
    add("category", "tooLong", { max: MAX_NAME_LENGTH });
  else {
    const category = categories.get(normalizeName(categoryName));
    if (category) categoryId = category.id;
    else add("category", "unknownCategory", { value: categoryName });
  }

  const name = raw.name;
  if (name === "") add("name", "required");
  else if (name.length > MAX_NAME_LENGTH)
    add("name", "tooLong", { max: MAX_NAME_LENGTH });

  if (raw.description.length > MAX_DESCRIPTION_LENGTH)
    add("description", "tooLong", { max: MAX_DESCRIPTION_LENGTH });

  const typeValue = normalizeName(raw.type);
  let type: MenuImportRow["type"] | undefined;
  if (typeValue === "") add("type", "required");
  else if (typeValue !== "single" && typeValue !== "combo")
    add("type", "invalidType");
  else type = typeValue;

  const priceValue = raw.priceIdr;
  let priceIdr: number | undefined;
  if (priceValue === "") add("priceIdr", "required");
  else {
    const parsed = parsePriceIdr(priceValue);
    if (parsed.ok) priceIdr = parsed.value;
    else add("priceIdr", parsed.code);
  }

  const stationName = raw.station;
  let stationId: string | undefined;
  if (stationName === "") add("station", "required");
  else if (stationName.length > MAX_NAME_LENGTH)
    add("station", "tooLong", { max: MAX_NAME_LENGTH });
  else {
    const station = stations.get(normalizeName(stationName));
    if (station) stationId = station.id;
    else add("station", "unknownStation", { value: stationName });
  }

  if (raw.course.length > MAX_COURSE_LENGTH)
    add("course", "tooLong", { max: MAX_COURSE_LENGTH });

  const labels = splitCellList(raw.labels);
  for (const label of labels)
    if (label.length > MAX_NAME_LENGTH) {
      add("labels", "tooLong", { max: MAX_NAME_LENGTH });
      break;
    }
  if (labels.length > MAX_LABELS)
    add("labels", "tooManyLabels", { max: MAX_LABELS });

  const allergens = splitCellList(raw.allergens);
  for (const allergen of allergens)
    if (allergen.length > MAX_NAME_LENGTH) {
      add("allergens", "tooLong", { max: MAX_NAME_LENGTH });
      break;
    }
  if (allergens.length > MAX_ALLERGENS)
    add("allergens", "tooManyAllergens", { max: MAX_ALLERGENS });

  const course = raw.course === "" ? null : raw.course;

  // Backstop: the contract schema is the source of truth. All field checks
  // above mirror it, so a failure here means this file missed a rule.
  if (issues.length === 0) {
    const parsed = importRowSchema.safeParse({
      category: categoryName,
      name,
      description: raw.description,
      type,
      priceIdr,
      station: stationName,
      course: raw.course,
      labels,
      allergens,
    });
    if (!parsed.success) issues.push(...backstopIssues(parsed.error.issues));
  }

  return {
    rowNumber: record.line,
    raw,
    parsed: {
      categoryId,
      stationId,
      type,
      priceIdr,
      labels,
      allergens,
      course,
    },
    issues,
    valid: issues.length === 0,
  };
}

/**
 * Parses and validates the whole file. Referential rules use the names the
 * back office already has (case-insensitive): an unknown category or station
 * is a per-row error, never a silent create with a new master record.
 */
export function analyzeImport(
  text: string,
  reference: ImportReference = EMPTY_REFERENCE,
): ImportAnalysis {
  const { delimiter, records, unterminatedQuote } = parseCsv(text);
  const fileIssues: ImportFileIssue[] = [];
  if (unterminatedQuote) fileIssues.push({ code: "unterminatedQuote" });
  if (records.length === 0) {
    fileIssues.push({ code: "emptyFile" });
    return {
      delimiter,
      fileIssues,
      rows: [],
      counts: { total: 0, valid: 0, invalid: 0 },
    };
  }

  const header = mapHeader(records[0].cells);
  if (!header.positions) {
    return {
      delimiter,
      fileIssues: [...fileIssues, ...header.issues],
      rows: [],
      counts: { total: 0, valid: 0, invalid: 0 },
    };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) fileIssues.push({ code: "emptyFile" });

  const categories = indexByName(reference.categories);
  const stations = indexByName(reference.stations);
  const rows = dataRecords.map((record) =>
    validateRow(record, header.positions!, categories, stations),
  );
  const valid = rows.filter((row) => row.valid).length;
  return {
    delimiter,
    fileIssues,
    rows,
    counts: { total: rows.length, valid, invalid: rows.length - valid },
  };
}

/**
 * XLSX (and CSV) analysed by the server (legend-az32) → the same analysis the
 * CSV path produces. Rows the server accepted are re-validated here against
 * the back office's categories and stations, so the commit step gets resolved
 * ids exactly as for a CSV; rows the server refused keep its messages.
 */
export function analysisFromServerReport(
  report: MenuImportReport,
  reference: ImportReference = EMPTY_REFERENCE,
): ImportAnalysis {
  const positions = {} as Record<ImportColumn, number>;
  IMPORT_COLUMNS.forEach((column, index) => {
    positions[column] = index;
  });
  const categories = indexByName(reference.categories);
  const stations = indexByName(reference.stations);
  const rows: ImportRowResult[] = report.rows.map((serverRow) => {
    const result = serverRow.data
      ? validateRow(
          {
            cells: importRowToCells(serverRow.data),
            line: serverRow.rowNumber,
          },
          positions,
          categories,
          stations,
        )
      : ({
          rowNumber: serverRow.rowNumber,
          raw: Object.fromEntries(
            IMPORT_COLUMNS.map((column) => [column, ""]),
          ) as ImportRowRaw,
          parsed: { labels: [], allergens: [], course: null },
          issues: [],
          valid: false,
        } satisfies ImportRowResult);
    for (const error of serverRow.errors)
      result.issues.push({
        field: (IMPORT_COLUMNS as readonly string[]).includes(error.field)
          ? (error.field as ImportColumn)
          : "name",
        code: "serverRow",
        params: { message: error.message },
      });
    result.rowNumber = serverRow.rowNumber;
    result.valid = result.issues.length === 0;
    return result;
  });
  const valid = rows.filter((row) => row.valid).length;
  return {
    delimiter: ",",
    fileIssues: rows.length === 0 ? [{ code: "emptyFile" }] : [],
    rows,
    counts: { total: rows.length, valid, invalid: rows.length - valid },
  };
}

/**
 * The price list a commit writes to: the latest effective dine-in list for the
 * outlet; when the outlet has no dine-in list yet, the first list in channel
 * order so the import is never silently price-less (PRD §8 "Harga per Kanal").
 */
export function pickImportPriceList(
  lists: readonly PriceList[],
  businessDate: string,
): PriceList | undefined {
  const dineIn = [...lists]
    .filter(
      (list) =>
        list.channel === "dine_in" && list.effectiveFrom <= businessDate,
    )
    .sort((left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom),
    )
    .at(-1);
  if (dineIn) return dineIn;
  return [...lists].sort(
    (left, right) =>
      left.channel.localeCompare(right.channel) ||
      left.effectiveFrom.localeCompare(right.effectiveFrom),
  )[0];
}

export type PriceEntry = {
  itemId: string;
  variantId: string | null;
  priceIdr: number;
};

/**
 * `setPriceListItems` replaces the whole grid, so the commit sends the union
 * of the stored entries and the imported prices instead of only the new rows
 * (which would delete every existing price).
 */
export function mergePriceListEntries(
  existing: readonly PriceEntry[],
  additions: readonly PriceEntry[],
): PriceEntry[] {
  const key = (entry: PriceEntry) => `${entry.itemId}:${entry.variantId ?? ""}`;
  const merged = new Map(existing.map((entry) => [key(entry), entry]));
  for (const entry of additions) merged.set(key(entry), entry);
  return [...merged.values()];
}

export type PrintableItem = {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  sortOrder: number;
  isActive: boolean;
  mediaId?: string | null;
  mediaUrl?: string | null;
};

export type PrintableSection = {
  categoryId: string;
  categoryName: string;
  rows: { item: PrintableItem; priceIdr: number | undefined }[];
};

/**
 * Active items grouped by category for the printable menu (PRD §8 "Menu Cetak
 * Otomatis"): display order, empty categories omitted. The sheet is
 * guest-facing, so it applies the Q23 guest rule (`menuItemVisibleToGuests`):
 * drafts (imported rows) and legacy active rows without a photo never print.
 */
export function printableSections(input: {
  items: readonly PrintableItem[];
  categories: readonly { id: string; name: string; sortOrder: number }[];
  priceItems: readonly PriceEntry[];
}): PrintableSection[] {
  const prices = new Map(
    input.priceItems
      .filter((row) => row.variantId === null)
      .map((row) => [row.itemId, row.priceIdr]),
  );
  return [...input.categories]
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name, "id-ID"),
    )
    .flatMap((category) => {
      const rows = input.items
        .filter(
          (item) =>
            menuItemVisibleToGuests(item) && item.categoryId === category.id,
        )
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.name.localeCompare(right.name, "id-ID"),
        )
        .map((item) => ({ item, priceIdr: prices.get(item.id) }));
      return rows.length === 0
        ? []
        : [{ categoryId: category.id, categoryName: category.name, rows }];
    });
}
