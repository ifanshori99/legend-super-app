// legend-gchkf: the owner's panic-alarm devices under /api/identity/push-devices
// (contract `listPushDevices` / `revokePushDevice` in @starter/shared/identity).
// Account-level and own rows only, in every tenant: the owner is derived from
// the verified session inside the database functions, never from the path or
// body.

import { Router, type Request } from "express";
import { pushDeviceParamsSchema } from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  listOwnPushDevices,
  revokeOwnPushDevice,
} from "../services/identity-push-devices.service";

export const identityPushDevicesRouter = Router();

function scopeOf(req: Request) {
  const auth = getAuth(req);
  return {
    userId: auth.user.id,
    currentSessionId: auth.session.id,
  };
}

identityPushDevicesRouter.get("/", requireAuth, async (req, res) => {
  res.json({ data: await listOwnPushDevices(scopeOf(req)) });
});

identityPushDevicesRouter.delete(
  "/:id",
  requireAuth,
  requireTrustedOrigin,
  async (req, res) => {
    const { id } = pushDeviceParamsSchema.parse(req.params);
    await revokeOwnPushDevice({ ...scopeOf(req), id });
    res.status(204).end();
  },
);
