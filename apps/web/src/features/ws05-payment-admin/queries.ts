// Query keys and options for the payment back office. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getEdcCashierDefaults,
  getPaymentRouting,
  getReconciliationSummary,
  listEdcTerminals,
  listReconciliationCases,
  listSettlements,
  listRefundablePayments,
  listRefundReconHolds,
  listRefunds,
  listUnallocatedFunds,
} from "@starter/shared/payment/admin";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** Everything under one prefix, for a screen that opens a different tab. */
export const paymentAdminKeys = { all: ["payment-admin"] as const };

// A back-office screen shows its error state instead of retrying silently for
// seven seconds; the ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export const routingQuery = (query: Query<typeof getPaymentRouting>) => ({
  ...endpointQueryOptions(getPaymentRouting, { query }),
  ...RETRY,
});

export const terminalsQuery = (query: Query<typeof listEdcTerminals>) => ({
  ...endpointQueryOptions(listEdcTerminals, { query }),
  ...RETRY,
});

export const cashierDefaultsQuery = (
  query: Query<typeof getEdcCashierDefaults>,
) => ({
  ...endpointQueryOptions(getEdcCashierDefaults, { query }),
  ...RETRY,
});

export const refundsQuery = (query: Query<typeof listRefunds>) => ({
  ...endpointQueryOptions(listRefunds, { query }),
  ...RETRY,
});

export const refundablePaymentsQuery = (
  query: Query<typeof listRefundablePayments>,
) => ({
  ...endpointQueryOptions(listRefundablePayments, { query }),
  ...RETRY,
});

export const unallocatedFundsQuery = (
  query: Query<typeof listUnallocatedFunds>,
) => ({
  ...endpointQueryOptions(listUnallocatedFunds, { query }),
  ...RETRY,
});

export const refundReconHoldsQuery = (
  query: Query<typeof listRefundReconHolds>,
) => ({
  ...endpointQueryOptions(listRefundReconHolds, { query }),
  ...RETRY,
});

export const reconciliationCasesQuery = (
  query: Query<typeof listReconciliationCases>,
) => ({
  ...endpointQueryOptions(listReconciliationCases, { query }),
  ...RETRY,
});

export const reconciliationSummaryQuery = (
  query: Query<typeof getReconciliationSummary>,
) => ({
  ...endpointQueryOptions(getReconciliationSummary, { query }),
  ...RETRY,
});

export const settlementsQuery = (query: Query<typeof listSettlements>) => ({
  ...endpointQueryOptions(listSettlements, { query }),
  ...RETRY,
});
