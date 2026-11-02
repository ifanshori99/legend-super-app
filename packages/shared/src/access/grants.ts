// Role grant rules (PRD v1.7 §3.7 "Pemberian Role — Memerlukan autentikasi
// ulang dan tercatat di audit log; pengguna tidak dapat menaikkan hak dirinya
// sendiri") and custom-role validation (§3.7 "Custom Role").

import type { UserId } from "../core/index.ts";
import { AccessError } from "./errors.ts";
import type { RoleAssignmentId } from "./ids.ts";
import {
  isPermissionCode,
  permissionHasTag,
  type PermissionCode,
} from "./permissions.ts";
import { permissionsRequireMfa, type RoleTemplate } from "./roles.ts";
import {
  assertAuthorized,
  authorize,
  isAssignmentActive,
  type AccessPrincipal,
  type AccessTarget,
  type AssignmentScope,
  type OrgIndex,
  type RoleGrant,
} from "./scope.ts";

/**
 * How recent the grantor's re-authentication must be. PRD §3.7 requires
 * re-authentication but names no window; 5 minutes is the tech-lead default
 * (tenant-configurable later through WS-01 identity settings).
 */
export const ROLE_GRANT_REAUTH_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Tenant top-authority templates (coordinator decision, legend-cyu.10): an
 * active tenant-scoped Owner or Admin Tenant assignment, with MFA verified and
 * a re-auth within ROLE_GRANT_REAUTH_MAX_AGE_MS, may grant any tenant-level
 * (non-platform) role inside its tenant without holding every delegated
 * permission (so Admin Tenant can assign Finance). Everyone else must hold
 * every permission they delegate, which keeps reciprocal escalation impossible.
 * The `owner` template itself is never reachable through this path: only a
 * grantor who already holds all of Owner's permissions can create an Owner,
 * so two Admin Tenants cannot promote each other to Owner.
 */
export const ROLE_GRANT_TOP_AUTHORITY_TEMPLATES = Object.freeze([
  "owner",
  "tenant_admin",
] as const);
const TOP_AUTHORITY_EXCLUDED_TARGETS: readonly string[] = ["owner"];

/** A grantor's role as the API loaded it; templateKey null = custom role. */
export type GrantorRole = RoleGrant & { readonly templateKey?: string | null };

/** The role being granted, as the API loaded it. */
export type GrantableRole = RoleGrant & {
  /** Template key, or null for a custom role. */
  readonly templateKey: string | null;
  readonly level: RoleTemplate["level"];
  readonly allowedScopeTypes: RoleTemplate["allowedScopeTypes"];
};

function targetOf(scope: AssignmentScope): AccessTarget {
  return scope.type === "tenant"
    ? { type: "tenant" }
    : { type: scope.type, id: scope.id };
}

/**
 * Throws AccessError unless `grantor` may give `role` to `granteeUserId` at
 * `scope` right now. Checks, in order: no self-grant, recent re-auth, role is a
 * tenant role allowed at that scope type, grantor holds `access.role.assign`
 * over that scope and every delegated permission at that scope (deny by default,
 * MFA included). This prevents reciprocal role elevation. Returns the grantor
 * assignment that authorized it, for the audit log.
 */
export function assertCanGrantRole(input: {
  readonly grantor: AccessPrincipal;
  readonly grantorRoles: readonly GrantorRole[];
  readonly grantorMfaVerified: boolean;
  /** Last successful re-authentication of the grantor's session, or null. */
  readonly grantorReauthenticatedAt: Date | null;
  readonly granteeUserId: UserId | string;
  readonly role: GrantableRole;
  readonly scope: AssignmentScope;
  readonly org: OrgIndex;
  readonly now: Date;
}): RoleAssignmentId {
  if (input.granteeUserId.toLowerCase() === input.grantor.userId.toLowerCase())
    throw new AccessError("SELF_ELEVATION_FORBIDDEN");
  const reauthAt = input.grantorReauthenticatedAt?.getTime();
  const age =
    reauthAt === undefined ? Infinity : input.now.getTime() - reauthAt;
  if (!(age >= 0 && age <= ROLE_GRANT_REAUTH_MAX_AGE_MS))
    throw new AccessError("REAUTH_REQUIRED");
  if (input.role.level !== "tenant")
    throw new AccessError("ROLE_NOT_ASSIGNABLE");
  if (!input.role.allowedScopeTypes.includes(input.scope.type))
    throw new AccessError("ROLE_SCOPE_NOT_ALLOWED");
  if (
    input.role.permissions.some(
      (permission) =>
        !isPermissionCode(permission) ||
        permissionHasTag(permission, "platform"),
    )
  )
    throw new AccessError("ROLE_NOT_ASSIGNABLE");
  const authorization = {
    principal: input.grantor,
    roles: input.grantorRoles,
    org: input.org,
    permission: "access.role.assign" as const,
    target: targetOf(input.scope),
    now: input.now,
    surface: "back_office" as const,
    mfaVerified: input.grantorMfaVerified,
  };
  const assignmentId = assertAuthorized(authorization);
  const excludedTarget =
    input.role.templateKey !== null &&
    TOP_AUTHORITY_EXCLUDED_TARGETS.includes(input.role.templateKey);
  const topAuthority = excludedTarget
    ? null
    : topAuthorityAssignment(input, "access.role.assign");
  if (topAuthority !== null) return topAuthority;
  for (const permission of input.role.permissions)
    assertAuthorized({ ...authorization, permission });
  return assignmentId;
}

/**
 * The grantor's active tenant-scoped Owner/Admin Tenant assignment that may
 * use the top-authority path for a grant or custom-role edit, or null.
 * Requires a verified second factor regardless of the role's own MFA flag.
 */
function topAuthorityAssignment(
  input: {
    readonly grantor: AccessPrincipal;
    readonly grantorRoles: readonly GrantorRole[];
    readonly grantorMfaVerified: boolean;
    readonly now: Date;
  },
  permission: PermissionCode,
): RoleAssignmentId | null {
  if (input.grantorMfaVerified !== true) return null;
  const top: readonly string[] = ROLE_GRANT_TOP_AUTHORITY_TEMPLATES;
  const byId = new Map(
    input.grantorRoles.map((role) => [role.id.toLowerCase(), role] as const),
  );
  const tenantId = input.grantor.tenantId.toLowerCase();
  const userId = input.grantor.userId.toLowerCase();
  for (const row of input.grantor.assignments) {
    if (row.scope.type !== "tenant") continue;
    if (row.tenantId.toLowerCase() !== tenantId) continue;
    if (row.userId.toLowerCase() !== userId) continue;
    if (!isAssignmentActive(row, input.now)) continue;
    const role = byId.get(row.roleId.toLowerCase());
    if (!role || typeof role.templateKey !== "string") continue;
    if (!top.includes(role.templateKey)) continue;
    if (!role.permissions.includes(permission)) continue;
    return row.id;
  }
  return null;
}

/**
 * Custom-role edit rule (coordinator decision C6, bead legend-vbws; PRD §3.7
 * "Pemberian Role — pengguna tidak dapat menaikkan hak dirinya sendiri").
 *
 * Adding permissions to a custom role follows the same grant rule as handing
 * out a role: the editor must hold every added permission at tenant scope,
 * unless the editor is a tenant Owner / Admin Tenant with MFA verified and a
 * re-authentication within ROLE_GRANT_REAUTH_MAX_AGE_MS. Removing permissions
 * and renaming are not grants, so the caller checks them separately.
 *
 * Holding is a role-assignment fact, not a surface check: the surface
 * second-factor rule (AUTH-05) is enforced by the back-office guard and must
 * not turn an owner without a fresh factor into an editor who cannot even add
 * the permissions they hold.
 */
export function assertCanEditCustomRole(input: {
  readonly grantor: AccessPrincipal;
  readonly grantorRoles: readonly GrantorRole[];
  readonly grantorMfaVerified: boolean;
  readonly grantorReauthenticatedAt: Date | null;
  readonly addedPermissions: readonly PermissionCode[];
  readonly org: OrgIndex;
  readonly now: Date;
}): void {
  if (input.addedPermissions.length === 0) return;
  const authorization = {
    principal: input.grantor,
    roles: input.grantorRoles,
    org: input.org,
    permission: "access.role.manage" as const,
    target: { type: "tenant" } as const,
    now: input.now,
    surface: "pos" as const,
    mfaVerified: false,
  };
  // The service also gates the route on access.role.manage; keep the pure
  // rule self-contained so contract and API tests exercise the same decision.
  assertAuthorized(authorization);
  const reauthAt = input.grantorReauthenticatedAt?.getTime();
  const age =
    reauthAt === undefined ? Infinity : input.now.getTime() - reauthAt;
  if (
    age >= 0 &&
    age <= ROLE_GRANT_REAUTH_MAX_AGE_MS &&
    topAuthorityAssignment(input, "access.role.manage") !== null
  )
    return;
  for (const permission of input.addedPermissions)
    if (!authorize({ ...authorization, permission }).allowed)
      throw new AccessError(
        "SELF_ELEVATION_FORBIDDEN",
        "Anda hanya dapat menambahkan izin yang Anda miliki sendiri.",
      );
}

/**
 * Validates a custom role's permission list: catalog codes only, no platform
 * permissions. Returns the deduplicated list (catalog order is not required)
 * and whether the role must require MFA (AUTH-05: a custom role that reaches
 * finance, payroll, personal data or access administration always does).
 */
export function normalizeCustomRolePermissions(
  permissions: readonly string[],
  options: { readonly mfaRequested?: boolean } = {},
): { permissions: PermissionCode[]; mfaRequired: boolean } {
  const unique = [...new Set(permissions)];
  for (const code of unique)
    if (!isPermissionCode(code) || permissionHasTag(code, "platform"))
      throw new AccessError("PERMISSION_NOT_IN_CATALOG");
  const codes = unique as PermissionCode[];
  return {
    permissions: codes,
    mfaRequired: Boolean(options.mfaRequested) || permissionsRequireMfa(codes),
  };
}
