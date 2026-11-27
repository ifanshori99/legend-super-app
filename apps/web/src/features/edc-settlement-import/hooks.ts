// The upload mutation. An import clears "perlu dicek" flags, so the EDC
// reconciliation queue and the day recap are refreshed after it.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { listEdcReconciliationQueue } from "@starter/shared/payment/admin";
import { submitEdcSettlementCsv } from "./api";

export function useImportEdcSettlementCsv() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submitEdcSettlementCsv,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [listEdcReconciliationQueue.id],
      }),
  });
}
