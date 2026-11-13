// The only way components touch cash & bank data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  MatchStatus,
  ReconciliationCaseStatus,
} from "@starter/shared/accounting";
import * as api from "./api";
import {
  cashApprovalLimitQuery,
  cashBankEntriesQuery,
  cashBankKeys,
  cashDepositsQuery,
  bankAccountsQuery,
  financePolicyQuery,
  gatewaySettlementReconQuery,
  matchJournalsQuery,
  pettyCashEntriesQuery,
  pettyCashFundsQuery,
  reconciliationCaseQuery,
  reconciliationCasesQuery,
  reconciliationSummaryQuery,
  statementLineDedupeKeysQuery,
  statementLinesForPeriodQuery,
  STATEMENT_PAGE_SIZE,
  undepositedAlertsQuery,
  type StatementLineFilters,
} from "./queries";

// ---- Queries --------------------------------------------------------------

export function useFinancePolicy() {
  return useQuery(financePolicyQuery());
}

/** The cash out approval limit; `enabled` false skips the call (no permission). */
export function useCashApprovalLimit(enabled = true) {
  return useQuery({ ...cashApprovalLimitQuery(), enabled });
}

export function useBankAccounts(legalEntityId: string | undefined) {
  return useQuery(bankAccountsQuery(legalEntityId));
}

/** The match workspace: pages appended as the user asks for more lines. */
export function useStatementLinesInfinite(filters: StatementLineFilters) {
  return useInfiniteQuery({
    queryKey: [...cashBankKeys.lineList(filters), "infinite"] as const,
    queryFn: ({ pageParam, signal }) =>
      api.fetchStatementLines(
        filters.bankAccountId,
        {
          from: filters.from,
          to: filters.to,
          limit: STATEMENT_PAGE_SIZE,
          ...(filters.matchStatus && filters.matchStatus !== "all"
            ? { matchStatus: filters.matchStatus as MatchStatus }
            : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    enabled: Boolean(filters.bankAccountId && filters.from && filters.to),
  });
}

export function useStatementLinesForPeriod(
  bankAccountId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(statementLinesForPeriodQuery(bankAccountId, from, to));
}

export function useStatementLineDedupeKeys(bankAccountId: string | undefined) {
  return useQuery(statementLineDedupeKeysQuery(bankAccountId));
}

export function useReconciliationSummary(
  bankAccountId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(reconciliationSummaryQuery(bankAccountId, from, to));
}

export function useCashDeposits(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(cashDepositsQuery(legalEntityId, from, to));
}

export function useUndepositedAlerts(
  legalEntityId: string | undefined,
  asOf: string,
) {
  return useQuery(undepositedAlertsQuery(legalEntityId, asOf));
}

export function useReconciliationCases(
  legalEntityId: string | undefined,
  status: ReconciliationCaseStatus | "all" = "all",
) {
  return useQuery(reconciliationCasesQuery(legalEntityId, status));
}

export function useReconciliationCase(caseId: string | undefined) {
  return useQuery(reconciliationCaseQuery(caseId));
}

export function useGatewaySettlementRecon(
  legalEntityId: string | undefined,
  bankAccountId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(
    gatewaySettlementReconQuery(legalEntityId, bankAccountId, from, to),
  );
}

export function useMatchJournals(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(matchJournalsQuery(legalEntityId, from, to));
}

export function useCashBankEntries(
  legalEntityId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(cashBankEntriesQuery(legalEntityId, from, to));
}

export function usePettyCashFunds(legalEntityId: string | undefined) {
  return useQuery(pettyCashFundsQuery(legalEntityId));
}

export function usePettyCashEntries(
  outletId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery(pettyCashEntriesQuery(outletId, from, to));
}

// ---- Mutations ------------------------------------------------------------

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: cashBankKeys.all });
}

export function useCreateBankAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: api.CreateBankAccountBody) =>
      api.createBankAccount(body),
    onSuccess: invalidate,
  });
}

export function useImportBankStatement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (variables: {
      bankAccountId: string;
      input: api.ImportStatementInput;
    }) => api.importBankStatement(variables.bankAccountId, variables.input),
    onSuccess: invalidate,
  });
}

export function useMatchStatementLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (variables: {
      lineId: string;
      refs: Parameters<typeof api.matchStatementLine>[1];
    }) => api.matchStatementLine(variables.lineId, variables.refs),
    onSuccess: invalidate,
  });
}

export function useExcludeStatementLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (variables: { lineId: string; reason: string }) =>
      api.excludeStatementLine(variables.lineId, variables.reason),
    onSuccess: invalidate,
  });
}

export function useUnmatchStatementLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (lineId: string) => api.unmatchStatementLine(lineId),
    onSuccess: invalidate,
  });
}

export function useCreateCashDeposit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: api.CreateCashDepositBody) =>
      api.createCashDeposit(body),
    onSuccess: invalidate,
  });
}

export function useOpenReconciliationCase() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.openReconciliationCase>[0]) =>
      api.openReconciliationCase(body),
    onSuccess: invalidate,
  });
}

export function useCaseAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (variables: {
      caseId: string;
      action: Parameters<typeof api.actOnReconciliationCase>[1];
    }) => api.actOnReconciliationCase(variables.caseId, variables.action),
    onSuccess: invalidate,
  });
}

export function useCreateCashBankEntry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: api.CreateCashBankEntryBody) =>
      api.createCashBankEntry(body),
    onSuccess: invalidate,
  });
}

export function useApproveCashBankEntry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (entryId: string) => api.approveCashBankEntry(entryId),
    onSuccess: invalidate,
  });
}

export function useRejectCashBankEntry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (variables: { entryId: string; reason: string }) =>
      api.rejectCashBankEntry(variables.entryId, variables.reason),
    onSuccess: invalidate,
  });
}

export function useUpdateCashApprovalLimit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (limitIdr: number) => api.updateCashApprovalLimit(limitIdr),
    onSuccess: invalidate,
  });
}

export function useCreatePettyCashMovement() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: api.CreatePettyCashMovementBody) =>
      api.createPettyCashMovement(body),
    onSuccess: invalidate,
  });
}

export function usePostPettyCashEntry() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (entryId: string) => api.postPettyCashEntry(entryId),
    onSuccess: invalidate,
  });
}
