// Pure helpers of the WS-07 cash & bank screens (bead legend-53q; PRD v1.7
// §3 F19 "Kas & Bank [P0]" and "Rekonsiliasi Gateway [P0]"; ACC-04 "Rekonsiliasi
// bank dan gateway mencapai ≥ 99% kecocokan otomatis; setiap selisih menjadi
// kasus dengan PIC", ACC-05 "Setiap setoran kas tercatat dan dicocokkan dengan
// mutasi; kas yang belum disetor melewati batas hari yang ditetapkan memicu
// peringatan").
//
// No React and no DOM at import time, and only relative or bare package
// imports, so tests/ws07-cash-bank.test.mjs loads this file with Node type
// stripping. Business rules stay in the contract (@starter/shared/accounting):
// parsing, dedupe keys, matching and the auto-match rate are imported, never
// re-derived. This file only shapes CSV input for the import wizard and derives
// what the screens display.

import {
  AUTO_MATCH_TARGET_BP,
  MAX_CASH_OUT_APPROVAL_LIMIT_IDR,
  bankCsvMappingSchema,
  findStatementMatch,
  parseBankCsvAmount,
  parseBankCsvDate,
  statementLineDedupeKey,
  type Account,
  type BankCsvMapping,
  type BankStatementLine,
  type CashBankEntryKind,
  type CashBankEntryStatus,
  type CashDeposit,
  type CashDepositStatus,
  type JournalEntry,
  type MatchCandidate,
  type MatchOutcome,
  type MatchStatus,
  type MatchingPolicy,
  type PettyCashEntryKind,
  type PettyCashJournalStatus,
  type ReconciliationCase,
  type ReconciliationCaseStatus,
  type ReconciliationRef,
  type UndepositedCashAlert,
} from "@starter/shared/accounting";
import { createUlid } from "@starter/shared/core";
import { formatNumber } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";

/** Re-exported so the match workspace types its suggestion from the lib. */
export type { MatchOutcome };

// The API body cap is 100 kB; the contract allows a 90 kB CSV (banking.ts).
export const MAX_IMPORT_CSV_CHARS = 90_000;

/** Bank columns the mapping form can point at (the contract caps at 50). */
export const CSV_COLUMN_LIMIT = 50;

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

// ---- Dates ----------------------------------------------------------------

/** The outlet's business date; the outlet-context bead supplies the zone. */
export const DEFAULT_OUTLET_TIME_ZONE = "Asia/Jakarta";

export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = DEFAULT_OUTLET_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** First and last day of the month a business date falls in. */
export function monthRange(businessDate: string): { from: string; to: string } {
  const [year, month] = businessDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = businessDate.slice(0, 7);
  return {
    from: `${prefix}-01`,
    to: `${prefix}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** "2026-11-03" → "November 2026" (the month a list covers). */
export function formatMonthLabel(businessDate: string): string {
  const [year, month] = businessDate.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** "2026-11-03" → "3 Nov 2026" (locale-stable, id-ID, no time zone drift). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** ISO instant → "3 Nov 2026, 10.00" in the outlet time zone. */
export function formatDateTime(
  value: string,
  timeZone: string = DEFAULT_OUTLET_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

/** First eight characters of an id, for labels that have no display name. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---- CSV: rows, delimiter and column mapping ------------------------------

/**
 * One CSV body → rows of cells. Handles quoted fields, escaped quotes ("")
 * and CRLF; a trailing empty line is dropped. No third-party CSV library:
 * bank exports are small and the contract only accepts `,`, `;` and tab.
 */
export function parseCsvRows(csv: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (inQuotes) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      if (csv[index + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (
    rows.length > 0 &&
    (rows.at(-1)?.every((cell) => cell.trim() === "") ?? false)
  )
    rows.pop();
  return rows;
}

export function detectDelimiter(csv: string): BankCsvMapping["delimiter"] {
  const firstLine = csv.split(/\r?\n/, 1)[0] ?? "";
  const counts: [BankCsvMapping["delimiter"], number][] = [
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
  ];
  let best: BankCsvMapping["delimiter"] = ",";
  let bestCount = 0;
  for (const [delimiter, count] of counts)
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  return best;
}

/** Number of columns the widest row has; the mapping form never exceeds it. */
export function csvColumnCount(csv: string, delimiter: string): number {
  const rows = parseCsvRows(csv, delimiter);
  return rows.reduce((max, cells) => Math.max(max, cells.length), 0);
}

const HEADER_PATTERNS = {
  date: /tanggal|tgl|date|posting/i,
  description: /keterangan|uraian|description|remark|berita|memo/i,
  reference: /referensi|reference|ref\b|no\.? ?ref/i,
  debit: /debit|keluar|out/i,
  credit: /kredit|credit|masuk|in\b/i,
  amount: /jumlah|nominal|amount|nilai|mutasi/i,
} as const;

function headerIndex(header: readonly string[], pattern: RegExp): number {
  return header.findIndex((cell) => pattern.test(cell.trim()));
}

function detectDateFormat(value: string): BankCsvMapping["dateFormat"] {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return "YYYY-MM-DD";
  if (/^\d{2}-\d{2}-\d{4}$/.test(value.trim())) return "DD-MM-YYYY";
  return "DD/MM/YYYY";
}

function detectDecimalSeparator(value: string): "," | "." {
  if (/,\d{1,2}$/.test(value.trim())) return ",";
  if (/\.\d{1,2}$/.test(value.trim())) return ".";
  return ",";
}

/**
 * Deterministic first guess of a bank CSV's layout: delimiter, header row and
 * the columns that look like date/description/amount/reference. The wizard
 * shows every guess as a field the user can change before previewing.
 */
export function detectMapping(csv: string): BankCsvMapping {
  const delimiter = detectDelimiter(csv);
  const rows = parseCsvRows(csv, delimiter);
  const first = rows[0] ?? [];
  const headerLike = first.some((cell) =>
    /tanggal|tgl|date|keterangan|uraian|description|debit|kredit|credit|jumlah|nominal|amount|referensi|reference/i.test(
      cell,
    ),
  );
  const hasHeader =
    headerLike &&
    !/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test((first[0] ?? "").trim());
  const header = hasHeader ? first : [];
  const dataRow = rows[hasHeader ? 1 : 0] ?? [];
  const columns = Math.max(
    rows.reduce((max, cells) => Math.max(max, cells.length), 0),
    1,
  );
  const clamp = (index: number, fallback: number) => {
    const value = index >= 0 ? index : fallback;
    return Math.min(
      Math.max(value, 0),
      Math.min(columns - 1, CSV_COLUMN_LIMIT),
    );
  };
  const dateColumn = clamp(headerIndex(header, HEADER_PATTERNS.date), 0);
  const descriptionColumn = clamp(
    headerIndex(header, HEADER_PATTERNS.description),
    1,
  );
  const debitColumn = headerIndex(header, HEADER_PATTERNS.debit);
  const creditColumn = headerIndex(header, HEADER_PATTERNS.credit);
  const amountColumn = clamp(headerIndex(header, HEADER_PATTERNS.amount), 2);
  const referenceFound = headerIndex(header, HEADER_PATTERNS.reference);
  const referenceColumn =
    referenceFound >= 0 ? clamp(referenceFound, 3) : columns > 3 ? 3 : null;
  const amountCell =
    debitColumn >= 0
      ? (dataRow[debitColumn] ?? "")
      : (dataRow[amountColumn] ?? "");
  return bankCsvMappingSchema.parse({
    hasHeader,
    delimiter,
    dateColumn,
    dateFormat: detectDateFormat(dataRow[dateColumn] ?? ""),
    descriptionColumn,
    amount:
      debitColumn >= 0 && creditColumn >= 0
        ? {
            kind: "debit_credit",
            debitColumn: clamp(debitColumn, 3),
            creditColumn: clamp(creditColumn, 4),
          }
        : { kind: "signed", column: amountColumn },
    decimalSeparator: detectDecimalSeparator(amountCell),
    referenceColumn,
  });
}

/** A fresh default mapping before a CSV is read. */
export function defaultCsvMapping(): BankCsvMapping {
  return {
    hasHeader: true,
    delimiter: ",",
    dateColumn: 0,
    dateFormat: "DD/MM/YYYY",
    descriptionColumn: 1,
    amount: { kind: "signed", column: 2 },
    decimalSeparator: ",",
    referenceColumn: null,
  };
}

// ---- CSV: import preview --------------------------------------------------

export type ImportRowErrorCode =
  | "columns"
  | "date"
  | "amount"
  | "debit_credit"
  | "description"
  | "reference"
  | "dedupe_key";

/**
 * The server refuses a row whose normalised dedupe key is longer than this
 * (parseStatementCsv); the preview applies the same limit so a row it shows as
 * ready is never refused on import.
 */
export const MAX_DEDUPE_KEY_LENGTH = 400;

export const IMPORT_ROW_ERROR_KEYS: Record<ImportRowErrorCode, MessageKey> = {
  columns: "accounting.cash.import.preview.errorColumns",
  date: "accounting.cash.import.preview.errorDate",
  amount: "accounting.cash.import.preview.errorAmount",
  debit_credit: "accounting.cash.import.preview.errorDebitCredit",
  description: "accounting.cash.import.preview.errorDescription",
  reference: "accounting.cash.import.preview.errorReference",
  dedupe_key: "accounting.cash.import.preview.errorDedupeKey",
};

export type ImportRowStatus = "ready" | "duplicate" | "error";

export type ImportPreviewRow = {
  /** 1-based row number in the uploaded file (header included). */
  rowNumber: number;
  postedOn: string | null;
  description: string;
  amountIdr: number | null;
  externalRef: string | null;
  dedupeKey: string | null;
  status: ImportRowStatus;
  errorCode: ImportRowErrorCode | null;
};

export type ImportPreview = {
  rows: ImportPreviewRow[];
  readyCount: number;
  duplicateCount: number;
  errorCount: number;
};

function cellAt(cells: readonly string[], index: number): string {
  return (cells[index] ?? "").trim();
}

/**
 * One amount cell through the contract parser, plus a guard the parser lacks:
 * more than two digits after the decimal separator means the separator was
 * chosen wrong ("15.000" read with "." would silently become Rp15), so the
 * row is refused instead of imported a thousand times too small.
 */
function parseAmountCell(text: string, decimalSeparator: "," | "."): number {
  const unsigned = text.replace(/[\s()+-]|Rp/gi, "");
  const separatorAt = unsigned.lastIndexOf(decimalSeparator);
  if (separatorAt !== -1 && unsigned.length - separatorAt - 1 > 2)
    throw new Error("amount");
  return parseBankCsvAmount(text, decimalSeparator);
}

/** Banks often fill the unused debit/credit column with "0,00": treat as empty. */
function isZeroAmountCell(text: string, decimalSeparator: "," | "."): boolean {
  if (text === "") return false;
  try {
    return parseAmountCell(text, decimalSeparator) === 0;
  } catch {
    return false;
  }
}

function errorRow(
  rowNumber: number,
  description: string,
  errorCode: ImportRowErrorCode,
  postedOn: string | null = null,
  amountIdr: number | null = null,
): ImportPreviewRow {
  return {
    rowNumber,
    postedOn,
    description,
    amountIdr,
    externalRef: null,
    dedupeKey: null,
    status: "error",
    errorCode,
  };
}

/**
 * Parses a bank CSV with the chosen mapping into the rows the wizard previews
 * and the mock imports. A row is a duplicate when its contract dedupe key is
 * already stored for the account; identical rows inside one file are kept
 * (`occurrence`, so two real Rp15.000 fees on one day survive). Errors carry a
 * catalog key so the preview can show them next to the offending row.
 */
export function buildImportPreview(
  csv: string,
  mapping: BankCsvMapping,
  existingDedupeKeys: readonly string[] = [],
): ImportPreview {
  const rows = parseCsvRows(csv, mapping.delimiter);
  const existing = new Set(existingDedupeKeys);
  const occurrences = new Map<string, number>();
  const preview: ImportPreviewRow[] = [];
  const start = mapping.hasHeader ? 1 : 0;
  for (let index = start; index < rows.length; index += 1) {
    const cells = rows[index];
    const rowNumber = index + 1;
    if (!cells || cells.every((cell) => cell.trim() === "")) continue;
    const required = [
      mapping.dateColumn,
      mapping.descriptionColumn,
      mapping.amount.kind === "signed"
        ? mapping.amount.column
        : Math.max(mapping.amount.debitColumn, mapping.amount.creditColumn),
    ];
    if (required.some((column) => column >= cells.length)) {
      preview.push(errorRow(rowNumber, "", "columns"));
      continue;
    }
    let postedOn: string;
    try {
      postedOn = parseBankCsvDate(
        cellAt(cells, mapping.dateColumn),
        mapping.dateFormat,
      );
    } catch {
      preview.push(
        errorRow(rowNumber, cellAt(cells, mapping.descriptionColumn), "date"),
      );
      continue;
    }
    let amountIdr: number;
    try {
      if (mapping.amount.kind === "signed") {
        const text = cellAt(cells, mapping.amount.column);
        if (text === "") {
          preview.push(
            errorRow(
              rowNumber,
              cellAt(cells, mapping.descriptionColumn),
              "amount",
              postedOn,
            ),
          );
          continue;
        }
        amountIdr = parseAmountCell(text, mapping.decimalSeparator);
      } else {
        const debitRaw = cellAt(cells, mapping.amount.debitColumn);
        const creditRaw = cellAt(cells, mapping.amount.creditColumn);
        const debitText = isZeroAmountCell(debitRaw, mapping.decimalSeparator)
          ? ""
          : debitRaw;
        const creditText = isZeroAmountCell(creditRaw, mapping.decimalSeparator)
          ? ""
          : creditRaw;
        if (debitText !== "" && creditText !== "") {
          preview.push(
            errorRow(
              rowNumber,
              cellAt(cells, mapping.descriptionColumn),
              "debit_credit",
              postedOn,
            ),
          );
          continue;
        }
        if (debitText === "" && creditText === "") {
          preview.push(
            errorRow(
              rowNumber,
              cellAt(cells, mapping.descriptionColumn),
              "amount",
              postedOn,
            ),
          );
          continue;
        }
        const value = parseAmountCell(
          creditText !== "" ? creditText : debitText,
          mapping.decimalSeparator,
        );
        // The column carries the direction; a signed value inside a debit or
        // credit column is ambiguous, so the row is refused, never flipped.
        if (value < 0) throw new Error("amount");
        amountIdr = creditText !== "" ? value : -value;
      }
    } catch {
      preview.push(
        errorRow(
          rowNumber,
          cellAt(cells, mapping.descriptionColumn),
          "amount",
          postedOn,
        ),
      );
      continue;
    }
    if (amountIdr === 0) {
      preview.push(
        errorRow(
          rowNumber,
          cellAt(cells, mapping.descriptionColumn),
          "amount",
          postedOn,
        ),
      );
      continue;
    }
    const description = cellAt(cells, mapping.descriptionColumn);
    if (description === "" || description.length > 255) {
      preview.push(
        errorRow(rowNumber, description, "description", postedOn, amountIdr),
      );
      continue;
    }
    const referenceText =
      mapping.referenceColumn === null
        ? ""
        : cellAt(cells, mapping.referenceColumn);
    const externalRef = referenceText === "" ? null : referenceText;
    if (externalRef !== null && externalRef.length > 100) {
      preview.push(
        errorRow(rowNumber, description, "reference", postedOn, amountIdr),
      );
      continue;
    }
    const occurrenceKey = [
      postedOn,
      amountIdr,
      description.replace(/\s+/g, " ").toUpperCase(),
      externalRef ?? "",
    ].join("|");
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const dedupeKey = statementLineDedupeKey({
      postedOn,
      amountIdr,
      description,
      externalRef,
      occurrence,
    });
    if (dedupeKey.length > MAX_DEDUPE_KEY_LENGTH) {
      preview.push(
        errorRow(rowNumber, description, "dedupe_key", postedOn, amountIdr),
      );
      continue;
    }
    preview.push({
      rowNumber,
      postedOn,
      description,
      amountIdr,
      externalRef,
      dedupeKey,
      status: existing.has(dedupeKey) ? "duplicate" : "ready",
      errorCode: null,
    });
  }
  return {
    rows: preview,
    readyCount: preview.filter((row) => row.status === "ready").length,
    duplicateCount: preview.filter((row) => row.status === "duplicate").length,
    errorCount: preview.filter((row) => row.status === "error").length,
  };
}

// ---- Idempotency key per dialog -------------------------------------------

/**
 * Idempotency keys for the life of a dialog, one per request body. A resend
 * of the same body after a failed or slow attempt carries the same key, so
 * the server replays instead of opening a second case. A changed body (for
 * example another PIC) gets its own key, because the server refuses a key
 * reused for a different request; going back to an earlier body reuses its
 * key, since that request may already have reached the server. `reset`
 * (success) forgets every key; the next dialog starts a new session.
 */
export function createIdempotencyKeySession(
  newKey: () => string = createUlid,
): { current: (fingerprint?: string) => string; reset: () => void } {
  const keys = new Map<string, string>();
  return {
    current: (fingerprint = "") => {
      let key = keys.get(fingerprint);
      if (key === undefined) {
        key = newKey();
        keys.set(fingerprint, key);
      }
      return key;
    },
    reset: () => {
      keys.clear();
    },
  };
}

// ---- Catalog keys and tones ----------------------------------------------

export const MATCH_STATUS_KEYS: Record<MatchStatus, MessageKey> = {
  unmatched: "accounting.cash.match.status.unmatched",
  auto_matched: "accounting.cash.match.status.auto_matched",
  manually_matched: "accounting.cash.match.status.manually_matched",
  in_case: "accounting.cash.match.status.in_case",
  excluded: "accounting.cash.match.status.excluded",
};

export const MATCH_STATUS_TONES: Record<MatchStatus, Tone> = {
  unmatched: "warning",
  auto_matched: "success",
  manually_matched: "info",
  in_case: "warning",
  excluded: "neutral",
};

export const DEPOSIT_STATUS_KEYS: Record<CashDepositStatus, MessageKey> = {
  recorded: "accounting.cash.deposits.status.recorded",
  matched: "accounting.cash.deposits.status.matched",
  discrepancy: "accounting.cash.deposits.status.discrepancy",
};

export const DEPOSIT_STATUS_TONES: Record<CashDepositStatus, Tone> = {
  recorded: "info",
  matched: "success",
  discrepancy: "danger",
};

export const CASE_STATUS_KEYS: Record<ReconciliationCaseStatus, MessageKey> = {
  open: "accounting.cash.recon.status.open",
  in_progress: "accounting.cash.recon.status.in_progress",
  resolved: "accounting.cash.recon.status.resolved",
  written_off: "accounting.cash.recon.status.written_off",
};

export const CASE_STATUS_TONES: Record<ReconciliationCaseStatus, Tone> = {
  open: "warning",
  in_progress: "info",
  resolved: "success",
  written_off: "neutral",
};

/** Case kind as the contract carries it (the schema has no exported alias). */
export type ReconciliationCaseType = ReconciliationCase["type"];

export const CASE_TYPE_KEYS: Record<ReconciliationCaseType, MessageKey> = {
  bank_statement: "accounting.cash.recon.type.bank_statement",
  gateway_settlement: "accounting.cash.recon.type.gateway_settlement",
  edc_settlement: "accounting.cash.recon.type.edc_settlement",
  cash_deposit: "accounting.cash.recon.type.cash_deposit",
};

export const REF_TYPE_KEYS: Record<ReconciliationRef["type"], MessageKey> = {
  journal_entry: "accounting.cash.match.ref.journal_entry",
  cash_deposit: "accounting.cash.match.ref.cash_deposit",
  gateway_settlement: "accounting.cash.match.ref.gateway_settlement",
  edc_settlement: "accounting.cash.match.ref.edc_settlement",
  supplier_payment: "accounting.cash.match.ref.supplier_payment",
  bank_statement_line: "accounting.cash.match.ref.bank_statement_line",
};

export type ReconciliationCaseActionType = "start" | "reassign" | "resolve";

/** Which buttons a case status allows (the contract also has write_off). */
export function reconciliationCaseActions(
  status: ReconciliationCaseStatus,
): readonly ReconciliationCaseActionType[] {
  switch (status) {
    case "open":
      return ["start", "reassign", "resolve"];
    case "in_progress":
      return ["reassign", "resolve"];
    case "resolved":
    case "written_off":
      return [];
  }
}

// ---- Matching (ACC-04) ----------------------------------------------------

export function candidateKey(ref: ReconciliationRef): string {
  return `${ref.type}:${ref.id}`;
}

/** The bank account's signed movement inside one journal entry. */
export function journalBankAmount(
  entry: Pick<JournalEntry, "lines">,
  bankGlAccountId: string,
): number | null {
  let total: number | null = null;
  for (const line of entry.lines) {
    if (line.accountId !== bankGlAccountId) continue;
    total = (total ?? 0) + line.debitIdr - line.creditIdr;
  }
  return total;
}

/**
 * Candidate documents for a statement line: journals that move the selected
 * bank account and cash deposits into it. `occupied` holds the refs already
 * used by another line, because the contract's matcher never sees documents
 * that are matched elsewhere.
 */
export function matchCandidates(
  journals: readonly JournalEntry[],
  deposits: readonly CashDeposit[],
  bankAccountId: string,
  bankGlAccountId: string,
  occupied: ReadonlySet<string>,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const entry of journals) {
    const amountIdr = journalBankAmount(entry, bankGlAccountId);
    if (amountIdr === null || amountIdr === 0) continue;
    const ref: ReconciliationRef = { type: "journal_entry", id: entry.id };
    if (occupied.has(candidateKey(ref))) continue;
    candidates.push({ ref, amountIdr, date: entry.entryDate });
  }
  for (const deposit of deposits) {
    if (deposit.bankAccountId !== bankAccountId) continue;
    const ref: ReconciliationRef = { type: "cash_deposit", id: deposit.id };
    if (occupied.has(candidateKey(ref))) continue;
    candidates.push({
      ref,
      amountIdr: deposit.amountIdr,
      date: deposit.depositedAt.slice(0, 10),
    });
  }
  return candidates;
}

/** The contract's automatic matcher, exposed for the workspace's suggestion. */
export function suggestMatch(
  line: Pick<BankStatementLine, "amountIdr" | "postedOn">,
  candidates: readonly MatchCandidate[],
  policy: MatchingPolicy,
): MatchOutcome {
  return findStatementMatch(line, candidates, policy);
}

/** Refs used by other lines of the account (matched documents are taken). */
export function occupiedRefs(
  lines: readonly BankStatementLine[],
  exceptLineId?: string,
): Set<string> {
  const walk = (predicate: (line: BankStatementLine) => boolean) =>
    lines
      .filter(predicate)
      .flatMap((line) => line.matchedRefs)
      .map(candidateKey);
  return new Set(walk((line) => line.id !== exceptLineId));
}

// ---- Reconciliation settlement rows --------------------------------------

export type SettlementFeeLine = { accountId: string; amountIdr: number };

export type SettlementRow = {
  journalEntryId: string;
  settlementId: string;
  date: string;
  description: string;
  grossIdr: number;
  netIdr: number;
  feeLines: SettlementFeeLine[];
  statementLine: BankStatementLine | null;
  matchedAmountIdr: number;
  varianceIdr: number;
};

/**
 * One gateway settlement journal → the bruto / biaya / diterima di bank rows
 * the recon screen shows. The bank line is the net settled amount; every other
 * debit line is a fee (MDR, VA service fee, …) so each gets its own row, and
 * the credit lines are the gross settlement.
 */
export function settlementRows(
  journals: readonly JournalEntry[],
  statementLines: readonly BankStatementLine[],
  bankGlAccountId: string,
): SettlementRow[] {
  const rows: SettlementRow[] = [];
  for (const entry of journals) {
    if (entry.sourceType !== "gateway_settlement") continue;
    let netIdr = 0;
    let grossIdr = 0;
    const feeLines: SettlementFeeLine[] = [];
    for (const line of entry.lines) {
      if (line.accountId === bankGlAccountId) {
        netIdr += line.debitIdr - line.creditIdr;
      } else if (line.creditIdr > 0) {
        grossIdr += line.creditIdr;
      } else if (line.debitIdr > 0) {
        feeLines.push({ accountId: line.accountId, amountIdr: line.debitIdr });
      }
    }
    const statementLine =
      statementLines.find((line) =>
        line.matchedRefs.some(
          (ref) =>
            ref.type === "gateway_settlement" && ref.id === entry.sourceId,
        ),
      ) ?? null;
    const matchedAmountIdr = statementLine?.amountIdr ?? 0;
    rows.push({
      journalEntryId: entry.id,
      settlementId: entry.sourceId ?? entry.id,
      date: entry.entryDate,
      description: entry.description,
      grossIdr,
      netIdr,
      feeLines,
      statementLine,
      matchedAmountIdr,
      varianceIdr: netIdr - matchedAmountIdr,
    });
  }
  return rows.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.description.localeCompare(b.description),
  );
}

// ---- Display totals -------------------------------------------------------

export function totalUndeposited(
  alerts: readonly UndepositedCashAlert[],
): number {
  return alerts.reduce((sum, alert) => sum + alert.undepositedIdr, 0);
}

export function openCases(
  cases: readonly ReconciliationCase[],
): ReconciliationCase[] {
  return cases.filter(
    (row) => row.status === "open" || row.status === "in_progress",
  );
}

export function totalOpenDifference(
  cases: readonly ReconciliationCase[],
): number {
  // Absolute: a +100k and a -100k case are 200k to resolve, not Rp0.
  return openCases(cases).reduce(
    (sum, row) => sum + Math.abs(row.differenceIdr),
    0,
  );
}

/** "Belum cocok" includes lines already inside a case (both need a person). */
export function pendingMatchCount(lines: {
  unmatchedCount: number;
  inCaseCount: number;
}): number {
  return lines.unmatchedCount + lines.inCaseCount;
}

/** Basis points → "99,00%" (the ACC-04 target is 9_900 bp). */
export function formatBasisPoints(basisPoints: number): string {
  return `${formatNumber(basisPoints / 100, { fractionDigits: 2 })}%`;
}

export function autoMatchTargetReached(basisPoints: number): boolean {
  return basisPoints >= AUTO_MATCH_TARGET_BP;
}

export function autoMatchTargetPercent(): string {
  return formatBasisPoints(AUTO_MATCH_TARGET_BP);
}

/** Total of a list of deposit amounts (the deposit table's footer). */
export function totalDeposits(
  deposits: readonly Pick<CashDeposit, "amountIdr">[],
): number {
  return deposits.reduce((sum, row) => sum + row.amountIdr, 0);
}

// ---- Error → catalog key -------------------------------------------------

/** Contract refusal → the sentence shown next to the action. */
export function matchErrorKey(code: string): MessageKey {
  switch (code) {
    case "STATEMENT_LINE_ALREADY_MATCHED":
    case "CONFLICT":
      return "accounting.cash.match.error.alreadyMatched";
    case "MATCH_AMOUNT_MISMATCH":
      return "accounting.cash.match.error.amountMismatch";
    case "INVALID_TRANSITION":
      return "accounting.cash.match.error.invalid";
    case "NOT_FOUND":
      return "accounting.cash.match.error.notFound";
    default:
      return "accounting.cash.match.error.failed";
  }
}

/** True when the server refused the CSV because a cell cannot be read. */
export function isStatementValueInvalid(code: string): boolean {
  return code === "STATEMENT_VALUE_INVALID";
}

/** Import refusal → the fallback sentence when the server gives no row detail. */
export function importErrorKey(code: string): MessageKey {
  switch (code) {
    case "STATEMENT_LINE_ALREADY_MATCHED":
    case "CONFLICT":
      return "accounting.cash.import.error.conflict";
    default:
      return "accounting.cash.import.failed";
  }
}

export function caseErrorKey(code: string): MessageKey {
  switch (code) {
    case "INVALID_TRANSITION":
      return "accounting.cash.recon.drawer.invalidTransition";
    case "NOT_FOUND":
      return "accounting.cash.recon.drawer.error";
    default:
      return "accounting.cash.recon.drawer.failed";
  }
}

// ---- Cash in/out, transfers and petty cash (legend-4961) -------------------

export const CASH_ENTRY_KIND_KEYS: Record<CashBankEntryKind, MessageKey> = {
  cash_in: "accounting.cash.entries.kind.cash_in",
  cash_out: "accounting.cash.entries.kind.cash_out",
  transfer: "accounting.cash.entries.kind.transfer",
  petty_topup: "accounting.cash.entries.kind.petty_topup",
};

export const CASH_ENTRY_KIND_TONES: Record<CashBankEntryKind, Tone> = {
  cash_in: "success",
  cash_out: "warning",
  transfer: "info",
  petty_topup: "warning",
};

export const CASH_ENTRY_STATUS_KEYS: Record<CashBankEntryStatus, MessageKey> = {
  pending_approval: "accounting.cash.entries.status.pending_approval",
  approved: "accounting.cash.entries.status.approved",
  rejected: "accounting.cash.entries.status.rejected",
};

export const CASH_ENTRY_STATUS_TONES: Record<CashBankEntryStatus, Tone> = {
  pending_approval: "warning",
  approved: "success",
  rejected: "danger",
};

export const CASH_REASON_MAX = 500;

/**
 * A cash out waits for a second person only above the tenant limit ("di
 * atas" = strictly greater). The API decides; this only warns the person
 * before they save.
 */
export function cashOutNeedsApproval(
  kind: CashBankEntryKind,
  amountIdr: number | null,
  limitIdr: number | undefined,
): boolean {
  return (
    kind === "cash_out" &&
    amountIdr !== null &&
    limitIdr !== undefined &&
    amountIdr > limitIdr
  );
}

/** The approval limit's ceiling in the contract (whole rupiah, minimum 1). */
export const CASH_LIMIT_MAX_IDR = MAX_CASH_OUT_APPROVAL_LIMIT_IDR;

export const PETTY_KIND_KEYS: Record<PettyCashEntryKind, MessageKey> = {
  topup: "accounting.cash.petty.kind.topup",
  return: "accounting.cash.petty.kind.return",
  purchase: "accounting.cash.petty.kind.purchase",
};

export const PETTY_JOURNAL_KEYS: Record<PettyCashJournalStatus, MessageKey> = {
  posted: "accounting.cash.petty.journal.posted",
  parked: "accounting.cash.petty.journal.parked",
  external: "accounting.cash.petty.journal.external",
};

export const PETTY_JOURNAL_TONES: Record<PettyCashJournalStatus, Tone> = {
  posted: "success",
  parked: "warning",
  external: "neutral",
};

/**
 * Counter accounts a cash in/out may name: active, not a header (nothing hangs
 * under it) and not a cash or bank account, which is what a transfer is for.
 * The API refuses the same accounts (CASH_BANK_COUNTER_ACCOUNT_INVALID); this
 * only keeps the picker honest.
 */
export function counterAccountChoices(accounts: readonly Account[]): Account[] {
  const parents = new Set(
    accounts.flatMap((account) => (account.parentId ? [account.parentId] : [])),
  );
  return accounts
    .filter(
      (account) =>
        account.isActive &&
        !parents.has(account.id) &&
        account.reportGroup !== "cash_and_equivalents",
    )
    .sort((a, b) => a.code.localeCompare(b.code, "en"));
}

/** A return above the fund balance: the API refuses it, the form says so first. */
export function pettyReturnExceedsBalance(
  kind: "topup" | "return",
  amountIdr: number,
  balanceIdr: number,
): boolean {
  return kind === "return" && amountIdr > balanceIdr;
}

/**
 * The sentence for a refused money request, by contract error code. Unknown
 * codes return null so the caller shows the server's own message instead.
 */
export function moneyErrorKey(code: string): MessageKey | null {
  switch (code) {
    case "PETTY_CASH_INSUFFICIENT":
      return "accounting.cash.moneyError.insufficient";
    case "CASH_BANK_COUNTER_ACCOUNT_INVALID":
      return "accounting.cash.moneyError.counterInvalid";
    case "IDEMPOTENCY_KEY_REUSED":
      return "accounting.cash.moneyError.keyReused";
    case "ACCOUNT_MAPPING_MISSING":
      return "accounting.cash.moneyError.mappingMissing";
    case "PERIOD_CLOSED":
      return "accounting.cash.moneyError.periodClosed";
    case "CASH_OUT_SELF_APPROVAL":
      return "accounting.cash.moneyError.selfApproval";
    case "CASH_ENTRY_NOT_PENDING":
      return "accounting.cash.moneyError.notPending";
    case "CASH_ENTRY_NOT_FOUND":
      return "accounting.cash.moneyError.entryNotFound";
    case "CASH_OUT_CHAIN_OPEN":
      return "accounting.cash.moneyError.chainOpen";
    case "CASH_OUT_CHAIN_MISSING":
      return "accounting.cash.moneyError.chainMissing";
    default:
      return null;
  }
}
