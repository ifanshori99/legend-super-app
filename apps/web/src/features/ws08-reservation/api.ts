// One typed caller per reservation-desk endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Each caller unwraps the `{ data }` envelope so
// hooks and components see the payload the contract describes; list endpoints
// stay cursor pages. Components never call these directly — they use
// ./hooks.ts, which owns cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  approveRescheduleRequest as approveRescheduleRequestEndpoint,
  assignReservationTables as assignReservationTablesEndpoint,
  cancelReservation as cancelReservationEndpoint,
  callWaitlistEntry as callWaitlistEntryEndpoint,
  declineRescheduleRequest as declineRescheduleRequestEndpoint,
  getReservation as getReservationEndpoint,
  listReservationPackages as listReservationPackagesEndpoint,
  listRescheduleRequests as listRescheduleRequestsEndpoint,
  listReservations as listReservationsEndpoint,
  listWaitlist as listWaitlistEndpoint,
  markReservationNoShow as markReservationNoShowEndpoint,
  placeReservationPreOrder as placeReservationPreOrderEndpoint,
  resendReservationDepositLink as resendReservationDepositLinkEndpoint,
  resolveWaitlistEntry as resolveWaitlistEntryEndpoint,
  seatReservation as seatReservationEndpoint,
} from "@starter/shared/reservation";
import { getFloorBoard as getFloorBoardEndpoint } from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** A day's schedule fits one page; the desk never needs a second cursor. */
export const RESERVATION_PAGE_SIZE = 100;

export const fetchReservations = (
  params: Params<typeof listReservationsEndpoint>,
  query: Query<typeof listReservationsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listReservationsEndpoint, { params, query }, options);

export const fetchReservation = async (
  params: Params<typeof getReservationEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getReservationEndpoint, { params }, options)).data;

/** RSV-01: the server refuses a table another reservation holds. */
export const assignTables = async (
  params: Params<typeof assignReservationTablesEndpoint>,
  body: Body<typeof assignReservationTablesEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      assignReservationTablesEndpoint,
      { params, body },
      options,
    )
  ).data;

/** RSV-02: seating opens the table session and allocates the paid DP. */
export const seatReservation = async (
  params: Params<typeof seatReservationEndpoint>,
  body: Body<typeof seatReservationEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(seatReservationEndpoint, { params, body }, options)).data;

/** RSV-03: the close payload tells the host what happens to the DP. */
export const cancelReservation = async (
  params: Params<typeof cancelReservationEndpoint>,
  body: Body<typeof cancelReservationEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(cancelReservationEndpoint, { params, body }, options))
    .data;

export const markNoShow = async (
  params: Params<typeof markReservationNoShowEndpoint>,
  body: Body<typeof markReservationNoShowEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(markReservationNoShowEndpoint, { params, body }, options))
    .data;

/** RSV-02: the link is a guest credential; the host copies or sends it once. */
export const resendDepositLink = async (
  params: Params<typeof resendReservationDepositLinkEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      resendReservationDepositLinkEndpoint,
      { params, body: {} },
      {
        ...options,
        headers: { "Idempotency-Key": newIdempotencyKey() },
      },
    )
  ).data;

export const placePreOrder = async (
  params: Params<typeof placeReservationPreOrderEndpoint>,
  body: Body<typeof placeReservationPreOrderEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      placeReservationPreOrderEndpoint,
      { params, body },
      options,
    )
  ).data;

export const fetchPackages = async (
  params: Params<typeof listReservationPackagesEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(listReservationPackagesEndpoint, { params }, options))
    .data;

export const fetchWaitlist = (
  params: Params<typeof listWaitlistEndpoint>,
  query: Query<typeof listWaitlistEndpoint>,
  options?: CallOptions,
) => callEndpoint(listWaitlistEndpoint, { params, query }, options);

/** The FE does the browser notification when this resolves. */
export const callWaitlistEntry = async (
  params: Params<typeof callWaitlistEntryEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(callWaitlistEntryEndpoint, { params }, options)).data;

export const resolveWaitlistEntry = async (
  params: Params<typeof resolveWaitlistEntryEndpoint>,
  body: Body<typeof resolveWaitlistEntryEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(resolveWaitlistEntryEndpoint, { params, body }, options))
    .data;

export const fetchRescheduleRequests = (
  params: Params<typeof listRescheduleRequestsEndpoint>,
  query: Query<typeof listRescheduleRequestsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listRescheduleRequestsEndpoint, { params, query }, options);

/** A taken table answers 409 RESERVATION_SLOT_TAKEN and the request stays pending. */
export const approveRescheduleRequest = async (
  params: Params<typeof approveRescheduleRequestEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      approveRescheduleRequestEndpoint,
      { params, body: {} },
      options,
    )
  ).data;

export const declineRescheduleRequest = async (
  params: Params<typeof declineRescheduleRequestEndpoint>,
  body: Body<typeof declineRescheduleRequestEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      declineRescheduleRequestEndpoint,
      { params, body },
      options,
    )
  ).data;

/** Zones and tables for the assignment floor plan (WS-03 read model). */
export const fetchFloorBoard = async (
  params: Params<typeof getFloorBoardEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(getFloorBoardEndpoint, { params, query: {} }, options))
    .data;
