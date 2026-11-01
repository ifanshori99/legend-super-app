import { queryOptions } from "@tanstack/react-query";
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
  board: () => [...expoKeys.all, "board"] as const,
  runners: () => [...expoKeys.all, "runners"] as const,
};

export const pickupKeys = {
  all: ["kitchen", "pickup"] as const,
  display: () => [...pickupKeys.all, "display"] as const,
};

export function expoBoardQuery() {
  return queryOptions({
    queryKey: expoKeys.board(),
    queryFn: ({ signal }) => fetchExpoBoard(signal),
    refetchInterval: EXPO_REFRESH_MS,
  });
}

export function expoRunnersQuery() {
  return queryOptions({
    queryKey: expoKeys.runners(),
    queryFn: ({ signal }) => fetchExpoRunners(signal),
    staleTime: RUNNERS_STALE_MS,
  });
}

export function pickupDisplayQuery() {
  return queryOptions({
    queryKey: pickupKeys.display(),
    queryFn: ({ signal }) => fetchPickupDisplay(signal),
    refetchInterval: PICKUP_REFRESH_MS,
  });
}
