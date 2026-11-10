import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { getMyAccess } from "@starter/shared/access";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  accessForMockRole,
  resolveAreaAccess,
  MOCK_ROLE_COOKIE,
  MOCK_SUPPORT_COOKIE,
  parseMockRole,
  type AreaAccess,
} from "./access.ts";

const ACCESS_TIMEOUT_MS = 3000;

// Mock mode only: the role cookie lives on the web origin, so the server reads
// it. A real build compiles API_MOCK to false and never calls this.
const getMockRoleFn = createServerFn({ method: "GET" }).handler(() =>
  API_MOCK ? parseMockRole(getCookie(MOCK_ROLE_COOKIE)) : "none",
);

// Mock mode only: a read-only support session for the e2e and screenshots.
const getMockSupportFn = createServerFn({ method: "GET" }).handler(
  () => API_MOCK && getCookie(MOCK_SUPPORT_COOKIE) === "read_only",
);

/**
 * Visitor reach for route guards and navigation, computed once per navigation
 * in the root route. Presentation only: the API authorizes every request.
 */
export async function loadAreaAccess(
  session: {
    user: object;
    session?: { impersonatedBy?: string | null };
  } | null,
): Promise<AreaAccess> {
  if (API_MOCK) {
    const access = accessForMockRole(await getMockRoleFn());
    if (!access.authenticated || !(await getMockSupportFn())) return access;
    return {
      ...access,
      supportSession: {
        accessMode: "read_only",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    };
  }
  // Real session: the API answers with the caller's effective permissions.
  // Failures fail closed (see resolveAreaAccess). The timeout keeps a hung API
  // from stalling every navigation: an abort throws and fails closed too.
  return resolveAreaAccess(
    session,
    async () =>
      (
        await callEndpoint(
          getMyAccess,
          {},
          {
            signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
          },
        )
      ).data,
  );
}
