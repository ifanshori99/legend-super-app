// The only way components touch reservation data: queries keep their endpoint
// keys, every write invalidates the lists, the open detail and the floor board
// the change can touch.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getReservation,
  listRescheduleRequests,
  listReservations,
  listWaitlist,
} from "@starter/shared/reservation";
import type {
  Reservation,
  ReservationPackage,
  ReservationRescheduleRequest,
  WaitlistEntry,
} from "@starter/shared/reservation";

// Ids are branded on the wire; the contract exports the schemas, so the
// branded types come from the row shapes they belong to.
type ReservationId = Reservation["id"];
type ReservationPackageId = ReservationPackage["id"];
type WaitlistEntryId = WaitlistEntry["id"];
type RescheduleRequestId = ReservationRescheduleRequest["id"];
import { getFloorBoard } from "@starter/shared/qr-order";
import type { TableId } from "@starter/shared/qr-order";
import type { ListReservationsQuery } from "@starter/shared/reservation";
import * as api from "./api";
import { RESERVATION_PAGE_SIZE } from "./api";
import {
  floorBoardQuery,
  packagesQuery,
  reservationDetailQuery,
  rescheduleRequestsQuery,
  reservationsQuery,
  waitlistQuery,
  type RescheduleRequestsQuery,
  type WaitlistQuery,
} from "./queries";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

/** A write can change the schedule, the open detail and the floor board. */
const RESERVATION_WRITES = [
  listReservations,
  getReservation,
  getFloorBoard,
] as const;

function useReservationMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const refresh = useInvalidate(RESERVATION_WRITES);
  // Settled, not only success (Opus review): a 409 such as
  // RESERVATION_SLOT_TAKEN means the desk's view is stale, so the conflict
  // map and the detail must refetch before the host tries again (RSV-01).
  return useMutation({ mutationFn, onSettled: () => refresh() });
}

export function useReservations(
  outletId: string | undefined,
  query: ListReservationsQuery,
) {
  return useQuery({
    ...reservationsQuery(outletId ?? "", query),
    enabled: Boolean(outletId),
  });
}

export function useReservationDetail(
  outletId: string | undefined,
  reservationId: string | undefined,
) {
  return useQuery({
    ...reservationDetailQuery(outletId ?? "", reservationId ?? ""),
    enabled: Boolean(outletId && reservationId),
  });
}

export function usePackages(outletId: string | undefined) {
  return useQuery({
    ...packagesQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useWaitlist(
  outletId: string | undefined,
  query: WaitlistQuery = { limit: RESERVATION_PAGE_SIZE },
) {
  return useQuery({
    ...waitlistQuery(outletId ?? "", query),
    enabled: Boolean(outletId),
  });
}

export function useRescheduleRequests(
  outletId: string | undefined,
  query: RescheduleRequestsQuery = { limit: RESERVATION_PAGE_SIZE },
) {
  return useQuery({
    ...rescheduleRequestsQuery(outletId ?? "", query),
    enabled: Boolean(outletId),
  });
}

export function useFloorPlan(outletId: string | undefined) {
  return useQuery({
    ...floorBoardQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

/** RSV-01: the API refuses a table another reservation holds in the slot. */
export function useAssignTables() {
  return useReservationMutation(
    (input: {
      outletId: string;
      reservationId: ReservationId;
      tableIds: TableId[];
    }) =>
      api.assignTables(
        { outletId: input.outletId, reservationId: input.reservationId },
        { tableIds: input.tableIds },
      ),
  );
}

/** RSV-02: seating opens the table session for the party. */
export function useSeatReservation() {
  return useReservationMutation(
    (input: {
      outletId: string;
      reservationId: ReservationId;
      tableIds: TableId[];
    }) =>
      api.seatReservation(
        { outletId: input.outletId, reservationId: input.reservationId },
        { tableIds: input.tableIds },
      ),
  );
}

/** RSV-02: resend the DP link of a booking that still waits for its DP. */
export function useResendDepositLink() {
  return useReservationMutation(
    (input: { outletId: string; reservationId: ReservationId }) =>
      api.resendDepositLink({
        outletId: input.outletId,
        reservationId: input.reservationId,
      }),
  );
}

/** RSV-03: the result carries what the frozen policy says about the DP. */
export function useCancelReservation() {
  return useReservationMutation(
    (input: {
      outletId: string;
      reservationId: ReservationId;
      reason: string;
    }) =>
      api.cancelReservation(
        { outletId: input.outletId, reservationId: input.reservationId },
        { reason: input.reason },
      ),
  );
}

export function useMarkNoShow() {
  return useReservationMutation(
    (input: {
      outletId: string;
      reservationId: ReservationId;
      note?: string;
    }) =>
      api.markNoShow(
        { outletId: input.outletId, reservationId: input.reservationId },
        { note: input.note },
      ),
  );
}

export function usePlacePreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      outletId: string;
      reservationId: ReservationId;
      packageId: ReservationPackageId;
    }) =>
      api.placePreOrder(
        { outletId: input.outletId, reservationId: input.reservationId },
        { packageId: input.packageId },
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [getReservation.id] }),
        queryClient.invalidateQueries({ queryKey: [listReservations.id] }),
      ]),
  });
}

function useWaitlistMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  // Seating a walk-in opens a table session, so the floor board and the
  // reservation conflict view change too; refresh on errors as well, since a
  // 409 means the queue moved under the host.
  const refresh = useInvalidate([
    listWaitlist,
    getFloorBoard,
    listReservations,
  ]);
  return useMutation({ mutationFn, onSettled: () => refresh() });
}

export function useCallWaitlistEntry() {
  return useWaitlistMutation(
    (input: { outletId: string; entryId: WaitlistEntryId }) =>
      api.callWaitlistEntry({
        outletId: input.outletId,
        entryId: input.entryId,
      }),
  );
}

export function useResolveWaitlistEntry() {
  return useWaitlistMutation(
    (input: {
      outletId: string;
      entryId: WaitlistEntryId;
      resolution: "seated" | "left" | "cancelled";
      tableIds?: TableId[];
    }) =>
      api.resolveWaitlistEntry(
        { outletId: input.outletId, entryId: input.entryId },
        { resolution: input.resolution, tableIds: input.tableIds },
      ),
  );
}

function useRescheduleMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  // Approving moves the booking and its table holds; refresh on errors too,
  // since a 409 means the request or the table changed under the host.
  const refresh = useInvalidate([
    listRescheduleRequests,
    ...RESERVATION_WRITES,
  ]);
  return useMutation({ mutationFn, onSettled: () => refresh() });
}

export function useApproveRescheduleRequest() {
  return useRescheduleMutation(
    (input: { outletId: string; requestId: RescheduleRequestId }) =>
      api.approveRescheduleRequest({
        outletId: input.outletId,
        requestId: input.requestId,
      }),
  );
}

export function useDeclineRescheduleRequest() {
  return useRescheduleMutation(
    (input: {
      outletId: string;
      requestId: RescheduleRequestId;
      reason?: string;
    }) =>
      api.declineRescheduleRequest(
        { outletId: input.outletId, requestId: input.requestId },
        { reason: input.reason },
      ),
  );
}
