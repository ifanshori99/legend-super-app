// X2 (legend-wasr7.11): the EDC settlement CSV reader. Fail closed: a line it
// cannot read refuses the whole file; a void line is never a sale.
import { describe, expect, it } from "vitest";
import {
  EdcSettlementCsvError,
  parseEdcSettlementCsv,
  parseRupiah,
} from "../services/edc-settlement-csv-parse.ts";

describe("EDC settlement CSV reader (X2)", () => {
  it("reads rupiah as the banks print it, whole rupiah only", () => {
    expect(parseRupiah("55000")).toBe(55_000);
    expect(parseRupiah("55.000")).toBe(55_000);
    expect(parseRupiah("1,250,000")).toBe(1_250_000);
    expect(parseRupiah("Rp 1.250.000,00")).toBe(1_250_000);
    expect(parseRupiah("1,250,000.00")).toBe(1_250_000);
    expect(parseRupiah("55000.00")).toBe(55_000);
    expect(parseRupiah("Rp 55.000,-")).toBe(55_000);
    expect(parseRupiah("55.000.-")).toBe(55_000);
    expect(parseRupiah("55000.50")).toBeNull();
    expect(parseRupiah("1.250.000,50")).toBeNull();
    expect(parseRupiah("-55000")).toBeNull();
    expect(parseRupiah("5.5E+04")).toBeNull();
    expect(parseRupiah("0")).toBeNull();
    expect(parseRupiah("")).toBeNull();
  });

  it("skips the bank preamble and footer, normalises RRN and terminal, never reads the card column", () => {
    const csv = [
      "LAPORAN SETTLEMENT EDC BCA",
      "Periode;27-11-2026",
      "No;Tanggal;TID EDC;No Kartu;Approval Code;RRN;Nilai;Batch",
      '1;27-11-2026;tid-sa;4111********1111;A1B2C3;"1234-5678-9012";55.000;000123',
      "2;27-11-2026;TID-SA;5500********0004;;X1 RRN 77;Rp 110.000,00;000123",
      ";;;;;;165.000;",
    ].join("\r\n");
    const lines = parseEdcSettlementCsv("bca", csv);
    expect(lines).toEqual([
      {
        lineNo: 4,
        kind: "sale",
        terminalCode: "TID-SA",
        rrn: "123456789012",
        amountIdr: 55_000,
        approvalCode: "A1B2C3",
        batchNo: "000123",
      },
      {
        lineNo: 5,
        kind: "sale",
        terminalCode: "TID-SA",
        rrn: "X1RRN77",
        amountIdr: 110_000,
        approvalCode: null,
        batchNo: "000123",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("4111");
  });

  it("uses the bank's own column names (Mandiri trx amt, BJB id terminal)", () => {
    expect(
      parseEdcSettlementCsv(
        "mandiri",
        "Terminal ID,RRN Number,Trx Amt,Auth ID\nM001,000111222333,25000,ZX9\n",
      )[0],
    ).toMatchObject({ terminalCode: "M001", amountIdr: 25_000 });
    expect(
      parseEdcSettlementCsv(
        "bjb",
        "ID Terminal,No RRN,Nominal Trx\nJ01,9988,15000\n",
      )[0],
    ).toMatchObject({ terminalCode: "J01", rrn: "9988", amountIdr: 15_000 });
    // Mandiri's amount column name is not BJB's.
    expect(() =>
      parseEdcSettlementCsv("bjb", "Terminal ID,RRN,Trx Amt\nJ01,9988,15000\n"),
    ).toThrow(EdcSettlementCsvError);
  });

  it("a line it cannot read refuses the whole file and names the line", () => {
    const csv =
      "TID,RRN,Amount\nT1,111,55000\nT1,222,55000.50\nT1,3.3E+11,1000\n";
    let error: unknown;
    try {
      parseEdcSettlementCsv("bni", csv);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EdcSettlementCsvError);
    expect((error as EdcSettlementCsvError).lines).toEqual([3, 4]);
  });

  it("a void, refund or reversal line is never a sale", () => {
    const lines = parseEdcSettlementCsv(
      "bca",
      "TID,RRN,Amount,Type\nT1,111,55000,SALE\nT1,111,55000,VOID\nT1,222,1000,Refund\n",
    );
    expect(lines.map((line) => line.kind)).toEqual(["sale", "void", "void"]);
  });

  it("a file without the TID, RRN and amount columns is refused", () => {
    expect(() =>
      parseEdcSettlementCsv("bca", "Nama,Jumlah\nKopi,55000\n"),
    ).toThrow(/TID, RRN dan nominal/);
  });

  it("X2 review P3 6: a line with another cell count than the header refuses the file", () => {
    let error: unknown;
    try {
      parseEdcSettlementCsv(
        "bca",
        "TID,RRN,Amount\nT1,111,55000\nT1,222,55000,EXTRA\nT1,333\n",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EdcSettlementCsvError);
    expect((error as EdcSettlementCsvError).lines).toEqual([3, 4]);
  });
});
