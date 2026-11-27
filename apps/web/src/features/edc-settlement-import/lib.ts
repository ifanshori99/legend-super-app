// Pure rules for the EDC settlement CSV upload (X2-UI, legend-wasr7.18). No
// React and no `@/` alias, so tests can import this file with plain Node ESM.
// The API stays the authority; the screen only refuses what it would refuse
// and words its answers for finance.
import { EDC_SETTLEMENT_CSV_MAX_CHARS } from "@starter/shared/payment/admin";
import { ApiError } from "../../lib/api/errors.ts";

export const EDC_BANKS = ["bca", "mandiri", "bni", "bjb"] as const;
export type EdcBank = (typeof EDC_BANKS)[number];

export { EDC_SETTLEMENT_CSV_MAX_CHARS };

export type CsvCheck = "empty" | "tooLarge" | "notCsv";

/** Checks a chosen file before it is sent; null means it can go. */
export function checkCsvUpload(fileName: string, csv: string): CsvCheck | null {
  if (!/\.(csv|txt)$/i.test(fileName.trim())) return "notCsv";
  if (csv.trim() === "") return "empty";
  if (csv.length > EDC_SETTLEMENT_CSV_MAX_CHARS) return "tooLarge";
  return null;
}

export type ImportErrorView = {
  kind:
    | "rows"
    | "message"
    | "mfa"
    | "forbidden"
    | "notFound"
    | "offline"
    | "generic";
  /** Row numbers of the file the parser could not read (kind "rows"). */
  rows: number[];
  /** Reason code per row from the server's `rowErrors`; empty for the old sentence. */
  reasons: Record<number, string>;
  /** The parser's own sentence (kind "message"). */
  detail?: string;
};

/** "Baris 3, 5, 12 tidak dapat dibaca ..." (the API's parser) to [3, 5, 12]. */
function unreadableRows(message: string): number[] {
  const match = /^Baris ([\d, ]+) tidak dapat dibaca/.exec(message);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function importErrorView(error: unknown): ImportErrorView {
  if (!(error instanceof ApiError))
    return { kind: "generic", rows: [], reasons: {} };
  if (error.code === "MFA_REQUIRED" || error.code === "REAUTH_REQUIRED")
    return { kind: "mfa", rows: [], reasons: {} };
  if (error.code === "NETWORK_ERROR")
    return { kind: "offline", rows: [], reasons: {} };
  if (error.status === 403) return { kind: "forbidden", rows: [], reasons: {} };
  if (error.status === 404) return { kind: "notFound", rows: [], reasons: {} };
  if (error.status === 422) {
    // Structured list first; an older server only has the sentence.
    if (error.rowErrors && error.rowErrors.length > 0)
      return {
        kind: "rows",
        rows: error.rowErrors.map((entry) => entry.row),
        reasons: Object.fromEntries(
          error.rowErrors.map((entry) => [entry.row, entry.reason]),
        ),
      };
    const rows = unreadableRows(error.message);
    if (rows.length > 0) return { kind: "rows", rows, reasons: {} };
    return { kind: "message", rows: [], reasons: {}, detail: error.message };
  }
  return { kind: "generic", rows: [], reasons: {} };
}

/**
 * What goes under the file field: the data-row count of a chosen file, or the
 * general hint. The count is hidden while the server lists unreadable lines
 * (it would say "read" next to "could not read", audit P2 1).
 */
export function fileHintKind(
  hasFile: boolean,
  error: ImportErrorView | null,
): "count" | "hint" {
  return hasFile && error?.kind !== "rows" ? "count" : "hint";
}
