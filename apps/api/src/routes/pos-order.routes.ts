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
// - Optimistic concurrency (legend-63l6): every order response carries the
//   order `version` and `ETag: "<version>"` (the same value); a write may send
//   it back as body `expectedVersion` or `If-Match: "<version>"` and gets 412
//   PRECONDITION_FAILED when the order moved on. Without either, the
//   contract's `expectedStatus` is the stale-screen guard.
// - The device id is the signed `X-Device-Token` (device-id.ts), null without
//   one: a client-claimed device is never trusted. Cash needs it (the drawer
//   is per device).

import { Router, type Request, type Response } from "express";
import { CoreError, userIdSchema, type OutletId } from "@starter/shared/core";
import {
  addPosTender,
  applyPosDiscount,
  completePosOrder,
  createPosOrder,
  firePosOrderItems,
  getPosApprovalPolicy,
  getPosCatalog,
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
import { actorOf, resolveActingStaff } from "../middleware/acting-staff.ts";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { currentDeviceIdOf } from "./device-id.ts";
import * as corrections from "../services/pos-order-corrections.ts";
import * as discounts from "../services/pos-order-discounts.ts";
import { addPosTender as addPosTenderService } from "../services/pos-order-payment.ts";
import * as pos from "../services/pos-order.service.ts";
import { getPosCatalog as getPosCatalogService } from "../services/pos-catalog.service.ts";
import type { MenuMediaUrls } from "../services/menu-internals.ts";
import type { PosCaller } from "../services/pos-order-support.ts";

export const posOrderRouter = Router({ mergeParams: true });

posOrderRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
);

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

/**
 * legend-63l6: the version the client believes the order has is the body's
 * `expectedVersion` or the `If-Match` header. Both given and different is 412
 * (a client cannot state two versions). Both absent: no check, so legacy
 * clients keep working; `expectedStatus` still guards transitions.
 */
async function caller(
  req: Request,
  body?: { expectedVersion?: number },
): Promise<PosCaller> {
  const fromHeader = expectedVersion(req);
  const fromBody = body?.expectedVersion ?? null;
  if (fromHeader !== null && fromBody !== null && fromHeader !== fromBody)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "expectedVersion dan If-Match harus sama.",
    );
  // The services fingerprint the body for idempotency and add
  // `caller.expectedVersion` themselves. Drop the body copy (the object is the
  // fresh result of `.parse`) so a retry that switches between the body field
  // and If-Match keeps one fingerprint and replays instead of 409.
  if (body) delete body.expectedVersion;
  return {
    userId: userIdSchema.parse(actorOf(req)),
    deviceId: await currentDeviceIdOf(req),
    expectedVersion: fromBody ?? fromHeader,
  };
}

function versionIn(data: unknown): number | null {
  const holder =
    typeof data === "object" && data !== null && "order" in data
      ? (data as { order: unknown }).order
      : data;
  const version =
    typeof holder === "object" && holder !== null && "version" in holder
      ? (holder as { version: unknown }).version
      : undefined;
  return typeof version === "number" && Number.isSafeInteger(version)
    ? version
    : null;
}

async function sendOrder(
  req: Request,
  res: Response,
  outletId: OutletId,
  orderId: string,
  data: unknown,
  status = 200,
): Promise<void> {
  // The ETag must match the `version` in the body: a separate read after
  // commit could show a newer version (another write landed, or this is an
  // idempotent replay), and echoing that back as If-Match would skip a change
  // the client never saw. Only replays stored before legend-63l6 carry no
  // `version`; for those the stored snapshot is stale and invalid against the
  // response schema, so re-read the order and send the fresh detail with its
  // version as the ETag. Nothing is written again (legend-3k8no).
  let body = data;
  let version = versionIn(data);
  if (version === null) {
    const fresh = await pos.getPosOrder(
      getScopedTenantContext(req),
      outletId,
      orderId,
    );
    body =
      typeof data === "object" && data !== null && "order" in data
        ? { ...data, order: fresh.detail }
        : fresh.detail;
    version = fresh.version;
  }
  res.status(status).setHeader("ETag", `"${version}"`).json({ data: body });
}

// ---- Orders -------------------------------------------------------------------

/** Mounted by createApp with that app's configured photo URL resolver. */
export function createPosCatalogRouter(
  resolveMediaUrls: MenuMediaUrls,
): Router {
  const router = Router({ mergeParams: true });
  router.get(
    "/",
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    resolveActingStaff,
    view,
    async (req, res) => {
      const { outletId } = getPosCatalog.params.parse(req.params);
      const query = getPosCatalog.query.parse(req.query);
      const data = await getPosCatalogService(
        getScopedTenantContext(req),
        outletId,
        query,
        new Date(),
        resolveMediaUrls,
      );
      res.json({ data });
    },
  );
  return router;
}

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
    await caller(req),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
      await caller(req, body),
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
        await caller(req),
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
        await caller(req),
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
