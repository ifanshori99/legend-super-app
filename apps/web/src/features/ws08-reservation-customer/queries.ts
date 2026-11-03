// Query keys and options for the guest booking flow. Keys are
// `[endpoint.id, input]` (docs/frontend.md), so invalidating the endpoint id
// refreshes every view of that resource.
import { queryOptions } from "@tanstack/react-query";
import {
  getReservationAvailability,
  listPublicReservationPackages,
} from "@starter/shared/reservation";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";
import type { AvailabilityQuery } from "./api";

/** Another guest can take a slot at any time; a short cache keeps it honest. */
export const AVAILABILITY_STALE_MS = 30_000;

export function availabilityQuery(outletId: string, query: AvailabilityQuery) {
  const input = { params: { outletId }, query };
  return queryOptions({
    queryKey: endpointQueryKey(getReservationAvailability, input),
    queryFn: ({ signal }) =>
      api.fetchAvailability(input.params, input.query, { signal }),
    staleTime: AVAILABILITY_STALE_MS,
    retry: 1,
  });
}

/** Packages change with the outlet's event plan, not with every keystroke. */
export function packagesQuery(outletId: string) {
  const input = { params: { outletId } };
  return queryOptions({
    queryKey: endpointQueryKey(listPublicReservationPackages, input),
    queryFn: ({ signal }) => api.fetchPackages(input.params, { signal }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
