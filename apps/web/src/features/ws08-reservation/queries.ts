// Query keys and options for the reservation desk. Keys are
// `[endpoint.id, input]` (docs/frontend.md), so invalidating `[endpoint.id]`
// refreshes every view of that resource.
import { queryOptions } from "@tanstack/react-query";
import { listExampleOutlets } from "@starter/shared/api";
import {
  getReservation,
  listReservationPackages,
  listReservations,
  listWaitlist,
} from "@starter/shared/reservation";
import type {
  ListReservationsQuery,
  WaitlistStatus,
} from "@starter/shared/reservation";
import { getFloorBoard } from "@starter/shared/qr-order";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

/** The desk is live: poll slowly enough to stay quiet, fast enough to trust. */
export const DESK_REFETCH_MS = 30_000;

export type WaitlistQuery = {
  status?: WaitlistStatus;
  limit: number;
};

export const outletsQuery = () =>
  queryOptions({
    queryKey: endpointQueryKey(listExampleOutlets, { query: { limit: 20 } }),
    queryFn: ({ signal }) => api.fetchOutlets({ signal }),
    // One quick retry, then the error state with its own "Coba lagi" button.
    retry: 1,
  });

export const reservationsQuery = (
  outletId: string,
  query: ListReservationsQuery,
) =>
  queryOptions({
    queryKey: endpointQueryKey(listReservations, {
      params: { outletId },
      query,
    }),
    queryFn: ({ signal }) =>
      api.fetchReservations({ outletId }, query, { signal }),
    refetchInterval: DESK_REFETCH_MS,
    staleTime: DESK_REFETCH_MS / 3,
    retry: 1,
  });

export const reservationDetailQuery = (
  outletId: string,
  reservationId: string,
) =>
  queryOptions({
    queryKey: endpointQueryKey(getReservation, {
      params: { outletId, reservationId },
    }),
    queryFn: ({ signal }) =>
      api.fetchReservation({ outletId, reservationId }, { signal }),
    retry: 1,
  });

export const packagesQuery = (outletId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(listReservationPackages, {
      params: { outletId },
    }),
    queryFn: ({ signal }) => api.fetchPackages({ outletId }, { signal }),
    retry: 1,
  });

export const waitlistQuery = (outletId: string, query: WaitlistQuery) =>
  queryOptions({
    queryKey: endpointQueryKey(listWaitlist, {
      params: { outletId },
      query,
    }),
    queryFn: ({ signal }) => api.fetchWaitlist({ outletId }, query, { signal }),
    refetchInterval: DESK_REFETCH_MS,
    staleTime: DESK_REFETCH_MS / 3,
    retry: 1,
  });

/** Zones and tables of the assignment floor plan (WS-03 read model). */
export const floorBoardQuery = (outletId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getFloorBoard, { params: { outletId } }),
    queryFn: ({ signal }) => api.fetchFloorBoard({ outletId }, { signal }),
    staleTime: DESK_REFETCH_MS,
    retry: 1,
  });
