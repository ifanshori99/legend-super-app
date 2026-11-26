// 1269 E3: refuses a cloud POS write (sale, drawer, shift opening, points,
// tickets) on an outlet its edge serves
// (services/pos-edge-outlet.ts). Mount after the permission guard, so a caller
// without the permission still gets 403.
//
// 1271 F3: the `Core` variants mark the core POS paths the cloud serves while
// the outlet's failover window is `active` (CTO allowlist: cashier/captain
// order, payment, shift and drawer, receipt, KDS/expo, cashier sign-in). Every
// other write uses the plain variant and stays refused during a window.
import type { NextFunction, Request, Response } from "express";
import { outletIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertPosWriteNotOnEdge,
  assertTargetOutletNotOnEdge,
  type PosWriteGateOptions,
  type PosWriteTarget,
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
  options: PosWriteGateOptions = {},
): Promise<void> {
  const parsed = outletIdSchema.safeParse(outletId);
  // A malformed or missing outlet id is left to the route's own checks.
  if (!parsed.success) return;
  const tenantId = getTenantContext(req).tenantId;
  await withTenant(db, memberTenantContext(tenantId), (tx) =>
    assertPosWriteNotOnEdge(tx, tenantId, parsed.data, options),
  );
}

/** The outlet comes from a value an earlier middleware resolved. */
export function requirePosWriteOnCloudFor(
  outletOf: (req: Request) => unknown,
  options: PosWriteGateOptions = {},
): Middleware {
  return async (req, _res, next) => {
    await assertPosWriteOnCloud(req, outletOf(req), options);
    next();
  };
}

/** The outlet comes from the `:outletId` path parameter. */
export const requirePosWriteOnCloud: Middleware = requirePosWriteOnCloudFor(
  (req) => req.params.outletId,
);

/** Path parameters naming the row a core write acts on, first match wins. */
const TARGET_PARAMS: ReadonlyArray<[string, PosWriteTarget["kind"]]> = [
  ["orderId", "order"],
  ["shiftId", "shift"],
  ["receiptId", "receipt"],
  ["ticketId", "kitchen_ticket"],
];

function targetOf(
  req: Request,
  extra?: PosWriteTarget["kind"],
): PosWriteTarget | undefined {
  for (const [param, kind] of TARGET_PARAMS) {
    const id = req.params[param];
    if (typeof id === "string") return { kind, id };
  }
  const id = extra === undefined ? undefined : req.params.itemId;
  return typeof id === "string" && extra ? { kind: extra, id } : undefined;
}

function coreGate(extra?: PosWriteTarget["kind"]): Middleware {
  return async (req, _res, next) => {
    await assertPosWriteOnCloud(req, req.params.outletId, {
      failover: "core",
      target: targetOf(req, extra),
    });
    next();
  };
}

/**
 * Same as requirePosWriteOnCloud, for a core POS path open during an active
 * failover window; a row named in the path (order, shift, receipt, kitchen
 * ticket) must belong to that window.
 */
export const requireCorePosWriteOnCloud: Middleware = coreGate();

/** The KDS `/ticket-items/:itemId` variant (the item names its order). */
export const requireCoreKitchenItemWriteOnCloud: Middleware = coreGate(
  "kitchen_ticket_item",
);

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
