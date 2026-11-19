// Route gate for the HRIS SOP library, training and announcements (PRD v1.7
// §3 F32; bead legend-7df1).
//
// Same model as `requireHris` in hris.routes.ts: the gate only decides "may
// this caller use the route at all" and mints the narrowest context that
// covers it: tenant-wide if any accepted code is held tenant-wide, otherwise
// the union of the outlets those codes reach (TEN-03). The services re-check
// every record inside the tenant transaction (someone else's row answers 404).
//
// Duplicated on purpose: hris.routes.ts does not export its gate, and other
// workstreams edit that file, so these modules keep their own copy.
//
// AUTH-05: back-office routes run behind requireBackOfficeSurface; employee
// PWA routes use the `hris` identity surface (session checks, no back-office
// MFA rule).

import type { Request, RequestHandler } from "express";
import {
  AccessError,
  outletReachOf,
  type PermissionCode,
} from "@starter/shared/access";
import {
  outletIdSchema,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { getAuth } from "../middleware/auth.ts";
import { requireIdentitySurface } from "../middleware/identity.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import { getTenantContext } from "../middleware/tenant.ts";
import {
  loadTenantAccess,
  type AccessSnapshot,
} from "../services/permission-resolver.ts";
import { loadSurfaceAccessFacts } from "../services/surface-access.service.ts";

export { requireBackOfficeSurface } from "../middleware/identity-surface.ts";

const contexts = new WeakMap<Request, ScopedTenantContext>();

/** The context minted by `requireHrisLearning` for this request. */
export function hrisLearningContext(req: Request): ScopedTenantContext {
  const context = contexts.get(req);
  if (!context)
    throw new Error("hrisLearningContext() used without requireHrisLearning()");
  return context;
}

/** Session user id of the caller (validated). */
export function hrisLearningActor(req: Request) {
  return userIdSchema.parse(getAuth(req).user.id);
}

/**
 * The union-reach context for `codes`, or null when none of them reaches
 * anything. Tenant-wide if any code is held tenant-wide, otherwise the outlets
 * the codes reach through outlet or brand grants. A station-only grant has no
 * outlet reach here, so it never counts (legend-dak5).
 */
export async function resolveHrisLearningContext(
  snapshot: AccessSnapshot,
  tenant: TenantContext,
  userId: string,
  codes: readonly PermissionCode[],
): Promise<ScopedTenantContext | null> {
  for (const code of codes) {
    const context = snapshot.contextFor(code, { type: "tenant" });
    if (context) return context;
  }
  if (!codes.some((code) => snapshot.permissions.includes(code))) return null;
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userIdSchema.parse(userId),
  );
  const outletIds = new Set<OutletId>();
  let tenantWide = false;
  for (const code of codes) {
    const reach = outletReachOf({
      principal: {
        tenantId: tenant.tenantId,
        userId: userIdSchema.parse(userId),
        assignments: data.assignments,
      },
      roles: data.roles,
      org: data.org,
      now: data.clock ?? new Date(),
      permission: code,
    });
    if (reach === null) continue;
    if (reach.kind === "tenant") tenantWide = true;
    else
      for (const id of reach.outletIds)
        outletIds.add(outletIdSchema.parse(id.toLowerCase()));
  }
  if (tenantWide)
    return establishScopedTenantContext(tenant, { kind: "tenant" });
  if (outletIds.size > 0)
    return establishScopedTenantContext(tenant, {
      kind: "outlets",
      outletIds: [...outletIds],
    });
  return null;
}

/**
 * Admits the caller when they hold any of `codes` with some reach, and mints
 * the union-reach context. Deny by default: no reach → PERMISSION_DENIED.
 */
export function requireHrisLearning(
  codes: readonly PermissionCode[],
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const context = await resolveHrisLearningContext(
      snapshot,
      getTenantContext(req),
      getAuth(req).user.id,
      codes,
    );
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this tenant.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/** Employee PWA surface: session checks, no back-office MFA rule. */
export function requireHrisLearningSurface(): RequestHandler {
  return (req, res, next) => {
    const tenant = getTenantContext(req);
    return requireIdentitySurface("hris", {
      resolveAccessFacts: (input) =>
        loadSurfaceAccessFacts({ ...input, tenantId: tenant.tenantId }),
    })(req, res, next);
  };
}
