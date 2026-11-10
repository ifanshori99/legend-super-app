import { queryOptions } from "@tanstack/react-query";
import type { OutletId } from "@starter/shared/core";
import { fetchExpoBoard, fetchExpoRunners, fetchPickupDisplay } from "./api.ts";

// Both boards are live views of the kitchen: the expo tablet and the wall
// display pick up a change without a reload (PRD §3 F12). Polling keeps the
// screen correct while the edge WebSocket feed (WS-04 BE) is not wired yet.
const EXPO_REFRESH_MS = 15_000;
const PICKUP_REFRESH_MS = 10_000;
/** Runner names change with the roster, not with the service. */
const RUNNERS_STALE_MS = 60_000;

export const expoKeys = {
  all: ["kitchen", "expo"] as const,
  board: (outletId: OutletId | undefined) =>
    [...expoKeys.all, outletId, "board"] as const,
  runners: (outletId: OutletId | undefined) =>
    [...expoKeys.all, outletId, "runners"] as const,
};

export const pickupKeys = {
  all: ["kitchen", "pickup"] as const,
  display: (outletId: OutletId | undefined) =>
    [...pickupKeys.all, outletId, "display"] as const,
};

/** No outlet selected (null): the query stays off. */
export function expoBoardQuery(outletId: OutletId | undefined) {
  return queryOptions({
    queryKey: expoKeys.board(outletId),
    queryFn: ({ signal }) => fetchExpoBoard(outletId!, signal),
    enabled: outletId !== undefined,
    refetchInterval: EXPO_REFRESH_MS,
  });
}

export function expoRunnersQuery(outletId: OutletId | undefined) {
  return queryOptions({
    queryKey: expoKeys.runners(outletId),
    queryFn: ({ signal }) => fetchExpoRunners(outletId!, signal),
    enabled: outletId !== undefined,
    staleTime: RUNNERS_STALE_MS,
  });
}

export function pickupDisplayQuery(outletId: OutletId | undefined) {
  return queryOptions({
    queryKey: pickupKeys.display(outletId),
    queryFn: ({ signal }) => fetchPickupDisplay(outletId!, signal),
    enabled: outletId !== undefined,
    refetchInterval: PICKUP_REFRESH_MS,
  });
}
