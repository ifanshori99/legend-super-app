// Production RBAC facts for the AUTH-05 surface gate (bead legend-qfvu; PRD
// v1.7 §3 F6/F7, §6 B). legend-6xf ships the gate with a fail-closed port;
// this is the resolver it was waiting for now that the RBAC engine (legend-4f9)
// and tenant resolution (legend-1je) are on main.
//
// The facts are the same rows the permission middleware authorizes with
// (permission-resolver), read inside the tenant transaction so RLS applies
// (TEN-01/02). They answer `assertSurfaceAccess`'s question — which MFA roles
// the caller actively holds — and never widen access: the per-route
// requireTenantPermission still decides permission and scope.

import { tenantIdSchema, userIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { loadTenantAccess } from "./permission-resolver";
import type {
  SurfaceAccessFacts,
  SurfaceAccessFactsInput,
  SurfaceAccessFactsResolver,
} from "./identity-access.service";

export async function loadSurfaceAccessFacts(
  input: SurfaceAccessFactsInput,
): Promise<SurfaceAccessFacts | null> {
  // No tenant, no back office. The platform panel is guarded by
  // requireSessionMfa() instead (platform roles are not tenant assignments).
  if (input.tenantId === null) return null;
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(input.tenantId),
    // Brand pinning only narrows the org index; the gate asks about active
    // MFA roles in the tenant, and requireTenantPermission still authorizes
    // against the domain-pinned context.
    brandId: null,
    source: "session",
  });
  const userId = userIdSchema.parse(input.userId);
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userId,
  );
  return {
    principal: {
      tenantId: tenant.tenantId,
      userId,
      assignments: data.assignments,
    },
    roles: data.roles,
    clock: data.clock,
  };
}

export const resolveSurfaceAccessFacts: SurfaceAccessFactsResolver =
  loadSurfaceAccessFacts;
