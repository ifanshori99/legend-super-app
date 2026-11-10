// TL-06 get_financial_statement (bead legend-mfyo). P&L, balance sheet or cash
// flow lines from posted journal lines. Shareholders (access level
// closed_period_aggregate, no finance role) see only entries of CLOSED fiscal
// periods. Final only when every month of the period is closed.
import {
  getFinancialStatementInputSchema,
  getFinancialStatementOutputSchema,
} from "@starter/shared/ai";
import { resolveTenantScope, monthsOf } from "../../ai-metrics/scope.ts";
import {
  naturalAmount,
  queryStatementData,
  type AccountBalance,
} from "../../ai-metrics/finance.ts";
import type { AiToolHandler } from "../types.ts";
import { makeSource, maxRowsOf } from "./shared.ts";

const PL_GROUPS = new Set([
  "revenue",
  "cogs",
  "operating_expense",
  "other_income",
  "other_expense",
]);
const BS_GROUPS = new Set([
  "cash_and_equivalents",
  "current_asset",
  "non_current_asset",
  "current_liability",
  "non_current_liability",
  "equity",
]);

const ROUTES = {
  profit_loss: "/reports/finance/income-statement",
  balance_sheet: "/reports/finance/balance-sheet",
  cash_flow: "/reports/finance/cash-flow",
} as const;

export const getFinancialStatement: AiToolHandler = async (ctx, raw) => {
  const input = getFinancialStatementInputSchema.parse(raw);
  // Closed periods only when the grant that minted the tenant-wide context is
  // the aggregate one; another role held at a narrower scope never lifts it.
  const { context, match } = resolveTenantScope(ctx, "TL-06");
  const closedOnly = match.access === "closed_period_aggregate";
  const data = await queryStatementData(context, {
    from: input.statement === "balance_sheet" ? null : input.period.from,
    to: input.period.to,
    months: monthsOf(input.period),
    legalEntityId: input.legalEntityId,
    closedOnly,
  });

  const line = (account: AccountBalance, amount: number) => ({
    accountCode: account.code,
    label: account.name,
    amountIdr: amount,
  });
  let lines: { accountCode: string; label: string; amountIdr: number }[];
  if (input.statement === "profit_loss") {
    lines = data.accounts
      .filter((a) => PL_GROUPS.has(a.reportGroup))
      .map((a) => line(a, naturalAmount(a)));
  } else if (input.statement === "balance_sheet") {
    lines = data.accounts
      .filter((a) => BS_GROUPS.has(a.reportGroup))
      .map((a) => line(a, naturalAmount(a)));
    // Unclosed profit sits under equity so assets = liabilities + equity.
    const earnings = data.accounts
      .filter((a) => PL_GROUPS.has(a.reportGroup))
      .reduce(
        (sum, a) => sum + (a.type === "revenue" ? 1 : -1) * naturalAmount(a),
        0,
      );
    if (earnings !== 0)
      lines.push({
        accountCode: "0",
        label: "Laba berjalan (belum ditutup)",
        amountIdr: earnings,
      });
  } else {
    // Direct movement of cash accounts; opening balance is not part of it.
    lines = data.accounts
      .filter((a) => a.reportGroup === "cash_and_equivalents")
      .map((a) => line(a, a.debit - a.credit));
  }
  const cap = maxRowsOf("TL-06");
  const finality = data.periodClosed ? "final" : "estimate";
  return getFinancialStatementOutputSchema.parse({
    statement: input.statement,
    lines: lines.slice(0, cap),
    periodClosed: data.periodClosed,
    finality,
    truncated: lines.length > cap,
    sources: [
      makeSource({
        label: closedOnly
          ? "Laporan keuangan (hanya periode tutup)"
          : "Laporan keuangan dari jurnal terposting",
        metricCode:
          input.statement === "profit_loss" ? "net_profit" : undefined,
        period: input.period,
        finality,
        route: ROUTES[input.statement],
      }),
    ],
  });
};
