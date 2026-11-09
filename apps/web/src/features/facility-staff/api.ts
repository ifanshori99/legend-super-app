// Typed calls for the facility staff endpoints (WS-09, PRD v1.7 §3 F25
// "Siklus Kebersihan" + "Keselamatan", FAC-06/FAC-08). Every function goes
// through a `defineEndpoint` contract object, so mock mode and the future API
// validate the same shapes and the screen returns the `data` payload instead of
// repeating the envelope (docs/frontend.md "Typed endpoints and mock mode").
import {
  completeCleaningTask,
  createCleaningTask,
  getFacilityConfig,
  getFacilityUnitBoard,
  listFacilities,
  listFacilityIncidents,
  raiseFacilityIncident,
  respondFacilityIncident,
  startCleaningTask,
  updateFacilityUnit,
} from "@starter/shared/facility";
import type { EndpointInput } from "@starter/shared/api";
import { callEndpoint } from "@/lib/api/endpoint.ts";

export { listFacilityIncidents };

/** Request bodies exactly as the contract accepts them (branded ids parsed). */
export type CreateCleaningTaskBody = EndpointInput<
  typeof createCleaningTask
>["body"];
export type StartCleaningTaskBody = EndpointInput<
  typeof startCleaningTask
>["body"];
export type CompleteCleaningTaskBody = EndpointInput<
  typeof completeCleaningTask
>["body"];
export type UpdateFacilityUnitBody = EndpointInput<
  typeof updateFacilityUnit
>["body"];
export type RaiseFacilityIncidentBody = EndpointInput<
  typeof raiseFacilityIncident
>["body"];
export type RespondFacilityIncidentBody = EndpointInput<
  typeof respondFacilityIncident
>["body"];

/** The tenant's facilities: the staff screens resolve the one to work on. */
export async function fetchFacilities(signal?: AbortSignal) {
  return callEndpoint(listFacilities, { query: { limit: 50 } }, { signal });
}

export async function fetchFacilityConfig(
  facilityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getFacilityConfig,
    { query: { facilityId } },
    { signal },
  );
  return response.data;
}

/** GET /api/facility/units — staff board rows plus the server clock. */
export async function fetchUnitBoard(facilityId: string, signal?: AbortSignal) {
  const response = await callEndpoint(
    getFacilityUnitBoard,
    { query: { facilityId } },
    { signal },
  );
  return response.data;
}

/** The incident log read (see `listFacilityIncidents` above). */
export async function fetchIncidents(facilityId: string, signal?: AbortSignal) {
  return callEndpoint(
    listFacilityIncidents,
    { query: { facilityId, limit: 50 } },
    { signal },
  );
}

export async function createCleaningTaskForUnit(body: CreateCleaningTaskBody) {
  const response = await callEndpoint(createCleaningTask, { body });
  return response.data;
}

export async function startCleaningTaskById(
  taskId: string,
  body: StartCleaningTaskBody,
) {
  const response = await callEndpoint(startCleaningTask, {
    params: { taskId },
    body,
  });
  return response.data;
}

export async function completeCleaningTaskById(
  taskId: string,
  body: CompleteCleaningTaskBody,
) {
  const response = await callEndpoint(completeCleaningTask, {
    params: { taskId },
    body,
  });
  return response.data;
}

export async function updateUnit(unitId: string, body: UpdateFacilityUnitBody) {
  const response = await callEndpoint(updateFacilityUnit, {
    params: { unitId },
    body,
  });
  return response.data;
}

export async function raiseIncident(
  body: RaiseFacilityIncidentBody,
  idempotencyKey: string,
) {
  // The caller owns the key and reuses it for every retry of the same attempt,
  // so a retry cannot create a second incident (the API replays the first one).
  const response = await callEndpoint(
    raiseFacilityIncident,
    { body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return response.data;
}

export async function respondToIncident(
  incidentId: string,
  body: RespondFacilityIncidentBody,
) {
  const response = await callEndpoint(respondFacilityIncident, {
    params: { incidentId },
    body,
  });
  return response.data;
}
