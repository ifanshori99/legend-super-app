// Pure rules for the Duitku settlement import (C4b, legend-osqou.8). No React
// and no `@/` alias, so Node tests can import this file. The API stays the
// authority: the screen refuses only what the API would refuse, never reads an
// amount from the file, and words the server's answers for finance.
import {
  EDC_SETTLEMENT_CSV_MAX_CHARS,
  SETTLEMENT_TEMPLATE_V1_COLUMNS,
} from "@starter/shared/payment/admin";
import { ApiError } from "../../lib/api/errors.ts";

export type SettlementCsvCheck = "empty" | "tooLarge" | "notCsv";

/** Checks a chosen file before it is sent; null means it can go. */
export function checkSettlementCsv(
  fileName: string,
  csv: string,
): SettlementCsvCheck | null {
  if (!/\.(csv|txt)$/i.test(fileName.trim())) return "notCsv";
  if (csv.trim() === "") return "empty";
  // In bytes (UTF-8, what the request body carries): a file of non-ASCII text
  // weighs more than its characters and must stay under the 100 kB body cap.
  if (new Blob([csv]).size > EDC_SETTLEMENT_CSV_MAX_CHARS) return "tooLarge";
  return null;
}

/** Data rows of a chosen file (non-blank lines after the header), for the hint only. */
export function dataRowCount(csv: string): number {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  return Math.max(0, lines.length - 1);
}

/** The "Unduh template" file: the header only, so no sample line is ever imported. */
export function settlementTemplateCsv(): string {
  return `${SETTLEMENT_TEMPLATE_V1_COLUMNS.join(",")}\r\n`;
}

export type PeriodCheck = "periodRequired" | "periodOrder" | "periodTooLong";

/** Same period rules as the API (inclusive, at most 31 days). */
export function checkPeriod(start: string, end: string): PeriodCheck | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return "periodRequired";
  if (end < start) return "periodOrder";
  const days =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000;
  return days > 30 ? "periodTooLong" : null;
}

export const SETTLEMENT_ROW_REASONS = [
  "columns",
  "reference",
  "amount",
  "fee",
  "duplicate",
] as const;
export type SettlementRowReason =
  (typeof SETTLEMENT_ROW_REASONS)[number] | "other";

export type SettlementErrorView =
  | {
      kind: "rows";
      rows: { row: number; reason: SettlementRowReason }[];
    }
  | { kind: "rateLimited"; seconds: number | null }
  | {
      kind:
        | "invalid"
        | "conflict"
        | "forbidden"
        | "notFound"
        | "session"
        | "offline"
        | "generic";
    };

export function settlementErrorView(error: unknown): SettlementErrorView {
  if (!(error instanceof ApiError)) return { kind: "generic" };
  if (error.code === "NETWORK_ERROR") return { kind: "offline" };
  if (error.code === "SETTLEMENT_CONFLICT") return { kind: "conflict" };
  if (error.status === 401) return { kind: "session" };
  if (error.status === 429)
    return { kind: "rateLimited", seconds: error.retryAfterSeconds ?? null };
  if (error.status === 403) return { kind: "forbidden" };
  if (error.status === 404) return { kind: "notFound" };
  if (error.status === 422) {
    if (error.rowErrors && error.rowErrors.length > 0)
      return {
        kind: "rows",
        rows: error.rowErrors.map((entry) => ({
          row: entry.row,
          reason: (SETTLEMENT_ROW_REASONS as readonly string[]).includes(
            entry.reason,
          )
            ? (entry.reason as SettlementRowReason)
            : "other",
        })),
      };
    // The server's own message is English; the screen keeps its own words.
    return { kind: "invalid" };
  }
  return { kind: "generic" };
}

const periodFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "1 Nov 2026" or "1–3 Nov 2026" (dates are calendar days, read as UTC). */
export function periodLabel(start: string, end: string): string {
  const from = new Date(`${start}T00:00:00Z`);
  if (start === end) return periodFormat.format(from);
  return periodFormat.formatRange(from, new Date(`${end}T00:00:00Z`));
}
