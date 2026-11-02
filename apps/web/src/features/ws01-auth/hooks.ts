import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MfaEnrollInput, MfaVerifyInput } from "@starter/shared/identity";
import {
  removeMfaFactor,
  revokeDeviceSession,
  startMfaEnrollment,
  verifySecondFactor,
} from "./api";
import {
  currentAuthQuery,
  mfaFactorsQuery,
  securitySessionsQuery,
  staffAuthKeys,
} from "./queries";

// Components only touch identity data through these hooks; keys, cache updates
// and invalidation live here. `useQuery` (not suspense) keeps the loading,
// empty and error states of each section under its own control.

/** AUTH-05 state of this session; refetch when the idle warning needs it. */
export function useCurrentAuth(options?: {
  refetchInterval?: number;
  enabled?: boolean;
}) {
  return useQuery({
    ...currentAuthQuery({ refetchInterval: options?.refetchInterval }),
    enabled: options?.enabled,
  });
}

export function useMfaFactors() {
  return useQuery(mfaFactorsQuery());
}

export function useSecuritySessions() {
  return useQuery(securitySessionsQuery());
}

/** Starts enrollment and refreshes the factor list; the secret is shown once. */
export function useEnrollMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MfaEnrollInput) => startMfaEnrollment(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffAuthKeys.all }),
  });
}

/** AUTH-05: verifies this session (or finishes enrollment), then refreshes. */
export function useVerifyMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MfaVerifyInput) => verifySecondFactor(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffAuthKeys.all }),
  });
}

export function useDeleteMfaFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (factorId: string) => removeMfaFactor(factorId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffAuthKeys.all }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => revokeDeviceSession(sessionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffAuthKeys.all }),
  });
}
