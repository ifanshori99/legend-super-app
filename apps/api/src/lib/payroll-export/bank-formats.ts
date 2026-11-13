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
  /** 3-digit BI bank code. Formats that are bank specific (bca) require it. */
  bankCode?: string | null;
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

// BCA KlikBCA Bisnis Multi Payroll. BCA's own spec is not public. This renders
// the SOURCE sheet that BCA's "Multi Auto Transaksi" converter maps into the
// .txt + checksum upload (source: HReasily help article 72000646425, 13 Nov
// 2026). Debited account, effective date, Corporate ID, Company Code and Header
// ID are typed in the converter Transfer Info tab, never in this file.
// See docs/design/payroll-disbursement-manual-bca.md.
export const BCA_BANK_CODE = "014";

// Fields the bank has not confirmed. Check each with BCA before first live use.
export const BCA_UNCONFIRMED_FIELDS = [
  "transfer_type_literal_values",
  "transaction_id_length_and_charset",
  "receiver_name_length_and_charset",
  "credited_account_format",
  "amount_format",
] as const;

const BCA_HEADER = [
  "Transaction ID",
  "Transfer Type",
  "Credited Account",
  "Receiver Name",
  "Amount",
  "Employee ID",
  "Remark",
  "Email",
] as const;

const BCA_MAX_ROWS = 9999;

const bcaFormatter: BankFormatter = {
  format: "bca",
  contentType: "text/csv; charset=utf-8",
  extension: "csv",
  render(rows, meta) {
    if (rows.length > BCA_MAX_ROWS) {
      throw new HttpError(
        422,
        "PAYROLL_BANK_FILE_TOO_MANY_ROWS",
        `A BCA file holds at most ${BCA_MAX_ROWS} payees.`,
      );
    }
    const yyyymm = meta.periodLabel.replace("-", "");
    if (!/^\d{6}$/.test(yyyymm)) {
      throw new HttpError(
        422,
        "PAYROLL_BANK_FILE_PERIOD_INVALID",
        "Bank file period must be YYYY-MM.",
      );
    }
    const remark = `GAJI ${meta.periodLabel}`;
    const lines: string[][] = [[...BCA_HEADER]];
    rows.forEach((row, index) => {
      // Never guess another bank: only in-bank BCA rows are rendered.
      if (row.bankCode !== BCA_BANK_CODE) {
        throw new HttpError(
          422,
          "PAYROLL_BANK_FILE_BANK_UNSUPPORTED",
          "The BCA file format only accepts BCA accounts (bank code 014).",
        );
      }
      if (!Number.isSafeInteger(row.amountIdr) || row.amountIdr <= 0) {
        throw new HttpError(
          422,
          "PAYROLL_BANK_FILE_AMOUNT_INVALID",
          "Bank file amounts must be positive whole rupiah.",
        );
      }
      const account = row.accountNumber.replace(/\D/g, "");
      if (account === "") {
        throw new HttpError(
          422,
          "PAYROLL_BANK_FILE_ACCOUNT_INVALID",
          "Bank file account numbers must contain digits.",
        );
      }
      lines.push([
        `${yyyymm}${String(index + 1).padStart(4, "0")}`,
        "BCA",
        csvCell(account, { forceQuote: true }),
        csvCell(row.accountHolder || row.employeeName),
        String(row.amountIdr),
        csvCell(row.employeeCode),
        csvCell(remark),
        "",
      ]);
    });
    return csvRows(lines);
  },
};

// Other banks are added here once their layout is confirmed. Never guess one.
const FORMATTERS: Partial<Record<BankTransferFormat, BankFormatter>> = {
  generic_csv: genericCsvFormatter,
  bca: bcaFormatter,
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
