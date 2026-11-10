// Attach a member to an unpaid POS order (legend-111j; contract
// `setOrderCustomer`, PUT /api/pos/orders/:orderId/customer). The path
// carries no outlet, so the order's outlet is resolved first and the cashier
// needs `pos.sale.create` on it (TEN-03), like the other POS order writes.
// Mounted without a prefix (absolute path), guards on the route.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import { setOrderCustomer as setOrderCustomerEndpoint } from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
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
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  jsonBody,
  async (req, _res, next) => {
    const { orderId } = setOrderCustomerEndpoint.params.parse(req.params);
    const outletId = await orderCustomer.findPosOrderOutletId(
      getTenantContext(req).tenantId,
      orderId,
    );
    if (!outletId)
      throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
    outlets.set(req, outletId);
    next();
  },
  sell,
  async (req, res) => {
    const { orderId } = setOrderCustomerEndpoint.params.parse(req.params);
    const input = setOrderCustomerEndpoint.body.parse(req.body);
    res.json({
      data: await orderCustomer.setPosOrderCustomer(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        orderId,
        input,
      ),
    });
  },
);
