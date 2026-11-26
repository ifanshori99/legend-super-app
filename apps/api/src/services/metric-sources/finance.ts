// Metric sources of the "finance" family (F6, bead legend-qlirp; CTO decisions
// docs/briefs/1272-d2-keputusan.md). Every source here is a ledger source: the
// engine sums posted journal lines, so the finance reports equal the journal
// and its closed-month snapshots, split by outlet and by legal entity.
// - ebitda: the income statement sections (as net_profit) less every account
//   mapped to depreciation, amortization, interest or income tax (children
//   included). An entity that has not mapped one of those roles keeps its
//   lines in the figure and the answer names the role ("Belum memisahkan").
// - cash_balance / bank_balance: balance at the bucket end of the cash role
//   accounts (cash_on_hand + petty_cash) and of the bank role accounts. A
//   balance is a tenant or legal entity figure: bank transfers post without
//   an outlet, so an outlet's share is not guessed (dimension_not_supported).
// Not here: supplier_due (inventory-purchasing reader), pending_settlement
// (no source yet), the prime cost percents (gl.ts).

import type { GlComponent } from "../metrics-gl-sources";
import type { MetricSource, MetricSourceFamilyModule } from "./types";

const EBITDA: GlComponent = [
  {
    roles: [
      "depreciation_expense",
      "amortization_expense",
      "interest_expense",
      "income_tax_expense",
    ],
    sign: 1,
    exclude: true,
  },
  {
    reportGroups: [
      "revenue",
      "other_income",
      "cogs",
      "operating_expense",
      "other_expense",
    ],
    sign: 1,
  },
];

/** Asset balances grow with debits: sign −1 reads debit − credit. */
const CASH: GlComponent = [{ roles: ["cash_on_hand", "petty_cash"], sign: -1 }];
const BANK: GlComponent = [{ roles: ["bank"], sign: -1 }];

const sources: MetricSource[] = [
  {
    kind: "gl",
    code: "ebitda",
    gl: { kind: "amount", component: EBITDA },
  },
  {
    kind: "gl",
    code: "cash_balance",
    gl: { kind: "balance", component: CASH },
  },
  {
    kind: "gl",
    code: "bank_balance",
    gl: { kind: "balance", component: BANK },
  },
];

export const financeSources: MetricSourceFamilyModule = {
  family: "finance",
  sources,
  splits: [],
};
