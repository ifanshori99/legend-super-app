// AUTH-05 gate support for guarded surfaces (PRD v1.7 §3 F6/F7, §6 B).
//
// The permission and MFA decision itself is the contract's
// `assertSurfaceAccess` (@starter/shared/access) — this file only supplies the
// caller's RBAC facts. Those come from the RBAC engine (bead legend-4f9) which
// is not on main yet, so it is a port: the default resolver denies, and the
// integrator passes `resolveAccessFacts` when mounting a surface. A missing
// resolver therefore closes the surface instead of opening it.

import {
  AccessError,
  assertSurfaceAccess,
  isAssignmentActive,
  type AccessPrincipal,
  type AppSurface,
  type RoleGrant,
} from "@starter/shared/access";

/** What the gate needs from the RBAC engine: assignments, roles and tenant. */
export type SurfaceAccessFacts = {
  readonly principal: AccessPrincipal;
  readonly roles: readonly RoleGrant[];
  /**
   * The database clock the assignments were filtered with
   * (`TenantAccessData.clock`). When present it replaces the caller's `now`
   * for every assignment-validity check (bead 1201).
   */
  readonly clock?: Date;
};

export type SurfaceAccessFactsInput = {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly now: Date;
};

export type SurfaceAccessFactsResolver = (
  input: SurfaceAccessFactsInput,
) => Promise<SurfaceAccessFacts | null>;

/** Fail closed: no RBAC engine wired means no guarded surface. */
export const denySurfaceAccessFacts: SurfaceAccessFactsResolver = async () =>
  null;

/** True when the caller holds at least one active assignment (staff). */
export function hasActiveAssignment(
  facts: SurfaceAccessFacts,
  now: Date,
): boolean {
  return facts.principal.assignments.some((row) =>
    isAssignmentActive(row, facts.clock ?? now),
  );
}

/**
 * The API-side half of AUTH-05: a caller holding an MFA role cannot open back
 * office, dashboard or MCP without a second factor. `null` facts deny: the
 * surface cannot be authorized without a role resolver.
 */
export function assertSurfaceFacts(input: {
  readonly facts: SurfaceAccessFacts | null;
  readonly surface: AppSurface;
  readonly mfaVerified: boolean;
  readonly now: Date;
}): void {
  if (!input.facts) throw new AccessError("PERMISSION_DENIED");
  assertSurfaceAccess({
    principal: input.facts.principal,
    roles: input.facts.roles,
    surface: input.surface,
    mfaVerified: input.mfaVerified,
    now: input.facts.clock ?? input.now,
  });
}
