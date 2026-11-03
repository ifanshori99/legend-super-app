// Query keys and options for the approval inbox.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getCurrentAuth,
  listMfaFactors,
  type ApprovalInboxQuery,
} from "@starter/shared/identity";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { fetchApproval, fetchApprovals } from "./api.ts";
import { DEFAULT_FILTERS, toServerQuery } from "./logic.ts";

export const approvalKeys = {
  all: ["approvals"] as const,
  list: (query: Omit<ApprovalInboxQuery, "cursor">) =>
    [...approvalKeys.all, "list", query] as const,
  detail: (requestId: string) =>
    [...approvalKeys.all, "detail", requestId] as const,
  badge: () => [...approvalKeys.all, "badge"] as const,
};

export function approvalsQuery(query: Omit<ApprovalInboxQuery, "cursor">) {
  return infiniteQueryOptions({
    queryKey: approvalKeys.list(query),
    queryFn: ({ pageParam, signal }) =>
      fetchApprovals({ ...query, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { meta: { nextCursor: string | null } }) =>
      last.meta.nextCursor ?? undefined,
  });
}

export function approvalQuery(requestId: string) {
  return queryOptions({
    queryKey: approvalKeys.detail(requestId),
    queryFn: ({ signal }) => fetchApproval(requestId, signal),
  });
}

/**
 * Pending count for the shell badge; polls because approvals are time-boxed.
 * Same server query as the inbox's default view, so the badge number is the
 * inbox's default row count.
 */
export function approvalBadgeQuery() {
  return queryOptions({
    queryKey: approvalKeys.badge(),
    queryFn: ({ signal }) =>
      fetchApprovals(toServerQuery(DEFAULT_FILTERS), signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });
}

export const currentAuthQuery = () => endpointQueryOptions(getCurrentAuth);
export const mfaFactorsQuery = () => endpointQueryOptions(listMfaFactors);
