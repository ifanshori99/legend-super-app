// Query keys and options of the cash & bank screens. Hierarchical under one
// root so a write invalidates every list, summary and drawer a case or match
// can change.
import { queryOptions } from "@tanstack/react-query";
import type {
  MatchStatus,
  ReconciliationCaseStatus,
} from "@starter/shared/accounting";
import {
  fetchBankAccounts,
  fetchCashDeposits,
  fetchGatewaySettlements,
  fetchMatchJournals,
  fetchReconciliationCase,
  fetchReconciliationCases,
  fetchReconciliationSummary,
  fetchStatementLines,
  fetchUndepositedCashAlerts,
} from "./api";

export const STATEMENT_PAGE_SIZE = 50;
export const DEPOSIT_PAGE_SIZE = 50;
export const CASE_PAGE_SIZE = 50;

/** Dedupe keys are unique per account, so the preview reads a wide window. */
export const DEDUPE_SCAN_RANGE = { from: "2000-01-01", to: "2100-12-31" };

export type StatementLineFilters = {
  bankAccountId: string;
  from: string;
  to: string;
  matchStatus?: MatchStatus | "all";
};

export const cashBankKeys = {
  all: ["accounting", "cash-bank"] as const,
  bankAccounts: (legalEntityId: string) =>
    [...cashBankKeys.all, "bank-accounts", legalEntityId] as const,
  lines: () => [...cashBankKeys.all, "statement-lines"] as const,
  lineList: (filters: StatementLineFilters) =>
    [...cashBankKeys.lines(), filters] as const,
  dedupeKeys: (bankAccountId: string) =>
    [...cashBankKeys.lines(), "dedupe-keys", bankAccountId] as const,
  summary: (bankAccountId: string, from: string, to: string) =>
    [...cashBankKeys.all, "summary", bankAccountId, from, to] as const,
  deposits: (legalEntityId: string, from: string, to: string) =>
    [...cashBankKeys.all, "deposits", legalEntityId, from, to] as const,
  alerts: (legalEntityId: string, asOf: string) =>
    [...cashBankKeys.all, "undeposited-alerts", legalEntityId, asOf] as const,
  cases: (legalEntityId: string, status: string) =>
    [...cashBankKeys.all, "cases", legalEntityId, status] as const,
  case: (caseId: string) => [...cashBankKeys.all, "case", caseId] as const,
  settlements: (legalEntityId: string, from: string, to: string) =>
    [
      ...cashBankKeys.all,
      "gateway-settlements",
      legalEntityId,
      from,
      to,
    ] as const,
  matchJournals: (legalEntityId: string, from: string, to: string) =>
    [...cashBankKeys.all, "match-journals", legalEntityId, from, to] as const,
};

export function bankAccountsQuery(legalEntityId: string | undefined) {
  return queryOptions({
    queryKey: cashBankKeys.bankAccounts(legalEntityId ?? "none"),
    queryFn: ({ signal }) => fetchBankAccounts(legalEntityId ?? "", signal),
    enabled: Boolean(legalEntityId),
  });
}

export function statementLineListQuery(filters: StatementLineFilters) {
  return queryOptions({
    queryKey: [...cashBankKeys.lineList(filters), "page"] as const,
    queryFn: ({ signal }) =>
      fetchStatementLines(
        filters.bankAccountId,
        {
          from: filters.from,
          to: filters.to,
          limit: STATEMENT_PAGE_SIZE,
          ...(filters.matchStatus && filters.matchStatus !== "all"
            ? { matchStatus: filters.matchStatus as MatchStatus }
            : {}),
        },
        signal,
      ),
    enabled: Boolean(filters.bankAccountId && filters.from && filters.to),
  });
}

/** Wide-window dedupe keys for the import preview (unique per account). */
export function statementLineDedupeKeysQuery(
  bankAccountId: string | undefined,
) {
  return queryOptions({
    queryKey: cashBankKeys.dedupeKeys(bankAccountId ?? "none"),
    queryFn: ({ signal }) =>
      fetchStatementLines(
        bankAccountId ?? "",
        {
          from: DEDUPE_SCAN_RANGE.from,
          to: DEDUPE_SCAN_RANGE.to,
          limit: 100,
        },
        signal,
      ),
    enabled: Boolean(bankAccountId),
  });
}

/** All lines of one period (≤100), for linking settlement refs. */
export function statementLinesForPeriodQuery(
  bankAccountId: string | undefined,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.lineList({
      bankAccountId: bankAccountId ?? "none",
      from,
      to,
    }),
    queryFn: ({ signal }) =>
      fetchStatementLines(
        bankAccountId ?? "",
        { from, to, limit: 100 },
        signal,
      ),
    enabled: Boolean(bankAccountId && from && to),
  });
}

export function reconciliationSummaryQuery(
  bankAccountId: string | undefined,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.summary(bankAccountId ?? "none", from, to),
    queryFn: ({ signal }) =>
      fetchReconciliationSummary(
        { bankAccountId: bankAccountId ?? "", from, to },
        signal,
      ),
    enabled: Boolean(bankAccountId && from && to),
  });
}

export function cashDepositsQuery(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.deposits(legalEntityId ?? "none", from, to),
    queryFn: ({ signal }) =>
      fetchCashDeposits(
        {
          legalEntityId: legalEntityId ?? "",
          from,
          to,
          limit: DEPOSIT_PAGE_SIZE,
        },
        signal,
      ),
    enabled: Boolean(legalEntityId && from && to),
  });
}

export function undepositedAlertsQuery(
  legalEntityId: string | undefined,
  asOf: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.alerts(legalEntityId ?? "none", asOf),
    queryFn: ({ signal }) =>
      fetchUndepositedCashAlerts(legalEntityId ?? "", asOf, signal),
    enabled: Boolean(legalEntityId && asOf),
  });
}

export function reconciliationCasesQuery(
  legalEntityId: string | undefined,
  status: ReconciliationCaseStatus | "all",
) {
  return queryOptions({
    queryKey: cashBankKeys.cases(legalEntityId ?? "none", status),
    queryFn: ({ signal }) =>
      fetchReconciliationCases(
        {
          legalEntityId: legalEntityId ?? "",
          limit: CASE_PAGE_SIZE,
          ...(status === "all" ? {} : { status }),
        },
        signal,
      ),
    enabled: Boolean(legalEntityId),
  });
}

export function reconciliationCaseQuery(caseId: string | undefined) {
  return queryOptions({
    queryKey: cashBankKeys.case(caseId ?? "none"),
    queryFn: ({ signal }) => fetchReconciliationCase(caseId ?? "", signal),
    enabled: Boolean(caseId),
  });
}

export function gatewaySettlementsQuery(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.settlements(legalEntityId ?? "none", from, to),
    queryFn: ({ signal }) =>
      fetchGatewaySettlements(legalEntityId ?? "", from, to, signal),
    enabled: Boolean(legalEntityId && from && to),
  });
}

export function matchJournalsQuery(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: cashBankKeys.matchJournals(legalEntityId ?? "none", from, to),
    queryFn: ({ signal }) =>
      fetchMatchJournals(legalEntityId ?? "", from, to, signal),
    enabled: Boolean(legalEntityId && from && to),
  });
}
