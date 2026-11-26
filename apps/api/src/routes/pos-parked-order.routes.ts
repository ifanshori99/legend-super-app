import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  createPosParkedOrder,
  getPosParkedOrder,
  listPosParkedOrders,
  resumePosParkedOrder,
} from "@starter/shared/pos";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requirePosWriteOnCloud } from "../middleware/pos-on-cloud.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as parked from "../services/pos-parked-order.service.ts";

export const posParkedOrderRouter = Router({ mergeParams: true });
posParkedOrderRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const view = requireOutletPermission("order.view", outletOf);
const sell = requireOutletPermission("pos.sale.create", outletOf);
const creatorOf = (req: Request) => userIdSchema.parse(actorOf(req));

posParkedOrderRouter.post(
  "/parked-orders",
  sell,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId } = createPosParkedOrder.params.parse(req.params);
    const input = createPosParkedOrder.body.parse(req.body);
    const data = await parked.createPosParkedOrder(
      getScopedTenantContext(req),
      creatorOf(req),
      outletId,
      input,
    );
    res
      .status(201)
      .location(
        `/api/outlets/${encodeURIComponent(outletId)}/pos/parked-orders/${encodeURIComponent(data.id)}`,
      )
      .json({ data });
  },
);

posParkedOrderRouter.get("/parked-orders", view, async (req, res) => {
  const { outletId } = listPosParkedOrders.params.parse(req.params);
  listPosParkedOrders.query.parse(req.query);
  res.json({
    data: await parked.listPosParkedOrders(
      getScopedTenantContext(req),
      creatorOf(req),
      outletId,
    ),
  });
});

posParkedOrderRouter.get(
  "/parked-orders/:parkedOrderId",
  view,
  async (req, res) => {
    const { outletId, parkedOrderId } = getPosParkedOrder.params.parse(
      req.params,
    );
    res.json({
      data: await parked.getPosParkedOrder(
        getScopedTenantContext(req),
        creatorOf(req),
        outletId,
        parkedOrderId,
      ),
    });
  },
);

posParkedOrderRouter.post(
  "/parked-orders/:parkedOrderId/resume",
  sell,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId, parkedOrderId } = resumePosParkedOrder.params.parse(
      req.params,
    );
    resumePosParkedOrder.body.parse(req.body);
    res.json({
      data: await parked.resumePosParkedOrder(
        getScopedTenantContext(req),
        creatorOf(req),
        outletId,
        parkedOrderId,
      ),
    });
  },
);
