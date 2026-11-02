// Cached payment back-office data and mutations. Components never call
// apiFetch directly; each mutation invalidates the endpoint prefix it changes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApproveRefundInput,
  CreateEdcTerminalInput,
  CreateRefundInput,
  ResolveReconciliationCaseInput,
  ResolveUnallocatedFundInput,
  RoutedPaymentMethod,
  UpdateEdcCashierDefaultInput,
  UpdateEdcTerminalInput,
  UpdatePaymentRouteInput,
} from "@starter/shared/payment/admin";
import {
  getEdcCashierDefaults as getEdcCashierDefaultsEndpoint,
  getPaymentRouting as getPaymentRoutingEndpoint,
  getReconciliationSummary as getReconciliationSummaryEndpoint,
  listEdcTerminals as listEdcTerminalsEndpoint,
  listReconciliationCases as listReconciliationCasesEndpoint,
  listRefunds as listRefundsEndpoint,
  listUnallocatedFunds as listUnallocatedFundsEndpoint,
} from "@starter/shared/payment/admin";
import {
  addEdcTerminal,
  addRefund,
  approveRefund,
  patchEdcTerminal,
  resolveReconciliationCase,
  resolveUnallocatedFund,
  saveEdcCashierDefault,
  savePaymentRoute,
} from "./api";
import {
  cashierDefaultsQuery,
  reconciliationCasesQuery,
  reconciliationSummaryQuery,
  refundablePaymentsQuery,
  refundsQuery,
  routingQuery,
  terminalsQuery,
  unallocatedFundsQuery,
} from "./queries";

/** The routing screen edits the tenant default or one outlet's overrides. */
export function usePaymentRouting(outletId: string | null) {
  return useQuery(routingQuery(outletId === null ? {} : { outletId }));
}

export function useUpdatePaymentRoute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      method: RoutedPaymentMethod;
      body: UpdatePaymentRouteInput;
    }) => savePaymentRoute({ method: input.method }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [getPaymentRoutingEndpoint.id],
      }),
  });
}

export function useEdcTerminals(outletId?: string) {
  return useQuery(terminalsQuery({ limit: 100, outletId }));
}

export function useCreateEdcTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEdcTerminalInput) => addEdcTerminal(body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listEdcTerminalsEndpoint.id],
        }),
        queryClient.invalidateQueries({
          queryKey: [getEdcCashierDefaultsEndpoint.id],
        }),
      ]),
  });
}

export function useUpdateEdcTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { terminalId: string; body: UpdateEdcTerminalInput }) =>
      patchEdcTerminal({ terminalId: input.terminalId }, input.body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listEdcTerminalsEndpoint.id],
        }),
        queryClient.invalidateQueries({
          queryKey: [getEdcCashierDefaultsEndpoint.id],
        }),
      ]),
  });
}

export function useEdcCashierDefaults(outletId: string) {
  return useQuery(cashierDefaultsQuery({ outletId }));
}

export function useUpdateEdcCashierDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      cashierId: string;
      body: UpdateEdcCashierDefaultInput;
    }) => saveEdcCashierDefault({ cashierId: input.cashierId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [getEdcCashierDefaultsEndpoint.id],
      }),
  });
}

export function useRefunds(outletId?: string) {
  return useQuery(refundsQuery({ limit: 100, outletId }));
}

export function useRefundablePayments(outletId?: string) {
  return useQuery(refundablePaymentsQuery({ outletId }));
}

export function useCreateRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRefundInput) => addRefund(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
  });
}

export function useApproveRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { refundId: string; body: ApproveRefundInput }) =>
      approveRefund({ refundId: input.refundId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
  });
}

export function useUnallocatedFunds(outletId?: string) {
  return useQuery(unallocatedFundsQuery({ limit: 100, outletId }));
}

export function useResolveUnallocatedFund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      fundId: string;
      body: ResolveUnallocatedFundInput;
    }) => resolveUnallocatedFund({ fundId: input.fundId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [listUnallocatedFundsEndpoint.id],
      }),
  });
}

export function useReconciliationCases(outletId?: string) {
  return useQuery(reconciliationCasesQuery({ limit: 100, outletId }));
}

export function useReconciliationSummary(outletId?: string) {
  return useQuery(reconciliationSummaryQuery({ outletId }));
}

export function useResolveReconciliationCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      caseId: string;
      body: ResolveReconciliationCaseInput;
    }) => resolveReconciliationCase({ caseId: input.caseId }, input.body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listReconciliationCasesEndpoint.id],
        }),
        queryClient.invalidateQueries({
          queryKey: [getReconciliationSummaryEndpoint.id],
        }),
      ]),
  });
}
