// Back-office mount of the AUTH-05 gate (bead legend-qfvu; PRD v1.7 §3 F6/F7,
// TEN-02/03). legend-6xf's requireIdentitySurface() takes the tenant from the
// session row, but nothing sets `session.tenant_id` yet (tenant-bound login is
// its own follow-up). A back-office API already has a server-minted tenant —
// requireTenantContext() resolved it from the domain or credential, never from
// client input — so this adapter hands that id to the real RBAC resolver.
//
// Mount it once per guarded router, after requireTenantContext. The router's
// own requireTenantPermission(...) calls still decide every permission and
// outlet scope.

import type { RequestHandler } from "express";
import { getTenantContext } from "./tenant";
import { requireIdentitySurface } from "./identity";
import { loadSurfaceAccessFacts } from "../services/surface-access.service";

export function requireBackOfficeSurface(): RequestHandler {
  return (req, res, next) => {
    // Programming error if a router mounts this before requireTenantContext.
    const tenant = getTenantContext(req);
    return requireIdentitySurface("back_office", {
      resolveAccessFacts: (input) =>
        loadSurfaceAccessFacts({ ...input, tenantId: tenant.tenantId }),
    })(req, res, next);
  };
}
