// One typed caller per payment back-office endpoint (docs/frontend.md "Add a
// feature's UI"). Components never call these directly: they use the hooks in
// ./hooks.ts, which own cache keys and invalidation. The mock in ./mock.ts
// serves the same contracts when VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  approveRefund as approveRefundEndpoint,
  createEdcTerminal as createEdcTerminalEndpoint,
  createRefund as createRefundEndpoint,
  getEdcCashierDefaults as getEdcCashierDefaultsEndpoint,
  getPaymentRouting as getPaymentRoutingEndpoint,
  getReconciliationSummary as getReconciliationSummaryEndpoint,
  listEdcTerminals as listEdcTerminalsEndpoint,
  listReconciliationCases as listReconciliationCasesEndpoint,
  listRefundablePayments as listRefundablePaymentsEndpoint,
  listRefunds as listRefundsEndpoint,
  listUnallocatedFunds as listUnallocatedFundsEndpoint,
  resolveReconciliationCase as resolveReconciliationCaseEndpoint,
  resolveUnallocatedFund as resolveUnallocatedFundEndpoint,
  updateEdcCashierDefault as updateEdcCashierDefaultEndpoint,
  updateEdcTerminal as updateEdcTerminalEndpoint,
  updatePaymentRoute as updatePaymentRouteEndpoint,
} from "@starter/shared/payment/admin";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Routing -------------------------------------------------------------

export const fetchPaymentRouting = (
  query: Query<typeof getPaymentRoutingEndpoint>,
) => callEndpoint(getPaymentRoutingEndpoint, { query });

export const savePaymentRoute = (
  params: Params<typeof updatePaymentRouteEndpoint>,
  body: Body<typeof updatePaymentRouteEndpoint>,
) => callEndpoint(updatePaymentRouteEndpoint, { params, body });

// ---- EDC terminals and cashier defaults ----------------------------------

export const fetchEdcTerminals = (
  query: Query<typeof listEdcTerminalsEndpoint>,
) => callEndpoint(listEdcTerminalsEndpoint, { query });

export const addEdcTerminal = (body: Body<typeof createEdcTerminalEndpoint>) =>
  callEndpoint(createEdcTerminalEndpoint, { body });

export const patchEdcTerminal = (
  params: Params<typeof updateEdcTerminalEndpoint>,
  body: Body<typeof updateEdcTerminalEndpoint>,
) => callEndpoint(updateEdcTerminalEndpoint, { params, body });

export const fetchEdcCashierDefaults = (
  query: Query<typeof getEdcCashierDefaultsEndpoint>,
) => callEndpoint(getEdcCashierDefaultsEndpoint, { query });

export const saveEdcCashierDefault = (
  params: Params<typeof updateEdcCashierDefaultEndpoint>,
  body: Body<typeof updateEdcCashierDefaultEndpoint>,
) => callEndpoint(updateEdcCashierDefaultEndpoint, { params, body });

// ---- Refunds -------------------------------------------------------------

export const fetchRefunds = (query: Query<typeof listRefundsEndpoint>) =>
  callEndpoint(listRefundsEndpoint, { query });

export const fetchRefundablePayments = (
  query: Query<typeof listRefundablePaymentsEndpoint>,
) => callEndpoint(listRefundablePaymentsEndpoint, { query });

export const addRefund = (body: Body<typeof createRefundEndpoint>) =>
  callEndpoint(createRefundEndpoint, { body });

export const approveRefund = (
  params: Params<typeof approveRefundEndpoint>,
  body: Body<typeof approveRefundEndpoint>,
) => callEndpoint(approveRefundEndpoint, { params, body });

// ---- Unallocated funds (PAY-04) ------------------------------------------

export const fetchUnallocatedFunds = (
  query: Query<typeof listUnallocatedFundsEndpoint>,
) => callEndpoint(listUnallocatedFundsEndpoint, { query });

export const resolveUnallocatedFund = (
  params: Params<typeof resolveUnallocatedFundEndpoint>,
  body: Body<typeof resolveUnallocatedFundEndpoint>,
) => callEndpoint(resolveUnallocatedFundEndpoint, { params, body });

// ---- Settlement reconciliation (EDC-06) ----------------------------------

export const fetchReconciliationCases = (
  query: Query<typeof listReconciliationCasesEndpoint>,
) => callEndpoint(listReconciliationCasesEndpoint, { query });

export const fetchReconciliationSummary = (
  query: Query<typeof getReconciliationSummaryEndpoint>,
) => callEndpoint(getReconciliationSummaryEndpoint, { query });

export const resolveReconciliationCase = (
  params: Params<typeof resolveReconciliationCaseEndpoint>,
  body: Body<typeof resolveReconciliationCaseEndpoint>,
) => callEndpoint(resolveReconciliationCaseEndpoint, { params, body });
