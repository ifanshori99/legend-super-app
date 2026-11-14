// Query key and options for the guest's reservation view. The key holds the
// link token, which lives in memory only (the cache is never persisted).
import { queryOptions } from "@tanstack/react-query";
import { fetchGuestReservation } from "./api.ts";
import { guestErrorKind } from "./lib.ts";

export const guestReservationKeys = {
  all: ["reservation-guest"] as const,
  view: (token: string) =>
    [...guestReservationKeys.all, "view", token] as const,
};

export function guestReservationQuery(token: string) {
  return queryOptions({
    queryKey: guestReservationKeys.view(token),
    queryFn: ({ signal }) => fetchGuestReservation(token, signal),
    // A bad link and a rate limit are final answers; only a flaky read retries.
    retry: (count, error) => {
      const kind = guestErrorKind(error);
      return kind !== "invalid" && kind !== "rate_limited" && count < 1;
    },
    staleTime: 30_000,
  });
}
