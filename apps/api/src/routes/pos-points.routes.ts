// Member points at the cashier (936, legend-hpgyw part B; contract
// @starter/shared/pos/points): balance, quote and redeem on a POS order. The
// path carries no outlet, so the order's outlet is resolved first and the
// cashier needs `pos.payment.accept` on it (TEN-03), like a tender. Mounted
// without a prefix (absolute path), guards on the route.

import { Router, type Request } from "express";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import {
  getPosOrderPoints,
  quotePosOrderPoints,
  redeemPosOrderPoints,
} from "@starter/shared/pos/points";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { requirePosWriteOnCloudFor } from "../middleware/pos-on-cloud";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error";
import * as points from "../services/pos-points.service";
import { findPosOrderOutletId } from "../services/pos-order-customer.service";
import { currentDeviceIdOf } from "./device-id";

export const posPointsRouter = Router();

const outlets = new WeakMap<Request, string>();
const pay = requireOutletPermission("pos.payment.accept", (req) => {
  const outletId = outlets.get(req);
  if (!outletId) throw new Error("Order outlet was not resolved");
  return outletId;
});

const guards = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

/** Resolves the order's outlet (404 when it is not this tenant's POS order). */
async function resolveOutlet(
  req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
): Promise<void> {
  const { orderId } = getPosOrderPoints.params.parse(req.params);
  const outletId = await findPosOrderOutletId(
    getTenantContext(req).tenantId,
    orderId,
  );
  if (!outletId)
    throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  // The path carries no outlet, so resolveActingStaff could not compare it.
  if (req.actingStaff && req.actingStaff.outletId !== outletId)
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif bukan untuk outlet pesanan ini.",
    );
  outlets.set(req, outletId);
  next();
}

const outletOf = (req: Request) => outletIdSchema.parse(outlets.get(req));
// 1269 E3: points of a sale at an outlet its edge serves are used on that edge.
const onCloud = requirePosWriteOnCloudFor((req) => outlets.get(req));

posPointsRouter.get(
  "/pos/orders/:orderId/points",
  ...guards,
  resolveOutlet,
  pay,
  async (req, res) => {
    const { orderId } = getPosOrderPoints.params.parse(req.params);
    res.json({
      data: await points.getPosOrderPointsAccount(
        getScopedTenantContext(req),
        outletOf(req),
        orderId,
      ),
    });
  },
);

posPointsRouter.post(
  "/pos/orders/:orderId/points/quote",
  ...guards,
  jsonBody,
  resolveOutlet,
  pay,
  onCloud,
  async (req, res) => {
    const { orderId } = quotePosOrderPoints.params.parse(req.params);
    const body = quotePosOrderPoints.body.parse(req.body);
    res.json({
      data: await points.quotePosOrderPoints(
        getScopedTenantContext(req),
        outletOf(req),
        orderId,
        body.points,
      ),
    });
  },
);

posPointsRouter.post(
  "/pos/orders/:orderId/points/redeem",
  ...guards,
  jsonBody,
  resolveOutlet,
  pay,
  onCloud,
  async (req, res) => {
    const { orderId } = redeemPosOrderPoints.params.parse(req.params);
    const body = redeemPosOrderPoints.body.parse(req.body);
    const detail = await points.redeemPosOrderPoints(
      getScopedTenantContext(req),
      {
        userId: userIdSchema.parse(actorOf(req)),
        deviceId: await currentDeviceIdOf(req),
        expectedVersion: null,
      },
      outletOf(req),
      orderId,
      body,
    );
    res
      .status(201)
      .setHeader("ETag", `"${detail.version}"`)
      .json({ data: detail });
  },
);
