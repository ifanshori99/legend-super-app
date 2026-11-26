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
// mapped account, so sub-accounts opened under it are never dropped. A term
// with `sourceTypes` reads only lines of journals posted from those sources; a
// reversal counts as the source of the entry it reverses (a voided sale is a
// sale, a corrected remittance is not). A term with `exclude` leaves the
// accounts of its roles (and their descendants) out of the whole component,
// whatever other term matches them (EBITDA, legend-qlirp).
//
// The registry formula of each metric here (`formula.expression`, sent to
// Tanya AI and MCP through `definitionRef`) must describe this source; a
// money metric missing here must be listed in NON_GL_MONEY_METRICS
// (metrics-runtime.test.ts guards both).

import type {
  JournalSourceType,
  PostingAccountRole,
  ReportGroup,
} from "@starter/shared/accounting";

export type GlTerm = {
  readonly reportGroups?: readonly ReportGroup[];
  readonly roles?: readonly PostingAccountRole[];
  readonly sign: 1 | -1;
  /** Only journals of these sources (reversals by the reversed entry's). */
  readonly sourceTypes?: readonly Exclude<JournalSourceType, "reversal">[];
  /**
   * The accounts of `roles` never count in this component, in any order of
   * terms; `sign` is then unused. An entity that has not mapped one of the
   * roles keeps those lines in the figure, and the answer carries a note
   * naming the role (`GL_EXCLUDED_ROLE_LABELS`), never a guess.
   */
  readonly exclude?: true;
};

export type GlComponent = readonly GlTerm[];

export type GlMetricSource =
  /** Movement of the bucket: lines dated inside it. */
  | { readonly kind: "amount"; readonly component: GlComponent }
  /**
   * Balance at the bucket end: every line dated up to the last day of the
   * bucket, from the first posting on (a liability such as PBJT payable).
   */
  | { readonly kind: "balance"; readonly component: GlComponent }
  /** Percent = numerator / denominator × 100, recomputed per bucket. */
  | {
      readonly kind: "ratio";
      readonly numerator: GlComponent;
      readonly denominator: GlComponent;
      /**
       * The registry codes of numerator and denominator. A non-outlet split
       * of the percent splits both codes first and divides per split value
       * (DECISIONS 2026-11-10 point 1); without it the percent is not split.
       */
      readonly splitFrom?: {
        readonly numerator: string;
        readonly denominator: string;
      };
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
/**
 * Journals that collect from or return to the guest: the PBJT remittance to
 * the tax office (manual) and the service charge payout (payroll) move the
 * same accounts but are not collections.
 */
const SALE_SOURCES = ["sale", "refund"] as const;
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
  food_cost_pct: {
    kind: "ratio",
    numerator: COGS,
    denominator: NET_SALES,
    splitFrom: { numerator: "cogs", denominator: "net_sales" },
  },
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
    splitFrom: { numerator: "gross_profit", denominator: "net_sales" },
  },
  // Output tax and service charge: sales credit them, refunds debit them; the
  // remittance and the payroll payout are left out (SALE_SOURCES).
  tax_collected: {
    kind: "amount",
    component: [
      { roles: ["tax_payable_pbjt"], sign: 1, sourceTypes: SALE_SOURCES },
    ],
  },
  service_charge_collected: {
    kind: "amount",
    component: [
      { roles: ["service_charge"], sign: 1, sourceTypes: SALE_SOURCES },
    ],
  },
  // Every source counts in the balance, the remittance included.
  tax_payable: {
    kind: "balance",
    component: [{ roles: ["tax_payable_pbjt"], sign: 1 }],
  },
};

/**
 * Rupiah metrics of the registry the ledger does not answer yet: they read
 * operational sources (orders, settlements, stock) or balances, so the runtime
 * answers null for them rather than a figure that bypasses the ledger (I1).
 * Moving one into GL_METRIC_SOURCES removes it from this list.
 *
 * Not listed on purpose: a money metric a registered daily reader owns is
 * neither a ledger source nor a ledger gap. Reasons, per code:
 * - stock_value: stock is a point-in-time quantity x cost of the outlet
 *   (inventory-purchasing reader); the ledger has no per-outlet stock subledger.
 * - purchase_total: approved purchase orders of the business day, before any
 *   goods receipt or bill, so no journal exists for it yet.
 * - supplier_due: open payable items due on or before the day (point in
 *   time); the ledger answers the payable balance, not the due schedule.
 * - delivery_sales: gross - commission of delivery orders (reservation-delivery
 *   reader); the ledger does not post delivery orders yet, so there is no GL
 *   total to reconcile against.
 */
export const NON_GL_MONEY_METRICS: readonly string[] = [
  "avg_spend_per_pax",
  "revpash",
  "shower_revenue",
  "facility_product_revenue",
  "gross_sales",
  "refund_amount",
  "void_amount",
  "avg_ticket",
  "sales_target",
  "promo_cost",
  "pending_settlement",
  "cash_variance",
  "gateway_settlement",
  "edc_settlement",
];

/** Lowercase role names for the "Belum memisahkan ..." note of an exclusion. */
export const GL_EXCLUDED_ROLE_LABELS: Readonly<
  Partial<Record<PostingAccountRole, string>>
> = {
  depreciation_expense: "beban penyusutan",
  amortization_expense: "beban amortisasi",
  interest_expense: "beban bunga",
  income_tax_expense: "beban pajak penghasilan",
};

/** Note of a figure whose excluded roles some entity has not mapped. */
export function glUnmappedExclusionNote(
  roles: readonly PostingAccountRole[],
): string {
  const names = roles.map((role) => GL_EXCLUDED_ROLE_LABELS[role] ?? role);
  return `Belum memisahkan ${names.join(", ")}; angkanya masih ikut dihitung.`;
}

export function glComponentsOf(source: GlMetricSource): GlComponent[] {
  return source.kind !== "ratio"
    ? [source.component]
    : [source.numerator, source.denominator];
}
