// Query keys and options for the open-bill policy. Keys are
// `[endpoint.id, input]` (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import {
  getOpenBillPolicy,
  listOpenBillApprovers,
} from "@starter/shared/qr-order";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";

export const openBillKeys = {
  policy: (outletId: string) =>
    endpointQueryKey(getOpenBillPolicy, { params: { outletId } }),
  approvers: (outletId: string) =>
    endpointQueryKey(listOpenBillApprovers, { params: { outletId } }),
} as const;

export const openBillPolicyQuery = (outletId: string) =>
  queryOptions({
    queryKey: openBillKeys.policy(outletId),
    queryFn: ({ signal }) => api.getOpenBillPolicy({ outletId }, { signal }),
    // One quick retry, then the error state with its own "Coba lagi" button.
    retry: 1,
  });

/** Supervisors who may approve a conversion and have a staff PIN. */
export const openBillApproversQuery = (outletId: string) =>
  queryOptions({
    queryKey: openBillKeys.approvers(outletId),
    queryFn: ({ signal }) =>
      api.listOpenBillApprovers({ outletId }, { signal }),
    retry: 1,
  });
