// Query keys and options for the open-bill policy. Keys are
// `[endpoint.id, input]` (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import { getOpenBillPolicy } from "@starter/shared/qr-order";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

export const openBillKeys = {
  policy: (outletId: string) =>
    endpointQueryKey(getOpenBillPolicy, { params: { outletId } }),
} as const;

export const openBillPolicyQuery = (outletId: string) =>
  queryOptions({
    queryKey: openBillKeys.policy(outletId),
    queryFn: ({ signal }) => api.getOpenBillPolicy({ outletId }, { signal }),
    // One quick retry, then the error state with its own "Coba lagi" button.
    retry: 1,
  });
