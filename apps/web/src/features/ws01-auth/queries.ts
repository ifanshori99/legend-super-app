// Query keys and options for the staff security screens. Keys are hierarchical
// so a verification or a revoke can refresh exactly what changed.
import { queryOptions } from "@tanstack/react-query";
import {
  fetchCurrentAuth,
  fetchMfaFactors,
  fetchMfaRecoveryStatus,
  fetchPushDevices,
  fetchSessions,
} from "./api";

export const staffAuthKeys = {
  all: ["ws01-auth"] as const,
  current: () => [...staffAuthKeys.all, "current"] as const,
  factors: () => [...staffAuthKeys.all, "factors"] as const,
  sessions: () => [...staffAuthKeys.all, "sessions"] as const,
  pushDevices: () => [...staffAuthKeys.all, "push-devices"] as const,
  recovery: () => [...staffAuthKeys.all, "recovery"] as const,
};

/**
 * AUTH-05 state of this session. Never polled on a timer and never refetched
 * on window focus: reading it can count as session activity server-side, which
 * would defeat the 30-minute idle end (§3 F6). Callers refetch on user action.
 */
export function currentAuthQuery(options?: { refetchInterval?: number }) {
  return queryOptions({
    queryKey: staffAuthKeys.current(),
    queryFn: ({ signal }) => fetchCurrentAuth(signal),
    refetchInterval: options?.refetchInterval,
    refetchOnWindowFocus: false,
  });
}

export function mfaFactorsQuery() {
  return queryOptions({
    queryKey: staffAuthKeys.factors(),
    queryFn: ({ signal }) => fetchMfaFactors(signal),
  });
}

export function securitySessionsQuery() {
  return queryOptions({
    queryKey: staffAuthKeys.sessions(),
    queryFn: ({ signal }) => fetchSessions(signal),
  });
}

export function pushDevicesQuery() {
  return queryOptions({
    queryKey: staffAuthKeys.pushDevices(),
    queryFn: ({ signal }) => fetchPushDevices(signal),
  });
}

export function mfaRecoveryStatusQuery() {
  return queryOptions({
    queryKey: staffAuthKeys.recovery(),
    queryFn: ({ signal }) => fetchMfaRecoveryStatus(signal),
  });
}
