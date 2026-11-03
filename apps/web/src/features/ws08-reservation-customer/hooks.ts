// Hooks for the guest booking flow: one read per availability query, one read
// for the pre-order packages, and mutations that return the contract payload.
// Components never call ./api.ts directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReservationAvailability,
  listPublicReservationPackages,
} from "@starter/shared/reservation";
import * as api from "./api";
import type {
  AvailabilityQuery,
  CreateBookingBody,
  JoinWaitlistBody,
} from "./api";
import { availabilityQuery, packagesQuery } from "./queries";
import { isBusinessDate, saveConfirmation, submitProblemOf } from "./lib";

/** RSV-01 availability; stays idle until the form holds a usable date and pax. */
export function useAvailability(outletId: string, query: AvailabilityQuery) {
  return useQuery({
    ...availabilityQuery(outletId, query),
    enabled: isBusinessDate(query.date) && query.pax >= 1,
  });
}

export function useReservationPackages(outletId: string) {
  return useQuery(packagesQuery(outletId));
}

/** RSV-02: one reservation per Idempotency-Key; a retry reuses the same key. */
export function useCreateBooking(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: CreateBookingBody; idempotencyKey: string }) =>
      api.createBooking({ outletId }, input.body, input.idempotencyKey),
    onSuccess: (created) => {
      // Saved here, not in the component's mutate callback: the guest may
      // switch to the waitlist while the request is in flight, which unmounts
      // the form, and the DP link must not be lost (RSV-02).
      saveConfirmation(created);
      // The chosen slot is gone now; the next guest sees fresh availability.
      void queryClient.invalidateQueries({
        queryKey: [getReservationAvailability.id],
      });
    },
    onError: (error) => {
      // A slot or package another guest just took: refresh both lists so the
      // guest picks from what is really free.
      const problem = submitProblemOf(error);
      if (problem === "slot" || problem === "package")
        void queryClient.invalidateQueries({
          queryKey: [
            problem === "slot"
              ? getReservationAvailability.id
              : listPublicReservationPackages.id,
          ],
        });
    },
  });
}

export function useJoinWaitlist(outletId: string) {
  return useMutation({
    mutationFn: (input: { body: JoinWaitlistBody; idempotencyKey: string }) =>
      api.joinWaitlistEntry({ outletId }, input.body, input.idempotencyKey),
  });
}
