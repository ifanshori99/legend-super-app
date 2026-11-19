// legend 1118 D1: one account must not serve a cash role (cash_on_hand,
// petty_cash, bank) and another role. Pure contract tests of
// `accountMappingIssues`, no database. Written from the brief
// (docs/briefs/1118-fix-kas-ronde7-mapping.md, decision 1), not the code.
//
// Assumptions:
// - The issue string starts with the stable code `CASH_ACCOUNT_SHARED:` and
//   names both roles (checked with `toContain`, so wording after the code is free).
// - Clearing roles (gateway_clearing, edc_clearing, cash_in_clearing) are left
//   out on purpose: the brief lets the engineer decide; not asserted either way.
// - Pairs of non-cash roles on one account stay valid.
import { describe, expect, it } from "vitest";
import {
  accountIdSchema,
  accountMappingIssues,
  accountMappingSchema,
  accountSchema,
  legalEntityIdSchema,
  standardFnbChartTemplate,
  type Account,
  type AccountType,
  type PostingAccountRole,
} from "@starter/shared/accounting";

const entity = legalEntityIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
const tenantId = "22222222-2222-4222-8222-222222222222";
const idOf = (n: number) =>
  accountIdSchema.parse(
    `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  );

const account = (n: number, type: AccountType, group: string): Account =>
  accountSchema.parse({
    id: idOf(n),
    tenantId,
    legalEntityId: entity,
    code: String(1000 + n),
    name: `Akun ${n}`,
    type,
    reportGroup: group,
    parentId: null,
    isActive: true,
  });

// Two asset leaves, two liability leaves.
const chart = [
  account(1, "asset", "current_asset"),
  account(2, "asset", "current_asset"),
  account(3, "liability", "current_liability"),
  account(4, "liability", "current_liability"),
  account(5, "asset", "current_asset"),
];
const A1 = idOf(1);
const A2 = idOf(2);
const A5 = idOf(5);
const L3 = idOf(3);

const mapAll = (pairs: [PostingAccountRole, ReturnType<typeof idOf>][]) =>
  pairs.map(([role, accountId]) =>
    accountMappingSchema.parse({
      tenantId,
      legalEntityId: entity,
      role,
      accountId,
    }),
  );
const issues = (pairs: [PostingAccountRole, ReturnType<typeof idOf>][]) =>
  accountMappingIssues(mapAll(pairs), chart);

function expectShared(
  found: string[],
  roleA: PostingAccountRole,
  roleB: PostingAccountRole,
) {
  const hit = found.filter((issue) => issue.startsWith("CASH_ACCOUNT_SHARED:"));
  expect(hit, JSON.stringify(found)).not.toHaveLength(0);
  expect(hit.some((i) => i.includes(roleA) && i.includes(roleB))).toBe(true);
}

describe("1118 CASH_ACCOUNT_SHARED (accountMappingIssues)", () => {
  it.each([
    ["petty_cash", "employee_receivable"],
    ["employee_receivable", "petty_cash"],
    ["bank", "petty_cash"],
    ["cash_on_hand", "bank"],
    ["cash_on_hand", "petty_cash"],
    ["cash_on_hand", "employee_receivable"],
    ["bank", "accounts_receivable"],
    ["petty_cash", "inventory"],
  ] as [PostingAccountRole, PostingAccountRole][])(
    "[1118-shared-%s-%s] one asset account for both roles is refused with a CASH_ACCOUNT_SHARED issue naming both",
    (roleA, roleB) => {
      expectShared(
        issues([
          [roleA, A1],
          [roleB, A1],
        ]),
        roleA,
        roleB,
      );
    },
  );

  it("[1118-shared-cash-with-three-roles] a cash role shared with two other roles is refused", () => {
    const found = issues([
      ["petty_cash", A1],
      ["employee_receivable", A1],
      ["accounts_receivable", A1],
    ]);
    expectShared(found, "petty_cash", "employee_receivable");
  });

  it("[1118-distinct-cash-roles-ok] cash roles on their own accounts are valid", () => {
    expect(
      issues([
        ["cash_on_hand", A1],
        ["petty_cash", A2],
        ["employee_receivable", A5],
      ]).filter((i) => i.startsWith("CASH_ACCOUNT_SHARED")),
    ).toEqual([]);
    expect(
      issues([
        ["petty_cash", A1],
        ["employee_receivable", A2],
      ]),
    ).toEqual([]);
  });

  it.each([
    ["accounts_receivable", "employee_receivable"],
    ["inventory", "ppn_input"],
  ] as [PostingAccountRole, PostingAccountRole][])(
    "[1118-non-cash-shared-ok-%s-%s] two non-cash asset roles on one account stay valid",
    (roleA, roleB) => {
      expect(
        issues([
          [roleA, A1],
          [roleB, A1],
        ]),
      ).toEqual([]);
    },
  );

  it("[1118-non-cash-liability-shared-ok] two liability roles on one account stay valid", () => {
    expect(
      issues([
        ["tax_payable_ppn", L3],
        ["tax_payable_other", L3],
      ]),
    ).toEqual([]);
  });

  it("[1118-standard-chart-valid] the standard F&B chart template and its role mapping have no issue", () => {
    const byCode = new Map<string, ReturnType<typeof idOf>>();
    standardFnbChartTemplate.forEach((row, index) =>
      byCode.set(row.code, idOf(100 + index)),
    );
    const chartAccounts = standardFnbChartTemplate.map((row) =>
      accountSchema.parse({
        id: byCode.get(row.code),
        tenantId,
        legalEntityId: entity,
        code: row.code,
        name: row.name,
        type: row.type,
        reportGroup: row.reportGroup,
        parentId: row.parentCode ? (byCode.get(row.parentCode) ?? null) : null,
        isActive: true,
      }),
    );
    const mappings = standardFnbChartTemplate.flatMap((row) =>
      row.roles.map((role) =>
        accountMappingSchema.parse({
          tenantId,
          legalEntityId: entity,
          role,
          accountId: byCode.get(row.code),
        }),
      ),
    );
    expect(accountMappingIssues(mappings, chartAccounts)).toEqual([]);
  });
});
