// The only way components touch support-access data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type {
  RequestSupportAccessInput,
  RequestSupportWriteAccessInput,
} from "@starter/shared/platform";
import type { AreaAccess } from "@/lib/areas/access";
import {
  approveSupportAccessRequestCall,
  endSupportAccessCall,
  rejectSupportAccessRequestCall,
  requestSupportAccessCall,
  requestSupportWriteAccessCall,
} from "./api.ts";
import {
  evaluateSupportDecisionGuard,
  type SupportDecisionGuard,
} from "./decision-guard.ts";
import {
  orgGrantsQuery,
  platformGrantsQuery,
  supportAccessKeys,
  supportAccessRequestsQuery,
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

/** read_write: a request for the tenant owner to approve; no session opens. */
export function useRequestSupportWriteAccess() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0, // the body carries the authenticator code
    mutationFn: ({
      tenantId,
      body,
    }: {
      tenantId: string;
      body: RequestSupportWriteAccessInput;
    }) => requestSupportWriteAccessCall(tenantId, body).then((r) => r.data),
    onSuccess: () => refresh(),
  });
}

/** Owner: read_write requests of the tenant (pending, decided, expired). */
export function useSupportAccessRequests() {
  return useQuery({ ...supportAccessRequestsQuery(), enabled: browser() });
}

export function useApproveSupportAccessRequest() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ requestId }: { requestId: string }) =>
      approveSupportAccessRequestCall(requestId).then((r) => r.data),
    onSuccess: () => refresh(),
  });
}

export function useRejectSupportAccessRequest() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ requestId }: { requestId: string }) =>
      rejectSupportAccessRequestCall(requestId).then((r) => r.data),
    onSuccess: () => refresh(),
  });
}

/** Owner, second factor verified, not an impersonated session. The API
 * re-checks (403 IMPERSONATION_NOT_ALLOWED / MFA_REQUIRED). */
export function useSupportDecisionGuard(): SupportDecisionGuard {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
    session?: { session?: { impersonatedBy?: string | null } } | null;
  };
  return evaluateSupportDecisionGuard(
    context.access,
    context.session?.session?.impersonatedBy,
  );
}
