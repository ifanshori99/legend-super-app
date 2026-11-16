// One typed caller per payment back-office endpoint (docs/frontend.md "Add a
// feature's UI"). Components never call these directly: they use the hooks in
// ./hooks.ts, which own cache keys and invalidation. The mock in ./mock.ts
// serves the same contracts when VITE_API_MOCK=true.
import { defineEndpoint } from "@starter/shared/api";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { dataResponseSchema, z } from "@starter/shared/core";
import {
  integrationConnectionTestSchema,
  tenantIntegrationIdSchema,
} from "@starter/shared/platform";
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
  rejectRefund as rejectRefundEndpoint,
  releaseQuarantinedRefund as releaseQuarantinedRefundEndpoint,
  reopenQuarantinedRefund as reopenQuarantinedRefundEndpoint,
  resolveReconciliationCase as resolveReconciliationCaseEndpoint,
  resolveUnallocatedFund as resolveUnallocatedFundEndpoint,
  retryRefundPayout as retryRefundPayoutEndpoint,
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
  idempotencyKey: string,
) =>
  callEndpoint(
    updatePaymentRouteEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

// ---- EDC terminals and cashier defaults ----------------------------------

export const fetchEdcTerminals = (
  query: Query<typeof listEdcTerminalsEndpoint>,
) => callEndpoint(listEdcTerminalsEndpoint, { query });

export const addEdcTerminal = (
  body: Body<typeof createEdcTerminalEndpoint>,
  idempotencyKey: string,
) =>
  callEndpoint(
    createEdcTerminalEndpoint,
    { body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

export const patchEdcTerminal = (
  params: Params<typeof updateEdcTerminalEndpoint>,
  body: Body<typeof updateEdcTerminalEndpoint>,
  idempotencyKey: string,
) =>
  callEndpoint(
    updateEdcTerminalEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

export const fetchEdcCashierDefaults = (
  query: Query<typeof getEdcCashierDefaultsEndpoint>,
) => callEndpoint(getEdcCashierDefaultsEndpoint, { query });

export const saveEdcCashierDefault = (
  params: Params<typeof updateEdcCashierDefaultEndpoint>,
  body: Body<typeof updateEdcCashierDefaultEndpoint>,
  idempotencyKey: string,
) =>
  callEndpoint(
    updateEdcCashierDefaultEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

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

export const rejectRefund = (
  params: Params<typeof rejectRefundEndpoint>,
  body: Body<typeof rejectRefundEndpoint>,
) => callEndpoint(rejectRefundEndpoint, { params, body });

/** Also the "check status" action: after an attempt the API only looks up. */
export const retryRefundPayout = (
  params: Params<typeof retryRefundPayoutEndpoint>,
  body: Body<typeof retryRefundPayoutEndpoint>,
) => callEndpoint(retryRefundPayoutEndpoint, { params, body });

export const releaseQuarantinedRefund = (
  params: Params<typeof releaseQuarantinedRefundEndpoint>,
  body: Body<typeof releaseQuarantinedRefundEndpoint>,
) => callEndpoint(releaseQuarantinedRefundEndpoint, { params, body });

export const reopenQuarantinedRefund = (
  params: Params<typeof reopenQuarantinedRefundEndpoint>,
  body: Body<typeof reopenQuarantinedRefundEndpoint>,
) => callEndpoint(reopenQuarantinedRefundEndpoint, { params, body });

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
  idempotencyKey: string,
) =>
  callEndpoint(
    resolveReconciliationCaseEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

// ---- Duitku credentials (sub-302 D16) ------------------------------------

// The API serves POST /api/org/integrations/:integrationId/test but the shared
// `orgEndpoints` does not declare it yet, so this feature declares it with the
// contract's own schemas (same pattern as ws01-tenant-settings/endpoints.ts).
export const testIntegrationConnectionEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/org/integrations/:integrationId/test",
  params: z.strictObject({ integrationId: tenantIntegrationIdSchema }),
  response: dataResponseSchema(integrationConnectionTestSchema),
});

export const testIntegrationConnection = (integrationId: string) =>
  callEndpoint(testIntegrationConnectionEndpoint, {
    params: { integrationId },
  });
