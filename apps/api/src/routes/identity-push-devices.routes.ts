// legend-gchkf: the owner's panic-alarm devices under /api/identity/push-devices
// (contract `listPushDevices` / `revokePushDevice` in @starter/shared/identity).
// Account-level and own rows only, in every tenant: the owner is derived from
// the verified session inside the database functions, never from the path or
// body.

import { Router, type Request } from "express";
import { pushDeviceParamsSchema } from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import { supportGrantedTenantIds } from "../services/platform-support.service";
import {
  listOwnPushDevices,
  revokeOwnPushDevice,
} from "../services/identity-push-devices.service";

export const identityPushDevicesRouter = Router();

// legend-xqkr7: a support (impersonated) session sees and revokes only devices
// of tenants where its super admin holds a live grant; ordinary sessions are
// unchanged.
async function scopeOf(req: Request) {
  const auth = getAuth(req);
  const impersonatedBy = (
    auth.session as { impersonatedBy?: string | null } | undefined
  )?.impersonatedBy;
  return {
    userId: auth.user.id,
    currentSessionId: auth.session.id,
    ...(impersonatedBy
      ? {
          onlyTenantIds: await supportGrantedTenantIds({
            adminUserId: impersonatedBy,
            targetUserId: auth.user.id,
          }),
        }
      : {}),
  };
}

identityPushDevicesRouter.get("/", requireAuth, async (req, res) => {
  res.json({ data: await listOwnPushDevices(await scopeOf(req)) });
});

identityPushDevicesRouter.delete(
  "/:id",
  requireAuth,
  requireTrustedOrigin,
  async (req, res) => {
    const { id } = pushDeviceParamsSchema.parse(req.params);
    await revokeOwnPushDevice({ ...(await scopeOf(req)), id });
    res.status(204).end();
  },
);
