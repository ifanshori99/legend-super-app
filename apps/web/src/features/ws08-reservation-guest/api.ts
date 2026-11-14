// One typed caller per guest self-service endpoint (RSV-03). The link token
// goes in the `X-Reservation-Link-Token` header, never in a path or query, so
// it stays out of access logs. Components use the hooks in ./hooks.ts.
import {
  cancelGuestReservation,
  getGuestReservation,
  requestGuestReschedule,
} from "@starter/shared/reservation";
import type {
  GuestCancelInput,
  GuestRescheduleInput,
} from "@starter/shared/reservation";
import { callEndpoint } from "@/lib/api/endpoint";

export async function fetchGuestReservation(
  token: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(getGuestReservation, undefined, {
    signal,
    headers: { "X-Reservation-Link-Token": token },
  });
  return data;
}

/** Cancels by the policy snapshot; one Idempotency-Key per form content. */
export async function postGuestCancel(
  token: string,
  body: GuestCancelInput,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    cancelGuestReservation,
    { body },
    {
      headers: {
        "X-Reservation-Link-Token": token,
        "Idempotency-Key": idempotencyKey,
      },
    },
  );
  return data;
}

/** Records a request only; staff decide and the booking stays as it is. */
export async function postGuestReschedule(
  token: string,
  body: GuestRescheduleInput,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    requestGuestReschedule,
    { body },
    {
      headers: {
        "X-Reservation-Link-Token": token,
        "Idempotency-Key": idempotencyKey,
      },
    },
  );
  return data;
}
