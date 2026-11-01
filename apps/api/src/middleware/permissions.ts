// Tenant authorization middleware (bead legend-4f9; TEN-03). Mount after
// requireAuth + requireTrustedOrigin + requireTenantContext: the tenant comes
// from the domain or token (TEN-02), never from the request.
//
// The route names the permission it needs; the resolver answers with the
// server-minted ScopedTenantContext the handler passes to services. Its outlet
// reach is what `withTenant` installs as app.outlet_ids, so RLS and the service
// checks agree on the caller's scope.
//
// AUTH-05: the snapshot carries `mfaRequired` / `mfaVerified` for the web area
// guards and `/api/me/access`. The API-side second-factor gate is bead
// legend-6xf (`assertSurfaceAccess` from @starter/shared/access); this
// middleware enforces permission + scope + time only, which keeps every other
// BE route usable until the MFA factor store lands.

import type { Request, RequestHandler } from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { getAuth } from "./auth";
import { sessionMfaVerifiedAt } from "../lib/mfa";
import { getTenantContext } from "./tenant";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
  type AccessSnapshot,
} from "../services/permission-resolver";

const snapshots = new WeakMap<Request, AccessSnapshot>();
const contexts = new WeakMap<Request, ScopedTenantContext>();

/**
 * Resolves (and caches per request) the caller's effective access. Read-only:
 * the tenant transaction only selects assignments, roles and the org tree.
 */
export async function loadRequestAccess(req: Request): Promise<AccessSnapshot> {
  const cached = snapshots.get(req);
  if (cached) return cached;
  const tenant = getTenantContext(req);
  const userId = getAuth(req).user.id;
  const data = await loadTenantAccess(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    userId,
  );
  const snapshot = resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    // The session's verified second factor (lib/mfa.ts, bead legend-6xf).
    // Never the per-request `mfaCode` check: that consumes a TOTP step and is
    // reserved for TEN-04 support access. The web guard reads the same flag
    // through /api/me/access.
    mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
    now: new Date(),
  });
  snapshots.set(req, snapshot);
  return snapshot;
}

/** The snapshot loaded by a permission middleware on this request. */
export function getAccessSnapshot(req: Request): AccessSnapshot {
  const snapshot = snapshots.get(req);
  if (!snapshot)
    throw new Error("getAccessSnapshot() used without a permission middleware");
  return snapshot;
}

/** The tenant context minted for this request's permitted action (TEN-03). */
export function getScopedTenantContext(req: Request): ScopedTenantContext {
  const context = contexts.get(req);
  if (!context)
    throw new Error(
      "getScopedTenantContext() used without requireTenantPermission",
    );
  return context;
}

/**
 * Requires `permission` over the whole tenant (tenant administration: roles,
 * organisation settings, approval matrix). A brand/outlet/station-scoped grant
 * does not reach a tenant-wide target, so it is denied (deny by default).
 *
 * The role/route split that already exists in the codebase uses
 * `requireTenantPermission("org.structure.manage")` on org routes and
 * `requireTenantPermission("access.role.view")` on the RBAC routes.
 */
export function requireTenantPermission(
  permission: PermissionCode,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const context = snapshot.contextFor(permission, { type: "tenant" });
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

/**
 * Requires `permission` on one outlet and mints an outlet-scoped context, so
 * `withTenant` installs `app.outlet_ids` and RLS limits every query to that
 * outlet (TEN-03). The outlet id must come from the verified request (path or
 * body) and is schema-validated; a role that only holds another outlet, or a
 * station-only grant, is denied. No route uses it yet (POS/KDS land with
 * WS-04); the resolver half is covered by permission-resolver.test.ts.
 */
export function requireOutletPermission(
  permission: PermissionCode,
  outletIdOf: (req: Request) => string,
): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const outletId = outletIdSchema.parse(outletIdOf(req));
    const context = snapshot.contextFor(permission, {
      type: "outlet",
      id: outletId,
    });
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this outlet.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}
