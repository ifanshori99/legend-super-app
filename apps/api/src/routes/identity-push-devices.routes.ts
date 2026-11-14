// legend-gchkf: the owner's panic-alarm devices under /api/identity/push-devices
// (contract `listPushDevices` / `revokePushDevice` in @starter/shared/identity).
// Account-level and own rows only: the user id comes from the verified session,
// the tenant from the session or the registered domain (TEN-02), never from
// the path or body.

import { Router, type Request } from "express";
import { pushDeviceParamsSchema } from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import { findTenantContext } from "../middleware/tenant";
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
    domainTenantId: findTenantContext(req)?.tenantId ?? null,
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
