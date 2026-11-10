// The only way components touch open-bill data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OPEN_BILL_NOT_ELIGIBLE,
  getFloorBoard,
  getOpenBillPolicy,
  getSessionBill,
} from "@starter/shared/qr-order";
import type {
  OpenBillApprover,
  TableSessionId,
} from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import * as api from "./api";
import {
  openBillApproversQuery,
  openBillKeys,
  openBillPolicyQuery,
} from "./queries";

/** Open-bill limits of one outlet. */
export function useOpenBillPolicy(outletId: string | undefined) {
  return useQuery({
    ...openBillPolicyQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

/** Who may approve a conversion at this outlet (holds the permission + a PIN). */
export function useOpenBillApprovers(outletId: string | undefined) {
  return useQuery({
    ...openBillApproversQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useUpdateOpenBillPolicy(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.updateOpenBillPolicy>[1]) =>
      api.updateOpenBillPolicy({ outletId }, body),
    onSuccess: (policy) => {
      queryClient.setQueryData(openBillKeys.policy(outletId), policy);
    },
  });
}

/** Turns a running pay-first session into an open bill (approver, PIN, reason). */
export function useConvertToOpenBill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      sessionId: TableSessionId;
      reason: string;
      approverUserId: OpenBillApprover["userId"];
      pin: string;
    }) =>
      api.convertSessionToOpenBill(
        { sessionId: variables.sessionId },
        {
          reason: variables.reason,
          approverUserId: variables.approverUserId,
          pin: variables.pin,
        },
      ),
    onSuccess: () =>
      Promise.all(
        [getFloorBoard, getSessionBill, getOpenBillPolicy].map((endpoint) =>
          queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
    // Not eligible usually means it is already converted (a retry or a double
    // tap after success): refresh the board so it shows the true state. The
    // dialog keeps its "notEligible" message.
    onError: (error) => {
      if (error instanceof ApiError && error.code === OPEN_BILL_NOT_ELIGIBLE)
        void queryClient.invalidateQueries({ queryKey: [getFloorBoard.id] });
    },
  });
}
