// 1269 E3: refuses a cloud POS write (sale, drawer, shift opening) on an outlet
// its edge serves (services/pos-edge-outlet.ts). Mount after the permission
// guard, so a caller without the permission still gets 403.
import type { NextFunction, Request, Response } from "express";
import { outletIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { assertPosWriteNotOnEdge } from "../services/pos-edge-outlet.ts";
import { getScopedTenantContext } from "./permissions.ts";

export async function requirePosWriteOnCloud(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = outletIdSchema.safeParse(req.params.outletId);
  // A malformed outlet id is left to the route's own params schema.
  if (parsed.success) {
    const context = getScopedTenantContext(req);
    await withTenant(db, context, (tx) =>
      assertPosWriteNotOnEdge(tx, context.tenant.tenantId, parsed.data),
    );
  }
  next();
}
