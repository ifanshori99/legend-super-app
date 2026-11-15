// Query options for the EDC reconciliation queue. The key is endpoint id +
// input (same as `endpointQueryOptions`), so invalidating `[endpoint.id]`
// refreshes it. The queryFn follows `meta.nextCursor` so no row is hidden
// behind the first page.
import { queryOptions } from "@tanstack/react-query";
import { edcTransactionStatusSchema } from "@starter/shared/edc";
import { listEdcReconciliationQueue } from "@starter/shared/payment/admin";
import { endpointQueryKey } from "@/lib/api/endpoint";
import { fetchEdcReconciliationQueue } from "./api";

// The screen shows its error state instead of retrying silently; the
// ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

// Safety cap: 20 pages of 100 rows. If it is hit, the merged result keeps the
// last non-null `nextCursor` so the truncation is not reported as the end.
const MAX_PAGES = 20;
const PAGE_LIMIT = 100;

export type EdcReconciliationFilters = {
  outletId?: string;
  status?: string;
  q?: string;
};

export const edcReconciliationQueueQuery = (
  filters: EdcReconciliationFilters,
) => {
  const query = {
    limit: PAGE_LIMIT,
    outletId: filters.outletId || undefined,
    // An unknown status in the URL is ignored, not sent to the API.
    status: edcTransactionStatusSchema.safeParse(filters.status).data,
    q: filters.q?.trim() || undefined,
  };
  return queryOptions({
    queryKey: endpointQueryKey(listEdcReconciliationQueue, { query }),
    queryFn: async ({ signal }) => {
      let page = await fetchEdcReconciliationQueue(query, { signal });
      const data = [...page.data];
      for (let n = 1; n < MAX_PAGES && page.meta.nextCursor; n += 1) {
        page = await fetchEdcReconciliationQueue(
          { ...query, cursor: page.meta.nextCursor },
          { signal },
        );
        data.push(...page.data);
      }
      return { data, meta: page.meta };
    },
    ...RETRY,
  });
};
