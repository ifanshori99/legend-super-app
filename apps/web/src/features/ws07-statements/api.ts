// One typed caller per statement/period endpoint the two screens use
// (docs/frontend.md "Typed endpoints and mock mode"). Responses are unwrapped
// from their `{ data }` envelope. Components never call these directly: they
// use the hooks in ./hooks.ts, which own cache keys and invalidation.
//
// The fiscal-period list and the legal-entity list belong to the existing
// WS-07 back office; this feature imports its callers instead of duplicating
// them, so both screens share one cache entry.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  approvePeriodReopen as approvePeriodReopenEndpoint,
  closeFiscalPeriod as closeFiscalPeriodEndpoint,
  closeFiscalPeriodOverride as closeFiscalPeriodOverrideEndpoint,
  getBalanceSheet as getBalanceSheetEndpoint,
  getCashFlow as getCashFlowEndpoint,
  getEquityChanges as getEquityChangesEndpoint,
  getMultiEntityProfitAndLoss as getMultiEntityProfitAndLossEndpoint,
  getPeriodSnapshot as getPeriodSnapshotEndpoint,
  getProfitAndLoss as getProfitAndLossEndpoint,
  getStatementDrillDown as getStatementDrillDownEndpoint,
  getTrialBalance as getTrialBalanceEndpoint,
  listManualJournals as listManualJournalsEndpoint,
  listPeriodCloseBlockers as listPeriodCloseBlockersEndpoint,
  listPeriodReopenRequests as listPeriodReopenRequestsEndpoint,
  rejectPeriodReopen as rejectPeriodReopenEndpoint,
  requestPeriodReopen as requestPeriodReopenEndpoint,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Statements ------------------------------------------------------------

export async function fetchTrialBalance(
  query: Query<typeof getTrialBalanceEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getTrialBalanceEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function fetchBalanceSheet(
  query: Query<typeof getBalanceSheetEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getBalanceSheetEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function fetchProfitAndLoss(
  query: Query<typeof getProfitAndLossEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getProfitAndLossEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function fetchMultiEntityProfitAndLoss(
  query: Query<typeof getMultiEntityProfitAndLossEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getMultiEntityProfitAndLossEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function fetchCashFlow(
  query: Query<typeof getCashFlowEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getCashFlowEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function fetchEquityChanges(
  query: Query<typeof getEquityChangesEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getEquityChangesEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

/** ACC-03: the journal lines behind one statement row (cursor pages). */
export async function fetchStatementDrillDown(
  query: Query<typeof getStatementDrillDownEndpoint>,
  signal?: AbortSignal,
) {
  return callEndpoint(getStatementDrillDownEndpoint, { query }, { signal });
}

// ---- Fiscal periods and reopen requests -----------------------------------

export async function fetchPeriodSnapshot(
  fiscalPeriodId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getPeriodSnapshotEndpoint,
    {
      params: {
        fiscalPeriodId,
      } as Params<typeof getPeriodSnapshotEndpoint>,
    },
    { signal },
  );
  return response.data;
}

/** ACC-02: closing is version-guarded; the write carries an idempotency key. */
export async function closeFiscalPeriod(
  fiscalPeriodId: string,
  body: Omit<Body<typeof closeFiscalPeriodEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(closeFiscalPeriodEndpoint, {
    params: { fiscalPeriodId } as Params<typeof closeFiscalPeriodEndpoint>,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

/**
 * Parked stock sources that stop the close (card 1263). The close refusal
 * (422 PERIOD_INVENTORY_GL_BLOCKED) carries no list, so the dialog reads it here.
 */
export async function fetchPeriodCloseBlockers(
  fiscalPeriodId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listPeriodCloseBlockersEndpoint,
    {
      params: {
        fiscalPeriodId,
      } as Params<typeof listPeriodCloseBlockersEndpoint>,
    },
    { signal },
  );
  return response.data;
}

/**
 * Close over incomplete production batches with a written reason. The caller
 * owns the idempotency key (one per attempt, reused by a retry of the same
 * request), unlike the plain close, which mints a key per call.
 */
export async function closeFiscalPeriodOverride(
  fiscalPeriodId: string,
  body: Body<typeof closeFiscalPeriodOverrideEndpoint>,
) {
  const response = await callEndpoint(closeFiscalPeriodOverrideEndpoint, {
    params: {
      fiscalPeriodId,
    } as Params<typeof closeFiscalPeriodOverrideEndpoint>,
    body,
  });
  return response.data;
}

export async function requestPeriodReopen(
  fiscalPeriodId: string,
  reason: string,
) {
  const response = await callEndpoint(requestPeriodReopenEndpoint, {
    params: { fiscalPeriodId } as Params<typeof requestPeriodReopenEndpoint>,
    body: { reason },
  });
  return response.data;
}

export async function fetchPeriodReopenRequests(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listPeriodReopenRequestsEndpoint,
    {
      params: {
        legalEntityId,
      } as Params<typeof listPeriodReopenRequestsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function approvePeriodReopen(
  requestId: string,
  note: string | null,
) {
  const response = await callEndpoint(approvePeriodReopenEndpoint, {
    params: { requestId } as Params<typeof approvePeriodReopenEndpoint>,
    body: { note },
  });
  return response.data;
}

export async function rejectPeriodReopen(requestId: string, reason: string) {
  const response = await callEndpoint(rejectPeriodReopenEndpoint, {
    params: { requestId } as Params<typeof rejectPeriodReopenEndpoint>,
    body: { reason },
  });
  return response.data;
}

// ---- Close checklist support ----------------------------------------------

/**
 * Manual journals of the entity, all statuses. The close checklist counts the
 * drafts and pending approvals inside the period it is closing.
 */
export async function fetchManualJournals(
  query: Query<typeof listManualJournalsEndpoint>,
  signal?: AbortSignal,
) {
  return callEndpoint(listManualJournalsEndpoint, { query }, { signal });
}
