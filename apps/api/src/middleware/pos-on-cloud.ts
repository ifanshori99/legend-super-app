// 1269 E3: refuses a cloud POS write (sale, drawer, shift opening, points,
// tickets, table seating) on an outlet its edge serves
// (services/pos-edge-outlet.ts). Mount after the permission guard, so a caller
// without the permission still gets 403.
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { outletIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { tableSessions } from "../db/schema/floor.ts";
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

/** The outlet is the one of the `:sessionId` table session (404 is the route's). */
export const requirePosWriteOnCloudForTableSession: Middleware =
  requirePosWriteOnCloudForAsync(async (req) => {
    const sessionId = String(req.params.sessionId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    const tenantId = getTenantContext(req).tenantId;
    return withTenant(db, memberTenantContext(tenantId), async (tx) => {
      const [row] = await tx
        .select({ outletId: tableSessions.outletId })
        .from(tableSessions)
        .where(
          and(
            eq(tableSessions.tenantId, tenantId),
            eq(tableSessions.id, sessionId),
          ),
        )
        .limit(1);
      return row?.outletId ?? null;
    });
  });

function requirePosWriteOnCloudForAsync(
  outletOf: (req: Request) => Promise<unknown>,
): Middleware {
  return async (req, _res, next) => {
    await assertOnCloud(req, await outletOf(req));
    next();
  };
}
