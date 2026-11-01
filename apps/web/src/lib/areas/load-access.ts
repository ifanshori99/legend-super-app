import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  accessForMockRole,
  accessFromSession,
  MOCK_ROLE_COOKIE,
  parseMockRole,
  type AreaAccess,
} from "./access.ts";

// Mock mode only: the role cookie lives on the web origin, so the server reads
// it. A real build compiles API_MOCK to false and never calls this.
const getMockRoleFn = createServerFn({ method: "GET" }).handler(() =>
  API_MOCK ? parseMockRole(getCookie(MOCK_ROLE_COOKIE)) : "none",
);

/**
 * Visitor reach for route guards and navigation, computed once per navigation
 * in the root route. Presentation only: the API authorizes every request.
 */
export async function loadAreaAccess(
  session: { user: object } | null,
): Promise<AreaAccess> {
  if (API_MOCK) return accessForMockRole(await getMockRoleFn());
  return accessFromSession(session);
}
