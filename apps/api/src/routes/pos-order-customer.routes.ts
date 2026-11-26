// Attach a member to an unpaid POS order (legend-111j; contract
// `setOrderCustomer`, PUT /api/pos/orders/:orderId/customer). The path
// carries no outlet, so the order's outlet is resolved first and the cashier
// needs `pos.sale.create` on it (TEN-03), like the other POS order writes.
// Mounted without a prefix (absolute path), guards on the route.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { setOrderCustomer as setOrderCustomerEndpoint } from "@starter/shared/crm";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requirePosWriteOnCloudFor } from "../middleware/pos-on-cloud";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error";
import * as orderCustomer from "../services/pos-order-customer.service";

export const posOrderCustomerRouter = Router();

const outlets = new WeakMap<Request, string>();
const sell = requireOutletPermission("pos.sale.create", (req) => {
  const outletId = outlets.get(req);
  if (!outletId) throw new Error("Order outlet was not resolved");
  return outletId;
});

posOrderCustomerRouter.put(
  "/pos/orders/:orderId/customer",
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  jsonBody,
  async (req, _res, next) => {
    const { orderId } = setOrderCustomerEndpoint.params.parse(req.params);
    const outletId = await orderCustomer.findPosOrderOutletId(
      getTenantContext(req).tenantId,
      orderId,
    );
    if (!outletId)
      throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    // The path carries no outlet, so resolveActingStaff could not compare it:
    // a cashier token issued for another outlet is refused here.
    if (req.actingStaff && req.actingStaff.outletId !== outletId)
      throw new HttpError(
        403,
        ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
        "Kasir aktif bukan untuk outlet pesanan ini.",
      );
    outlets.set(req, outletId);
    next();
  },
  sell,
  requirePosWriteOnCloudFor((req) => outlets.get(req)),
  async (req, res) => {
    const { orderId } = setOrderCustomerEndpoint.params.parse(req.params);
    const input = setOrderCustomerEndpoint.body.parse(req.body);
    res.json({
      data: await orderCustomer.setPosOrderCustomer(
        getScopedTenantContext(req),
        userIdSchema.parse(actorOf(req)),
        orderId,
        input,
      ),
    });
  },
);
