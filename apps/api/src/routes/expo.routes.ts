// Expo routes (bead legend-him8j; contract @starter/shared/kitchen endpoints.ts:
// getExpoBoard, listExpoRunners, assignExpoRunner, markExpoOrderDelivered).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId", expoRouter)`.
// The prefix is shared with other outlet routers, so auth is attached per
// route (see pickup.routes.ts). `kds.expo.operate` on the path outlet; the
// tenant comes from the server-minted context. The acting user comes from the
// session; the device id stays null until WS-02 device registration.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  assignExpoRunner,
  getExpoBoard,
  listExpoRunners,
  markExpoOrderDelivered,
} from "@starter/shared/kitchen";
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
import * as expo from "../services/expo.service.ts";
import type { KdsActor } from "../services/kds-support.ts";

export const expoRouter = Router({ mergeParams: true });

const guard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  requireOutletPermission("kds.expo.operate", (req) =>
    String(req.params.outletId),
  ),
];

function actor(req: Request): KdsActor {
  return { userId: userIdSchema.parse(actorOf(req)), deviceId: null };
}

expoRouter.get("/expo", ...guard, async (req, res) => {
  const { outletId } = getExpoBoard.params.parse(req.params);
  res.json({
    data: await expo.readExpoBoard(
      getScopedTenantContext(req),
      outletId,
      new Date(),
    ),
  });
});

expoRouter.get("/expo/runners", ...guard, async (req, res) => {
  const { outletId } = listExpoRunners.params.parse(req.params);
  res.json({
    data: await expo.listExpoRunners(
      getScopedTenantContext(req),
      outletId,
      new Date(),
    ),
  });
});

expoRouter.post(
  "/expo/:orderId/runner",
  ...guard,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = assignExpoRunner.params.parse(req.params);
    const { runnerId } = assignExpoRunner.body.parse(req.body);
    res.json({
      data: await expo.assignExpoRunner(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        orderId,
        runnerId,
        new Date(),
      ),
    });
  },
);

expoRouter.post("/expo/:orderId/delivered", ...guard, async (req, res) => {
  const { outletId, orderId } = markExpoOrderDelivered.params.parse(req.params);
  res.json({
    data: await expo.markExpoOrderDelivered(
      getScopedTenantContext(req),
      actor(req),
      outletId,
      orderId,
      new Date(),
    ),
  });
});
