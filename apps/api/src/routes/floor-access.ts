// Route-side floor authorization (TEN-02/TEN-03). The floor editor routes carry
// no outlet id (contract decision, legend-th7): the server resolves the
// caller's outlet from the stored role assignments.
//
// `resolveFloorContext` loads the access snapshot and mints a context only for
// an outlet the permission actually reaches. When a tenant-wide role reaches
// several outlets, the first active outlet (created_at, id) is the working
// outlet, matching the development bootstrap; a later WS-01 bead exposes the
// staff's assigned outlets so the UI can pick one explicitly.
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
import { getTenantContext } from "../middleware/tenant";
import { loadRequestAccess } from "../middleware/permissions";
import { listTenantOutletIds } from "../services/floor.service";

export type FloorAccess = {
  readonly context: ScopedTenantContext;
  /** The outlet a floor-level read/write works on ("the caller's outlet"). */
  readonly outletId: string;
};

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
  for (const raw of outletIds) {
    const outletId = outletIdSchema.parse(raw);
    const context = snapshot.contextFor(permission, {
      type: "outlet",
      id: outletId,
    });
    if (context) {
      assertTrustedScopedContext(context);
      return { context, outletId };
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
  return context;
}
