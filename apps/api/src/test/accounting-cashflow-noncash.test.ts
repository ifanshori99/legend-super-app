import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountSchema,
  buildCashFlow,
  type Account,
  type EntryLedgerLine,
  type ReportGroup,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const legalEntityId = randomUUID();
const account = (
  code: string,
  name: string,
  type: Account["type"],
  reportGroup: ReportGroup,
) =>
  accountSchema.parse({
    id: randomUUID(),
    tenantId: cafeLegendPlatformFixtures.tenant.id,
    legalEntityId,
    code,
    name,
    type,
    reportGroup,
    parentId: null,
    isActive: true,
  });
const cash = account("1100", "Kas", "asset", "cash_and_equivalents");
const bank = account("1101", "Bank", "asset", "cash_and_equivalents");
const equipment = account("1500", "Peralatan", "asset", "non_current_asset");
const payable = account("2100", "Utang", "liability", "current_liability");
const revenue = account("4100", "Penjualan", "revenue", "revenue");
const receivable = account("1200", "Piutang", "asset", "current_asset");
const loan = account("2500", "Pinjaman", "liability", "non_current_liability");
const accounts = [cash, bank, equipment, payable, revenue, receivable, loan];
const input = { legalEntityId, from: "2025-02-01", to: "2025-02-28" };
const line = (
  account: Account,
  debitIdr: number,
  creditIdr: number,
  entryId = "entry",
): EntryLedgerLine => ({
  accountId: account.id,
  debitIdr,
  creditIdr,
  outletId: null,
  entryDate: "2025-02-10",
  entryId,
  sourceType: "manual",
});
const total = (
  statement: ReturnType<typeof buildCashFlow>,
  activity: "operating" | "investing" | "financing",
) =>
  statement.sections.find((section) => section.activity === activity)!.totalIdr;

describe("547b cash flow excludes noncash portions of compound entries", () => {
  it("reports only the Rp100,000 cash paid on a Rp1,000,000 asset financed by Rp900,000 payable", () => {
    const statement = buildCashFlow(
      accounts,
      [
        line(equipment, 1_000_000, 0),
        line(cash, 0, 100_000),
        line(payable, 0, 900_000),
      ],
      input,
    );

    expect(total(statement, "investing")).toBe(-100_000);
    expect(total(statement, "operating")).toBe(0);
    expect(total(statement, "financing")).toBe(0);
    expect(statement.netChangeIdr).toBe(-100_000);
    expect(statement.closingCashIdr).toBe(-100_000);
  });

  it("excludes an unpaid receivable from a partially collected sale", () => {
    const statement = buildCashFlow(
      accounts,
      [
        line(cash, 100_000, 0),
        line(receivable, 900_000, 0),
        line(revenue, 0, 1_000_000),
      ],
      input,
    );

    expect(
      statement.sections.find((section) => section.activity === "operating")!
        .rows,
    ).toEqual([{ label: "Penjualan", amountIdr: 100_000 }]);
    expect(statement.netChangeIdr).toBe(100_000);
  });

  it("preserves exact whole rupiah across fully cash-paid counterparts", () => {
    const statement = buildCashFlow(
      accounts,
      [line(equipment, 2, 0), line(receivable, 1, 0), line(cash, 0, 3)],
      input,
    );

    expect(total(statement, "investing")).toBe(-2);
    expect(total(statement, "operating")).toBe(-1);
    expect(statement.netChangeIdr).toBe(-3);
  });

  const expectAmbiguous = (lines: EntryLedgerLine[]) => {
    expect(() => buildCashFlow(accounts, lines, input)).toThrowError(
      expect.objectContaining({
        name: "AccountingError",
        code: "STATEMENT_VALUE_INVALID",
        status: 422,
      }),
    );
  };

  it("rejects ambiguous combined receipts and payments even when net cash is zero", () => {
    expectAmbiguous([
      line(cash, 100_000, 0),
      line(revenue, 0, 100_000),
      line(equipment, 100_000, 0),
      line(cash, 0, 100_000),
    ]);
  });

  it("rejects ambiguous combined receipts and payments with positive net cash", () => {
    expectAmbiguous([
      line(cash, 200_000, 0),
      line(revenue, 0, 200_000),
      line(equipment, 100_000, 0),
      line(cash, 0, 100_000),
    ]);
  });

  it("does not invent cash flows from a transfer combined with a financed asset", () => {
    expectAmbiguous([
      line(bank, 100_000, 0),
      line(cash, 0, 100_000),
      line(equipment, 100_000, 0),
      line(payable, 0, 100_000),
    ]);
  });

  it("does not split cash sales into financing when the entry includes a loan-financed asset", () => {
    expectAmbiguous([
      line(cash, 100_000, 0),
      line(revenue, 0, 100_000),
      line(equipment, 100_000, 0),
      line(loan, 0, 100_000),
    ]);
  });

  it("rejects ambiguous partial cash payments against multiple noncash counterparts", () => {
    expectAmbiguous([
      line(equipment, 2, 0),
      line(receivable, 1, 0),
      line(cash, 0, 2),
      line(payable, 0, 1),
    ]);
  });

  it("allows a transfer combined with an unambiguous cash sale", () => {
    const statement = buildCashFlow(
      accounts,
      [
        line(bank, 200_000, 0),
        line(cash, 0, 100_000),
        line(revenue, 0, 100_000),
      ],
      input,
    );

    expect(total(statement, "operating")).toBe(100_000);
    expect(total(statement, "investing")).toBe(0);
    expect(total(statement, "financing")).toBe(0);
    expect(statement.netChangeIdr).toBe(100_000);
  });

  it("ignores noncash entries and internal cash transfers", () => {
    const statement = buildCashFlow(
      accounts,
      [
        line(equipment, 1_000_000, 0, "noncash"),
        line(payable, 0, 1_000_000, "noncash"),
        line(bank, 100_000, 0, "transfer"),
        line(cash, 0, 100_000, "transfer"),
      ],
      input,
    );

    expect(statement.sections.flatMap((section) => section.rows)).toEqual([]);
    expect(statement.netChangeIdr).toBe(0);
  });
});
