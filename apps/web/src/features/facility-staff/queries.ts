// Query keys and queryOptions for the staff facility screens. Keys are
// hierarchical so one mutation refreshes exactly the lists it changed: a
// cleaning action refreshes every board, an incident action refreshes the
// incident logs (docs/frontend.md "Query options and keys").
import { queryOptions } from "@tanstack/react-query";
import * as api from "./api.ts";

export const staffKeys = {
  all: ["facility-staff"] as const,
  facilities: () => [...staffKeys.all, "facilities"] as const,
  configs: () => [...staffKeys.all, "config"] as const,
  config: (facilityId: string) => [...staffKeys.configs(), facilityId] as const,
  boards: () => [...staffKeys.all, "board"] as const,
  board: (facilityId: string) => [...staffKeys.boards(), facilityId] as const,
  incidentLists: () => [...staffKeys.all, "incidents"] as const,
  incidents: (facilityId: string) =>
    [...staffKeys.incidentLists(), facilityId] as const,
};

export function facilitiesQuery() {
  return queryOptions({
    queryKey: staffKeys.facilities(),
    queryFn: ({ signal }) => api.fetchFacilities(signal),
  });
}

export function facilityConfigQuery(facilityId: string) {
  return queryOptions({
    queryKey: staffKeys.config(facilityId),
    queryFn: ({ signal }) => api.fetchFacilityConfig(facilityId, signal),
    staleTime: 5 * 60_000,
  });
}

/** The staff board is live: status decides whether a unit can be sold. */
export function unitBoardQuery(facilityId: string) {
  return queryOptions({
    queryKey: staffKeys.board(facilityId),
    queryFn: ({ signal }) => api.fetchUnitBoard(facilityId, signal),
    staleTime: 0,
  });
}

/** FAC-08: a raised signal must show up without a manual reload. */
export function incidentsQuery(facilityId: string) {
  return queryOptions({
    queryKey: staffKeys.incidents(facilityId),
    queryFn: ({ signal }) => api.fetchIncidents(facilityId, signal),
    staleTime: 0,
  });
}
