// Query keys and options for the POS kasir screens. A payment session polls
// while an attempt waits for the bank or the EDC; everything else is fetched on
// demand and refreshed by the mutations in ./hooks.ts.
import { queryOptions } from "@tanstack/react-query";
import {
  fetchEdcTerminals,
  fetchResolveApprovers,
  fetchEwallets,
  fetchPaymentMethods,
  fetchPaymentSession,
  fetchPointsAccount,
  fetchVaBanks,
} from "./api";
import {
  fetchActiveShift,
  fetchCashMovements,
  fetchDayCloseRecap,
  fetchOpenShiftsOfDay,
  fetchRegisteredTerminals,
  fetchShiftReview,
  fetchSupervisors,
} from "./shift-api";
import {
  fetchForceCloseView,
  fetchHeldCashOuts,
  fetchOwnCountSummary,
  fetchWitnesses,
} from "./shift-extra-api";
import type { ForceCloseViewer } from "./shift-extra-types";
import type { OverrideAction } from "./types";

// Every key carries the outlet: a cashier who switches outlet must never see
// another outlet's session, shift or recap from the cache.
export const posKasirKeys = {
  all: ["pos-kasir"] as const,
  session: (outletId: string, orderId: string) =>
    ["pos-kasir", outletId, "session", orderId] as const,
  methods: (outletId: string, orderId: string) =>
    ["pos-kasir", outletId, "methods", orderId] as const,
  points: (outletId: string, orderId: string) =>
    ["pos-kasir", outletId, "points", orderId] as const,
  edcTerminals: (outletId: string) =>
    ["pos-kasir", outletId, "edc-terminals"] as const,
  edcApprovers: (outletId: string) =>
    ["pos-kasir", outletId, "edc-approvers"] as const,
  vaBanks: (outletId: string) => ["pos-kasir", outletId, "va-banks"] as const,
  ewallets: (outletId: string) => ["pos-kasir", outletId, "ewallets"] as const,
  shift: (outletId: string) => ["pos-kasir", outletId, "shift"] as const,
  movements: (outletId: string, shiftId: string) =>
    ["pos-kasir", outletId, "movements", shiftId] as const,
  terminals: (outletId: string) =>
    ["pos-kasir", outletId, "terminals"] as const,
  supervisors: (outletId: string) =>
    ["pos-kasir", outletId, "supervisors"] as const,
  review: (outletId: string, shiftId: string) =>
    ["pos-kasir", outletId, "review", shiftId] as const,
  held: (outletId: string, shiftId: string) =>
    ["pos-kasir", outletId, "held-cash-outs", shiftId] as const,
  ownCount: (outletId: string, shiftId: string) =>
    ["pos-kasir", outletId, "own-count", shiftId] as const,
  forceClose: (outletId: string, shiftId: string) =>
    ["pos-kasir", outletId, "force-close", shiftId] as const,
  witnesses: (outletId: string) =>
    ["pos-kasir", outletId, "witnesses"] as const,
  day: (outletId: string, businessDate: string) =>
    ["pos-kasir", outletId, "day", businessDate] as const,
  openShifts: (outletId: string, businessDate: string) =>
    ["pos-kasir", outletId, "day", businessDate, "open-shifts"] as const,
};

/** Poll gaps while a payment waits: EDC answers fast, gateways slower. */
export const EDC_POLL_MS = 1000;
export const GATEWAY_POLL_MS = 3000;

export function paymentSessionQuery(outletId: string, orderId: string) {
  return queryOptions({
    queryKey: posKasirKeys.session(outletId, orderId),
    queryFn: ({ signal }) => fetchPaymentSession(outletId, orderId, signal),
    refetchInterval: (query) => {
      const attempt = query.state.data?.activeAttempt;
      if (
        !attempt ||
        (attempt.status !== "waiting" && attempt.status !== "cancelling")
      )
        return false;
      return attempt.method === "edc" ? EDC_POLL_MS : GATEWAY_POLL_MS;
    },
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export const paymentMethodsQuery = (outletId: string, orderId: string) =>
  queryOptions({
    queryKey: posKasirKeys.methods(outletId, orderId),
    queryFn: () => fetchPaymentMethods(outletId),
    retry: false,
  });

/** The member on the order and their points; null when there is no member. */
export const pointsAccountQuery = (outletId: string, orderId: string) =>
  queryOptions({
    queryKey: posKasirKeys.points(outletId, orderId),
    queryFn: () => fetchPointsAccount(orderId),
    retry: false,
  });

export const edcTerminalsQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.edcTerminals(outletId),
    queryFn: () => fetchEdcTerminals(outletId),
    retry: false,
  });

export const resolveApproversQuery = (
  outletId: string,
  action: "void" | "edc_standalone",
) =>
  queryOptions({
    queryKey: [...posKasirKeys.edcApprovers(outletId), "resolve", action],
    queryFn: () => fetchResolveApprovers(outletId, action),
    retry: false,
  });

export const vaBanksQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.vaBanks(outletId),
    queryFn: () => fetchVaBanks(outletId),
    retry: false,
  });

export const ewalletsQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.ewallets(outletId),
    queryFn: () => fetchEwallets(outletId),
    retry: false,
  });

export const activeShiftQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.shift(outletId),
    queryFn: ({ signal }) => fetchActiveShift(outletId, signal),
    retry: false,
  });

export const cashMovementsQuery = (outletId: string, shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.movements(outletId, shiftId),
    queryFn: ({ signal }) => fetchCashMovements(outletId, shiftId, signal),
    retry: false,
  });

export const registeredTerminalsQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.terminals(outletId),
    queryFn: () => fetchRegisteredTerminals(),
    retry: false,
  });

export const supervisorsQuery = (outletId: string, action?: OverrideAction) =>
  queryOptions({
    queryKey: [...posKasirKeys.supervisors(outletId), action ?? "any"],
    queryFn: () => fetchSupervisors(outletId, action),
    retry: false,
  });

export const shiftReviewQuery = (outletId: string, shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.review(outletId, shiftId),
    queryFn: () => fetchShiftReview(shiftId),
    retry: false,
  });

export const heldCashOutsQuery = (outletId: string, shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.held(outletId, shiftId),
    queryFn: ({ signal }) => fetchHeldCashOuts(outletId, shiftId, signal),
    retry: false,
  });

export const ownCountSummaryQuery = (outletId: string, shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.ownCount(outletId, shiftId),
    queryFn: () => fetchOwnCountSummary(outletId, shiftId),
    retry: false,
  });

export const forceCloseViewQuery = (
  outletId: string,
  shiftId: string,
  viewer: ForceCloseViewer,
) =>
  queryOptions({
    queryKey: posKasirKeys.forceClose(outletId, shiftId),
    queryFn: ({ signal }) =>
      fetchForceCloseView(outletId, shiftId, viewer, signal),
    retry: false,
  });

export const witnessesQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.witnesses(outletId),
    queryFn: () => fetchWitnesses(outletId),
    retry: false,
  });

export const dayCloseRecapQuery = (
  outletId: string,
  businessDate: string,
  cutoff: string,
) =>
  queryOptions({
    queryKey: posKasirKeys.day(outletId, businessDate),
    queryFn: ({ signal }) =>
      fetchDayCloseRecap(outletId, businessDate, cutoff, signal),
    retry: false,
  });

/** Review K P1: the day's open shifts, each a link to its force close. */
export const openShiftsOfDayQuery = (outletId: string, businessDate: string) =>
  queryOptions({
    queryKey: posKasirKeys.openShifts(outletId, businessDate),
    queryFn: ({ signal }) =>
      fetchOpenShiftsOfDay(outletId, businessDate, signal),
    retry: false,
  });
