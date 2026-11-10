// What the web app knows about the visitor's reach, enough to decide which
// areas to show (presentation only; the API authorizes every request).
//
// Source: the Better Auth session carries no Legend role assignments, so a real
// session is authenticated from GET /api/me/access (`resolveAreaAccess`). When
// that call fails or answers something unexpected, every guarded area fails
// closed (`accessFromSession`). In mock mode (VITE_API_MOCK=true) a cookie picks a role
// template so every area can be reviewed.
import {
  ROLE_TEMPLATE_KEYS,
  PERMISSION_CODES,
  myAccessViewSchema,
  roleTemplate,
  stationIdSchema,
  type MyAccessView,
  type PermissionCode,
  type RoleTemplateKey,
  type StationId,
} from "@starter/shared/access";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";

export type AreaAccess = {
  readonly authenticated: boolean;
  readonly permissions: readonly PermissionCode[];
  /** users.mfa_required (§6 B): the user holds a role that requires MFA. */
  readonly mfaRequired: boolean;
  /** The session passed a second factor (AUTH-05). */
  readonly mfaVerified: boolean;
  /** Display role name for the shell (role template default name). */
  readonly roleLabel?: string;
  /**
   * Stations the account may work on, from the assignments (legend-fsb7). The
   * KDS only polls the boards in this list, so a station-scoped account never
   * asks for another station's board. Empty = no station reach (fail closed).
   */
  readonly stations: readonly StationId[];
  /**
   * Set when this session is a Super Admin support session (Better Auth
   * impersonation) with a grant, from GET /api/me/access. Presentation only;
   * the API refuses writes under a read_only grant.
   */
  readonly supportSession?: {
    readonly accessMode: "read_only" | "read_write";
    readonly expiresAt: string;
  } | null;
};

export const ANONYMOUS_ACCESS: AreaAccess = Object.freeze({
  authenticated: false,
  permissions: Object.freeze([]) as readonly PermissionCode[],
  mfaRequired: false,
  mfaVerified: false,
  stations: Object.freeze([]) as readonly StationId[],
});

/**
 * A signed-in account whose Legend permissions are not known: fails closed.
 * MFA is assumed required and unverified until the API says otherwise, the
 * same default as `authorize()` (an unknown role requires MFA).
 */
export function accessFromSession(
  session: { user: object } | null | undefined,
): AreaAccess {
  if (!session) return ANONYMOUS_ACCESS;
  return {
    authenticated: true,
    permissions: [],
    mfaRequired: true,
    mfaVerified: false,
    stations: [],
  };
}

/** Maps the validated GET /api/me/access view to the visitor's reach. */
export function accessFromView(view: MyAccessView): AreaAccess {
  return {
    authenticated: true,
    permissions: view.permissions,
    mfaRequired: view.mfaRequired,
    mfaVerified: view.mfaVerified,
    stations: view.stations,
    supportSession: view.supportSession,
  };
}

/**
 * Real-session access (legend-oldg): ask the API for the caller's effective
 * permissions. A missing session is anonymous without a request. Any failure
 * (401, 403, network, a body that does not match the contract) falls back to
 * `accessFromSession`: authenticated, no permissions, MFA assumed required.
 * The API authorizes every request again, so this only decides what to show.
 */
export async function resolveAreaAccess(
  session: { user: object } | null | undefined,
  fetchView: () => Promise<unknown>,
): Promise<AreaAccess> {
  if (!session) return ANONYMOUS_ACCESS;
  try {
    const parsed = myAccessViewSchema.safeParse(await fetchView());
    return parsed.success
      ? accessFromView(parsed.data)
      : accessFromSession(session);
  } catch {
    return accessFromSession(session);
  }
}

export const MOCK_ROLE_COOKIE = "legend-mock-role";
/** Mock only: `read_only` simulates a read-only support session (TEN-04). */
export const MOCK_SUPPORT_COOKIE = "legend-mock-support";
/** "all" = every catalog permission (dev default), "none" = signed out. */
export type MockRole = RoleTemplateKey | "all" | "none";

/**
 * Cookie value → mock role. No cookie means "all" so a fresh dev server shows
 * every area; an unknown value means "none" (fail closed).
 */
export function parseMockRole(value: string | undefined | null): MockRole {
  if (value === undefined || value === null || value === "") return "all";
  if (value === "all" || value === "none") return value;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value)
    ? (value as RoleTemplateKey)
    : "none";
}

/** Mock station reach: the kitchen fixtures' stations (menu fixtures, ids 200-203). */
const MOCK_STATIONS: readonly StationId[] = cafeLegendMenuFixtures.stations.map(
  (station) => stationIdSchema.parse(station.id),
);

function mockStationsFor(role: RoleTemplateKey): readonly StationId[] {
  const template = roleTemplate(role);
  if (!template.permissions.some((permission) => permission.startsWith("kds.")))
    return [];
  // A station-level template (Barista / Cook) works one station; mock data has
  // no person-to-station link, so the first fixture station stands in for the
  // assigned one (presentation only).
  return template.allowedScopeTypes.includes("station")
    ? MOCK_STATIONS.slice(0, 1)
    : MOCK_STATIONS;
}

export function accessForMockRole(role: MockRole): AreaAccess {
  if (role === "none") return ANONYMOUS_ACCESS;
  if (role === "all")
    return {
      authenticated: true,
      permissions: PERMISSION_CODES,
      mfaRequired: false,
      mfaVerified: true,
      roleLabel: undefined,
      stations: MOCK_STATIONS,
    };
  const template = roleTemplate(role);
  return {
    authenticated: true,
    permissions: template.permissions,
    mfaRequired: template.mfaRequired,
    mfaVerified: true,
    roleLabel: template.defaultName,
    stations: mockStationsFor(role),
  };
}
