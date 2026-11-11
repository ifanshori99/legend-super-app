// Route-side floor authorization (TEN-02/TEN-03). The floor editor routes carry
// no outlet id (contract decision, legend-th7): the server resolves the
// caller's outlet from the stored role assignments.
//
// `resolveFloorContext` loads the access snapshot and mints a context only for
// an outlet the permission actually reaches. When a tenant-wide role reaches
// several outlets, the outlet the session pinned with PUT /api/me/active-outlet
// (legend-6vgv) is the working outlet when the permission still reaches it;
// without a valid pin the first active outlet (created_at, id) is, matching
// the development bootstrap.
//
// `requireTenantContext`, `requireAuth` and `requireTrustedOrigin` run before
// this helper on every route that uses it.

import type { Request } from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { HttpError } from "../lib/http-error";
import { getTenantContext } from "../middleware/tenant";
import { getAuth } from "../middleware/auth";
import { loadRequestAccess } from "../middleware/permissions";
import { listTenantOutletIds } from "../services/floor.service";
import { pinnedOutletOf } from "../services/me-active-outlet.service";

export type FloorAccess = {
  readonly context: ScopedTenantContext;
  /** The outlet a floor-level read/write works on ("the caller's outlet"). */
  readonly outletId: string;
};

/**
 * An acting cashier's token is bound to one outlet (middleware/acting-staff.ts
 * leaves the check to the handler on routes without :outletId). A brand- or
 * tenant-wide role must not let the token act in another outlet.
 */
function assertActingOutlet(req: Request, outletId: string): void {
  const acting = req.actingStaff;
  if (acting && acting.outletId.toLowerCase() !== outletId.toLowerCase())
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif ini bertugas di outlet lain.",
    );
}

/**
 * The reach of an acting cashier's context is cut to the token's outlet: a
 * tenant- or brand-wide role would otherwise let a service touch rows of
 * another outlet by id (they then read as not found).
 */
function narrowToActingOutlet(
  req: Request,
  context: ScopedTenantContext,
): ScopedTenantContext {
  const acting = req.actingStaff;
  if (!acting) return context;
  return establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(acting.outletId)],
  });
}

/** Denies unless `permission` reaches at least one outlet of this tenant. */
export async function resolveFloorContext(
  req: Request,
  permission: PermissionCode,
): Promise<FloorAccess> {
  const snapshot = await loadRequestAccess(req);
  const tenant = getTenantContext(req);
  const outletIds = await listTenantOutletIds(
    establishScopedTenantContext(tenant, { kind: "tenant" }),
  );
  // An acting cashier works in the token's outlet only, whatever else the
  // role reaches.
  const candidates = req.actingStaff
    ? outletIds.filter(
        (raw) => raw.toLowerCase() === req.actingStaff!.outletId.toLowerCase(),
      )
    : outletIds;
  // The pinned outlet goes first. It is only a preference: the permission
  // must still reach it, else the loop falls through to the other outlets.
  const pinned = req.auth
    ? await pinnedOutletOf(tenant, getAuth(req).session.id)
    : null;
  const ordered = pinned
    ? [
        ...candidates.filter((raw) => raw.toLowerCase() === pinned),
        ...candidates.filter((raw) => raw.toLowerCase() !== pinned),
      ]
    : candidates;
  for (const raw of ordered) {
    const outletId = outletIdSchema.parse(raw);
    const context = snapshot.contextFor(permission, {
      type: "outlet",
      id: outletId,
    });
    if (context) {
      assertTrustedScopedContext(context);
      return { context: narrowToActingOutlet(req, context), outletId };
    }
  }
  throw new AccessError(
    "PERMISSION_DENIED",
    "Your account cannot manage the floor of this tenant's outlets.",
  );
}

/**
 * A context for an action on one known outlet (the board read). The id comes
 * from the verified path/route, never from the body.
 */
export async function resolveOutletContext(
  req: Request,
  permission: PermissionCode,
  outletId: string,
): Promise<ScopedTenantContext> {
  const snapshot = await loadRequestAccess(req);
  const parsed = outletIdSchema.parse(outletId);
  assertActingOutlet(req, parsed);
  const context = snapshot.contextFor(permission, {
    type: "outlet",
    id: parsed,
  });
  if (!context)
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this outlet.",
    );
  assertTrustedScopedContext(context);
  return narrowToActingOutlet(req, context);
}
