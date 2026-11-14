// Hooks for the guest "kelola reservasi" page. The link token is read from the
// URL fragment in the browser only (never SSR), and the view is personal, so
// it is fetched in the browser only too. Components never call ./api.ts.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GuestCancelInput,
  GuestRescheduleInput,
} from "@starter/shared/reservation";
import { newIdempotencyKey } from "@/lib/idempotency";
import { publicSiteQuery } from "../ws08-website/queries";
import { postGuestCancel, postGuestReschedule } from "./api";
import { GUEST_DEFAULT_TIME_ZONE, readLinkToken } from "./lib";
import { guestReservationQuery } from "./queries";

/**
 * The token in `window.location.hash`: `undefined` on the server and before
 * mount (so SSR and the first client render match), then the token or `null`
 * when the fragment is missing or malformed. Follows `hashchange`.
 */
export function useLinkToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setToken(readLinkToken(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return token;
}

/** The reservation behind the link; idle until a token string exists. */
export function useGuestReservation(token: string | null | undefined) {
  const enabled = typeof token === "string";
  return useQuery({
    ...guestReservationQuery(token ?? ""),
    enabled,
  });
}

/**
 * One Idempotency-Key per form content: the same content (a retry after an
 * error) reuses the key, so the server returns the first answer instead of
 * acting twice; changed content gets a new key. A success clears it.
 */
function useAttemptKey() {
  const attempt = useRef<{ content: string; key: string } | null>(null);
  return {
    keyFor(input: unknown): string {
      const content = JSON.stringify(input);
      if (attempt.current?.content !== content)
        attempt.current = { content, key: newIdempotencyKey() };
      return attempt.current.key;
    },
    clear() {
      attempt.current = null;
    },
  };
}

/** Asks staff to move the booking; the result's view replaces the cached one. */
export function useRequestGuestReschedule(token: string) {
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: (input: GuestRescheduleInput) =>
      postGuestReschedule(token, input, attempt.keyFor(input)),
    onSuccess: (result) => {
      attempt.clear();
      queryClient.setQueryData(
        guestReservationQuery(token).queryKey,
        result.view,
      );
    },
  });
}

/** Cancels by the booking's policy; the cancelled view replaces the cached one. */
export function useCancelGuestReservation(token: string) {
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: (input: GuestCancelInput) =>
      postGuestCancel(token, input, attempt.keyFor(input)),
    onSuccess: (result) => {
      attempt.clear();
      queryClient.setQueryData(
        guestReservationQuery(token).queryKey,
        result.view,
      );
    },
  });
}

/**
 * The outlet's time zone from the public site data when it describes this
 * outlet, else WIB. `ready` turns true once the site read has settled (data or
 * failure), so the page can hold its loading screen instead of showing times
 * in WIB and then shifting them.
 */
export function useGuestTimeZone(outletId: string | undefined): {
  timeZone: string;
  ready: boolean;
} {
  const query = useQuery({
    ...publicSiteQuery(),
    enabled: typeof window !== "undefined" && outletId !== undefined,
  });
  const outlet = query.data?.outlet;
  const ready = outletId !== undefined && !query.isPending;
  if (outlet !== undefined && outlet.id === outletId) {
    return { timeZone: outlet.timeZone, ready };
  }
  // legend-z5ygw: view belum membawa timeZone
  return { timeZone: GUEST_DEFAULT_TIME_ZONE, ready };
}
