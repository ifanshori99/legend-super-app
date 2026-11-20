// Role grant rules (PRD v1.7 §3.7 "Pemberian Role — Memerlukan autentikasi
// ulang dan tercatat di audit log; pengguna tidak dapat menaikkan hak dirinya
// sendiri") and custom-role validation (§3.7 "Custom Role").

import type { UserId } from "../core/index.ts";
import { AccessError } from "./errors.ts";
import type { RoleAssignmentId } from "./ids.ts";
import {
  canonicalPermissionCode,
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
 * How far a re-authentication stamp may lie ahead of `now` and still count as
 * "just now" (age 0). The stamp comes from the API clock (session
 * mfa_verified_at) while the grant path reads the database clock
 * (readDbClock, legend-hzdy5), and the two drift by tens of milliseconds on a
 * Docker/VM host. A stamp further in the future is still REAUTH_REQUIRED.
 */
export const REAUTH_CLOCK_SKEW_TOLERANCE_MS = 2_000;

/**
 * True when `reauthenticatedAt` is no older than ROLE_GRANT_REAUTH_MAX_AGE_MS
 * at `now` and no more than REAUTH_CLOCK_SKEW_TOLERANCE_MS ahead of it.
 */
export function isReauthFresh(
  reauthenticatedAt: Date | null,
  now: Date,
): boolean {
  if (reauthenticatedAt === null) return false;
  const age = now.getTime() - reauthenticatedAt.getTime();
  return (
    age >= -REAUTH_CLOCK_SKEW_TOLERANCE_MS &&
    age <= ROLE_GRANT_REAUTH_MAX_AGE_MS
  );
}

/**
 * Tenant top-authority templates (coordinator decision, legend-cyu.10): an
 * active tenant-scoped Owner or Admin Tenant assignment, with MFA verified and
 * a re-auth within ROLE_GRANT_REAUTH_MAX_AGE_MS, may grant any tenant-level
 * (non-platform) role inside its tenant without holding every delegated
 * permission (so Admin Tenant can assign Finance). Everyone else must hold
 * every permission they delegate, which keeps reciprocal escalation impossible.
 * The `owner` template itself is never reachable through this path: only a
 * grantor with an active tenant-scoped Owner assignment can create an Owner
 * (legend-7vsby). Holding the same permissions through a custom role is not
 * enough, so an Admin Tenant cannot build a custom role with every Owner code,
 * hand it to a second account, and have that account promote anyone to Owner.
 * Founder Q41 (the tenant admin may configure everything) does not cover
 * creating a new Owner: an Owner only comes from an Owner.
 */
export const ROLE_GRANT_TOP_AUTHORITY_TEMPLATES = Object.freeze([
  "owner",
  "tenant_admin",
] as const);
const OWNER_TEMPLATE_KEY = "owner";

/**
 * Permissions that only the Owner template may carry (legend-7vsby). A custom
 * role can never include them: `normalizeCustomRolePermissions` refuses them
 * on create and edit, and readers drop them from custom roles stored before
 * this rule (`withoutOwnerOnlyPermissions`), so old rows keep loading.
 * `pos.receipt.writeoff` removes a gap from the numbered receipt trail for
 * good (legend-0hzqw, legend-l56xd).
 */
export const OWNER_TEMPLATE_ONLY_PERMISSIONS = Object.freeze([
  "pos.receipt.writeoff",
] as const satisfies readonly PermissionCode[]);
const ownerOnly: readonly string[] = OWNER_TEMPLATE_ONLY_PERMISSIONS;

/** `codes` without the Owner-template-only permissions (custom-role reads). */
export function withoutOwnerOnlyPermissions<T extends string>(
  codes: readonly T[],
): T[] {
  return codes.filter((code) => !ownerOnly.includes(code));
}

/**
 * What a stored role row actually grants: Owner-template-only codes count only
 * on the Owner template. Any other row (a custom role stored before the rule,
 * or a future template that picked one up) loses them on read.
 */
export function rolePermissionsAsGranted(
  templateKey: string | null,
  codes: readonly PermissionCode[],
): PermissionCode[] {
  const allowed =
    templateKey === OWNER_TEMPLATE_KEY
      ? codes
      : withoutOwnerOnlyPermissions(codes);
  return [...new Set(allowed.map(canonicalPermissionCode))];
}

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
  if (!isReauthFresh(input.grantorReauthenticatedAt, input.now))
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
  if (input.role.templateKey === OWNER_TEMPLATE_KEY) {
    // legend-7vsby: an Owner only comes from an Owner. Top authority never
    // applies, and holding every Owner permission (e.g. through a custom
    // role) is not enough; the grantor also needs every delegated permission
    // below, which a tenant-scoped Owner holds.
    const owner = ownerTemplateAssignment(input);
    if (owner === null)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Hanya Owner yang dapat memberikan role Owner.",
      );
    for (const permission of input.role.permissions)
      assertAuthorized({ ...authorization, permission });
    return owner;
  }
  const topAuthority = topAuthorityAssignment(input, "access.role.assign");
  if (topAuthority !== null) return topAuthority;
  for (const permission of input.role.permissions)
    assertAuthorized({ ...authorization, permission });
  return assignmentId;
}

/**
 * The grantor's own active tenant-scoped assignment of the tenant's Owner
 * template, or null. A brand-scoped Owner, an ended or future assignment and
 * any custom role (templateKey null) never count.
 */
function ownerTemplateAssignment(input: {
  readonly grantor: AccessPrincipal;
  readonly grantorRoles: readonly GrantorRole[];
  readonly now: Date;
}): RoleAssignmentId | null {
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
    if (role?.templateKey !== OWNER_TEMPLATE_KEY) continue;
    return row.id;
  }
  return null;
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
  if (
    isReauthFresh(input.grantorReauthenticatedAt, input.now) &&
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
 * permissions, no Owner-template-only permissions (legend-7vsby). Returns the deduplicated list (catalog order is not required)
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
  if (unique.some((code) => ownerOnly.includes(code)))
    throw new AccessError("PERMISSION_OWNER_ONLY");
  const codes = [
    ...new Set((unique as PermissionCode[]).map(canonicalPermissionCode)),
  ];
  return {
    permissions: codes,
    mfaRequired: Boolean(options.mfaRequested) || permissionsRequireMfa(codes),
  };
}
