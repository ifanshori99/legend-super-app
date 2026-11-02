// Role assignments and the authorization decision (PRD v1.7 §3.7, §6 B
// role_assignments, TEN-03, AUTH-05).
//
// - Deny by default: a permission is granted only by an active assignment of
//   a role that holds it, whose scope covers the target.
// - Time-bound: active on [validFrom, validUntil); validUntil null = open.
//   Ending a role early sets validUntil (the 119connect machinery used
//   revoked_at; §6 has no such column, so the end date is the single switch).
// - Scope: tenant ⊃ brand ⊃ outlet ⊃ station. A narrower scope never reaches a
//   wider target; an unknown brand/outlet/station fails closed.
// - The functions are pure. The API loads assignments, roles and the org index
//   for the tenant it resolved (TEN-02) and passes them in; the result feeds
//   establishOutletScope (core/server) for TEN-03 query filters.

import { z } from "zod";
import {
  brandIdSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "../core/index.ts";
import type {
  BrandId,
  OutletId,
  OutletScopeData,
  TenantId,
  UserId,
} from "../core/index.ts";
import { AccessError } from "./errors.ts";
import {
  roleAssignmentIdSchema,
  roleIdSchema,
  stationIdSchema,
} from "./ids.ts";
import type { RoleAssignmentId, RoleId, StationId } from "./ids.ts";
import type { PermissionCode } from "./permissions.ts";
import { SCOPE_TYPES } from "./roles.ts";
import type { ScopeType } from "./roles.ts";

export const scopeTypeSchema = z.enum(SCOPE_TYPES);

/** scope_type + scope_id (§6 B). `tenant` carries no id; the others must. */
export const assignmentScopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tenant"), id: z.null() }),
  z.strictObject({ type: z.literal("brand"), id: brandIdSchema }),
  z.strictObject({ type: z.literal("outlet"), id: outletIdSchema }),
  z.strictObject({ type: z.literal("station"), id: stationIdSchema }),
]);
export type AssignmentScope = z.infer<typeof assignmentScopeSchema>;

/** One `role_assignments` row (§6 B), wire shape. */
export const roleAssignmentSchema = z
  .strictObject({
    id: roleAssignmentIdSchema,
    tenantId: tenantIdSchema,
    userId: userIdSchema,
    roleId: roleIdSchema,
    scope: assignmentScopeSchema,
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema.nullable(),
    assignedBy: userIdSchema,
    assignedAt: isoDateTimeSchema,
  })
  .refine(
    (row) =>
      row.validUntil === null ||
      Date.parse(row.validUntil) > Date.parse(row.validFrom),
    { message: "validUntil must be after validFrom", path: ["validUntil"] },
  );
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

/** What the decision needs to know about a role (template or custom). */
export type RoleGrant = {
  readonly id: RoleId;
  readonly permissions: readonly PermissionCode[];
  readonly mfaRequired: boolean;
};

/**
 * The tenant's org tree, loaded by the server: which brand an outlet belongs
 * to, which outlet a station belongs to, and all brands including empty ones.
 */
export type OrgIndex = {
  readonly brands: readonly { readonly id: BrandId }[];
  readonly outlets: readonly {
    readonly id: OutletId;
    readonly brandId: BrandId;
  }[];
  readonly stations: readonly {
    readonly id: StationId;
    readonly outletId: OutletId;
  }[];
};

/** What an action touches. Tenant-wide settings and ledgers use `tenant`. */
export type AccessTarget =
  | { readonly type: "tenant" }
  | { readonly type: "brand"; readonly id: BrandId | string }
  | { readonly type: "outlet"; readonly id: OutletId | string }
  | { readonly type: "station"; readonly id: StationId | string };

/**
 * Surfaces that AUTH-05 guards with the second factor. Tanya AI runs inside
 * the dashboard; MCP clients get their token through a back-office flow.
 */
export const MFA_GUARDED_SURFACES = [
  "back_office",
  "dashboard",
  "mcp",
] as const;
export const APP_SURFACES = [
  ...MFA_GUARDED_SURFACES,
  "pos",
  "kds",
  "captain_order",
  "hris",
] as const;
export type AppSurface = (typeof APP_SURFACES)[number];

export function isMfaGuardedSurface(surface: AppSurface): boolean {
  return (MFA_GUARDED_SURFACES as readonly string[]).includes(surface);
}

export type AccessPrincipal = {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly assignments: readonly RoleAssignment[];
};

export function isAssignmentActive(
  assignment: Pick<RoleAssignment, "validFrom" | "validUntil">,
  now: Date,
): boolean {
  const at = now.getTime();
  if (Number.isNaN(at)) throw new RangeError("Invalid clock value");
  const from = Date.parse(assignment.validFrom);
  if (!Number.isFinite(from) || from > at) return false;
  return (
    assignment.validUntil === null || at < Date.parse(assignment.validUntil)
  );
}

function lower(id: string): string {
  return id.toLowerCase();
}

/** Outlet ids an assignment scope reaches inside the org; null = whole tenant. */
function outletsOfScope(
  scope: AssignmentScope,
  org: OrgIndex,
): readonly OutletId[] | null {
  switch (scope.type) {
    case "tenant":
      return null;
    case "brand":
      return org.outlets
        .filter((outlet) => lower(outlet.brandId) === lower(scope.id))
        .map((outlet) => outlet.id);
    case "outlet":
      return org.outlets.some((outlet) => lower(outlet.id) === lower(scope.id))
        ? [scope.id]
        : [];
    case "station":
      // Deliberate: an outlet-only filter cannot enforce a station
      // restriction, so a station assignment contributes no outlet-wide query
      // reach here. Station-bound routes get their RLS reach from
      // `contextFor(permission, { type: "station" })` (the station's outlet)
      // and re-assert the station on every service call (legend-fsb7).
      return [];
  }
}

/** True if the assignment scope covers the target (fails closed on unknown ids). */
export function scopeCovers(
  scope: AssignmentScope,
  target: AccessTarget,
  org: OrgIndex,
): boolean {
  if (
    target.type === "brand" &&
    !org.brands.some((row) => lower(row.id) === lower(target.id))
  )
    return false;
  if (scope.type === "tenant") {
    if (target.type === "outlet")
      return org.outlets.some((row) => lower(row.id) === lower(target.id));
    if (target.type === "station")
      return org.stations.some(
        (row) =>
          lower(row.id) === lower(target.id) &&
          org.outlets.some(
            (outlet) => lower(outlet.id) === lower(row.outletId),
          ),
      );
    return true;
  }
  switch (target.type) {
    case "tenant":
      return false;
    case "brand":
      return scope.type === "brand" && lower(scope.id) === lower(target.id);
    case "outlet": {
      const outlet = org.outlets.find(
        (row) => lower(row.id) === lower(target.id),
      );
      if (!outlet) return false;
      if (scope.type === "brand")
        return lower(outlet.brandId) === lower(scope.id);
      if (scope.type === "outlet") return lower(outlet.id) === lower(scope.id);
      return false; // station scope never reaches a whole outlet
    }
    case "station": {
      const station = org.stations.find(
        (row) => lower(row.id) === lower(target.id),
      );
      if (!station) return false;
      if (scope.type === "station")
        return lower(station.id) === lower(scope.id);
      const outlet = org.outlets.find(
        (row) => lower(row.id) === lower(station.outletId),
      );
      if (!outlet) return false;
      if (scope.type === "brand")
        return lower(outlet.brandId) === lower(scope.id);
      return lower(outlet.id) === lower(scope.id);
    }
  }
}

export const ACCESS_DENIAL_REASONS = [
  "no_active_assignment",
  "permission_not_granted",
  "out_of_scope",
  "mfa_required",
] as const;
export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];

export type AccessDecision =
  | { readonly allowed: true; readonly assignmentId: RoleAssignmentId }
  | { readonly allowed: false; readonly reason: AccessDenialReason };

export type AuthorizeInput = {
  readonly principal: AccessPrincipal;
  readonly roles: readonly RoleGrant[];
  readonly org: OrgIndex;
  readonly permission: PermissionCode;
  readonly target: AccessTarget;
  readonly now: Date;
  /** Where the request comes from; AUTH-05 guards back office and dashboard. */
  readonly surface: AppSurface;
  /** The session passed a second factor (TOTP or passkey). */
  readonly mfaVerified: boolean;
};

function activeAssignmentsOf(
  principal: AccessPrincipal,
  now: Date,
): RoleAssignment[] {
  return principal.assignments.filter(
    (row) =>
      lower(row.tenantId) === lower(principal.tenantId) &&
      lower(row.userId) === lower(principal.userId) &&
      isAssignmentActive(row, now),
  );
}

function rolesById(roles: readonly RoleGrant[]): Map<string, RoleGrant> {
  return new Map(roles.map((role) => [lower(role.id), role]));
}

/**
 * The one permission check (API services, AI tools, MCP tools). Deny by
 * default. Assignments of another tenant or user, expired or future
 * assignments, and unknown roles grant nothing. AUTH-05: on back office and
 * dashboard surfaces, a user holding any active MFA role is denied until the
 * session has a verified second factor. Device surfaces (POS, KDS, captain
 * order) use the staff PIN instead (§3.6), so the MFA rule does not apply there.
 */
export function authorize(input: AuthorizeInput): AccessDecision {
  const active = activeAssignmentsOf(input.principal, input.now);
  if (active.length === 0)
    return { allowed: false, reason: "no_active_assignment" };
  const roles = rolesById(input.roles);
  if (
    isMfaGuardedSurface(input.surface) &&
    !input.mfaVerified &&
    active.some((row) => roles.get(lower(row.roleId))?.mfaRequired !== false)
  )
    return { allowed: false, reason: "mfa_required" };
  let permissionSeen = false;
  for (const row of active) {
    const role = roles.get(lower(row.roleId));
    if (!role || !role.permissions.includes(input.permission)) continue;
    permissionSeen = true;
    if (scopeCovers(row.scope, input.target, input.org))
      return { allowed: true, assignmentId: row.id };
  }
  return {
    allowed: false,
    reason: permissionSeen ? "out_of_scope" : "permission_not_granted",
  };
}

/** authorize() that throws AccessError (MFA_REQUIRED or PERMISSION_DENIED). */
export function assertAuthorized(input: AuthorizeInput): RoleAssignmentId {
  const decision = authorize(input);
  if (decision.allowed) return decision.assignmentId;
  throw new AccessError(
    decision.reason === "mfa_required" ? "MFA_REQUIRED" : "PERMISSION_DENIED",
  );
}

/** users.mfa_required (§6 B): true while any active role requires MFA. */
export function userRequiresMfa(
  principal: AccessPrincipal,
  roles: readonly RoleGrant[],
  now: Date,
): boolean {
  const byId = rolesById(roles);
  return activeAssignmentsOf(principal, now).some(
    (row) => byId.get(lower(row.roleId))?.mfaRequired !== false,
  );
}

/**
 * AUTH-05: a user holding an MFA role cannot open back office or dashboard
 * without a second factor. Throws AccessError MFA_REQUIRED.
 */
export function assertSurfaceAccess(input: {
  readonly principal: AccessPrincipal;
  readonly roles: readonly RoleGrant[];
  readonly surface: AppSurface;
  readonly mfaVerified: boolean;
  readonly now: Date;
}): void {
  if (
    isMfaGuardedSurface(input.surface) &&
    !input.mfaVerified &&
    userRequiresMfa(input.principal, input.roles, input.now)
  )
    throw new AccessError("MFA_REQUIRED");
}

/**
 * Outlet reach of the caller's active assignments, optionally only those whose
 * role holds `permission`. Station-only grants cannot safely produce outlet-wide reach.
 * The result is what the server passes to
 * establishOutletScope (TEN-03): `tenant` if any tenant-scoped assignment
 * applies, else the union of outlets reached through brand and outlet
 * assignments. null = no reach at all (deny).
 */
export function outletReachOf(input: {
  readonly principal: AccessPrincipal;
  readonly roles: readonly RoleGrant[];
  readonly org: OrgIndex;
  readonly now: Date;
  readonly permission?: PermissionCode;
}): OutletScopeData | null {
  const roles = rolesById(input.roles);
  const outletIds = new Set<OutletId>();
  for (const row of activeAssignmentsOf(input.principal, input.now)) {
    const role = roles.get(lower(row.roleId));
    if (!role) continue;
    if (input.permission && !role.permissions.includes(input.permission))
      continue;
    const outlets = outletsOfScope(row.scope, input.org);
    if (outlets === null) return { kind: "tenant" };
    for (const id of outlets) outletIds.add(lower(id) as OutletId);
  }
  return outletIds.size === 0
    ? null
    : { kind: "outlets", outletIds: [...outletIds] };
}

/**
 * Stations the caller may work on for `permission` (KDS: "Hanya KDS stasiun
 * yang ditugaskan"). Station assignments give that station; wider scopes give
 * every station of the outlets they reach. This is the authoritative list
 * station-bound services filter and assert against (legend-fsb7): an id
 * missing from it is denied, and an unknown or soft-deleted station is never
 * in it (the org index only carries live stations of the caller's brand).
 */
export function stationReachOf(input: {
  readonly principal: AccessPrincipal;
  readonly roles: readonly RoleGrant[];
  readonly org: OrgIndex;
  readonly now: Date;
  readonly permission: PermissionCode;
}): StationId[] {
  return input.org.stations
    .filter((station) => {
      const decision = authorize({
        ...input,
        target: { type: "station", id: station.id },
        surface: "kds",
        mfaVerified: false,
      });
      return decision.allowed;
    })
    .map((station) => station.id);
}

export type { ScopeType };
