// The server side of the Legend RBAC contract (bead legend-4f9; PRD v1.7
// §3.7 RBAC, §6 B role_assignments, TEN-03, AUTH-05).
//
// One resolver turns a verified session into:
// - the caller's effective permission codes (union of active assignments),
// - a server-minted ScopedTenantContext whose outlet reach becomes the RLS
//   `app.outlet_ids` filter (minted on the server, never from client input,
//   TEN-02),
// - `mfaRequired` / `mfaVerified` for the web area guards (AUTH-05).
//
// Deny by default: assignments, roles and the org tree are loaded inside the
// tenant transaction (RLS), and the pure decision comes from
// `@starter/shared/access` (`authorize`, `outletReachOf`); nothing here
// re-implements the catalog or the scope rules.
//
// Station scope: the menu/KDS schema (`stations`) belongs to WS-03 and has not
// landed. The org index therefore reports no stations, so a station-scoped
// assignment grants nothing yet (fail closed). The wiring bead must add the
// stations query here; see the report.

import {
  PERMISSION_CODES,
  roleAssignmentSchema,
  roleIdSchema,
  stationIdSchema,
  authorize,
  isAssignmentActive,
  outletReachOf,
  userRequiresMfa,
  type AccessTarget,
  type OrgIndex,
  type PermissionCode,
  type RoleAssignment,
  type RoleGrant,
} from "@starter/shared/access";
import {
  brandIdSchema,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  brands,
  outlets,
  roleAssignments,
  roles,
  stations,
} from "../db/schema";
import { withTenant } from "../db/tenant";

export type RoleGrantRow = RoleGrant & {
  readonly templateKey: string | null;
  readonly allowedScopeTypes: readonly string[];
};

export type TenantAccessData = {
  readonly assignments: readonly RoleAssignment[];
  readonly roles: readonly RoleGrantRow[];
  readonly org: OrgIndex;
};

type AssignmentRow = typeof roleAssignments.$inferSelect;
type RoleRow = typeof roles.$inferSelect;

function toAssignment(row: AssignmentRow): RoleAssignment {
  return roleAssignmentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    roleId: row.roleId,
    scope:
      row.scopeType === "tenant"
        ? { type: "tenant", id: null }
        : { type: row.scopeType, id: row.scopeId },
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt.toISOString(),
  });
}

export function toRoleGrant(row: RoleRow): RoleGrantRow {
  return {
    id: roleIdSchema.parse(row.id),
    permissions: row.permissions,
    mfaRequired: row.mfaRequired,
    templateKey: row.templateKey,
    allowedScopeTypes: row.allowedScopeTypes,
  };
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Assignments, roles and the org tree for one user, read on the caller's
 * tenant transaction so the write and the authorization see one snapshot.
 */
export async function loadTenantAccessInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
): Promise<TenantAccessData> {
  // One query at a time on the tenant transaction: pg serialises concurrent
  // queries on a single client anyway, and its deprecation warning would
  // otherwise fire on every request.
  const assignmentRows = await tx
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, context.tenant.tenantId),
        eq(roleAssignments.userId, userId),
      ),
    );
  const roleRows = await tx
    .select()
    .from(roles)
    .where(eq(roles.tenantId, context.tenant.tenantId));
  const brandRows = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(
      context.tenant.brandId === null
        ? eq(brands.tenantId, context.tenant.tenantId)
        : and(
            eq(brands.tenantId, context.tenant.tenantId),
            eq(brands.id, context.tenant.brandId),
          ),
    );
  const outletRows = await tx
    .select({ id: outlets.id, brandId: outlets.brandId })
    .from(outlets)
    .where(
      context.tenant.brandId === null
        ? eq(outlets.tenantId, context.tenant.tenantId)
        : and(
            eq(outlets.tenantId, context.tenant.tenantId),
            eq(outlets.brandId, context.tenant.brandId),
          ),
    );
  // Stations (WS-03 menu schema) make station-scoped assignments resolvable.
  // The org index is brand-filtered like the outlets above, so a brand pinned
  // by the domain cannot see another brand's stations. Soft-deleted (edge
  // tombstone) stations grant nothing.
  const stationRows =
    context.tenant.brandId !== null && outletRows.length === 0
      ? []
      : await tx
          .select({ id: stations.id, outletId: stations.outletId })
          .from(stations)
          .where(
            and(
              eq(stations.tenantId, context.tenant.tenantId),
              isNull(stations.deletedAt),
              context.tenant.brandId === null
                ? undefined
                : inArray(
                    stations.outletId,
                    outletRows.map((row) => row.id),
                  ),
            ),
          );
  return {
    assignments: assignmentRows.map(toAssignment),
    roles: roleRows.map(toRoleGrant),
    org: {
      brands: brandRows.map((row) => ({ id: brandIdSchema.parse(row.id) })),
      outlets: outletRows.map((row) => ({
        id: outletIdSchema.parse(row.id),
        brandId: brandIdSchema.parse(row.brandId),
      })),
      // WS-03 menu schema (legend-lmk): station-scoped assignments resolve.
      stations: stationRows.map((row) => ({
        id: stationIdSchema.parse(row.id),
        outletId: outletIdSchema.parse(row.outletId),
      })),
    },
  };
}

/**
 * Assignments, roles and the org tree for one user, read inside the tenant
 * transaction so RLS applies (TEN-01/02). The org index is filtered to the
 * brand pinned by the domain, when there is one.
 */
export async function loadTenantAccess(
  context: ScopedTenantContext,
  userId: string,
): Promise<TenantAccessData> {
  return withTenant(db, context, (tx) =>
    loadTenantAccessInTransaction(tx, context, userId),
  );
}

export type AccessSnapshotInput = {
  readonly tenant: TenantContext;
  readonly userId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly roles: readonly RoleGrantRow[];
  readonly org: OrgIndex;
  readonly mfaVerified: boolean;
  readonly now: Date;
};

export type AccessSnapshot = {
  readonly tenant: TenantContext;
  readonly userId: string;
  /** Catalog-ordered, de-duplicated effective codes. */
  readonly permissions: readonly PermissionCode[];
  /** users.mfa_required: an active assignment of a role that requires MFA. */
  readonly mfaRequired: boolean;
  readonly mfaVerified: boolean;
  /** Template keys the user actively holds (for the shell's role label). */
  readonly templateKeys: readonly string[];
  /** Permission + scope + time decision for one target. */
  readonly allows: (
    permission: PermissionCode,
    target: AccessTarget,
  ) => boolean;
  /**
   * The server-minted context for a permitted action, or null. Its outlet
   * reach is what `withTenant` installs as app.outlet_ids for RLS (TEN-03).
   */
  readonly contextFor: (
    permission: PermissionCode,
    target: AccessTarget,
  ) => ScopedTenantContext | null;
};

/**
 * Pure snapshot of what a session may do. MFA is reported, not enforced here:
 * the web guard applies AUTH-05 through these flags, and legend-6xf owns the
 * API-side second-factor gate (`assertSurfaceAccess`). Permission and scope
 * decisions always apply.
 */
export function resolveAccessSnapshot(
  input: AccessSnapshotInput,
): AccessSnapshot {
  const userId = userIdSchema.parse(input.userId);
  const principal = {
    tenantId: input.tenant.tenantId,
    userId,
    assignments: input.assignments,
  } as const;
  const roleById = new Map(
    input.roles.map((role) => [role.id.toLowerCase(), role]),
  );
  const permissions = new Set<PermissionCode>();
  const templateKeys = new Set<string>();
  for (const assignment of input.assignments) {
    if (
      assignment.tenantId.toLowerCase() !==
        input.tenant.tenantId.toLowerCase() ||
      assignment.userId.toLowerCase() !== userId.toLowerCase() ||
      !isAssignmentActive(assignment, input.now)
    )
      continue;
    const role = roleById.get(assignment.roleId.toLowerCase());
    if (!role) continue;
    for (const permission of role.permissions) permissions.add(permission);
    if (role.templateKey !== null) templateKeys.add(role.templateKey);
  }
  const effective = PERMISSION_CODES.filter((code) => permissions.has(code));

  // The contract's one decision. `pos` is a device surface, so this asks the
  // permission/scope/time question without the back-office second-factor rule;
  // AUTH-05 is a separate gate (web guard now, legend-6xf for the API).
  const allows = (permission: PermissionCode, target: AccessTarget) =>
    authorize({
      principal,
      roles: input.roles,
      org: input.org,
      permission,
      target,
      now: input.now,
      surface: "pos",
      mfaVerified: false,
    }).allowed;

  const contextFor = (
    permission: PermissionCode,
    target: AccessTarget,
  ): ScopedTenantContext | null => {
    if (!allows(permission, target)) return null;
    const reach = outletReachOf({
      principal,
      roles: input.roles,
      org: input.org,
      now: input.now,
      permission,
    });
    if (reach === null) return null;
    return establishScopedTenantContext(input.tenant, reach);
  };

  return {
    tenant: input.tenant,
    userId: input.userId,
    permissions: effective,
    mfaRequired: userRequiresMfa(principal, input.roles, input.now),
    mfaVerified: input.mfaVerified,
    templateKeys: [...templateKeys],
    allows,
    contextFor,
  };
}
