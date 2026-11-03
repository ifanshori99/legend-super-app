// Hooks for the device PIN pad and the override modal. Exported for the POS,
// captain and KDS beads (see index.ts).
import { useMutation, useQuery } from "@tanstack/react-query";
import type { VerifyStaffPinInput } from "@starter/shared/identity";
import {
  createApprovalRequestCall,
  getApprovalRequestCall,
  verifyStaffPinCall,
} from "./api.ts";

/** Switch user with a personal PIN (POST /api/staff-pins/verify). */
export function useVerifyStaffPin() {
  // gcTime 0: a settled verify (its variables are the PIN) leaves the cache
  // at once; usePinSession also resets it on settle.
  return useMutation({
    mutationFn: (input: VerifyStaffPinInput) => verifyStaffPinCall(input),
    gcTime: 0,
  });
}

export function useCreateApprovalRequest() {
  return useMutation({ mutationFn: createApprovalRequestCall });
}

/** UI cadence for the phone-approval wait; not a policy number. */
export const APPROVAL_POLL_MS = 3_000;

/**
 * Polls one approval request until it is decided. Polling stops once the
 * status leaves "pending" or the deadline passes (the screen then shows it
 * expired), pauses while the tab is hidden and ends on unmount. A failed read
 * keeps trying (the wait is on the supervisor, not on this device).
 */
export function useApprovalRequestPolling(requestId: string | null) {
  return useQuery({
    queryKey: ["device-pin", "approval", requestId],
    queryFn: ({ signal }) =>
      getApprovalRequestCall(requestId as string, signal),
    enabled: requestId !== null,
    refetchInterval: (query) => {
      const request = query.state.data?.data;
      if (!request) return APPROVAL_POLL_MS;
      return request.status === "pending" &&
        Date.now() < Date.parse(request.deadlineAt)
        ? APPROVAL_POLL_MS
        : false;
    },
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  });
}
