// POS order routes (bead legend-kk7; PRD v1.7 §3 F8; contract
// @starter/shared/pos endpoints.ts — order lifecycle, tenders, discounts,
// linked corrections, events, policy and action availability). Shifts, cash
// movements, end of day, receipts and the customer display belong to their
// own beads.
//
// Mount (lead, routes/index.ts): `apiRouter.use("/outlets/:outletId/pos",
// posOrderRouter)`. The router merges params, so every contract path
// `/api/outlets/:outletId/pos/...` is served here.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext, then
//   requireOutletPermission on the path's outlet (TEN-03); the tenant comes
//   from the server-minted context (TEN-02), never the body.
// - Bodies, params and queries are parsed with the strict contract schemas.
// - Optimistic concurrency (legend-63l6): every order response carries
//   `ETag: "<version>"`; a write may send `If-Match: "<version>"` and gets
//   412 PRECONDITION_FAILED when the order moved on. Without the header the
//   contract's `expectedStatus` is the stale-screen guard.
// - The device id stays null until WS-02 device registration (legend-165)
//   supplies a verified one: a client-claimed device is never trusted.

import { Router, type Request, type Response } from "express";
import { CoreError, userIdSchema } from "@starter/shared/core";
import {
  addPosTender,
  applyPosDiscount,
  completePosOrder,
  createPosOrder,
  firePosOrderItems,
  getPosApprovalPolicy,
  getPosOrder,
  getPosOrderActionAvailability,
  listPosOrderEvents,
  listPosOrders,
  refundPosOrder,
  removePosDiscount,
  submitPosOrder,
  voidPosOrder,
  voidPosOrderCorrection,
  voidPosOrderItem,
} from "@starter/shared/pos";
import type { PermissionCode } from "@starter/shared/access";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as corrections from "../services/pos-order-corrections.ts";
import * as discounts from "../services/pos-order-discounts.ts";
import { addPosTender as addPosTenderService } from "../services/pos-order-payment.ts";
import * as pos from "../services/pos-order.service.ts";
import type { PosCaller } from "../services/pos-order-support.ts";

export const posOrderRouter = Router({ mergeParams: true });

posOrderRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const can = (permission: PermissionCode) =>
  requireOutletPermission(permission, outletOf);

const view = can("order.view");
const sell = can("pos.sale.create");
const pay = can("pos.payment.accept");
const discount = can("pos.discount.apply");
const voids = can("pos.void.request");
const refund = can("pos.refund.request");

/** `If-Match: "3"` (or `3`) → 3; absent → null; anything else → 412. */
function expectedVersion(req: Request): number | null {
  const header = req.get("if-match");
  if (header === undefined) return null;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header);
  if (!match)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "If-Match harus berisi versi pesanan.",
    );
  return Number(match[1]);
}

function caller(req: Request): PosCaller {
  return {
    userId: userIdSchema.parse(getAuth(req).user.id),
    deviceId: null,
    expectedVersion: expectedVersion(req),
  };
}

async function sendOrder(
  req: Request,
  res: Response,
  outletId: string,
  orderId: string,
  data: unknown,
  status = 200,
): Promise<void> {
  const version = await pos.posOrderVersion(
    getScopedTenantContext(req),
    outletId,
    orderId,
  );
  res.status(status).setHeader("ETag", `"${version}"`).json({ data });
}

// ---- Orders -------------------------------------------------------------------

posOrderRouter.get("/orders", view, async (req, res) => {
  const { outletId } = listPosOrders.params.parse(req.params);
  const query = listPosOrders.query.parse(req.query);
  res.json(
    await pos.listPosOrders(getScopedTenantContext(req), outletId, query),
  );
});

posOrderRouter.post("/orders", sell, jsonBody, async (req, res) => {
  const { outletId } = createPosOrder.params.parse(req.params);
  const body = createPosOrder.body.parse(req.body);
  const order = await pos.createPosOrder(
    getScopedTenantContext(req),
    caller(req),
    outletId,
    body,
  );
  res.location(
    `/api/outlets/${encodeURIComponent(outletId)}/pos/orders/${encodeURIComponent(order.id)}`,
  );
  await sendOrder(req, res, outletId, order.id, order, 201);
});

posOrderRouter.get("/orders/:orderId", view, async (req, res) => {
  const { outletId, orderId } = getPosOrder.params.parse(req.params);
  const { detail, version } = await pos.getPosOrder(
    getScopedTenantContext(req),
    outletId,
    orderId,
  );
  res.setHeader("ETag", `"${version}"`).json({ data: detail });
});

posOrderRouter.post(
  "/orders/:orderId/submit",
  sell,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = submitPosOrder.params.parse(req.params);
    const body = submitPosOrder.body.parse(req.body);
    const data = await pos.submitPosOrder(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

posOrderRouter.post(
  "/orders/:orderId/fire",
  sell,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = firePosOrderItems.params.parse(req.params);
    const body = firePosOrderItems.body.parse(req.body);
    const data = await pos.firePosOrderItems(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

posOrderRouter.post(
  "/orders/:orderId/complete",
  sell,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = completePosOrder.params.parse(req.params);
    const body = completePosOrder.body.parse(req.body);
    const data = await pos.completePosOrder(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

posOrderRouter.post(
  "/orders/:orderId/void",
  voids,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = voidPosOrder.params.parse(req.params);
    const body = voidPosOrder.body.parse(req.body);
    const data = await pos.voidPosOrder(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

posOrderRouter.post(
  "/orders/:orderId/items/:itemId/void",
  voids,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId, itemId } = voidPosOrderItem.params.parse(
      req.params,
    );
    const body = voidPosOrderItem.body.parse(req.body);
    const data = await pos.voidPosOrderItem(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      itemId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

posOrderRouter.get("/orders/:orderId/events", view, async (req, res) => {
  const { outletId, orderId } = listPosOrderEvents.params.parse(req.params);
  const query = listPosOrderEvents.query.parse(req.query);
  res.json(
    await pos.listPosOrderEvents(
      getScopedTenantContext(req),
      outletId,
      orderId,
      query,
    ),
  );
});

posOrderRouter.get("/orders/:orderId/actions", view, async (req, res) => {
  const { outletId, orderId } = getPosOrderActionAvailability.params.parse(
    req.params,
  );
  res.json({
    data: await pos.getPosOrderActions(
      getScopedTenantContext(req),
      outletId,
      orderId,
    ),
  });
});

// ---- Payment panel ----------------------------------------------------------------

posOrderRouter.post(
  "/orders/:orderId/tenders",
  pay,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = addPosTender.params.parse(req.params);
    const body = addPosTender.body.parse(req.body);
    const data = await addPosTenderService(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data, 201);
  },
);

posOrderRouter.post(
  "/orders/:orderId/discounts",
  discount,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = applyPosDiscount.params.parse(req.params);
    const body = applyPosDiscount.body.parse(req.body);
    const data = await discounts.applyPosDiscount(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data, 201);
  },
);

posOrderRouter.delete(
  "/orders/:orderId/discounts/:discountId",
  discount,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId, discountId } = removePosDiscount.params.parse(
      req.params,
    );
    const body = removePosDiscount.body.parse(req.body);
    const data = await discounts.removePosDiscount(
      getScopedTenantContext(req),
      caller(req),
      outletId,
      orderId,
      discountId,
      body,
    );
    await sendOrder(req, res, outletId, orderId, data);
  },
);

// ---- Linked corrections (POS-04) ------------------------------------------------

posOrderRouter.post(
  "/orders/:orderId/corrections/void",
  voids,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = voidPosOrderCorrection.params.parse(
      req.params,
    );
    const body = voidPosOrderCorrection.body.parse(req.body);
    res.status(201).json({
      data: await corrections.voidPosOrderCorrection(
        getScopedTenantContext(req),
        caller(req),
        outletId,
        orderId,
        body,
      ),
    });
  },
);

posOrderRouter.post(
  "/orders/:orderId/corrections/refund",
  refund,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = refundPosOrder.params.parse(req.params);
    const body = refundPosOrder.body.parse(req.body);
    res.status(201).json({
      data: await corrections.refundPosOrder(
        getScopedTenantContext(req),
        caller(req),
        outletId,
        orderId,
        body,
      ),
    });
  },
);

// ---- Policy -------------------------------------------------------------------------

posOrderRouter.get("/policy", view, async (req, res) => {
  const { outletId } = getPosApprovalPolicy.params.parse(req.params);
  res.json({
    data: await pos.getPosApprovalPolicy(getScopedTenantContext(req), outletId),
  });
});
