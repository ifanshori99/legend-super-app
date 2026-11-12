// Typed endpoint callers; components use ./hooks.ts only.
import {
  orgEndpoints,
  platformEndpoints,
  type RequestSupportAccessInput,
  type RequestSupportWriteAccessInput,
} from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

export function requestSupportAccessCall(
  tenantId: string,
  body: RequestSupportAccessInput,
) {
  return callEndpoint(platformEndpoints.requestSupportAccess, {
    params: { tenantId },
    body,
  });
}

/** read_write: files a request the tenant owner must approve (no grant yet). */
export function requestSupportWriteAccessCall(
  tenantId: string,
  body: RequestSupportWriteAccessInput,
) {
  return callEndpoint(platformEndpoints.requestSupportWriteAccess, {
    params: { tenantId },
    body,
  });
}

export function endSupportAccessCall(grantId: string) {
  return callEndpoint(platformEndpoints.endSupportAccess, {
    params: { grantId },
  });
}

export function fetchPlatformGrants(signal?: AbortSignal) {
  return callEndpoint(
    platformEndpoints.listSupportAccess,
    { query: { limit: 100 } },
    { signal },
  );
}

export function fetchOrgGrants(signal?: AbortSignal) {
  return callEndpoint(
    orgEndpoints.listSupportAccess,
    { query: { limit: 100 } },
    { signal },
  );
}

export function fetchTenants(signal?: AbortSignal) {
  return callEndpoint(
    platformEndpoints.listTenants,
    { query: { limit: 100 } },
    { signal },
  );
}

export function fetchSupportAccessRequests(signal?: AbortSignal) {
  return callEndpoint(
    orgEndpoints.listSupportAccessRequests,
    { query: { limit: 100 } },
    { signal },
  );
}

export function approveSupportAccessRequestCall(requestId: string) {
  return callEndpoint(orgEndpoints.approveSupportAccessRequest, {
    params: { requestId },
    body: {},
  });
}

export function rejectSupportAccessRequestCall(requestId: string) {
  return callEndpoint(orgEndpoints.rejectSupportAccessRequest, {
    params: { requestId },
    body: {},
  });
}
