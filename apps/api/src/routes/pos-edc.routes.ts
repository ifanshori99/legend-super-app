// POS ECR routes (1269 E7, replaces B-E3; contract @starter/shared/pos
// startPosEdcSale / getPosEdcTransaction / inquirePosEdcTransaction /
// cancelPosEdcTransaction). The EDC agent of this edge node drives the
// terminal (services/pos-edc-request.service.ts); off the edge, or with the
// agent down, every route answers 503 EDC_AGENT_NOT_READY (ECR locked).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/pos",
// posEdcRouter)`. Same guards as the POS order router; the actor is the
// acting staff on a shared device, and the agent checks pos.payment.accept
// again for that user.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  cancelPosEdcTransaction,
  getPosEdcTransaction,
  inquirePosEdcTransaction,
  startPosEdcSale,
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
import * as ecr from "../services/pos-edc-request.service.ts";

export const posEdcRouter = Router({ mergeParams: true });
posEdcRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const pay = requireOutletPermission("pos.payment.accept", outletOf);
const actor = (req: Request) => userIdSchema.parse(actorOf(req));

posEdcRouter.post(
  "/orders/:orderId/edc",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = startPosEdcSale.params.parse(req.params);
    const body = startPosEdcSale.body.parse(req.body);
    res.set("Cache-Control", "no-store").json({
      data: await ecr.startPosEdcSale(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        orderId,
        body,
      ),
    });
  },
);

posEdcRouter.get("/edc/:transactionId", pay, async (req, res) => {
  const ref = getPosEdcTransaction.params.parse(req.params);
  res.set("Cache-Control", "no-store").json({
    data: await ecr.getPosEdcTransaction(
      getScopedTenantContext(req),
      actor(req),
      ref,
    ),
  });
});

posEdcRouter.post(
  "/edc/:transactionId/inquire",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const ref = inquirePosEdcTransaction.params.parse(req.params);
    inquirePosEdcTransaction.body.parse(req.body);
    res.set("Cache-Control", "no-store").json({
      data: await ecr.inquirePosEdcTransaction(
        getScopedTenantContext(req),
        actor(req),
        ref,
      ),
    });
  },
);

posEdcRouter.post(
  "/edc/:transactionId/cancel",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const ref = cancelPosEdcTransaction.params.parse(req.params);
    cancelPosEdcTransaction.body.parse(req.body);
    res.set("Cache-Control", "no-store").json({
      data: await ecr.cancelPosEdcTransaction(
        getScopedTenantContext(req),
        actor(req),
        ref,
      ),
    });
  },
);
