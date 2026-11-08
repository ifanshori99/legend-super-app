// Query keys and options for the POS kasir screens. A payment session polls
// while an attempt waits for the bank or the EDC; everything else is fetched on
// demand and refreshed by the mutations in ./hooks.ts.
import { queryOptions } from "@tanstack/react-query";
import {
  fetchActiveShift,
  fetchCashMovements,
  fetchDayCloseRecap,
  fetchEdcTerminals,
  fetchEwallets,
  fetchPaymentMethods,
  fetchPaymentSession,
  fetchRegisteredTerminals,
  fetchShiftReview,
  fetchSupervisors,
  fetchVaBanks,
} from "./api";

export const posKasirKeys = {
  all: ["pos-kasir"] as const,
  session: (orderId: string) => ["pos-kasir", "session", orderId] as const,
  methods: (orderId: string) => ["pos-kasir", "methods", orderId] as const,
  edcTerminals: ["pos-kasir", "edc-terminals"] as const,
  vaBanks: ["pos-kasir", "va-banks"] as const,
  ewallets: ["pos-kasir", "ewallets"] as const,
  shift: ["pos-kasir", "shift"] as const,
  movements: (shiftId: string) => ["pos-kasir", "movements", shiftId] as const,
  terminals: ["pos-kasir", "terminals"] as const,
  supervisors: ["pos-kasir", "supervisors"] as const,
  review: (shiftId: string) => ["pos-kasir", "review", shiftId] as const,
  day: ["pos-kasir", "day"] as const,
};

/** Poll gaps while a payment waits: EDC answers fast, gateways slower. */
export const EDC_POLL_MS = 1000;
export const GATEWAY_POLL_MS = 3000;

export function paymentSessionQuery(outletId: string, orderId: string) {
  return queryOptions({
    queryKey: posKasirKeys.session(orderId),
    queryFn: ({ signal }) => fetchPaymentSession(outletId, orderId, signal),
    refetchInterval: (query) => {
      const attempt = query.state.data?.activeAttempt;
      if (!attempt || attempt.status !== "waiting") return false;
      return attempt.method === "edc" ? EDC_POLL_MS : GATEWAY_POLL_MS;
    },
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export const paymentMethodsQuery = (orderId: string) =>
  queryOptions({
    queryKey: posKasirKeys.methods(orderId),
    queryFn: () => fetchPaymentMethods(),
    retry: false,
  });

export const edcTerminalsQuery = () =>
  queryOptions({
    queryKey: posKasirKeys.edcTerminals,
    queryFn: () => fetchEdcTerminals(),
    retry: false,
  });

export const vaBanksQuery = () =>
  queryOptions({
    queryKey: posKasirKeys.vaBanks,
    queryFn: () => fetchVaBanks(),
    retry: false,
  });

export const ewalletsQuery = () =>
  queryOptions({
    queryKey: posKasirKeys.ewallets,
    queryFn: () => fetchEwallets(),
    retry: false,
  });

export const activeShiftQuery = (outletId: string) =>
  queryOptions({
    queryKey: posKasirKeys.shift,
    queryFn: ({ signal }) => fetchActiveShift(outletId, signal),
    retry: false,
  });

export const cashMovementsQuery = (outletId: string, shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.movements(shiftId),
    queryFn: ({ signal }) => fetchCashMovements(outletId, shiftId, signal),
    retry: false,
  });

export const registeredTerminalsQuery = () =>
  queryOptions({
    queryKey: posKasirKeys.terminals,
    queryFn: () => fetchRegisteredTerminals(),
    retry: false,
  });

export const supervisorsQuery = () =>
  queryOptions({
    queryKey: posKasirKeys.supervisors,
    queryFn: () => fetchSupervisors(),
    retry: false,
  });

export const shiftReviewQuery = (shiftId: string) =>
  queryOptions({
    queryKey: posKasirKeys.review(shiftId),
    queryFn: () => fetchShiftReview(shiftId),
    retry: false,
  });

export const dayCloseRecapQuery = (
  outletId: string,
  businessDate: string,
  cutoff: string,
) =>
  queryOptions({
    queryKey: [...posKasirKeys.day, businessDate] as const,
    queryFn: ({ signal }) =>
      fetchDayCloseRecap(outletId, businessDate, cutoff, signal),
    retry: false,
  });
