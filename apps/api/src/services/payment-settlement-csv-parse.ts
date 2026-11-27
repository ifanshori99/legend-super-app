// Gateway settlement CSV reader (C4b legend-osqou.8). Pure: text in, lines out.
//
// `legend_template_v1` is Legend's own template
// (docs/design/settlement-csv-template.md): the first non-blank row is the
// header and names exactly `reference`, `amount_idr` and `fee_idr` (any order,
// any case, each once, nothing else). Amounts are whole rupiah written as plain
// digits; anything else is unreadable. The gateway's native export is a
// separate format, added only once a real sample file is verified.
//
// Fail closed: one unreadable line refuses the whole file, so a report is never
// half imported. Errors carry the line number and a reason code, never content.
import {
  GATEWAY_SETTLEMENT_CSV_MAX_LINES,
  SETTLEMENT_TEMPLATE_V1_COLUMNS,
  type GatewaySettlementCsvFormat,
} from "@starter/shared/payment/admin";
import {
  EdcSettlementCsvError,
  readCsvRows,
} from "./edc-settlement-csv-parse.ts";

export type GatewaySettlementCsvLine = {
  reference: string;
  amountIdr: number;
  feeIdr: number;
};

export type GatewaySettlementRowError = {
  /** 1-based row of the file, header included. */
  row: number;
  reason: "columns" | "reference" | "amount" | "fee" | "duplicate";
};

/** The file as a whole cannot be read (no row to point at). */
export class GatewaySettlementCsvError extends Error {
  constructor(
    message: string,
    readonly rowErrors: readonly GatewaySettlementRowError[] = [],
  ) {
    super(message);
    this.name = "GatewaySettlementCsvError";
  }
}

/** Row errors listed per file; the rest are summarised by the message. */
const MAX_ROW_ERRORS = 20;

const wholeRupiah = (raw: string, min: number): number | null => {
  const value = raw.trim();
  if (!/^\d{1,15}$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= min ? amount : null;
};

// 1273 P3-4: a reference that starts like a spreadsheet formula is refused, so
// it cannot run as one when a later export is opened in a spreadsheet.
const FORMULA_START = /^[=+\-@\t\r]/;

const validReference = (value: string) =>
  !FORMULA_START.test(value) &&
  value.length >= 1 &&
  value.length <= 100 &&
  [...value].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127);

function parseTemplateV1(text: string): GatewaySettlementCsvLine[] {
  let rows: string[][];
  try {
    rows = readCsvRows(text);
  } catch (error) {
    if (error instanceof EdcSettlementCsvError)
      throw new GatewaySettlementCsvError("Berkas CSV tidak dapat dibaca.");
    throw error;
  }
  const blank = (row: string[]) => row.every((cell) => cell.trim() === "");
  const headerIndex = rows.findIndex((row) => !blank(row));
  if (headerIndex < 0) throw new GatewaySettlementCsvError("Berkas kosong.");
  const names = rows[headerIndex]!.map((cell) => cell.trim().toLowerCase());
  const expected: readonly string[] = SETTLEMENT_TEMPLATE_V1_COLUMNS;
  if (
    names.length !== expected.length ||
    new Set(names).size !== names.length ||
    !expected.every((column) => names.includes(column))
  )
    throw new GatewaySettlementCsvError(
      `Kolom harus tepat: ${expected.join(", ")}.`,
    );
  const at = {
    reference: names.indexOf("reference"),
    amount: names.indexOf("amount_idr"),
    fee: names.indexOf("fee_idr"),
  };

  const lines: GatewaySettlementCsvLine[] = [];
  const errors: GatewaySettlementRowError[] = [];
  const seen = new Set<string>();
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const cells = rows[index]!;
    if (blank(cells)) continue;
    const row = index + 1;
    if (cells.length !== names.length) {
      errors.push({ row, reason: "columns" });
      continue;
    }
    const reference = cells[at.reference]!.trim();
    if (
      FORMULA_START.test(cells[at.reference]!) ||
      !validReference(reference)
    ) {
      errors.push({ row, reason: "reference" });
      continue;
    }
    const amountIdr = wholeRupiah(cells[at.amount]!, 1);
    if (amountIdr === null) {
      errors.push({ row, reason: "amount" });
      continue;
    }
    const feeIdr = wholeRupiah(cells[at.fee]!, 0);
    // A fee above the amount would settle a negative net for the line.
    if (feeIdr === null || feeIdr > amountIdr) {
      errors.push({ row, reason: "fee" });
      continue;
    }
    if (seen.has(reference)) {
      errors.push({ row, reason: "duplicate" });
      continue;
    }
    seen.add(reference);
    lines.push({ reference, amountIdr, feeIdr });
  }
  if (errors.length > 0)
    throw new GatewaySettlementCsvError(
      errors.length > MAX_ROW_ERRORS
        ? `${errors.length} baris tidak dapat dibaca; ${MAX_ROW_ERRORS} pertama ditampilkan.`
        : `${errors.length} baris tidak dapat dibaca.`,
      errors.slice(0, MAX_ROW_ERRORS),
    );
  if (lines.length === 0)
    throw new GatewaySettlementCsvError(
      "Berkas tidak berisi baris settlement.",
    );
  if (lines.length > GATEWAY_SETTLEMENT_CSV_MAX_LINES)
    throw new GatewaySettlementCsvError(
      `Berkas melebihi ${GATEWAY_SETTLEMENT_CSV_MAX_LINES} baris.`,
    );
  return lines;
}

export function parseGatewaySettlementCsv(
  format: GatewaySettlementCsvFormat,
  text: string,
): GatewaySettlementCsvLine[] {
  switch (format) {
    case "legend_template_v1":
      return parseTemplateV1(text);
  }
}
