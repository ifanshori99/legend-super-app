// One typed caller per public reservation endpoint this flow uses (PRD v1.7
// §3.22 "Reservasi & Event", §4 Alur H). Each caller unwraps the `{ data }`
// envelope, so hooks and components see the payload the contract describes.
// Components never call these directly — they go through ./hooks.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createReservation,
  getReservationAvailability,
  joinWaitlist,
  listPublicReservationPackages,
  type ReservationAvailabilityQuery,
} from "@starter/shared/reservation";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** What the guest form sends; brands live on the response, not the request. */
export type CreateBookingBody = Body<typeof createReservation>;
export type JoinWaitlistBody = Body<typeof joinWaitlist>;
// `EndpointInput` widens a `clientInputSchema` query to unknown; the contract's
// own inferred type keeps `pax`/`date` typed for the form guard.
export type AvailabilityQuery = ReservationAvailabilityQuery;

/** RSV-01: free tables per candidate start time for a date, pax and zone. */
export const fetchAvailability = async (
  params: Params<typeof getReservationAvailability>,
  query: Query<typeof getReservationAvailability>,
  options?: CallOptions,
) =>
  (await callEndpoint(getReservationAvailability, { params, query }, options))
    .data;

/** Active event pre-order packages shown under the guest details (§3.22). */
export const fetchPackages = async (
  params: Params<typeof listPublicReservationPackages>,
  options?: CallOptions,
) =>
  (await callEndpoint(listPublicReservationPackages, { params }, options)).data;

/**
 * RSV-02: books the slot. One Idempotency-Key per attempt, so a retry of the
 * same form reuses the key and the server returns the first reservation
 * (and its DP link) instead of making a second one.
 */
export const createBooking = async (
  params: Params<typeof createReservation>,
  body: Body<typeof createReservation>,
  idempotencyKey: string,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      createReservation,
      { params, body },
      { ...options, headers: { "Idempotency-Key": idempotencyKey } },
    )
  ).data;

/** Walk-in waitlist entry; the response carries the quoted wait estimate. */
export const joinWaitlistEntry = async (
  params: Params<typeof joinWaitlist>,
  body: Body<typeof joinWaitlist>,
  idempotencyKey: string,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      joinWaitlist,
      { params, body },
      { ...options, headers: { "Idempotency-Key": idempotencyKey } },
    )
  ).data;
