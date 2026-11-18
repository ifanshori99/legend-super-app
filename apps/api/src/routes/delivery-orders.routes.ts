// Delivery channel order routes (bead legend-5bn3; contract
// @starter/shared/delivery endpoints.ts), slice D4.
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/delivery-orders", deliveryOrdersRouter)`;
// the router merges params. requireAuth + requireTrustedOrigin +
// requireTenantContext like the POS routers; on a shared tablet the cashier PIN
// token is required (resolveActingStaff + requireActingStaffOnSharedDevice,
// legend-13vhb) and the actor is `actorOf(req)`; each handler adds
// requireOutletPermission on the path's outlet. The contract has one order
// permission (`delivery.order.handle`): list, detail, manual order and status
// steps all need it. An optional `Idempotency-Key` header makes a retried
// manual order or status step return the first answer.
import { Router, type Request } from "express";
import { idempotencyKeySchema, userIdSchema } from "@starter/shared/core";
import {
  createManualDeliveryOrder,
  getDeliveryOrder,
  listDeliveryOrders,
  mapDeliveryOrderLines,
  resendDeliveryOrderSync,
  resolveDeliveryOrderSync,
  updateDeliveryOrderStatus,
} from "@starter/shared/delivery";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as deliveryMapLines from "../services/delivery-map-lines.ts";
import * as deliveryOrders from "../services/delivery-orders.service.ts";
import * as platformRetry from "../services/delivery-platform-retry.ts";

export const deliveryOrdersRouter = Router({ mergeParams: true });

deliveryOrdersRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const handle = requireOutletPermission("delivery.order.handle", (req) =>
  String(req.params.outletId ?? ""),
);

/** Optional `Idempotency-Key` header; a malformed key is a 422. */
function idempotencyKeyOf(req: Request): string | null {
  const raw = req.get("Idempotency-Key");
  return raw === undefined ? null : idempotencyKeySchema.parse(raw);
}

function caller(req: Request): deliveryOrders.DeliveryOrderCaller {
  return {
    userId: userIdSchema.parse(actorOf(req)),
    idempotencyKey: idempotencyKeyOf(req),
  };
}

deliveryOrdersRouter.get("/", handle, async (req, res) => {
  const { outletId } = listDeliveryOrders.params.parse(req.params);
  const query = listDeliveryOrders.query.parse(req.query);
  res.json(
    await deliveryOrders.listDeliveryOrders(
      getScopedTenantContext(req),
      outletId,
      query,
    ),
  );
});

// Registered before `/:deliveryOrderId` so "manual" is never read as an id.
deliveryOrdersRouter.post("/manual", handle, jsonBody, async (req, res) => {
  const { outletId } = createManualDeliveryOrder.params.parse(req.params);
  const body = createManualDeliveryOrder.body.parse(req.body);
  const data = await deliveryOrders.createManualDeliveryOrder(
    getScopedTenantContext(req),
    caller(req),
    outletId,
    body,
  );
  res
    .status(201)
    .location(
      `/api/outlets/${encodeURIComponent(outletId)}/delivery-orders/${encodeURIComponent(data.id)}`,
    )
    .json({ data });
});

deliveryOrdersRouter.get("/:deliveryOrderId", handle, async (req, res) => {
  const { outletId, deliveryOrderId } = getDeliveryOrder.params.parse(
    req.params,
  );
  res.json({
    data: await deliveryOrders.getDeliveryOrder(
      getScopedTenantContext(req),
      outletId,
      deliveryOrderId,
    ),
  });
});

deliveryOrdersRouter.post(
  "/:deliveryOrderId/status",
  handle,
  jsonBody,
  async (req, res) => {
    const { outletId, deliveryOrderId } =
      updateDeliveryOrderStatus.params.parse(req.params);
    const body = updateDeliveryOrderStatus.body.parse(req.body);
    res.json({
      data: await deliveryOrders.updateDeliveryOrderStatus(
        getScopedTenantContext(req),
        caller(req),
        outletId,
        deliveryOrderId,
        body,
      ),
    });
  },
);

// legend-eyqvo (founder Q58): staff act on a `platformSync: needs_action`
// order. Same `delivery.order.handle` gate as the status step.
deliveryOrdersRouter.post(
  "/:deliveryOrderId/platform-sync/resend",
  handle,
  jsonBody,
  async (req, res) => {
    const { outletId, deliveryOrderId } = resendDeliveryOrderSync.params.parse(
      req.params,
    );
    resendDeliveryOrderSync.body.parse(req.body);
    res.json({
      data: await platformRetry.resendDeliveryOrderSync(
        getScopedTenantContext(req),
        { userId: userIdSchema.parse(actorOf(req)) },
        outletId,
        deliveryOrderId,
      ),
    });
  },
);

deliveryOrdersRouter.post(
  "/:deliveryOrderId/platform-sync/resolve",
  handle,
  jsonBody,
  async (req, res) => {
    const { outletId, deliveryOrderId } = resolveDeliveryOrderSync.params.parse(
      req.params,
    );
    const body = resolveDeliveryOrderSync.body.parse(req.body);
    res.json({
      data: await platformRetry.resolveDeliveryOrderSync(
        getScopedTenantContext(req),
        { userId: userIdSchema.parse(actorOf(req)) },
        outletId,
        deliveryOrderId,
        body,
      ),
    });
  },
);

// legend-5d76: staff map the unmatched lines of a needs_review order and send
// it to the kitchen. Same gate; idempotent (an injected order answers as is).
deliveryOrdersRouter.post(
  "/:deliveryOrderId/map-lines",
  handle,
  jsonBody,
  async (req, res) => {
    const { outletId, deliveryOrderId } = mapDeliveryOrderLines.params.parse(
      req.params,
    );
    const body = mapDeliveryOrderLines.body.parse(req.body);
    res.json({
      data: await deliveryMapLines.mapDeliveryOrderLines(
        getScopedTenantContext(req),
        { userId: userIdSchema.parse(actorOf(req)) },
        outletId,
        deliveryOrderId,
        body,
      ),
    });
  },
);
