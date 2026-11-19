// Cached payment back-office data and mutations. Components never call
// apiFetch directly; each mutation invalidates the endpoint prefix it changes.
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { orgEndpoints } from "@starter/shared/platform";
import type {
  ApproveRefundInput,
  CreateEdcTerminalInput,
  CreateRefundInput,
  QuarantinedRefundActionInput,
  RejectRefundInput,
  RetryRefundPayoutInput,
  ResolveReconciliationCaseInput,
  ResolveRefundReconHoldInput,
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
  listRefundReconHolds as listRefundReconHoldsEndpoint,
  listRefunds as listRefundsEndpoint,
  listUnallocatedFunds as listUnallocatedFundsEndpoint,
} from "@starter/shared/payment/admin";
import {
  addEdcTerminal,
  addRefund,
  approveRefund,
  patchEdcTerminal,
  rejectRefund,
  releaseQuarantinedRefund,
  reopenQuarantinedRefund,
  resolveReconciliationCase,
  resolveRefundReconHold,
  resolveUnallocatedFund,
  retryRefundPayout,
  saveEdcCashierDefault,
  savePaymentRoute,
  testIntegrationConnection,
} from "./api";
import {
  cashierDefaultsQuery,
  reconciliationCasesQuery,
  reconciliationSummaryQuery,
  refundablePaymentsQuery,
  refundReconHoldsQuery,
  refundsQuery,
  routingQuery,
  terminalsQuery,
  unallocatedFundsQuery,
} from "./queries";

/** The routing screen edits the tenant default or one outlet's overrides. */
export function usePaymentRouting(outletId: string | null) {
  return useQuery({
    ...routingQuery(outletId === null ? {} : { outletId }),
    // Switching scope keeps the old list on screen instead of blanking the panel.
    placeholderData: keepPreviousData,
  });
}

export function useUpdatePaymentRoute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      method: RoutedPaymentMethod;
      body: UpdatePaymentRouteInput;
      idempotencyKey: string;
    }) =>
      savePaymentRoute(
        { method: input.method },
        input.body,
        input.idempotencyKey,
      ),
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
    mutationFn: (input: {
      body: CreateEdcTerminalInput;
      idempotencyKey: string;
    }) => addEdcTerminal(input.body, input.idempotencyKey),
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
    mutationFn: (input: {
      terminalId: string;
      body: UpdateEdcTerminalInput;
      idempotencyKey: string;
    }) =>
      patchEdcTerminal(
        { terminalId: input.terminalId },
        input.body,
        input.idempotencyKey,
      ),
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
      idempotencyKey: string;
    }) =>
      saveEdcCashierDefault(
        { cashierId: input.cashierId },
        input.body,
        input.idempotencyKey,
      ),
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

// Every refund follow-up carries its idempotency key in the body (set once per
// dialog by the caller), so a double click or retry replays instead of acting twice.
export function useRejectRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { refundId: string; body: RejectRefundInput }) =>
      rejectRefund({ refundId: input.refundId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
  });
}

/** Retry (never-sent) and "check status" (maybe-sent) share this endpoint. */
export function useRetryRefundPayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { refundId: string; body: RetryRefundPayoutInput }) =>
      retryRefundPayout({ refundId: input.refundId }, input.body),
    // A failed lookup still changes counters server-side: refresh either way.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
  });
}

export function useReleaseQuarantinedRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      refundId: string;
      body: QuarantinedRefundActionInput;
    }) => releaseQuarantinedRefund({ refundId: input.refundId }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
  });
}

export function useReopenQuarantinedRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      refundId: string;
      body: QuarantinedRefundActionInput;
    }) => reopenQuarantinedRefund({ refundId: input.refundId }, input.body),
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

export function useRefundReconHolds(
  status: "open" | "resolved",
  enabled = true,
) {
  return useQuery({
    ...refundReconHoldsQuery({ limit: 100, status }),
    enabled,
  });
}

/** A resolve can open refund/payout limits too, so refunds refresh as well. */
export function useResolveRefundReconHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      holdId: string;
      body: ResolveRefundReconHoldInput;
    }) => resolveRefundReconHold({ holdId: input.holdId }, input.body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listRefundReconHoldsEndpoint.id],
        }),
        queryClient.invalidateQueries({ queryKey: [listRefundsEndpoint.id] }),
      ]),
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
      idempotencyKey: string;
    }) =>
      resolveReconciliationCase(
        { caseId: input.caseId },
        input.body,
        input.idempotencyKey,
      ),
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

/**
 * Tests the stored Duitku credentials. The answer carries no secret; the API
 * also stamps `lastCheckedAt`/`lastErrorCode` on the row, so the integrations
 * list is refetched to show the new status.
 */
export function useTestIntegrationConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (integrationId: string) =>
      testIntegrationConnection(integrationId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [orgEndpoints.listIntegrations.id],
      }),
  });
}
