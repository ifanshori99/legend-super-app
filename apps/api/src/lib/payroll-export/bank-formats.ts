import type { BankTransferFormat } from "@starter/shared/hris/payroll/payslips";
import { HttpError } from "../http-error";
import { csvCell, csvRows } from "./csv";

export type BankFileRow = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  bankName: string | null;
  accountNumber: string;
  accountHolder: string;
  amountIdr: number;
};

export type BankFileMeta = {
  payrollRunId: string;
  /** YYYY-MM */
  periodLabel: string;
  /** YYYY-MM-DD */
  payDate: string;
};

export interface BankFormatter {
  format: BankTransferFormat;
  contentType: string;
  extension: string;
  render(rows: readonly BankFileRow[], meta: BankFileMeta): string;
}

const GENERIC_CSV_HEADER = [
  "no",
  "employee_code",
  "employee_name",
  "bank_name",
  "account_number",
  "account_holder",
  "amount_idr",
  "reference",
] as const;

const genericCsvFormatter: BankFormatter = {
  format: "generic_csv",
  contentType: "text/csv; charset=utf-8",
  extension: "csv",
  render(rows, meta) {
    const reference = `PAYROLL-${meta.periodLabel}`;
    const lines: string[][] = [[...GENERIC_CSV_HEADER]];
    rows.forEach((row, index) => {
      if (!Number.isSafeInteger(row.amountIdr) || row.amountIdr <= 0) {
        throw new HttpError(
          422,
          "PAYROLL_BANK_FILE_AMOUNT_INVALID",
          "Bank file amounts must be positive whole rupiah.",
        );
      }
      lines.push([
        String(index + 1),
        csvCell(row.employeeCode),
        csvCell(row.employeeName),
        csvCell(row.bankName),
        csvCell(row.accountNumber, { forceQuote: true }),
        csvCell(row.accountHolder),
        String(row.amountIdr),
        csvCell(reference),
      ]);
    });
    return csvRows(lines);
  },
};

// Other banks are added here once their layout is confirmed. Never guess one.
const FORMATTERS: Partial<Record<BankTransferFormat, BankFormatter>> = {
  generic_csv: genericCsvFormatter,
};

export function getBankFormatter(format: BankTransferFormat): BankFormatter {
  const formatter = FORMATTERS[format];
  if (!formatter) {
    throw new HttpError(
      422,
      "PAYROLL_BANK_FORMAT_NOT_SUPPORTED",
      `Bank file format ${format} is not supported yet.`,
    );
  }
  return formatter;
}
