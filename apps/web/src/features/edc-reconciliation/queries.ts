// Query options for the EDC reconciliation queue. `endpointQueryOptions` keys
// by endpoint id + input, so invalidating `[endpoint.id]` refreshes every page.
import { edcTransactionStatusSchema } from "@starter/shared/edc";
import { listEdcReconciliationQueue } from "@starter/shared/payment/admin";
import { endpointQueryOptions } from "@/lib/api/endpoint";

// The screen shows its error state instead of retrying silently; the
// ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export type EdcReconciliationFilters = {
  outletId?: string;
  status?: string;
  q?: string;
};

export const edcReconciliationQueueQuery = (
  filters: EdcReconciliationFilters,
) => ({
  ...endpointQueryOptions(listEdcReconciliationQueue, {
    query: {
      limit: 100,
      outletId: filters.outletId || undefined,
      // An unknown status in the URL is ignored, not sent to the API.
      status: edcTransactionStatusSchema.safeParse(filters.status).data,
      q: filters.q?.trim() || undefined,
    },
  }),
  ...RETRY,
});
