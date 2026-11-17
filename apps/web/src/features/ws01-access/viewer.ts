import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { API_MOCK } from "@/lib/api/mock-flag";

// The viewer id the access screens use to decide what the viewer may grant
// (legend-4jo2d). A real session always wins. Mock mode has no session (the
// visitor has only a role cookie), so it falls back to the Admin Tenant that
// the mock handlers in ./mock.ts already act as. Presentation only: the API
// authorizes every grant, and the access guard is unchanged. API_MOCK is
// inlined at build time, so a normal build drops the fallback.
export function accessViewerUserId(
  session: { user: { id: string } } | null | undefined,
): string | undefined {
  if (session) return session.user.id;
  return API_MOCK ? cafeLegendAccessFixtures.users.tenantAdmin.id : undefined;
}
