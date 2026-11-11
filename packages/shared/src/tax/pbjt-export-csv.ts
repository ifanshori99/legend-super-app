// PBJT recap as a CSV file (same columns and format as the web download in
// apps/web/src/features/ws05-tax/lib.ts toPbjtCsv, with fixed English labels).
// Pure: it renders the recap object as given, so the total row and the stored
// export amount always equal getPbjtMonthlyRecap's totals. No BOM; the browser
// download adds it.

import type { PbjtMonthlyRecap } from "./schemas.ts";

const PBJT_CSV_HEADER = [
  "code",
  "rate",
  "transactions",
  "gross",
  "base",
  "service",
  "tax",
] as const;

function csvCell(value: string | number): string {
  // Text cells come from tenant input (rule codes). A leading = + - @ or
  // control character makes Excel/Sheets evaluate the cell as a formula
  // (CSV injection, OWASP), so text is prefixed with an apostrophe. Numbers
  // are written as numbers and never prefixed.
  const raw = String(value);
  const text =
    typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV: header, one row per recap row, then a total row (CRLF). */
export function pbjtRecapToCsv(recap: PbjtMonthlyRecap): string {
  let transactionCount = 0;
  let grossSalesIdr = 0;
  let serviceChargeIdr = 0;
  for (const row of recap.rows) {
    transactionCount += row.transactionCount;
    grossSalesIdr += row.grossSalesIdr;
    serviceChargeIdr += row.serviceChargeIdr;
  }
  const lines: (string | number)[][] = [
    [...PBJT_CSV_HEADER],
    ...recap.rows.map((row) => [
      row.taxRuleCode,
      row.rateBp,
      row.transactionCount,
      row.grossSalesIdr,
      row.taxBaseIdr,
      row.serviceChargeIdr,
      row.taxIdr,
    ]),
    [
      "total",
      "",
      transactionCount,
      grossSalesIdr,
      recap.totalTaxBaseIdr,
      serviceChargeIdr,
      recap.totalTaxIdr,
    ],
  ];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function pbjtExportFileName(period: string, outletId: string): string {
  return `pbjt-${period}-${outletId.slice(0, 8)}.csv`;
}
