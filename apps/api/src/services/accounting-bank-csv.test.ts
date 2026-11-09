// Bank statement CSV parser (bead legend-fnxl, WS-07; PRD v1.7 §3.19 "Impor
// mutasi bank (CSV)", ACC-04). Pure unit tests, no database.
//
// Rules under test (docs/briefs/271-ws07-cash-bank.md "S3 tests"): signed and
// debit/credit layouts, "0,00" counts as empty in the unused column, both
// columns filled is refused, a fraction ("1.234,50") is refused with the row
// named ("Baris N"), an unterminated quote is refused, identical rows in one
// file stay apart (different dedupe keys), the header row is skipped.
//
// Assumptions: row numbers are 1-based and count the header row, so the first
// data row under a header is "Baris 2". An amount is positive for money in.
// In the debit/credit layout debit is money out (negative) and credit money
// in (positive).

import { describe, expect, it } from "vitest";
import type { BankCsvMapping } from "@starter/shared/accounting";
import { parseStatementCsv } from "./accounting-bank-csv";

const signed: BankCsvMapping = {
  hasHeader: true,
  delimiter: ",",
  dateColumn: 0,
  dateFormat: "DD/MM/YYYY",
  descriptionColumn: 1,
  amount: { kind: "signed", column: 2 },
  decimalSeparator: ",",
  referenceColumn: null,
};

const debitCredit: BankCsvMapping = {
  hasHeader: true,
  delimiter: ";",
  dateColumn: 0,
  dateFormat: "DD/MM/YYYY",
  descriptionColumn: 1,
  amount: { kind: "debit_credit", debitColumn: 2, creditColumn: 3 },
  decimalSeparator: ",",
  referenceColumn: 4,
};

const HEADER = "Tanggal,Keterangan,Jumlah";

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("Expected the CSV to be refused, but it was parsed.");
}

describe("legend-fnxl bank CSV parser", () => {
  it("signed layout: positive is money in, negative is money out, date becomes ISO", () => {
    const lines = parseStatementCsv(
      [
        HEADER,
        '05/11/2026,Setoran tunai,"1.500.000,00"',
        '06/11/2026,Biaya admin,"-15.000,00"',
      ].join("\n"),
      signed,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      rowNumber: 2,
      postedOn: "2026-11-05",
      amountIdr: 1_500_000,
      description: "Setoran tunai",
      externalRef: null,
    });
    expect(lines[1]).toMatchObject({
      rowNumber: 3,
      postedOn: "2026-11-06",
      amountIdr: -15_000,
    });
  });

  it("debit/credit layout: credit is money in, debit is money out, '0,00' in the unused column counts as empty", () => {
    const lines = parseStatementCsv(
      [
        "Tgl;Ket;Debit;Kredit;Ref",
        "05/11/2026;Setoran;0,00;2.000.000,00;REF-1",
        "06/11/2026;Biaya;15.000,00;0,00;REF-2",
        "07/11/2026;Tarik;7.500;;",
      ].join("\r\n"),
      debitCredit,
    );
    expect(lines.map((line) => line.amountIdr)).toEqual([
      2_000_000, -15_000, -7_500,
    ]);
    expect(lines.map((line) => line.externalRef)).toEqual([
      "REF-1",
      "REF-2",
      null,
    ]);
  });

  it("debit/credit layout: both columns filled is refused and names the row", () => {
    const error = refusal(() =>
      parseStatementCsv(
        [
          "Tgl;Ket;Debit;Kredit;Ref",
          "05/11/2026;Ok;0,00;10.000,00;",
          "06/11/2026;Aneh;5.000,00;10.000,00;",
        ].join("\n"),
        debitCredit,
      ),
    );
    expect(error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(error.message).toContain("Baris 3");
  });

  it("debit/credit layout: both columns empty is refused", () => {
    const error = refusal(() =>
      parseStatementCsv(
        "Tgl;Ket;Debit;Kredit;Ref\n05/11/2026;Kosong;;;",
        debitCredit,
      ),
    );
    expect(error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(error.message).toContain("Baris 2");
  });

  it("a fraction such as 1.234,50 is refused, never rounded, and the message names the row", () => {
    const error = refusal(() =>
      parseStatementCsv(
        [
          HEADER,
          '05/11/2026,Ok,"1.000,00"',
          '06/11/2026,Pecahan,"1.234,50"',
        ].join("\n"),
        signed,
      ),
    );
    expect(error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(error.message).toContain("Baris 3");
  });

  it("an unreadable date is refused with the row", () => {
    const error = refusal(() =>
      parseStatementCsv(`${HEADER}\n2026-11-05,Salah format,"1.000,00"`, signed),
    );
    expect(error.code).toBe("STATEMENT_VALUE_INVALID");
    expect(error.message).toContain("Baris 2");
  });

  it("an unterminated quote refuses the whole file", () => {
    const error = refusal(() =>
      parseStatementCsv(
        `${HEADER}\n05/11/2026,"Setoran tanpa tutup,"1.000,00"\n06/11/2026,Lain,"2.000,00"`,
        signed,
      ),
    );
    expect(error.code).toBe("STATEMENT_VALUE_INVALID");
  });

  it("a zero amount, an empty description and a file without rows are refused", () => {
    for (const csv of [
      `${HEADER}\n05/11/2026,Nol,"0,00"`,
      `${HEADER}\n05/11/2026,,"1.000,00"`,
      HEADER,
    ])
      expect(refusal(() => parseStatementCsv(csv, signed)).code).toBe(
        "STATEMENT_VALUE_INVALID",
      );
  });

  it("identical rows in one file are kept apart, and a re-parse yields the same keys", () => {
    const csv = [
      HEADER,
      '10/11/2026,Biaya admin,"-15.000,00"',
      '10/11/2026,Biaya admin,"-15.000,00"',
      '10/11/2026,Biaya admin,"-15.000,00"',
    ].join("\n");
    const first = parseStatementCsv(csv, signed);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((line) => line.dedupeKey)).size).toBe(3);
    const again = parseStatementCsv(csv, signed);
    expect(again.map((line) => line.dedupeKey)).toEqual(
      first.map((line) => line.dedupeKey),
    );
  });

  it("the same row in another file keeps the same key (re-upload adds nothing)", () => {
    const row = '10/11/2026,Biaya admin,"-15.000,00"';
    const [alone] = parseStatementCsv(`${HEADER}\n${row}`, signed);
    const later = parseStatementCsv(
      `${HEADER}\n11/11/2026,Lain,"-1.000,00"\n${row}\n`,
      signed,
    )[1]!;
    expect(later.dedupeKey).toBe(alone!.dedupeKey);
  });

  it("header row is skipped when hasHeader is true and read as data when false", () => {
    const body = '05/11/2026,Setoran,"1.000,00"';
    const withHeader = parseStatementCsv(`${HEADER}\n${body}`, signed);
    expect(withHeader).toHaveLength(1);
    expect(withHeader[0]!.rowNumber).toBe(2);

    const noHeader = parseStatementCsv(body, { ...signed, hasHeader: false });
    expect(noHeader).toHaveLength(1);
    expect(noHeader[0]!.rowNumber).toBe(1);

    // A header read as data is an unreadable date: refused, not skipped.
    expect(
      refusal(() =>
        parseStatementCsv(`${HEADER}\n${body}`, { ...signed, hasHeader: false }),
      ).message,
    ).toContain("Baris 1");
  });

  it("quoted descriptions keep commas and doubled quotes, and blank lines are ignored", () => {
    const lines = parseStatementCsv(
      `${HEADER}\r\n05/11/2026,"Setoran, ""Cabang A""","1.000,00"\r\n\r\n`,
      signed,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.description).toBe('Setoran, "Cabang A"');
  });
});
