// Hooks for the device PIN pad and the override modal. Exported for the POS,
// captain and KDS beads (see index.ts).
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createApprovalRequestCall,
  getApprovalRequestCall,
  verifyStaffPinCall,
} from "./api.ts";

/** Switch user with a personal PIN (POST /api/staff-pins/verify). */
export function useVerifyStaffPin() {
  return useMutation({ mutationFn: (pin: string) => verifyStaffPinCall(pin) });
}

export function useCreateApprovalRequest() {
  return useMutation({ mutationFn: createApprovalRequestCall });
}

/** UI cadence for the phone-approval wait; not a policy number. */
export const APPROVAL_POLL_MS = 3_000;

/**
 * Polls one approval request until it is decided. Polling stops once the
 * status leaves "pending"; a failed read keeps trying (the wait is on the
 * supervisor, not on this device).
 */
export function useApprovalRequestPolling(requestId: string | null) {
  return useQuery({
    queryKey: ["device-pin", "approval", requestId],
    queryFn: ({ signal }) =>
      getApprovalRequestCall(requestId as string, signal),
    enabled: requestId !== null,
    refetchInterval: (query) =>
      query.state.data?.data.status === "pending" || !query.state.data
        ? APPROVAL_POLL_MS
        : false,
    retry: false,
    gcTime: 0,
  });
}
