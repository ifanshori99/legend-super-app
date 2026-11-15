// Cached EDC reconciliation data and the resolve mutation. Components never
// call apiFetch directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ResolveEdcReconciliationBody } from "@starter/shared/edc";
import { listEdcReconciliationQueue as listEdcReconciliationQueueEndpoint } from "@starter/shared/payment/admin";
import { submitEdcReconciliation } from "./api";
import {
  edcReconciliationQueueQuery,
  type EdcReconciliationFilters,
} from "./queries";

export function useEdcReconciliationQueue(filters: EdcReconciliationFilters) {
  return useQuery(edcReconciliationQueueQuery(filters));
}

export function useResolveEdcReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: ResolveEdcReconciliationBody }) =>
      submitEdcReconciliation({ id: input.id }, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [listEdcReconciliationQueueEndpoint.id],
      }),
  });
}
