// Bank statement CSV → statement lines (bead legend-fnxl, WS-07; PRD v1.7
// §3.19 "Impor mutasi bank (CSV)"; ACC-04). Pure, no database.
//
// All or nothing: one unreadable row refuses the whole file with
// STATEMENT_VALUE_INVALID and a message naming the row and the column, so a
// statement is never half imported and nothing is guessed. The rules mirror
// the web preview (apps/web/src/features/ws07-cash-bank/lib.ts
// `buildImportPreview`) so what the user previewed is what the server takes:
// - amounts go through the contract's strict `parseBankCsvAmount` (whole
//   rupiah, a non-zero fraction is refused, never rounded);
// - debit/credit layout: "0,00" in the unused column counts as empty; both
//   filled, both empty or a signed value inside either column is refused;
// - a zero amount, an empty or > 255-char description, or a > 100-char
//   reference is refused;
// - identical rows inside one file are kept apart by `occurrence`, so two
//   real Rp15.000 fees on one day survive and a re-upload adds nothing
//   (`statementLineDedupeKey`).

import {
  AccountingError,
  parseBankCsvAmount,
  parseBankCsvDate,
  statementLineDedupeKey,
  type BankCsvMapping,
} from "@starter/shared/accounting";

export type ParsedStatementLine = {
  /** 1-based row in the file, header included. */
  rowNumber: number;
  postedOn: string;
  amountIdr: number;
  description: string;
  externalRef: string | null;
  dedupeKey: string;
};

/** At most this many data rows per file (90 kB body keeps it far below). */
export const MAX_STATEMENT_ROWS = 5_000;

function refuse(message: string): never {
  throw new AccountingError("STATEMENT_VALUE_INVALID", message);
}

/**
 * RFC 4180-style split: quoted fields, "" escapes, CRLF/LF/CR line ends.
 * An unterminated quote refuses the file instead of swallowing the rest.
 */
export function splitCsv(csv: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (inQuotes) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") endRow();
    else if (char === "\r") {
      if (csv[index + 1] !== "\n") endRow();
    } else field += char;
  }
  if (inQuotes)
    refuse("File CSV tidak lengkap: ada tanda kutip yang tidak ditutup.");
  if (field !== "" || row.length > 0) endRow();
  while (rows.length > 0 && rows.at(-1)!.every((cell) => cell.trim() === ""))
    rows.pop();
  return rows;
}

const cellAt = (cells: readonly string[], index: number) =>
  (cells[index] ?? "").trim();

function isZeroCell(text: string, decimalSeparator: "," | "."): boolean {
  if (text === "") return false;
  try {
    return parseBankCsvAmount(text, decimalSeparator) === 0;
  } catch {
    return false;
  }
}

function amountOf(
  cells: readonly string[],
  mapping: BankCsvMapping,
  rowNumber: number,
): number {
  const at = `Baris ${rowNumber}`;
  const read = (text: string, column: string): number => {
    try {
      return parseBankCsvAmount(text, mapping.decimalSeparator);
    } catch {
      return refuse(
        `${at}: kolom ${column} tidak dapat dibaca sebagai rupiah utuh. Periksa pemisah desimal dan kolom yang dipilih.`,
      );
    }
  };
  if (mapping.amount.kind === "signed") {
    const text = cellAt(cells, mapping.amount.column);
    if (text === "") refuse(`${at}: kolom jumlah kosong.`);
    return read(text, "jumlah");
  }
  const debitRaw = cellAt(cells, mapping.amount.debitColumn);
  const creditRaw = cellAt(cells, mapping.amount.creditColumn);
  const debit = isZeroCell(debitRaw, mapping.decimalSeparator) ? "" : debitRaw;
  const credit = isZeroCell(creditRaw, mapping.decimalSeparator)
    ? ""
    : creditRaw;
  if (debit !== "" && credit !== "")
    refuse(`${at}: kolom debit dan kredit sama-sama terisi.`);
  if (debit === "" && credit === "")
    refuse(`${at}: kolom debit dan kredit sama-sama kosong.`);
  const value =
    credit !== "" ? read(credit, "kredit") : read(debit, "debit");
  // The column carries the direction; a signed value inside it is ambiguous.
  if (value < 0)
    refuse(
      `${at}: nilai bertanda minus di kolom ${credit !== "" ? "kredit" : "debit"}; arah sudah ditentukan oleh kolomnya.`,
    );
  return credit !== "" ? value : -value;
}

/** Every data row of the file, or STATEMENT_VALUE_INVALID naming the first bad row. */
export function parseStatementCsv(
  csv: string,
  mapping: BankCsvMapping,
): ParsedStatementLine[] {
  const rows = splitCsv(csv, mapping.delimiter);
  const start = mapping.hasHeader ? 1 : 0;
  const required = Math.max(
    mapping.dateColumn,
    mapping.descriptionColumn,
    mapping.amount.kind === "signed"
      ? mapping.amount.column
      : Math.max(mapping.amount.debitColumn, mapping.amount.creditColumn),
  );
  const occurrences = new Map<string, number>();
  const lines: ParsedStatementLine[] = [];
  for (let index = start; index < rows.length; index += 1) {
    const cells = rows[index];
    const rowNumber = index + 1;
    if (cells.every((cell) => cell.trim() === "")) continue;
    const at = `Baris ${rowNumber}`;
    if (required >= cells.length)
      refuse(
        `${at}: hanya ${cells.length} kolom, sedangkan pemetaan memakai kolom ke-${required + 1}.`,
      );
    let postedOn: string;
    try {
      postedOn = parseBankCsvDate(
        cellAt(cells, mapping.dateColumn),
        mapping.dateFormat,
      );
    } catch {
      return refuse(
        `${at}: tanggal tidak sesuai format ${mapping.dateFormat}.`,
      );
    }
    const amountIdr = amountOf(cells, mapping, rowNumber);
    if (amountIdr === 0) refuse(`${at}: jumlah mutasi nol.`);
    const description = cellAt(cells, mapping.descriptionColumn).replace(
      /\s+/g,
      " ",
    );
    if (description === "") refuse(`${at}: keterangan kosong.`);
    if (description.length > 255)
      refuse(`${at}: keterangan lebih dari 255 karakter.`);
    const referenceText =
      mapping.referenceColumn === null
        ? ""
        : cellAt(cells, mapping.referenceColumn);
    const externalRef = referenceText === "" ? null : referenceText;
    if (externalRef !== null && externalRef.length > 100)
      refuse(`${at}: referensi lebih dari 100 karakter.`);
    const occurrenceKey = [
      postedOn,
      amountIdr,
      description.toUpperCase(),
      externalRef ?? "",
    ].join("|");
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    lines.push({
      rowNumber,
      postedOn,
      amountIdr,
      description,
      externalRef,
      dedupeKey: statementLineDedupeKey({
        postedOn,
        amountIdr,
        description,
        externalRef,
        occurrence,
      }),
    });
    if (lines.length > MAX_STATEMENT_ROWS)
      refuse(`File berisi lebih dari ${MAX_STATEMENT_ROWS} baris mutasi.`);
  }
  if (lines.length === 0) refuse("File tidak berisi baris mutasi.");
  return lines;
}
