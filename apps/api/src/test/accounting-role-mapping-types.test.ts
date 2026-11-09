// Allowed account types per posting role (legend-k8sz, legend-75kr; brief
// docs/briefs/sub-payroll-journal-followups.md D2/D3). Pure contract tests, no
// database: `allowedAccountTypesForRole` and `accountMappingIssues`.
//
// - `service_charge` may be mapped to a liability or a revenue account (PRD F11
//   lets the tenant choose); asset, expense and equity are rejected.
// - `payroll_custom_deduction` may be mapped to an expense (default 6101) or a
//   liability account (e.g. "Utang Iuran Koperasi"); revenue, asset and equity
//   are rejected.
// - A role with a fixed type keeps its single-type rule and message.
// - Assumption: the issue message for a list is exactly
//   `Role <role>: needs a <type> or <type> account`, in the order of the list.

import { describe, expect, it } from "vitest";
import {
  POSTING_ACCOUNT_ROLES,
  POSTING_ROLE_ALLOWED_TYPES,
  accountIdSchema,
  accountMappingIssues,
  accountMappingSchema,
  accountSchema,
  allowedAccountTypesForRole,
  chartOfAccountsIssues,
  legalEntityIdSchema,
  standardFnbChartTemplate,
  type Account,
  type AccountType,
  type PostingAccountRole,
  type ReportGroup,
} from "@starter/shared/accounting";

const entity = legalEntityIdSchema.parse(
  "11111111-1111-4111-8111-111111111111",
);
const otherEntity = legalEntityIdSchema.parse(
  "11111111-1111-4111-8111-222222222222",
);
const tenantId = "22222222-2222-4222-8222-222222222222";

const idOf = (n: number) =>
  accountIdSchema.parse(
    `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  );

// One postable leaf account per type.
const typed: [AccountType, ReportGroup][] = [
  ["asset", "current_asset"],
  ["liability", "current_liability"],
  ["equity", "equity"],
  ["revenue", "revenue"],
  ["expense", "operating_expense"],
];
const leafOf = new Map<AccountType, Account>(
  typed.map(([type, reportGroup], index) => [
    type,
    accountSchema.parse({
      id: idOf(index + 1),
      tenantId,
      legalEntityId: entity,
      code: String(1000 + index),
      name: `Akun ${type}`,
      type,
      reportGroup,
      parentId: null,
      isActive: true,
    }),
  ]),
);
const chart = [...leafOf.values()];

const mapping = (role: PostingAccountRole, type: AccountType) =>
  accountMappingSchema.parse({
    tenantId,
    legalEntityId: entity,
    role,
    accountId: leafOf.get(type)!.id,
  });
const issuesFor = (role: PostingAccountRole, type: AccountType) =>
  accountMappingIssues([mapping(role, type)], chart);

describe("allowedAccountTypesForRole", () => {
  it("a fixed-type role allows exactly its type", () => {
    expect(allowedAccountTypesForRole("salary_expense")).toEqual(["expense"]);
    expect(allowedAccountTypesForRole("salaries_payable")).toEqual([
      "liability",
    ]);
    expect(allowedAccountTypesForRole("petty_cash")).toEqual(["asset"]);
  });

  it("service_charge allows liability or revenue", () => {
    expect(allowedAccountTypesForRole("service_charge")).toEqual([
      "liability",
      "revenue",
    ]);
  });

  it("payroll_custom_deduction allows expense or liability", () => {
    expect(allowedAccountTypesForRole("payroll_custom_deduction")).toEqual([
      "expense",
      "liability",
    ]);
  });

  it("payroll_custom_deduction is a role without a fixed type", () => {
    expect(POSTING_ACCOUNT_ROLES.payroll_custom_deduction).toBeNull();
    expect(POSTING_ROLE_ALLOWED_TYPES.payroll_custom_deduction).toEqual([
      "expense",
      "liability",
    ]);
  });

  it("every role is either fixed-type or has a non-empty allowed list", () => {
    for (const role of Object.keys(
      POSTING_ACCOUNT_ROLES,
    ) as PostingAccountRole[]) {
      const allowed = allowedAccountTypesForRole(role);
      if (POSTING_ACCOUNT_ROLES[role] !== null)
        expect(allowed).toEqual([POSTING_ACCOUNT_ROLES[role]]);
      else expect(allowed === null || allowed.length > 0).toBe(true);
    }
  });
});

describe("service_charge mapping type (legend-k8sz)", () => {
  it.each(["liability", "revenue"] as const)("accepts a %s account", (type) => {
    expect(issuesFor("service_charge", type)).toEqual([]);
  });

  it.each(["asset", "expense", "equity"] as const)(
    "rejects a %s account",
    (type) => {
      expect(issuesFor("service_charge", type)).toEqual([
        "Role service_charge: needs a liability or revenue account",
      ]);
    },
  );
});

describe("payroll_custom_deduction mapping type (legend-75kr)", () => {
  it.each(["expense", "liability"] as const)("accepts a %s account", (type) => {
    expect(issuesFor("payroll_custom_deduction", type)).toEqual([]);
  });

  it.each(["revenue", "asset", "equity"] as const)(
    "rejects a %s account",
    (type) => {
      expect(issuesFor("payroll_custom_deduction", type)).toEqual([
        "Role payroll_custom_deduction: needs a expense or liability account",
      ]);
    },
  );
});

describe("fixed-type roles keep their rule and message", () => {
  it("salary_expense on a liability account is rejected", () => {
    expect(issuesFor("salary_expense", "liability")).toEqual([
      "Role salary_expense: needs a expense account",
    ]);
  });

  it("salary_expense on an expense account is accepted", () => {
    expect(issuesFor("salary_expense", "expense")).toEqual([]);
  });
});

describe("other mapping checks still apply to list-typed roles", () => {
  it("an account of another legal entity is rejected", () => {
    const foreign = accountSchema.parse({
      ...leafOf.get("liability")!,
      id: idOf(90),
      legalEntityId: otherEntity,
      code: "2999",
    });
    expect(
      accountMappingIssues(
        [
          accountMappingSchema.parse({
            tenantId,
            legalEntityId: entity,
            role: "service_charge",
            accountId: foreign.id,
          }),
        ],
        [...chart, foreign],
      ),
    ).toEqual(["Role service_charge: account not in this legal entity"]);
  });

  it("a header account is rejected even with an allowed type", () => {
    const liability = leafOf.get("liability")!;
    const child = accountSchema.parse({
      ...liability,
      id: idOf(91),
      code: "1101",
      parentId: liability.id,
    });
    expect(
      accountMappingIssues(
        [mapping("payroll_custom_deduction", "liability")],
        [...chart, child],
      ),
    ).toEqual([
      "Role payroll_custom_deduction: header account is not postable",
    ]);
  });

  it("mapping the same role twice is reported", () => {
    expect(
      accountMappingIssues(
        [
          mapping("service_charge", "liability"),
          mapping("service_charge", "revenue"),
        ],
        chart,
      ),
    ).toEqual(["Role service_charge mapped twice"]);
  });
});

describe("the standard chart satisfies the type rules", () => {
  const ids = new Map(
    standardFnbChartTemplate.map((row, index) => [row.code, idOf(index + 100)]),
  );
  const accounts = standardFnbChartTemplate.map((row) =>
    accountSchema.parse({
      id: ids.get(row.code),
      tenantId,
      legalEntityId: entity,
      code: row.code,
      name: row.name,
      type: row.type,
      reportGroup: row.reportGroup,
      parentId: row.parentCode ? (ids.get(row.parentCode) ?? null) : null,
      isActive: true,
    }),
  );
  const mappings = standardFnbChartTemplate.flatMap((row) =>
    row.roles.map((role) =>
      accountMappingSchema.parse({
        tenantId,
        legalEntityId: entity,
        role,
        accountId: ids.get(row.code),
      }),
    ),
  );

  it("the chart and its default mappings have no issues", () => {
    expect(chartOfAccountsIssues(accounts)).toEqual([]);
    expect(accountMappingIssues(mappings, accounts)).toEqual([]);
  });

  it("6101 Beban Gaji carries salary_expense and payroll_custom_deduction", () => {
    const row = standardFnbChartTemplate.find((r) => r.code === "6101");
    expect(row?.roles).toEqual(["salary_expense", "payroll_custom_deduction"]);
  });

  it("a tenant may remap payroll_custom_deduction to a liability such as 2106", () => {
    const remapped = mappings.map((m) =>
      m.role === "payroll_custom_deduction"
        ? { ...m, accountId: ids.get("2106")! }
        : m,
    );
    expect(accountMappingIssues(remapped, accounts)).toEqual([]);
  });

  it("a tenant may remap service_charge to revenue 4102 but not to expense 6101", () => {
    const remap = (code: string) =>
      mappings.map((m) =>
        m.role === "service_charge" ? { ...m, accountId: ids.get(code)! } : m,
      );
    expect(accountMappingIssues(remap("4102"), accounts)).toEqual([]);
    expect(accountMappingIssues(remap("6101"), accounts)).toEqual([
      "Role service_charge: needs a liability or revenue account",
    ]);
  });
});
