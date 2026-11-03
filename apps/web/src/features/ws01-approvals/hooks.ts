// Hooks are the only way components touch approval data.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  ApprovalDecisionInput,
  ApprovalRequest,
} from "@starter/shared/identity";
import type { InboxFilters } from "./logic.ts";
import { toServerQuery } from "./logic.ts";
import { decideApproval, verifyFactor } from "./api.ts";
import {
  approvalBadgeQuery,
  approvalKeys,
  approvalQuery,
  approvalsQuery,
  currentAuthQuery,
  mfaFactorsQuery,
} from "./queries.ts";

const browser = () => typeof window !== "undefined";

export function useApprovals(filters: InboxFilters) {
  const query = useInfiniteQuery({
    ...approvalsQuery(toServerQuery(filters)),
    enabled: browser(),
  });
  const rows: ApprovalRequest[] =
    query.data?.pages.flatMap((page) => page.data) ?? [];
  return { ...query, rows };
}

export function useApproval(requestId: string, initial?: ApprovalRequest) {
  return useQuery({
    ...approvalQuery(requestId),
    enabled: browser(),
    placeholderData: initial ? { data: initial } : undefined,
  });
}

export function useApprovalBadge(enabled = true) {
  return useQuery({ ...approvalBadgeQuery(), enabled: enabled && browser() });
}

export function useCurrentAuth() {
  return useQuery({ ...currentAuthQuery(), enabled: browser() });
}

export function useTotpFactor(enabled: boolean) {
  const query = useQuery({ ...mfaFactorsQuery(), enabled });
  return {
    ...query,
    totp: query.data?.data.find((factor) => factor.type === "totp"),
  };
}

export function useDecide(requestId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApprovalDecisionInput) =>
      decideApproval(requestId, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}

export function useVerifyFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: verifyFactor,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: currentAuthQuery().queryKey }),
  });
}

/** "now" for countdowns; ticks every 30 s so a deadline flips to overdue. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
