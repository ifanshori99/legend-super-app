// Hooks for the staff facility screens: components never call the API or
// useQuery directly (docs/frontend.md, "Custom hooks"). Every mutation
// invalidates the query it can change, and the board is the source of truth for
// unit status across all four screens.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api.ts";
import {
  facilityConfigQuery,
  facilitiesQuery,
  incidentsQuery,
  staffKeys,
  unitBoardQuery,
} from "./queries.ts";
import { pickStaffFacility } from "./staff-facility.ts";

export function useFacilities() {
  return useQuery(facilitiesQuery());
}

/**
 * Resolve the facility the staff screens work on (see `pickStaffFacility`).
 * With no facility the screens show an honest empty state.
 */
export function useStaffFacility(
  requestedFacilityId?: string,
  options?: { releasedOnly?: boolean },
) {
  const facilities = useFacilities();
  const list = facilities.data?.data ?? [];
  const facility = pickStaffFacility(list, requestedFacilityId, options);
  const config = useQuery({
    ...facilityConfigQuery(facility?.id ?? ""),
    enabled: facility !== null,
  });
  return { facilities, facility, config };
}

export function useUnitBoard(facilityId: string | null) {
  return useQuery({
    ...unitBoardQuery(facilityId ?? ""),
    enabled: Boolean(facilityId),
  });
}

export function useIncidents(facilityId: string | null) {
  return useQuery({
    ...incidentsQuery(facilityId ?? ""),
    enabled: Boolean(facilityId),
  });
}

/** Invalidate every board and config: a unit changed on one facility. */
function invalidateUnitData(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: staffKeys.boards() }),
    queryClient.invalidateQueries({ queryKey: staffKeys.configs() }),
  ]);
}

export function useCreateCleaningTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateCleaningTaskBody) =>
      api.createCleaningTaskForUnit(body),
    onSuccess: () => invalidateUnitData(queryClient),
  });
}

export function useStartCleaningTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; body: api.StartCleaningTaskBody }) =>
      api.startCleaningTaskById(input.taskId, input.body),
    onSuccess: () => invalidateUnitData(queryClient),
  });
}

export function useCompleteCleaningTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      taskId: string;
      body: api.CompleteCleaningTaskBody;
    }) => api.completeCleaningTaskById(input.taskId, input.body),
    onSuccess: () => invalidateUnitData(queryClient),
  });
}

export function useUpdateFacilityUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { unitId: string; body: api.UpdateFacilityUnitBody }) =>
      api.updateUnit(input.unitId, input.body),
    onSuccess: () => invalidateUnitData(queryClient),
  });
}

export function useRaiseFacilityIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: api.RaiseFacilityIncidentBody;
      idempotencyKey: string;
    }) => api.raiseIncident(input.body, input.idempotencyKey),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffKeys.incidentLists() }),
  });
}

export function useRespondFacilityIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      incidentId: string;
      body: api.RespondFacilityIncidentBody;
    }) => api.respondToIncident(input.incidentId, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffKeys.incidentLists() }),
  });
}
