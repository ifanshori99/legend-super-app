// The only way components touch open-bill data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFloorBoard,
  getOpenBillPolicy,
  getSessionBill,
} from "@starter/shared/qr-order";
import type { TableSessionId } from "@starter/shared/qr-order";
import * as api from "./api";
import { openBillKeys, openBillPolicyQuery } from "./queries";

/** Open-bill limits of one outlet. */
export function useOpenBillPolicy(outletId: string | undefined) {
  return useQuery({
    ...openBillPolicyQuery(outletId ?? ""),
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

/** Turns a running pay-first session into an open bill (PIN + reason). */
export function useConvertToOpenBill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      sessionId: TableSessionId;
      reason: string;
      pin: string;
    }) =>
      api.convertSessionToOpenBill(
        { sessionId: variables.sessionId },
        { reason: variables.reason, pin: variables.pin },
      ),
    onSuccess: () =>
      Promise.all(
        [getFloorBoard, getSessionBill, getOpenBillPolicy].map((endpoint) =>
          queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
  });
}
