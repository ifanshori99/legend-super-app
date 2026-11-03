// The only way components touch support-access data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RequestSupportAccessInput } from "@starter/shared/platform";
import { endSupportAccessCall, requestSupportAccessCall } from "./api.ts";
import {
  orgGrantsQuery,
  platformGrantsQuery,
  supportAccessKeys,
  tenantsQuery,
} from "./queries.ts";

const browser = () => typeof window !== "undefined";

export function usePlatformGrants() {
  return useQuery({ ...platformGrantsQuery(), enabled: browser() });
}

export function useOrgGrants() {
  return useQuery({ ...orgGrantsQuery(), enabled: browser() });
}

export function useTenants(enabled: boolean) {
  return useQuery({ ...tenantsQuery(), enabled: enabled && browser() });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: supportAccessKeys.all });
}

/** TEN-04: opens a session; the API checks the second factor. */
export function useRequestSupportAccess() {
  const refresh = useRefresh();
  return useMutation({
    // The body carries the authenticator code: keep the finished mutation
    // (and its variables) out of the mutation cache.
    gcTime: 0,
    mutationFn: ({
      tenantId,
      body,
    }: {
      tenantId: string;
      body: RequestSupportAccessInput;
    }) => requestSupportAccessCall(tenantId, body).then((r) => r.data),
    onSuccess: () => refresh(),
  });
}

export function useEndSupportAccess() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (grantId: string) =>
      endSupportAccessCall(grantId).then((r) => r.data),
    onSuccess: () => refresh(),
  });
}
