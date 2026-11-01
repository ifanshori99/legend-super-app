// What the web app knows about the visitor's reach, enough to decide which
// areas to show (presentation only; the API authorizes every request).
//
// Source today: the Better Auth session carries no Legend role assignments
// yet, so a real session is authenticated with NO permissions — every guarded
// area fails closed until the API exposes the caller's effective permissions
// (follow-up bead). In mock mode (VITE_API_MOCK=true) a cookie picks a role
// template so every area can be reviewed.
import {
  ROLE_TEMPLATE_KEYS,
  PERMISSION_CODES,
  roleTemplate,
  type PermissionCode,
  type RoleTemplateKey,
} from "@starter/shared/access";

export type AreaAccess = {
  readonly authenticated: boolean;
  readonly permissions: readonly PermissionCode[];
  /** users.mfa_required (§6 B): the user holds a role that requires MFA. */
  readonly mfaRequired: boolean;
  /** The session passed a second factor (AUTH-05). */
  readonly mfaVerified: boolean;
  /** Display role name for the shell (role template default name). */
  readonly roleLabel?: string;
};

export const ANONYMOUS_ACCESS: AreaAccess = Object.freeze({
  authenticated: false,
  permissions: Object.freeze([]) as readonly PermissionCode[],
  mfaRequired: false,
  mfaVerified: false,
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
  };
}

export const MOCK_ROLE_COOKIE = "legend-mock-role";
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

export function accessForMockRole(role: MockRole): AreaAccess {
  if (role === "none") return ANONYMOUS_ACCESS;
  if (role === "all")
    return {
      authenticated: true,
      permissions: PERMISSION_CODES,
      mfaRequired: false,
      mfaVerified: true,
      roleLabel: undefined,
    };
  const template = roleTemplate(role);
  return {
    authenticated: true,
    permissions: template.permissions,
    mfaRequired: template.mfaRequired,
    mfaVerified: true,
    roleLabel: template.defaultName,
  };
}
