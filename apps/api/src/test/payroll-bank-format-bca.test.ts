// Pure unit tests of the BCA bank file formatter (bead legend-648, brief
// 648-brief.md "BCA format"; source: HReasily guide "How to upload GIRO File to
// Bank BCA portal"). BCA's own spec is not public, so `bca` renders the
// SOURCE sheet of BCA's "Multi Auto Transaksi" converter. Expected values come
// from the brief:
//   header   Transaction ID,Transfer Type,Credited Account,Receiver Name,Amount,Employee ID,Remark,Email
//   one row per payee; Transfer Type fixed `BCA`; Credited Account digits only;
//   Amount whole rupiah, no separators; Employee ID = employee code;
//   Remark = `GAJI <periodLabel>`; Email empty;
//   Transaction ID = `<YYYYMM><4-digit seq>`; only bankCode `014` rows,
//   anything else 422 PAYROLL_BANK_FILE_BANK_UNSUPPORTED (never guess a bank).
//
// Interfaces under test (none exist yet; every test fails first):
//   lib/payroll-export/bank-formats.ts
//     getBankFormatter("bca") -> BankFormatter
//     BankFileRow gets optional `bankCode`
//     BCA_UNCONFIRMED_FIELDS: readonly string[]
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - Same envelope as generic_csv: CRLF line ends, no BOM, no trailing line,
//   RFC 4180 quoting, formula-injection apostrophe on text cells.
// - `contentType` starts with `text/csv`; `extension` is `csv`.
// - The sequence in the Transaction ID starts at 0001 and follows row order;
//   the year-month comes from `meta.periodLabel` (YYYY-MM).
// - Receiver Name is the account holder name (the tests give a row the same
//   employeeName and accountHolder to keep this unambiguous).
// - A row with no bankCode at all is refused like a non-BCA code (never guess).
// - A non-positive or fractional amount is 422 PAYROLL_BANK_FILE_AMOUNT_INVALID
//   (same rule as generic_csv).
// - Unconfirmed layout details are listed in `BCA_UNCONFIRMED_FIELDS` (at least
//   the five the brief names) and in docs/design/payroll-disbursement-manual-bca.md.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import * as bankFormats from "../lib/payroll-export/bank-formats.ts";
import {
  getBankFormatter,
  type BankFileMeta,
  type BankFileRow,
} from "../lib/payroll-export/bank-formats.ts";

const META: BankFileMeta = {
  payrollRunId: "0f9d3c1e-6c3a-4a3e-9d57-7a1b2c3d4e5f",
  periodLabel: "2026-10",
  payDate: "2026-10-25",
};
const HEADER =
  "Transaction ID,Transfer Type,Credited Account,Receiver Name,Amount,Employee ID,Remark,Email";

const row = (over: Partial<BankFileRow> = {}): BankFileRow =>
  ({
    employeeId: "11111111-1111-4111-8111-111111111111",
    employeeCode: "E001",
    employeeName: "Budi Santoso",
    bankName: "BCA",
    accountNumber: "1234567890",
    accountHolder: "Budi Santoso",
    amountIdr: 4_250_000,
    bankCode: "014",
    ...over,
  }) as BankFileRow;

const bca = () => getBankFormatter("bca");
const render = (rows: BankFileRow[]) => bca().render(rows, META);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      current.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      current.push(cell);
      rows.push(current);
      current = [];
      cell = "";
      i++;
    } else cell += c;
  }
  current.push(cell);
  rows.push(current);
  return rows;
}

function failureOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return null;
}

describe("bca formatter registry", () => {
  it("[bca-registered] bca is a CSV formatter named after its format", () => {
    const formatter = bca();
    expect(formatter.format).toBe("bca");
    expect(formatter.contentType).toMatch(/^text\/csv/);
    expect(formatter.extension).toMatch(/^\.?csv$/);
    expect(typeof formatter.render).toBe("function");
  });

  it("[bca-others-still-unsupported] mandiri, bni and bjb stay unsupported (no guessed layout)", () => {
    for (const format of ["mandiri", "bni", "bjb"] as const) {
      const error = failureOf(() => getBankFormatter(format));
      expect(error, format).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe(
        "PAYROLL_BANK_FORMAT_NOT_SUPPORTED",
      );
    }
  });
});

describe("bca converter source sheet", () => {
  it("[bca-layout] header as listed by the guide, CRLF line ends, no BOM, no trailing line", () => {
    const text = render([
      row(),
      row({
        employeeCode: "E002",
        employeeName: "Siti Aminah",
        accountHolder: "Siti Aminah",
        accountNumber: "9876543210",
        amountIdr: 1_000_000,
      }),
    ]);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADER);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines[2]).not.toBe("");
    for (const cells of parseCsv(text)) expect(cells).toHaveLength(8);
  });

  it("[bca-cells] a row maps transaction id, fixed BCA type, digits-only account, name, whole rupiah, employee code, remark and an empty email", () => {
    const [, cells] = parseCsv(
      render([row({ accountNumber: "1234-567 890" })]),
    );
    expect(cells).toEqual([
      "2026100001",
      "BCA",
      "1234567890",
      "Budi Santoso",
      "4250000",
      "E001",
      "GAJI 2026-10",
      "",
    ]);
  });

  it("[bca-transaction-id-sequence] transaction ids run 0001, 0002, ... in row order under the period month", () => {
    const rows = [1, 2, 3].map((n) =>
      row({ employeeCode: `E00${n}`, accountNumber: `55500000${n}` }),
    );
    const ids = parseCsv(render(rows))
      .slice(1)
      .map((cells) => cells[0]);
    expect(ids).toEqual(["2026100001", "2026100002", "2026100003"]);
  });

  it("[bca-amount-plain] the amount is a plain integer: no separators, no decimals, large values intact", () => {
    const [, cells] = parseCsv(render([row({ amountIdr: 99_999_999 })]));
    expect(cells![4]).toBe("99999999");
  });

  it("[bca-account-leading-zero] leading zeros of the account survive", () => {
    const [, cells] = parseCsv(render([row({ accountNumber: "0012345678" })]));
    expect(cells![2]).toBe("0012345678");
  });

  it("[bca-quoting-and-injection] commas and quotes are RFC 4180 quoted, a leading = + - @ gets an apostrophe", () => {
    const tricky = row({
      employeeName: `Siti "Cici", S.Kom`,
      accountHolder: `Siti "Cici", S.Kom`,
    });
    const text = render([tricky]);
    expect(text).toContain(`"Siti ""Cici"", S.Kom"`);
    expect(parseCsv(text)[1]![3]).toBe(`Siti "Cici", S.Kom`);

    const formula = parseCsv(
      render([row({ employeeName: "=SUM(A1)", accountHolder: "=SUM(A1)" })]),
    )[1]!;
    expect(formula[3]).toBe("'=SUM(A1)");
  });
});

describe("bca refuses what it cannot render", () => {
  it("[bca-bank-unsupported] a payee of another bank code is refused 422 PAYROLL_BANK_FILE_BANK_UNSUPPORTED, no partial file", () => {
    const error = failureOf(() =>
      render([row(), row({ employeeCode: "E002", bankCode: "008" })]),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as HttpError).code).toBe(
      "PAYROLL_BANK_FILE_BANK_UNSUPPORTED",
    );
  });

  it("[bca-bank-code-missing] a payee without a bank code is refused the same way (never guess)", () => {
    const error = failureOf(() =>
      render([row({ bankCode: undefined } as Partial<BankFileRow>)]),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as HttpError).code).toBe(
      "PAYROLL_BANK_FILE_BANK_UNSUPPORTED",
    );
  });

  it("[bca-amount-invalid] zero, negative and fractional amounts are refused 422 PAYROLL_BANK_FILE_AMOUNT_INVALID", () => {
    for (const amountIdr of [0, -1, 1.5, Number.NaN]) {
      const error = failureOf(() => render([row({ amountIdr })]));
      expect(error, String(amountIdr)).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(422);
      expect((error as HttpError).code).toBe(
        "PAYROLL_BANK_FILE_AMOUNT_INVALID",
      );
    }
  });
});

describe("bca unconfirmed fields are declared", () => {
  it("[bca-unconfirmed-list] BCA_UNCONFIRMED_FIELDS names at least the five details the bank must still confirm", () => {
    const list = (bankFormats as Record<string, unknown>)
      .BCA_UNCONFIRMED_FIELDS;
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBeGreaterThanOrEqual(5);
    for (const entry of list as unknown[]) {
      expect(typeof entry).toBe("string");
      expect((entry as string).length).toBeGreaterThan(0);
    }
  });

  it("[bca-unconfirmed-doc] the design note exists and says which fields are unconfirmed", () => {
    const path = fileURLToPath(
      new URL(
        "../../../../docs/design/payroll-disbursement-manual-bca.md",
        import.meta.url,
      ),
    );
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/unconfirmed/i);
  });
});
