// One typed caller per profit-share endpoint the back office uses (docs/frontend.md
// "Typed endpoints and mock mode"). Responses are unwrapped from their `{ data }`
// envelope so components and query options never see it. Components never call
// these directly: they use the hooks in ./hooks.ts, which own cache keys and
// invalidation.
//
// Writes carry a fresh idempotency key minted per user attempt (contracts.md
// "Typed web client & idempotency headers"), exactly like ws07-accounting/api.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  cancelApprovedDistributionRun as cancelApprovedDistributionRunEndpoint,
  createAdjustmentDistribution as createAdjustmentDistributionEndpoint,
  createDistributionRun as createDistributionRunEndpoint,
  createProfitEntity as createProfitEntityEndpoint,
  createShareholder as createShareholderEndpoint,
  createShareAllocationVersion as createShareAllocationVersionEndpoint,
  decideDistributionRun as decideDistributionRunEndpoint,
  decideShareAllocationVersion as decideShareAllocationVersionEndpoint,
  getDistributionRun as getDistributionRunEndpoint,
  getDistributionStatement as getDistributionStatementEndpoint,
  getShareAllocationVersion as getShareAllocationVersionEndpoint,
  listDistributionRuns as listDistributionRunsEndpoint,
  listProfitEntities as listProfitEntitiesEndpoint,
  listShareAllocationVersions as listShareAllocationVersionsEndpoint,
  listShareholders as listShareholdersEndpoint,
  recordDistributionPayment as recordDistributionPaymentEndpoint,
  submitDistributionRun as submitDistributionRunEndpoint,
  submitShareAllocationVersion as submitShareAllocationVersionEndpoint,
  updateProfitEntity as updateProfitEntityEndpoint,
  updateShareholder as updateShareholderEndpoint,
  updateShareAllocationVersion as updateShareAllocationVersionEndpoint,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Profit entities & policy (PRD §3.37) --------------------------------

export async function fetchProfitEntities(signal?: AbortSignal) {
  const response = await callEndpoint(
    listProfitEntitiesEndpoint,
    {},
    { signal },
  );
  return response.data;
}

export async function createProfitEntity(
  body: Body<typeof createProfitEntityEndpoint>,
) {
  const response = await callEndpoint(createProfitEntityEndpoint, { body });
  return response.data;
}

export async function updateProfitEntity(
  profitEntityId: string,
  body: Body<typeof updateProfitEntityEndpoint>,
) {
  const response = await callEndpoint(updateProfitEntityEndpoint, {
    params: { profitEntityId } as Params<typeof updateProfitEntityEndpoint>,
    body,
  });
  return response.data;
}

// ---- Shareholder register -------------------------------------------------

export async function fetchShareholders(signal?: AbortSignal) {
  const response = await callEndpoint(listShareholdersEndpoint, {}, { signal });
  return response.data;
}

export async function createShareholder(
  body: Body<typeof createShareholderEndpoint>,
) {
  const response = await callEndpoint(createShareholderEndpoint, { body });
  return response.data;
}

export async function updateShareholder(
  shareholderId: string,
  body: Body<typeof updateShareholderEndpoint>,
) {
  const response = await callEndpoint(updateShareholderEndpoint, {
    params: { shareholderId } as Params<typeof updateShareholderEndpoint>,
    body,
  });
  return response.data;
}

// ---- Share allocation versions (SH-03) -----------------------------------

export async function fetchShareVersions(
  profitEntityId: string,
  status?: Query<typeof listShareAllocationVersionsEndpoint>["status"],
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listShareAllocationVersionsEndpoint,
    {
      params: { profitEntityId } as Params<
        typeof listShareAllocationVersionsEndpoint
      >,
      query: {
        ...(status ? { status } : {}),
      },
    },
    { signal },
  );
  return response.data;
}

export async function fetchShareVersion(
  profitEntityId: string,
  version: number,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getShareAllocationVersionEndpoint,
    { params: { profitEntityId, version } },
    { signal },
  );
  return response.data;
}

export async function createShareVersion(
  profitEntityId: string,
  body: Omit<
    Body<typeof createShareAllocationVersionEndpoint>,
    "idempotencyKey"
  >,
) {
  const response = await callEndpoint(createShareAllocationVersionEndpoint, {
    params: { profitEntityId } as Params<
      typeof createShareAllocationVersionEndpoint
    >,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function updateShareVersion(
  profitEntityId: string,
  version: number,
  body: Body<typeof updateShareAllocationVersionEndpoint>,
) {
  const response = await callEndpoint(updateShareAllocationVersionEndpoint, {
    params: { profitEntityId, version },
    body,
  });
  return response.data;
}

export async function submitShareVersion(
  profitEntityId: string,
  version: number,
) {
  const response = await callEndpoint(submitShareAllocationVersionEndpoint, {
    params: { profitEntityId, version },
    body: { idempotencyKey: createUlid() },
  });
  return response.data;
}

export type VersionDecision = Body<typeof decideShareAllocationVersionEndpoint>;

export async function decideShareVersion(
  profitEntityId: string,
  version: number,
  decision: "approve" | "reject",
  note: string | null,
) {
  const response = await callEndpoint(decideShareAllocationVersionEndpoint, {
    params: { profitEntityId, version },
    body: {
      decision,
      note: note?.trim() ? note.trim() : null,
      idempotencyKey: createUlid(),
    },
  });
  return response.data;
}

// ---- Distribution cycle (SH-04) ------------------------------------------

export async function fetchDistributionRuns(
  profitEntityId: string,
  query: Omit<Query<typeof listDistributionRunsEndpoint>, "cursor">,
  signal?: AbortSignal,
) {
  return callEndpoint(
    listDistributionRunsEndpoint,
    {
      params: { profitEntityId } as Params<typeof listDistributionRunsEndpoint>,
      query,
    },
    { signal },
  );
}

export async function fetchDistributionRun(
  distributionRunId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getDistributionRunEndpoint,
    {
      params: { distributionRunId } as Params<
        typeof getDistributionRunEndpoint
      >,
    },
    { signal },
  );
  return response.data;
}

export async function createDistributionRun(
  profitEntityId: string,
  body: Omit<Body<typeof createDistributionRunEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(createDistributionRunEndpoint, {
    params: { profitEntityId } as Params<typeof createDistributionRunEndpoint>,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function submitDistributionRun(distributionRunId: string) {
  const response = await callEndpoint(submitDistributionRunEndpoint, {
    params: { distributionRunId } as Params<
      typeof submitDistributionRunEndpoint
    >,
    body: { idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function decideDistributionRun(
  distributionRunId: string,
  decision: "approve" | "reject",
  note: string | null,
) {
  const response = await callEndpoint(decideDistributionRunEndpoint, {
    params: { distributionRunId } as Params<
      typeof decideDistributionRunEndpoint
    >,
    body: {
      decision,
      note: note?.trim() ? note.trim() : null,
      idempotencyKey: createUlid(),
    },
  });
  return response.data;
}

export async function cancelApprovedDistributionRun(
  distributionRunId: string,
  reason: string,
) {
  const response = await callEndpoint(cancelApprovedDistributionRunEndpoint, {
    params: { distributionRunId } as Params<
      typeof cancelApprovedDistributionRunEndpoint
    >,
    body: { reason: reason.trim(), idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function recordDistributionPayment(
  distributionRunId: string,
  distributionLineId: string,
  body: Omit<Body<typeof recordDistributionPaymentEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(recordDistributionPaymentEndpoint, {
    params: { distributionRunId, distributionLineId },
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function createAdjustmentDistribution(
  distributionRunId: string,
  body: Omit<
    Body<typeof createAdjustmentDistributionEndpoint>,
    "idempotencyKey"
  >,
) {
  const response = await callEndpoint(createAdjustmentDistributionEndpoint, {
    params: { distributionRunId } as Params<
      typeof createAdjustmentDistributionEndpoint
    >,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function fetchDistributionStatement(
  distributionRunId: string,
  distributionLineId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getDistributionStatementEndpoint,
    { params: { distributionRunId, distributionLineId } },
    { signal },
  );
  return response.data;
}
