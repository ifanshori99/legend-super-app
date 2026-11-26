// EDC settlement CSV reader (X2 legend-wasr7.11). Pure: text in, lines out.
//
// Each bank exports its settlement report with its own column names. The
// header row is found by name (a bank preamble above it is skipped), with the
// names every bank uses plus that bank's own. Only the terminal, RRN, amount,
// approval code, batch and transaction type are read; card number columns are
// never read, so a masked or full PAN in the file is never stored.
//
// Fail closed: one line that cannot be read (amount with cents, scientific
// notation, RRN that is not alphanumeric) refuses the whole file, so a file is
// never half imported. A line whose type is not a sale (void, refund,
// reversal) is returned as `void`, never as a sale.
import type { EdcBank } from "@starter/shared/edc";

/** Lines one file may carry (a day of one outlet is far below this). */
export const EDC_SETTLEMENT_CSV_MAX_LINES = 2000;

export type EdcSettlementCsvLine = {
  /** 1-based line number in the file, header included. */
  lineNo: number;
  kind: "sale" | "void";
  terminalCode: string;
  rrn: string;
  amountIdr: number;
  approvalCode: string | null;
  batchNo: string | null;
};

export class EdcSettlementCsvError extends Error {
  constructor(
    message: string,
    /** File line numbers that could not be read (at most 20). */
    readonly lines: readonly number[] = [],
  ) {
    super(message);
    this.name = "EdcSettlementCsvError";
  }
}

type Column = "terminal" | "rrn" | "amount" | "approval" | "batch" | "type";

const COMMON: Record<Column, readonly string[]> = {
  terminal: ["tid", "terminalid", "terminal", "noterminal", "terminalno"],
  rrn: [
    "rrn",
    "rrnno",
    "refno",
    "noref",
    "referenceno",
    "referencenumber",
    "retrievalreferencenumber",
    "noreferensi",
  ],
  amount: [
    "amount",
    "nominal",
    "jumlah",
    "trxamount",
    "transactionamount",
    "nilaitransaksi",
    "nominaltransaksi",
    "grossamount",
  ],
  approval: [
    "approvalcode",
    "authcode",
    "authorizationcode",
    "apprcode",
    "kodeotorisasi",
  ],
  batch: ["batch", "batchno", "nobatch", "batchnumber"],
  type: ["type", "trxtype", "transactiontype", "jenis", "jenistransaksi"],
};

/** Column names seen only in one bank's export. */
const BANK_EXTRA: Record<
  EdcBank,
  Partial<Record<Column, readonly string[]>>
> = {
  bca: {
    terminal: ["tidedc"],
    amount: ["nilai", "nominalrp"],
    approval: ["kodeapproval"],
  },
  mandiri: {
    amount: ["trxamt", "amountrp"],
    rrn: ["rrnnumber"],
    approval: ["authid"],
  },
  bni: {
    terminal: ["tidmerchant"],
    amount: ["amounttrx"],
    approval: ["approval"],
  },
  bjb: {
    terminal: ["idterminal"],
    amount: ["nominaltrx"],
    rrn: ["norrn"],
  },
};

const SALE_TYPES = new Set([
  "",
  "sale",
  "sales",
  "purchase",
  "penjualan",
  "debit",
  "credit",
  "kredit",
]);

const normalizeHeader = (value: string) =>
  value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

/**
 * RFC 4180 reader. The delimiter (, ; or tab) is the one that splits some line
 * of the first 20 the most (a bank title line above the header has none).
 */
export function readCsvRows(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const head = text.split(/\r\n|\n|\r/, 20);
  const widest = (d: string) =>
    Math.max(...head.map((line) => line.split(d).length));
  const delimiter = [",", ";", "\t"]
    .map((d) => ({ d, n: widest(d) }))
    .sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    started = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > EDC_SETTLEMENT_CSV_MAX_LINES + 20)
      throw new EdcSettlementCsvError(
        `Berkas melebihi ${EDC_SETTLEMENT_CSV_MAX_LINES} baris.`,
      );
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
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === delimiter) endCell();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  if (quoted) throw new EdcSettlementCsvError("Tanda kutip tidak ditutup.");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Whole rupiah from a bank amount: "55000", "55.000", "55,000", "Rp 55.000",
 * "55.000,00", "55,000.00" or "Rp 55.000,-". Cents other than 00, a sign, or anything
 * ambiguous gives null (the file is refused).
 */
export function parseRupiah(raw: string): number | null {
  // "Rp 55.000,-": the trailing ",-" (or ".-") means no cents.
  const value = raw
    .replaceAll(/\s/g, "")
    .replace(/^(rp|idr)\.?/i, "")
    .replace(/[.,]-$/, "");
  let digits: string | null = null;
  let match = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{2}))?$/.exec(value);
  if (match) {
    if (match[2] !== undefined && match[2] !== "00") return null;
    digits = match[1]!.replaceAll(".", "");
  } else if ((match = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{2}))?$/.exec(value))) {
    if (match[2] !== undefined && match[2] !== "00") return null;
    digits = match[1]!.replaceAll(",", "");
  } else if ((match = /^(\d+)(?:[.,](\d{2}))?$/.exec(value))) {
    if (match[2] !== undefined && match[2] !== "00") return null;
    digits = match[1]!;
  }
  if (digits === null) return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/** The RRN as every matcher compares it: no spaces or hyphens, upper case. */
export const normalizeRrn = (value: string) =>
  value.replaceAll(/[\s-]/g, "").toUpperCase();

export function parseEdcSettlementCsv(
  bank: EdcBank,
  text: string,
): EdcSettlementCsvLine[] {
  const rows = readCsvRows(text);
  const aliases = (column: Column) => [
    ...COMMON[column],
    ...(BANK_EXTRA[bank][column] ?? []),
  ];
  let headerIndex = -1;
  let at: Partial<Record<Column, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 20) && headerIndex < 0; i += 1) {
    const names = rows[i]!.map(normalizeHeader);
    const found: Partial<Record<Column, number>> = {};
    for (const column of Object.keys(COMMON) as Column[]) {
      const index = names.findIndex((name) => aliases(column).includes(name));
      if (index >= 0) found[column] = index;
    }
    if (
      found.terminal !== undefined &&
      found.rrn !== undefined &&
      found.amount !== undefined
    ) {
      headerIndex = i;
      at = found;
    }
  }
  if (headerIndex < 0)
    throw new EdcSettlementCsvError(
      "Kolom TID, RRN dan nominal tidak ditemukan. Pastikan berkas adalah laporan settlement EDC bank yang dipilih.",
    );
  const cell = (row: string[], column: Column) => {
    const index = at[column];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };
  const headerWidth = rows[headerIndex]!.length;
  const lines: EdcSettlementCsvLine[] = [];
  const bad: number[] = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const lineNo = i + 1;
    const terminal = cell(row, "terminal");
    const rrnRaw = cell(row, "rrn");
    // Blank lines and the bank's total/footer lines carry no terminal and RRN.
    if (terminal === "" && rrnRaw === "") continue;
    // X2 review P3 6: a shifted line (a stray delimiter, a missing cell)
    // would read another column as the amount: refused.
    if (row.length !== headerWidth) {
      bad.push(lineNo);
      continue;
    }
    const rrn = normalizeRrn(rrnRaw);
    const terminalCode = terminal.toUpperCase();
    const amountIdr = parseRupiah(cell(row, "amount"));
    if (
      !/^[A-Z0-9]{1,24}$/.test(rrn) ||
      !/^[A-Z0-9_-]{1,32}$/.test(terminalCode) ||
      amountIdr === null
    ) {
      bad.push(lineNo);
      continue;
    }
    const approval = cell(row, "approval");
    const batch = cell(row, "batch");
    lines.push({
      lineNo,
      kind: SALE_TYPES.has(normalizeHeader(cell(row, "type")))
        ? "sale"
        : "void",
      terminalCode,
      rrn,
      amountIdr,
      approvalCode: /^[A-Za-z0-9]{1,12}$/.test(approval) ? approval : null,
      batchNo: /^[A-Za-z0-9-]{1,20}$/.test(batch) ? batch : null,
    });
  }
  if (bad.length > 0)
    throw new EdcSettlementCsvError(
      `Baris ${bad.slice(0, 20).join(", ")} tidak dapat dibaca (TID, RRN atau nominal tidak valid). Tidak ada baris yang diimpor.`,
      bad.slice(0, 20),
    );
  if (lines.length === 0)
    throw new EdcSettlementCsvError("Berkas tidak memuat baris transaksi.");
  if (lines.length > EDC_SETTLEMENT_CSV_MAX_LINES)
    throw new EdcSettlementCsvError(
      `Berkas melebihi ${EDC_SETTLEMENT_CSV_MAX_LINES} baris transaksi.`,
    );
  return lines;
}
