// 1269 E3: refuses a cloud POS write (sale, drawer, shift opening, points,
// tickets) on an outlet its edge serves
// (services/pos-edge-outlet.ts). Mount after the permission guard, so a caller
// without the permission still gets 403.
import type { NextFunction, Request, Response } from "express";
import { outletIdSchema } from "@starter/shared/core";
import { orderIdSchema } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertPosRefundNotOnEdge,
  assertPosWriteNotOnEdge,
  assertTargetOutletNotOnEdge,
} from "../services/pos-edge-outlet.ts";
import { getScopedTenantContext } from "./permissions.ts";
import { getTenantContext } from "./tenant.ts";

type Middleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * 409 when the outlet is served by an edge. For a handler that resolved the
 * outlet itself after its own checks (E3b: the signed device's outlet).
 */
export async function assertPosWriteOnCloud(
  req: Request,
  outletId: unknown,
): Promise<void> {
  const parsed = outletIdSchema.safeParse(outletId);
  // A malformed or missing outlet id is left to the route's own checks.
  if (!parsed.success) return;
  const tenantId = getTenantContext(req).tenantId;
  await withTenant(db, memberTenantContext(tenantId), (tx) =>
    assertPosWriteNotOnEdge(tx, tenantId, parsed.data),
  );
}

/** The outlet comes from a value an earlier middleware resolved. */
export function requirePosWriteOnCloudFor(
  outletOf: (req: Request) => unknown,
): Middleware {
  return async (req, _res, next) => {
    await assertPosWriteOnCloud(req, outletOf(req));
    next();
  };
}

/** The outlet comes from the `:outletId` path parameter. */
export const requirePosWriteOnCloud: Middleware = requirePosWriteOnCloudFor(
  (req) => req.params.outletId,
);

/**
 * 1269 E6: `:outletId` and `:orderId` from the path. The refund of an edge
 * sale the cloud ingested passes (back office refunds it); everything else
 * on an outlet its edge serves is 409, as `requirePosWriteOnCloud`.
 */
export const requirePosRefundOnCloud: Middleware = async (req, _res, next) => {
  const outlet = outletIdSchema.safeParse(req.params.outletId);
  // A malformed outlet id is left to the route's own checks.
  if (outlet.success) {
    const order = orderIdSchema.safeParse(req.params.orderId);
    const tenantId = getTenantContext(req).tenantId;
    await withTenant(db, memberTenantContext(tenantId), (tx) =>
      assertPosRefundNotOnEdge(
        tx,
        tenantId,
        outlet.data,
        order.success ? order.data : null,
      ),
    );
  }
  next();
};

/**
 * The outlet of a target the path names by id (E3b: order item, issue,
 * charge), read on the server. Mount after the permission guard; a target
 * outside the caller's scope is left to the service (assertTargetOutletNotOnEdge).
 */
export function requirePosWriteOnCloudOfTarget(
  outletOf: (req: Request) => Promise<string | null>,
): Middleware {
  return async (req, _res, next) => {
    await assertTargetOutletNotOnEdge(
      getScopedTenantContext(req),
      await outletOf(req),
    );
    next();
  };
}
