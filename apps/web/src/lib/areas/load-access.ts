import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import type { MyAccessView } from "@starter/shared/access";
import { apiFetch } from "@/lib/api/client";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  accessForMockRole,
  accessFromSession,
  MOCK_ROLE_COOKIE,
  MOCK_SUPPORT_COOKIE,
  parseMockRole,
  type AreaAccess,
} from "./access.ts";

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
  const access = accessFromSession(session);
  // Only an impersonated session (Super Admin support, TEN-04) needs the
  // access view today; normal sessions cost no extra request.
  if (!session?.session?.impersonatedBy) return access;
  try {
    const view = await apiFetch<{ data: MyAccessView }>("/api/me/access");
    return { ...access, supportSession: view.data.supportSession };
  } catch {
    // The API enforces read-only either way; the notice is presentation.
    return access;
  }
}
