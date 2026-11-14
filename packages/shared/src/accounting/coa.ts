// Chart of accounts per legal entity (PRD v1.7 §3.19 "Chart of Accounts [P0]
// — CoA standar F&B yang dapat disesuaikan, per badan usaha"; §6 F
// `chart_of_accounts`: legal_entity_id, code, name, type, parent_id,
// is_active).
//
// Rules:
// - An account belongs to exactly one legal entity; its parent is in the same
//   entity and has the same type; the tree has no cycles; codes are unique per
//   entity.
// - Header accounts (any account with children) are not postable; only active
//   leaf accounts take journal lines. No extra column: "header" is derived.
// - Contra accounts (accumulated depreciation, sales discount) keep their
//   parent type and simply carry the opposite balance, so statements net them.
// - `reportGroup` places an account on the statements (balance sheet section,
//   COGS vs operating expense, cash for the cash flow). It is a column the BE
//   adds next to the §6 columns (decision recorded in the bead report).
// - The standard F&B CoA below is a template (data). Provisioning copies it
//   per legal entity and tenants edit it freely; codes are not business rules.
// - Posting roles: automatic journals never name an account code. They name a
//   role ("cash_on_hand", "sales_revenue"), and each legal entity maps every
//   role to one of its own accounts (`account_mappings`, tenant data).

import { z } from "zod";
import { tenantIdSchema } from "../core/index.ts";
import { AccountingError } from "./errors.ts";
import { accountIdSchema, legalEntityIdSchema } from "./ids.ts";
import type { AccountId, LegalEntityId } from "./ids.ts";

export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export const accountTypeSchema = z.enum(ACCOUNT_TYPES);
export type AccountType = z.infer<typeof accountTypeSchema>;

/** Which statement section an account lands in, and the type it requires. */
export const REPORT_GROUPS = {
  cash_and_equivalents: "asset",
  current_asset: "asset",
  non_current_asset: "asset",
  current_liability: "liability",
  non_current_liability: "liability",
  equity: "equity",
  revenue: "revenue",
  other_income: "revenue",
  cogs: "expense",
  operating_expense: "expense",
  other_expense: "expense",
} as const satisfies Record<string, AccountType>;
export type ReportGroup = keyof typeof REPORT_GROUPS;
export const reportGroupSchema = z.enum(
  Object.keys(REPORT_GROUPS) as [ReportGroup, ...ReportGroup[]],
);

/** Assets and expenses grow with debits; the rest with credits. */
export function normalBalanceOf(type: AccountType): "debit" | "credit" {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

export const accountCodeSchema = z
  .string()
  .regex(
    /^[0-9]{1,10}(?:[.-][0-9]{1,10}){0,4}$/,
    "Account code is digits, optionally separated by '.' or '-'",
  )
  .max(20);

export const accountSchema = z
  .strictObject({
    id: accountIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    code: accountCodeSchema,
    name: z.string().trim().min(1).max(150),
    type: accountTypeSchema,
    reportGroup: reportGroupSchema,
    parentId: accountIdSchema.nullable(),
    isActive: z.boolean(),
  })
  .superRefine((account, ctx) => {
    if (REPORT_GROUPS[account.reportGroup] !== account.type)
      ctx.addIssue({
        code: "custom",
        path: ["reportGroup"],
        message: `Report group ${account.reportGroup} needs type ${REPORT_GROUPS[account.reportGroup]}`,
      });
    if (account.parentId === account.id)
      ctx.addIssue({
        code: "custom",
        path: ["parentId"],
        message: "An account cannot be its own parent",
      });
  });
export type Account = z.infer<typeof accountSchema>;

/** Structural problems of one entity's chart, as messages (empty = valid). */
export function chartOfAccountsIssues(accounts: readonly Account[]): string[] {
  const issues: string[] = [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const codes = new Set<string>();
  for (const account of accounts) {
    const codeKey = `${account.legalEntityId}|${account.code}`;
    if (codes.has(codeKey))
      issues.push(`Duplicate code ${account.code} in one legal entity`);
    codes.add(codeKey);
    if (account.parentId === null) continue;
    const parent = byId.get(account.parentId);
    if (!parent) {
      issues.push(`Account ${account.code}: parent not in chart`);
      continue;
    }
    if (parent.legalEntityId !== account.legalEntityId)
      issues.push(`Account ${account.code}: parent in another legal entity`);
    if (parent.type !== account.type)
      issues.push(`Account ${account.code}: parent has another type`);
  }
  for (const account of accounts) {
    const seen = new Set<string>();
    let cursor: Account | undefined = account;
    while (cursor && cursor.parentId !== null) {
      if (seen.has(cursor.id)) {
        issues.push(`Account ${account.code}: parent cycle`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
  }
  return issues;
}

export const chartOfAccountsSchema = z
  .array(accountSchema)
  .superRefine((accounts, ctx) => {
    for (const message of chartOfAccountsIssues(accounts))
      ctx.addIssue({ code: "custom", message });
  });

/** Accounts that have at least one child (headers). */
export function headerAccountIds(
  accounts: readonly Account[],
): ReadonlySet<AccountId> {
  return new Set(
    accounts.flatMap((account) =>
      account.parentId === null ? [] : [account.parentId],
    ),
  );
}

/**
 * The check every journal line passes before posting: the account exists in
 * the entry's legal entity, is active and is a leaf (ACC-01 support).
 */
export function assertAccountPostable(
  accountId: AccountId,
  legalEntityId: LegalEntityId,
  accounts: readonly Account[],
): Account {
  const account = accounts.find((row) => row.id === accountId);
  if (!account || account.legalEntityId !== legalEntityId)
    throw new AccountingError("ACCOUNT_ENTITY_MISMATCH");
  if (!account.isActive) throw new AccountingError("ACCOUNT_INACTIVE");
  if (headerAccountIds(accounts).has(account.id))
    throw new AccountingError("ACCOUNT_NOT_POSTABLE");
  return account;
}

// ---- Posting roles and account mappings ----------------------------------

/** Roles automatic journals post to; each legal entity maps every role to an account. */
export const POSTING_ACCOUNT_ROLES = {
  cash_on_hand: "asset",
  petty_cash: "asset",
  bank: "asset",
  gateway_clearing: "asset",
  edc_clearing: "asset",
  accounts_receivable: "asset",
  /** Employee PPh 21 shortfall owed to the company (founder B8). */
  employee_receivable: "asset",
  inventory: "asset",
  inventory_semi_finished: "asset",
  ppn_input: "asset",
  fixed_assets: "asset",
  accumulated_depreciation: "asset",
  accounts_payable: "liability",
  grni: "liability",
  salaries_payable: "liability",
  bpjs_payable: "liability",
  loyalty_liability: "liability",
  /** Customer advances: DP held, late or double gateway payments, refunds awaiting payout. */
  customer_deposit: "liability",
  /**
   * Cash put into a drawer outside a sale (kas masuk, legend-89pn): held as a
   * liability until finance classifies it, never as income.
   */
  cash_in_clearing: "liability",
  tax_payable_pbjt: "liability",
  /** PPN output and other taxes of a sale, split from PBJT per tax type (legend-xa9bc). */
  tax_payable_ppn: "liability",
  tax_payable_other: "liability",
  pph21_payable: "liability",
  pph23_payable: "liability",
  /** PPh withheld on profit-share / dividend payouts (§3.37 potongan pajak). */
  dividend_tax_payable: "liability",
  retained_earnings: "equity",
  opening_balance_equity: "equity",
  sales_revenue: "revenue",
  sales_discount: "revenue",
  loyalty_breakage_revenue: "revenue",
  /** legend-msqvi: deferred revenue for loyalty points (PSAK 72), contra of the points liability. */
  loyalty_points_deferral: "revenue",
  rounding: "revenue",
  /** Forfeited DP (reservation cancelled late or no-show) recognised as other income. */
  deposit_forfeit_income: "revenue",
  asset_disposal_result: "revenue",
  revaluation_surplus: "equity",
  asset_revaluation_loss: "expense",
  cogs: "expense",
  waste_expense: "expense",
  inventory_adjustment: "expense",
  /** Supplier invoice price vs purchase order price (GRNI is cleared at the order price, legend-29vw). */
  purchase_price_variance: "expense",
  /**
   * Moving-average cost vs returned stock value on a purchase return.
   * The tenant chooses its posting account; the standard chart uses expense
   * 5106, while a custom mapping may use another type (legend-mksir).
   */
  inventory_price_variance: null,
  /** Direct cash purchases paid from petty cash (PRD §3.18 pembelian sederhana). */
  petty_purchase_expense: "expense",
  salary_expense: "expense",
  /** Employee reimbursements (PRD §3 reimbursement via payroll or kas). */
  reimbursement_expense: "expense",
  /**
   * Employer-borne PPh 21 (net scheme). Not deductible (UU PPh Pasal 9(1)h),
   * so it needs a fiscal correction (koreksi fiskal).
   */
  pph21_borne_expense: "expense",
  bpjs_expense: "expense",
  gateway_fee_expense: "expense",
  /** Bank fee of a payroll transfer, borne by the company (Q15, bead legend-658). */
  bank_charges: "expense",
  depreciation_expense: "expense",
  service_expense: "expense",
  /** Cash taken out of a drawer with a free-text reason (kas keluar, legend-89pn). */
  cash_out_expense: "expense",
  cash_over_short: "expense",
  /**
   * Custom payroll deductions (koperasi dues etc.). Default is salary_expense's
   * account (today's behaviour); a tenant may remap it to a liability such as
   * "Utang Iuran Koperasi". Allowed types: see POSTING_ROLE_ALLOWED_TYPES.
   */
  payroll_custom_deduction: null,
  // Service charge may be a staff liability or revenue; the tenant decides by
  // mapping it (PRD F11 service charge is configuration). Allowed types: see
  // POSTING_ROLE_ALLOWED_TYPES.
  service_charge: null,
} as const satisfies Record<string, AccountType | null>;
export type PostingAccountRole = keyof typeof POSTING_ACCOUNT_ROLES;

/**
 * Roles without a single fixed type (value `null` above) that still restrict
 * the mapped account to a list of types. A `null` role missing here accepts
 * any type.
 */
export const POSTING_ROLE_ALLOWED_TYPES: Partial<
  Record<PostingAccountRole, readonly AccountType[]>
> = {
  service_charge: ["liability", "revenue"],
  payroll_custom_deduction: ["expense", "liability"],
};

/** Account types a role may be mapped to; null = any type. */
export function allowedAccountTypesForRole(
  role: PostingAccountRole,
): readonly AccountType[] | null {
  const fixed: AccountType | null = POSTING_ACCOUNT_ROLES[role];
  if (fixed !== null) return [fixed];
  return POSTING_ROLE_ALLOWED_TYPES[role] ?? null;
}

export const postingAccountRoleSchema = z.enum(
  Object.keys(POSTING_ACCOUNT_ROLES) as [
    PostingAccountRole,
    ...PostingAccountRole[],
  ],
);

export const accountMappingSchema = z.strictObject({
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  role: postingAccountRoleSchema,
  accountId: accountIdSchema,
});
export type AccountMapping = z.infer<typeof accountMappingSchema>;

/** Problems of one entity's role mapping against its chart (empty = valid). */
export function accountMappingIssues(
  mappings: readonly AccountMapping[],
  accounts: readonly Account[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const headers = headerAccountIds(accounts);
  for (const mapping of mappings) {
    const key = `${mapping.legalEntityId}|${mapping.role}`;
    if (seen.has(key)) issues.push(`Role ${mapping.role} mapped twice`);
    seen.add(key);
    const account = accounts.find((row) => row.id === mapping.accountId);
    if (!account || account.legalEntityId !== mapping.legalEntityId) {
      issues.push(`Role ${mapping.role}: account not in this legal entity`);
      continue;
    }
    const allowed = allowedAccountTypesForRole(mapping.role);
    if (allowed !== null && !allowed.includes(account.type))
      issues.push(
        `Role ${mapping.role}: needs a ${allowed.join(" or ")} account`,
      );
    if (headers.has(account.id))
      issues.push(`Role ${mapping.role}: header account is not postable`);
  }
  return issues;
}

/** role → account for one legal entity; missing roles fail at posting time. */
export function accountMapFor(
  mappings: readonly AccountMapping[],
  legalEntityId: LegalEntityId,
): ReadonlyMap<PostingAccountRole, AccountId> {
  return new Map(
    mappings
      .filter((mapping) => mapping.legalEntityId === legalEntityId)
      .map((mapping) => [mapping.role, mapping.accountId]),
  );
}

// ---- Standard F&B chart (template data) ----------------------------------

export const chartTemplateRowSchema = z.strictObject({
  code: accountCodeSchema,
  name: z.string().min(1).max(150),
  type: accountTypeSchema,
  reportGroup: reportGroupSchema,
  parentCode: accountCodeSchema.nullable(),
  /** Posting roles this account is mapped to by default. */
  roles: z.array(postingAccountRoleSchema),
});
export type ChartTemplateRow = z.infer<typeof chartTemplateRowSchema>;

type Row = [
  code: string,
  name: string,
  group: ReportGroup,
  parentCode: string | null,
  roles?: PostingAccountRole[],
];
const standardRows: Row[] = [
  ["1100", "Kas dan Setara Kas", "cash_and_equivalents", null],
  ["1101", "Kas Outlet", "cash_and_equivalents", "1100", ["cash_on_hand"]],
  ["1102", "Kas Kecil", "cash_and_equivalents", "1100", ["petty_cash"]],
  ["1103", "Bank Operasional", "cash_and_equivalents", "1100", ["bank"]],
  ["1200", "Piutang", "current_asset", null],
  ["1201", "Piutang Usaha", "current_asset", "1200", ["accounts_receivable"]],
  [
    "1202",
    "Kliring Payment Gateway",
    "current_asset",
    "1200",
    ["gateway_clearing"],
  ],
  ["1203", "Kliring EDC", "current_asset", "1200", ["edc_clearing"]],
  [
    "1204",
    "Piutang Karyawan",
    "current_asset",
    "1200",
    ["employee_receivable"],
  ],
  ["1300", "Persediaan", "current_asset", null],
  ["1301", "Persediaan Bahan Baku", "current_asset", "1300", ["inventory"]],
  [
    "1302",
    "Persediaan Barang Setengah Jadi",
    "current_asset",
    "1300",
    ["inventory_semi_finished"],
  ],
  ["1400", "Pajak Dibayar di Muka", "current_asset", null],
  ["1401", "PPN Masukan", "current_asset", "1400", ["ppn_input"]],
  ["1500", "Aset Tetap", "non_current_asset", null],
  [
    "1501",
    "Peralatan Dapur dan Bar",
    "non_current_asset",
    "1500",
    ["fixed_assets"],
  ],
  [
    "1502",
    "Akumulasi Penyusutan Peralatan",
    "non_current_asset",
    "1500",
    ["accumulated_depreciation"],
  ],
  ["2100", "Utang Lancar", "current_liability", null],
  ["2101", "Utang Usaha", "current_liability", "2100", ["accounts_payable"]],
  [
    "2102",
    "Barang Diterima Belum Ditagih",
    "current_liability",
    "2100",
    ["grni"],
  ],
  ["2103", "Utang Gaji", "current_liability", "2100", ["salaries_payable"]],
  ["2104", "Utang BPJS", "current_liability", "2100", ["bpjs_payable"]],
  [
    "2105",
    "Liabilitas Poin Loyalty",
    "current_liability",
    "2100",
    ["loyalty_liability"],
  ],
  [
    "2106",
    "Utang Service Charge",
    "current_liability",
    "2100",
    ["service_charge"],
  ],
  [
    "2107",
    "Uang Muka Pelanggan",
    "current_liability",
    "2100",
    ["customer_deposit"],
  ],
  [
    "2108",
    "Kas Masuk Belum Diklasifikasi",
    "current_liability",
    "2100",
    ["cash_in_clearing"],
  ],
  ["2200", "Utang Pajak", "current_liability", null],
  ["2201", "Utang PBJT", "current_liability", "2200", ["tax_payable_pbjt"]],
  ["2202", "Utang PPh 21", "current_liability", "2200", ["pph21_payable"]],
  ["2203", "Utang PPh 23", "current_liability", "2200", ["pph23_payable"]],
  [
    "2204",
    "Utang PPh Dividen",
    "current_liability",
    "2200",
    ["dividend_tax_payable"],
  ],
  ["2205", "Utang PPN", "current_liability", "2200", ["tax_payable_ppn"]],
  [
    "2206",
    "Utang Pajak Lainnya",
    "current_liability",
    "2200",
    ["tax_payable_other"],
  ],
  ["3100", "Ekuitas", "equity", null],
  ["3101", "Modal Disetor", "equity", "3100"],
  ["3102", "Laba Ditahan", "equity", "3100", ["retained_earnings"]],
  ["3103", "Ekuitas Saldo Awal", "equity", "3100", ["opening_balance_equity"]],
  [
    "3104",
    "Surplus Revaluasi Aset Tetap",
    "equity",
    "3100",
    ["revaluation_surplus"],
  ],
  ["4100", "Pendapatan Usaha", "revenue", null],
  [
    "4101",
    "Penjualan Makanan dan Minuman",
    "revenue",
    "4100",
    ["sales_revenue"],
  ],
  ["4102", "Pendapatan Fasilitas", "revenue", "4100"],
  ["4103", "Diskon Penjualan", "revenue", "4100", ["sales_discount"]],
  [
    "4104",
    "Pendapatan Poin Kedaluwarsa",
    "revenue",
    "4100",
    ["loyalty_breakage_revenue"],
  ],
  // legend-msqvi: points earned defer revenue here; redemption releases it.
  [
    "4105",
    "Penangguhan Pendapatan Poin Loyalty",
    "revenue",
    "4100",
    ["loyalty_points_deferral"],
  ],
  ["5100", "Harga Pokok Penjualan", "cogs", null],
  ["5101", "HPP Makanan dan Minuman", "cogs", "5100", ["cogs"]],
  ["5102", "Waste dan Spoilage", "cogs", "5100", ["waste_expense"]],
  ["5103", "Selisih Stok Opname", "cogs", "5100", ["inventory_adjustment"]],
  [
    "5104",
    "Pembelian Langsung (Kas Kecil)",
    "cogs",
    "5100",
    ["petty_purchase_expense"],
  ],
  [
    "5105",
    "Selisih Harga Pembelian",
    "cogs",
    "5100",
    ["purchase_price_variance"],
  ],
  [
    "5106",
    "Selisih Harga Persediaan",
    "cogs",
    "5100",
    ["inventory_price_variance"],
  ],
  ["6100", "Beban Operasional", "operating_expense", null],
  [
    "6101",
    "Beban Gaji",
    "operating_expense",
    "6100",
    ["salary_expense", "payroll_custom_deduction"],
  ],
  [
    "6102",
    "Beban BPJS Perusahaan",
    "operating_expense",
    "6100",
    ["bpjs_expense"],
  ],
  [
    "6103",
    "Beban Payment Gateway",
    "operating_expense",
    "6100",
    ["gateway_fee_expense"],
  ],
  [
    "6104",
    "Beban Penyusutan",
    "operating_expense",
    "6100",
    ["depreciation_expense"],
  ],
  ["6105", "Beban Sewa", "operating_expense", "6100"],
  ["6106", "Beban Listrik, Air dan Internet", "operating_expense", "6100"],
  [
    "6107",
    "Beban Jasa Pihak Ketiga",
    "operating_expense",
    "6100",
    ["service_expense"],
  ],
  ["6108", "Selisih Kas", "operating_expense", "6100", ["cash_over_short"]],
  ["6109", "Beban Pemasaran", "operating_expense", "6100"],
  [
    "6110",
    "Beban Reimbursement Karyawan",
    "operating_expense",
    "6100",
    ["reimbursement_expense"],
  ],
  [
    "6111",
    "Beban PPh 21 Ditanggung Perusahaan",
    "operating_expense",
    "6100",
    ["pph21_borne_expense"],
  ],
  [
    "6112",
    "Beban Kas Keluar Kasir",
    "operating_expense",
    "6100",
    ["cash_out_expense"],
  ],
  ["7100", "Pendapatan Lain-lain", "other_income", null],
  ["7101", "Pembulatan Kas", "other_income", "7100", ["rounding"]],
  [
    "7102",
    "Laba (Rugi) Pelepasan Aset",
    "other_income",
    "7100",
    ["asset_disposal_result"],
  ],
  [
    "7103",
    "Pendapatan Uang Muka Hangus",
    "other_income",
    "7100",
    ["deposit_forfeit_income"],
  ],
  ["8100", "Beban Lain-lain", "other_expense", null],
  [
    "8101",
    "Beban Administrasi Bank",
    "other_expense",
    "8100",
    ["bank_charges"],
  ],
  [
    "8102",
    "Rugi Revaluasi Aset Tetap",
    "other_expense",
    "8100",
    ["asset_revaluation_loss"],
  ],
];

/** Standard F&B chart (PRD §3.19); a template, copied per legal entity and editable. */
export const standardFnbChartTemplate: readonly ChartTemplateRow[] =
  Object.freeze(
    standardRows.map(([code, name, reportGroup, parentCode, roles = []]) =>
      chartTemplateRowSchema.parse({
        code,
        name,
        type: REPORT_GROUPS[reportGroup],
        reportGroup,
        parentCode,
        roles,
      }),
    ),
  );
