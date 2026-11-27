// O2 offline batch ingest route (bead legend-wasr7.6; contract
// @starter/shared/pos offline-batch.ts `submitPosOfflineBatch`).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/pos",
// posOfflineBatchRouter)`. Under the outlet like the O1 kit route (CTO O2), so
// the outlet permission guard (TEN-03) runs on the path's outlet.
//
// - requireAuthAllowSharedDevice + requireTrustedOrigin + requireTenantContext,
//   then shift.cash.operate on the outlet; the service checks it again and
//   fails closed.
// - The device id is only ever the signed X-Device-Token's (currentDeviceIdOf).
// - A cloud sale write: refused while an edge serves the outlet.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  reportPosOfflineConflict,
  reportPosOfflineStuck,
  submitPosOfflineBatch,
} from "@starter/shared/pos";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireCorePosWriteOnCloud } from "../middleware/pos-on-cloud.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as offlineBatch from "../services/pos-offline-batch.service.ts";
import { currentDeviceIdOf } from "./device-id.ts";

export const posOfflineBatchRouter = Router({ mergeParams: true });

posOfflineBatchRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");

posOfflineBatchRouter.post(
  "/offline-batch",
  requireOutletPermission("shift.cash.operate", outletOf),
  requireCorePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId } = submitPosOfflineBatch.params.parse(req.params);
    const body = submitPosOfflineBatch.body.parse(req.body);
    res.status(200).json({
      data: await offlineBatch.submitPosOfflineBatch(
        getScopedTenantContext(req),
        {
          userId: userIdSchema.parse(actorOf(req)),
          deviceId: await currentDeviceIdOf(req),
        },
        outletId,
        body,
      ),
    });
  },
);

// Review O3 P1: the tablet's report of a sale the batch refused with
// OFFLINE_EVENT_CONFLICT. Same guards as the batch.
posOfflineBatchRouter.post(
  "/offline-conflicts",
  requireOutletPermission("shift.cash.operate", outletOf),
  requireCorePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId } = reportPosOfflineConflict.params.parse(req.params);
    const body = reportPosOfflineConflict.body.parse(req.body);
    res.status(200).json({
      data: await offlineBatch.reportPosOfflineConflict(
        getScopedTenantContext(req),
        {
          userId: userIdSchema.parse(actorOf(req)),
          deviceId: await currentDeviceIdOf(req),
        },
        outletId,
        body,
      ),
    });
  },
);

// 1273 second opinion P2-1: a sale the batch refuses for good, reported by the
// staff session with a supervisor PIN. Same guards; the device token is
// optional here (the service never asks the registry for the kit's device).
posOfflineBatchRouter.post(
  "/offline-stuck",
  requireOutletPermission("shift.cash.operate", outletOf),
  requireCorePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId } = reportPosOfflineStuck.params.parse(req.params);
    const body = reportPosOfflineStuck.body.parse(req.body);
    res.status(200).json({
      data: await offlineBatch.reportPosOfflineStuck(
        getScopedTenantContext(req),
        {
          userId: userIdSchema.parse(actorOf(req)),
          deviceId: await currentDeviceIdOf(req),
        },
        outletId,
        body,
      ),
    });
  },
);
