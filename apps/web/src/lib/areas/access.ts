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
  type MyOutlet,
  type PermissionCode,
  type RoleTemplateKey,
  type StationId,
} from "@starter/shared/access";
import { cafeLegendFixtures } from "@starter/shared/core";
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
   * Outlets assigned to the account, from GET /api/me/access (legend-2aqp).
   * The staff shell builds its outlet context and picker from this list. Empty
   * = no outlet (fail closed).
   */
  readonly outlets: readonly MyOutlet[];
  /**
   * Set when this session is a Super Admin support session (Better Auth
   * impersonation) with a grant, from GET /api/me/access. Presentation only;
   * the API refuses writes under a read_only grant.
   */
  readonly supportSession?: {
    readonly accessMode: "read_only" | "read_write";
    readonly expiresAt: string;
  } | null;
  /**
   * The account's assignments can change an employee's direct manager (HR, or
   * a GM at brand/tenant scope), from GET /api/me/access. Presentation only:
   * PATCH /employees/:id/manager decides again and answers 403.
   */
  readonly canChangeEmployeeManager?: boolean;
  /**
   * The account may rename, retype or delete a kitchen station (holds
   * `menu.item.manage` at tenant or outlet scope, not only at a station), from
   * GET /api/me/access. Presentation only: PATCH/DELETE /menu/stations/:id
   * decide again and answer 403.
   */
  readonly canManageStationConfig?: boolean;
  /**
   * The request comes from a shared tablet (GET /api/me/access `sharedDevice`,
   * founder Q29): only POS, tables and KDS open (reservations and Tanya AI in KDS
   * are hidden in release 1). Absent =
   * false (an older API). Presentation only; the API refuses the other screens.
   */
  readonly sharedDevice?: boolean;
};

export const ANONYMOUS_ACCESS: AreaAccess = Object.freeze({
  authenticated: false,
  permissions: Object.freeze([]) as readonly PermissionCode[],
  mfaRequired: false,
  mfaVerified: false,
  stations: Object.freeze([]) as readonly StationId[],
  outlets: Object.freeze([]) as readonly MyOutlet[],
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
    outlets: [],
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
    outlets: view.outlets,
    supportSession: view.supportSession,
    canChangeEmployeeManager: view.canChangeEmployeeManager,
    canManageStationConfig: view.canManageStationConfig,
    sharedDevice: view.sharedDevice,
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

/**
 * Mock station reach: the menu fixture stations of the mock session's outlet
 * (the first fixture outlet, ids 200-203); other outlets' stations are out of reach.
 */
const MOCK_STATIONS: readonly StationId[] = cafeLegendMenuFixtures.stations
  .filter((station) => station.outletId === cafeLegendFixtures.outlets[0].id)
  .map((station) => stationIdSchema.parse(station.id));

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

/**
 * Mock outlet reach: the first Cafe Legend fixture outlet (BDG-01), the same
 * one lib/mock/tenant-context.ts runs the shells on.
 */
const MOCK_OUTLETS: readonly MyOutlet[] = cafeLegendFixtures.outlets
  .slice(0, 1)
  .map((outlet) => ({
    id: outlet.id,
    name: outlet.name,
    timeZone: outlet.timeZone,
    businessDayCutoff: outlet.businessDayCutoff,
  }));

/**
 * Mock of the server's `canChangeEmployeeManager`: HR-style templates hold
 * hr.employee.manage; a GM-style template holds hr.attendance.manage and may be
 * assigned at brand or tenant scope. Outlet-scoped templates never qualify.
 */
function mockCanChangeEmployeeManager(role: RoleTemplateKey): boolean {
  const template = roleTemplate(role);
  if (template.permissions.includes("hr.employee.manage")) return true;
  return (
    template.permissions.includes("hr.attendance.manage") &&
    template.allowedScopeTypes.some(
      (scope) => scope === "brand" || scope === "tenant",
    )
  );
}

/**
 * Mock of the server's `canManageStationConfig`: the template holds
 * menu.item.manage and may be assigned above station scope.
 */
function mockCanManageStationConfig(role: RoleTemplateKey): boolean {
  const template = roleTemplate(role);
  return (
    template.permissions.includes("menu.item.manage") &&
    template.allowedScopeTypes.some((scope) => scope !== "station")
  );
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
      outlets: MOCK_OUTLETS,
      canChangeEmployeeManager: true,
      canManageStationConfig: true,
    };
  const template = roleTemplate(role);
  return {
    authenticated: true,
    permissions: template.permissions,
    mfaRequired: template.mfaRequired,
    mfaVerified: true,
    roleLabel: template.defaultName,
    stations: mockStationsFor(role),
    outlets: MOCK_OUTLETS,
    canChangeEmployeeManager: mockCanChangeEmployeeManager(role),
    canManageStationConfig: mockCanManageStationConfig(role),
  };
}
