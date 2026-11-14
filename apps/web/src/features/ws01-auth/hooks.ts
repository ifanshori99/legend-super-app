import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MfaEnrollInput,
  MfaRecoveryVerifyInput,
  MfaVerifyInput,
} from "@starter/shared/identity";
import {
  createMfaRecoveryCodes,
  extendStaffSession,
  removeMfaFactor,
  revokeAlarmDevice,
  revokeDeviceSession,
  startMfaEnrollment,
  submitMfaRecoveryCode,
  verifySecondFactor,
} from "./api";
import {
  currentAuthQuery,
  mfaFactorsQuery,
  mfaRecoveryStatusQuery,
  pushDevicesQuery,
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

/**
 * Finishes enrollment without refreshing the session queries: the refresh
 * would make a guarded page treat the session as verified and unmount the
 * enrollment before the recovery codes are shown. The caller refreshes with
 * `useRefreshStaffAuth` once the codes are saved.
 */
export function useVerifyEnrollment() {
  return useMutation({
    mutationFn: (input: MfaVerifyInput) => verifySecondFactor(input),
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

export function usePushDevices() {
  return useQuery(pushDevicesQuery());
}

/** Revokes one alarm phone; the list refreshes so the phone disappears. */
export function useRevokePushDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeAlarmDevice(id),
    // Not awaited: the dialog closes now and the list refreshes behind it.
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: staffAuthKeys.pushDevices(),
      });
    },
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

/** AUTH-05: only an explicit action extends the current staff session. */
export function useExtendStaffSession() {
  return useMutation({ mutationFn: extendStaffSession });
}

export function useMfaRecoveryStatus() {
  return useQuery(mfaRecoveryStatusQuery());
}

/**
 * Generates a new set (the old one stops working). `gcTime: 0` keeps the
 * plaintext codes out of the mutation cache once the component is gone; they
 * are shown once and never stored.
 */
export function useGenerateRecoveryCodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createMfaRecoveryCodes,
    gcTime: 0,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: staffAuthKeys.recovery() }),
  });
}

/**
 * Signs in with a recovery code. It does not refresh the session queries here:
 * that would swap the page to "already verified" before the success state is
 * shown. The caller refreshes with `useRefreshStaffAuth` on "Lanjutkan".
 */
export function useVerifyRecoveryCode() {
  return useMutation({
    mutationFn: (input: MfaRecoveryVerifyInput) => submitMfaRecoveryCode(input),
  });
}

export function useRefreshStaffAuth() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: staffAuthKeys.all });
}
