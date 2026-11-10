// Payroll journal with the employee PPh 21 receivable (brief
// docs/briefs/sub-pph21-receivable.md, implementer B; founder decision B8).
// Pure rule tests, no database: the `payroll.locked` rule (fed from run totals
// by `payrollJournalAmounts`, legend-s8a3), the new `employee_receivable` role
// and the standard chart account 1204.

import { describe, expect, it } from "vitest";
import {
  POSTING_ACCOUNT_ROLES,
  accountIdSchema,
  accountMapFor,
  accountMappingSchema,
  buildJournalLinesFromRule,
  defaultPostingRules,
  legalEntityIdSchema,
  payrollJournalAmounts,
  resolvePostingRule,
  standardFnbChartTemplate,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import { payrollRunTotalsSchema } from "@starter/shared/hris/payroll";

const entity = legalEntityIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
const tenantId = "22222222-2222-4222-8222-222222222222";

const accountIds = new Map(
  standardFnbChartTemplate.map((row, index) => [
    row.code,
    accountIdSchema.parse(
      `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
    ),
  ]),
);
const mappings = standardFnbChartTemplate.flatMap((row) =>
  row.roles.map((role) =>
    accountMappingSchema.parse({
      tenantId,
      legalEntityId: entity,
      role,
      accountId: accountIds.get(row.code),
    }),
  ),
);
const accountMap = accountMapFor(mappings, entity);
const rule = resolvePostingRule(defaultPostingRules, {
  eventName: "payroll.locked",
});

/** Run totals of one payroll with the new receivable and the collection. */
function totalsOf(parts: {
  gross: number;
  bpjsEmp: number;
  bpjsCo: number;
  withheld: number;
  receivable: number;
  collected: number;
}) {
  const deductions = parts.bpjsEmp + parts.withheld + parts.collected;
  const net = parts.gross - deductions;
  return payrollRunTotalsSchema.parse({
    employeeCount: 1,
    grossIdr: parts.gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: parts.bpjsEmp,
    bpjsCompanyIdr: parts.bpjsCo,
    pph21Idr: parts.withheld + parts.receivable,
    pph21WithheldIdr: parts.withheld,
    pph21EmployerBorneIdr: 0,
    pph21RefundIdr: 0,
    pph21EmployerRefundIdr: 0,
    pph21EmployerAllowanceRefundIdr: 0,
    loanRepaymentIdr: 0,
    pph21ReceivableIdr: parts.receivable,
    pph21ReceivableCollectedIdr: parts.collected,
    otherDeductionsIdr: 0,
    serviceChargeIdr: 0,
    reimbursementIdr: 0,
    bankTransferIdr: net,
    cashIdr: 0,
  });
}

/** Sum of debit and credit per account code for the built lines. */
function post(amounts: Record<string, number>) {
  const lines = buildJournalLinesFromRule(rule, amounts, accountMap, {
    outletId: null,
  });
  const byCode = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const code = [...accountIds].find(([, id]) => id === line.accountId)![0];
    const row = byCode.get(code) ?? { debit: 0, credit: 0 };
    row.debit += line.debitIdr;
    row.credit += line.creditIdr;
    byCode.set(code, row);
  }
  return {
    lines,
    byCode,
    debit: lines.reduce((sum, line) => sum + line.debitIdr, 0),
    credit: lines.reduce((sum, line) => sum + line.creditIdr, 0),
  };
}

const postTotals = (parts: Parameters<typeof totalsOf>[0]) =>
  post(payrollJournalAmounts(totalsOf(parts)));

// gross 10.000.000, employer BPJS 400.000, employee BPJS 300.000 (total
// 700.000), withheld W 800.000, new receivable 500.000, collected 200.000:
// net = gross - employee BPJS - W - collected = 8.700.000; deposit T = W + new
// receivable = 1.300.000.
const base = {
  gross: 10_000_000,
  bpjsEmp: 300_000,
  bpjsCo: 400_000,
  withheld: 800_000,
  receivable: 500_000,
  collected: 200_000,
};

describe("employee receivable role and account (founder B8)", () => {
  it("employee_receivable is an asset role", () => {
    expect(POSTING_ACCOUNT_ROLES.employee_receivable).toBe("asset");
  });

  it("standard chart has 1204 Piutang Karyawan under 1200, mapped to the role", () => {
    const row = standardFnbChartTemplate.find((r) => r.code === "1204");
    expect(row).toMatchObject({
      name: "Piutang Karyawan",
      type: "asset",
      parentCode: "1200",
      roles: ["employee_receivable"],
    });
  });

  it("every posting role is mapped by exactly one standard chart account", () => {
    const counts = new Map<string, number>();
    for (const row of standardFnbChartTemplate)
      for (const role of row.roles)
        counts.set(role, (counts.get(role) ?? 0) + 1);
    for (const role of Object.keys(
      POSTING_ACCOUNT_ROLES,
    ) as PostingAccountRole[])
      if (role !== "service_charge")
        expect([role, counts.get(role)]).toEqual([role, 1]);
  });
});

describe("payroll.locked with PPh 21 receivable", () => {
  it("balances with a new receivable and a collection above zero", () => {
    const { byCode, debit, credit } = postTotals(base);
    expect(debit).toBe(credit);
    expect(byCode.get("1204")).toEqual({ debit: 500_000, credit: 200_000 });
  });

  it("balances with only a new receivable", () => {
    const { byCode, debit, credit } = postTotals({ ...base, collected: 0 });
    expect(debit).toBe(credit);
    expect(byCode.get("1204")).toEqual({ debit: 500_000, credit: 0 });
  });

  it("balances with only a collection", () => {
    const { byCode, debit, credit } = postTotals({ ...base, receivable: 0 });
    expect(debit).toBe(credit);
    expect(byCode.get("1204")).toEqual({ debit: 0, credit: 200_000 });
  });

  it("zero receivable and collection post no employee receivable line", () => {
    const { byCode, debit, credit } = postTotals({
      gross: 42_000_000,
      bpjsEmp: 840_000,
      bpjsCo: 2_184_000,
      withheld: 630_000,
      receivable: 0,
      collected: 0,
    });
    expect(debit).toBe(credit);
    expect(byCode.has("1204")).toBe(false);
  });

  it("fails closed when the receivable amount keys are missing", () => {
    const { pph21ReceivableIdr, pph21ReceivableCollectedIdr, ...legacy } =
      payrollJournalAmounts(totalsOf(base));
    void pph21ReceivableIdr;
    void pph21ReceivableCollectedIdr;
    expect(() => post(legacy)).toThrow(/pph21ReceivableIdr/);
  });
});
