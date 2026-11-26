// 1269 E3: refuses a cloud POS write (sale, drawer, shift opening, points,
// tickets) on an outlet its edge serves
// (services/pos-edge-outlet.ts). Mount after the permission guard, so a caller
// without the permission still gets 403.
import type { NextFunction, Request, Response } from "express";
import { outletIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { withTenant } from "../db/tenant.ts";
import { assertPosWriteNotOnEdge } from "../services/pos-edge-outlet.ts";
import { getTenantContext } from "./tenant.ts";

type Middleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/** 409 when the outlet `outletOf` names is served by an edge. */
async function assertOnCloud(req: Request, outletId: unknown): Promise<void> {
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
    await assertOnCloud(req, outletOf(req));
    next();
  };
}

/** The outlet comes from the `:outletId` path parameter. */
export const requirePosWriteOnCloud: Middleware = requirePosWriteOnCloudFor(
  (req) => req.params.outletId,
);
