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
 * over that scope (deny by default, MFA included). Returns the grantor
 * assignment that authorized it, for the audit log.
 */
export function assertCanGrantRole(input: {
  readonly grantor: AccessPrincipal;
  readonly grantorRoles: readonly RoleGrant[];
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
  return assertAuthorized({
    principal: input.grantor,
    roles: input.grantorRoles,
    org: input.org,
    permission: "access.role.assign",
    target: targetOf(input.scope),
    now: input.now,
    surface: "back_office",
    mfaVerified: input.grantorMfaVerified,
  });
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
