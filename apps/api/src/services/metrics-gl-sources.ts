// Which general-ledger accounts each money metric reads (I1, bead legend-cdta).
// Money figures on dashboards, reports, Tanya AI and MCP are never recomputed
// from orders or payments: they are sums of posted journal lines, picked by
// statement section (`chart_of_accounts.report_group`) or by posting role
// (`account_mappings.role`). Statement sections keep the numbers equal to the
// income statement report (DASH-02); roles cover lines the sections cannot
// separate (payroll, gateway fees, waste).
//
// A term contributes `sign × (credit − debit)` of every matching account, so a
// revenue section reads with +1 and an expense with −1. One account counts
// once per component even when two terms match it (first term wins). A role
// term also reads every descendant (`chart_of_accounts.parent_id`) of the
// mapped account, so sub-accounts opened under it are never dropped.
//
// The registry formula of each metric here (`formula.expression`, sent to
// Tanya AI and MCP through `definitionRef`) must describe this source; a
// money metric missing here must be listed in NON_GL_MONEY_METRICS
// (metrics-runtime.test.ts guards both).

import type {
  PostingAccountRole,
  ReportGroup,
} from "@starter/shared/accounting";

export type GlTerm = {
  readonly reportGroups?: readonly ReportGroup[];
  readonly roles?: readonly PostingAccountRole[];
  readonly sign: 1 | -1;
};

export type GlComponent = readonly GlTerm[];

export type GlMetricSource =
  | { readonly kind: "amount"; readonly component: GlComponent }
  /** Percent = numerator / denominator × 100, recomputed per bucket. */
  | {
      readonly kind: "ratio";
      readonly numerator: GlComponent;
      readonly denominator: GlComponent;
    };

const INCOME_STATEMENT_GROUPS: readonly ReportGroup[] = [
  "revenue",
  "other_income",
  "cogs",
  "operating_expense",
  "other_expense",
];

/** Revenue section net of contra accounts (discounts post as debits there). */
const NET_SALES: GlComponent = [{ reportGroups: ["revenue"], sign: 1 }];
const COGS: GlComponent = [{ reportGroups: ["cogs"], sign: -1 }];
const GROSS_PROFIT: GlComponent = [
  { reportGroups: ["revenue"], sign: 1 },
  { reportGroups: ["cogs"], sign: 1 },
];
const LABOR: GlComponent = [
  { roles: ["salary_expense", "bpjs_expense"], sign: -1 },
];

/**
 * Money metrics the runtime answers from the ledger. A money metric missing
 * here answers "no data" (null), never a figure from operational tables.
 */
export const GL_METRIC_SOURCES: Readonly<Record<string, GlMetricSource>> = {
  net_sales: { kind: "amount", component: NET_SALES },
  cogs: { kind: "amount", component: COGS },
  gross_profit: { kind: "amount", component: GROSS_PROFIT },
  net_profit: {
    kind: "amount",
    component: [{ reportGroups: INCOME_STATEMENT_GROUPS, sign: 1 }],
  },
  discount_amount: {
    kind: "amount",
    component: [{ roles: ["sales_discount"], sign: -1 }],
  },
  waste_cost: {
    kind: "amount",
    component: [{ roles: ["waste_expense"], sign: -1 }],
  },
  gross_payroll: {
    kind: "amount",
    component: [{ roles: ["salary_expense"], sign: -1 }],
  },
  payment_fee: {
    kind: "amount",
    component: [{ roles: ["gateway_fee_expense"], sign: -1 }],
  },
  food_cost_pct: { kind: "ratio", numerator: COGS, denominator: NET_SALES },
  labor_cost_pct: { kind: "ratio", numerator: LABOR, denominator: NET_SALES },
  prime_cost_pct: {
    kind: "ratio",
    numerator: [...COGS, ...LABOR],
    denominator: NET_SALES,
  },
  gross_margin_pct: {
    kind: "ratio",
    numerator: GROSS_PROFIT,
    denominator: NET_SALES,
  },
};

/**
 * Rupiah metrics of the registry the ledger does not answer yet: they read
 * operational sources (orders, settlements, stock) or balances, so the runtime
 * answers null for them rather than a figure that bypasses the ledger (I1).
 * Moving one into GL_METRIC_SOURCES removes it from this list.
 */
export const NON_GL_MONEY_METRICS: readonly string[] = [
  "avg_spend_per_pax",
  "revpash",
  "shower_revenue",
  "facility_product_revenue",
  "ebitda",
  "gross_sales",
  "refund_amount",
  "void_amount",
  "avg_ticket",
  "sales_target",
  "promo_cost",
  "cash_balance",
  "bank_balance",
  "supplier_due",
  "pending_settlement",
  "cash_variance",
  "delivery_sales",
  "stock_value",
  "purchase_total",
  "tax_collected",
  "service_charge_collected",
  "tax_payable",
  "gateway_settlement",
  "edc_settlement",
];

export function glComponentsOf(source: GlMetricSource): GlComponent[] {
  return source.kind === "amount"
    ? [source.component]
    : [source.numerator, source.denominator];
}
