// One typed caller per AP/AR, fixed-asset and budget endpoint (bead
// legend-m4zn; docs/frontend.md "Typed endpoints and mock mode"). Responses are
// unwrapped from their `{ data }` envelope so components and query options
// never see it. Components use the hooks in ./hooks.ts, which own cache keys
// and invalidation. Writes mint an idempotency key like the rest of the
// accounting back office (features/ws07-accounting/api.ts).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  createFixedAsset as createFixedAssetEndpoint,
  disposeFixedAsset as disposeFixedAssetEndpoint,
  getAgingReport as getAgingReportEndpoint,
  getBudgetVsActual as getBudgetVsActualEndpoint,
  getFixedAsset as getFixedAssetEndpoint,
  listBudgets as listBudgetsEndpoint,
  listDepreciationRuns as listDepreciationRunsEndpoint,
  listFixedAssets as listFixedAssetsEndpoint,
  revalueFixedAsset as revalueFixedAssetEndpoint,
  runDepreciation as runDepreciationEndpoint,
  upsertBudgets as upsertBudgetsEndpoint,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Aging ----------------------------------------------------------------

export async function fetchAgingReport(
  query: Query<typeof getAgingReportEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getAgingReportEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

// ---- Fixed assets ---------------------------------------------------------

export async function fetchFixedAssets(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listFixedAssetsEndpoint,
    { params: { legalEntityId } as Params<typeof listFixedAssetsEndpoint> },
    { signal },
  );
  return response.data;
}

export async function fetchFixedAssetDetail(
  fixedAssetId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getFixedAssetEndpoint,
    { params: { fixedAssetId } as Params<typeof getFixedAssetEndpoint> },
    { signal },
  );
  return response.data;
}

export async function createFixedAsset(
  body: Omit<Body<typeof createFixedAssetEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(createFixedAssetEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function disposeFixedAsset(
  fixedAssetId: string,
  body: Omit<Body<typeof disposeFixedAssetEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(disposeFixedAssetEndpoint, {
    params: { fixedAssetId } as Params<typeof disposeFixedAssetEndpoint>,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function revalueFixedAsset(
  fixedAssetId: string,
  body: Omit<Body<typeof revalueFixedAssetEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(revalueFixedAssetEndpoint, {
    params: { fixedAssetId } as Params<typeof revalueFixedAssetEndpoint>,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function fetchDepreciationRuns(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listDepreciationRunsEndpoint,
    {
      params: {
        legalEntityId,
      } as Params<typeof listDepreciationRunsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function runDepreciation(
  body: Omit<Body<typeof runDepreciationEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(runDepreciationEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

// ---- Budgets --------------------------------------------------------------

export async function fetchBudgets(
  query: Query<typeof listBudgetsEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listBudgetsEndpoint,
    { query },
    { signal },
  );
  return response.data;
}

export async function upsertBudgets(body: Body<typeof upsertBudgetsEndpoint>) {
  const response = await callEndpoint(upsertBudgetsEndpoint, { body });
  return response.data;
}

export async function fetchBudgetVsActual(
  query: Query<typeof getBudgetVsActualEndpoint>,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getBudgetVsActualEndpoint,
    { query },
    { signal },
  );
  return response.data;
}
