// Acting cashier per device (bead legend-aruta; docs/DECISIONS.md "Kasir aktif
// per perangkat lewat token server"). Thin routes; every rule is in
// services/pos-acting-staff.service.ts.
//
// posActingStaffRouter (mount at /api/staff-pins, BEFORE staffPinRouter):
//   POST /pos-session       signed-in device owner on a registered outlet
//                           device (X-Device-Token), staff tile + PIN. 201
//                           with the `X-Acting-Staff` token.
//   POST /pos-session/end   ends the device's acting cashier. 204.
// The device comes from the signed device token and the login session from
// the cookie, never from the body.

import { Router, type Request } from "express";
import { CoreError } from "@starter/shared/core";
import { posSessionRequestSchema } from "@starter/shared/pos/acting-staff";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { registeredDeviceIdOf } from "./device-id";
import {
  endActingStaff,
  issueActingStaff,
} from "../services/pos-acting-staff.service";
import {
  isActiveSharedDevice,
  markSessionSharedDevice,
  sharedDeviceMarkLimit,
} from "../services/shared-device.service";

/**
 * The signed device id. Unlike `/verify` (no session), this route has a login
 * session AND the device token, and the request may arrive on the tenant's
 * registered domain (tenant source "domain"), so `source === "device"` is not
 * required: the signature, the tenant match and a current registry row
 * (device-id.ts `registeredDeviceIdOf`: not revoked, not rotated out) are.
 */
async function signedDeviceId(req: Request): Promise<string> {
  const deviceId = await registeredDeviceIdOf(req);
  if (deviceId === null)
    throw new CoreError(
      "UNAUTHORIZED",
      "Hanya perangkat outlet terdaftar yang dapat memakai PIN.",
    );
  return deviceId;
}

export const posActingStaffRouter = Router();

// Guards are per route, not `.use`: this router is mounted before
// staffPinRouter, whose /verify must stay reachable without a session.
posActingStaffRouter.post(
  "/pos-session",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const deviceId = await signedDeviceId(req);
    const input = posSessionRequestSchema.parse(req.body);
    const auth = getAuth(req);
    // Shared-device mode: mark the login session at activation, before any
    // guarded POS request (middleware/acting-staff.ts).
    // legend-dn7uo: a 9th device the session cannot record is refused, no PIN
    // session is issued for it.
    if (
      (await isActiveSharedDevice(getTenantContext(req), deviceId)) &&
      !(await markSessionSharedDevice(auth.session.id, deviceId))
    )
      throw await sharedDeviceMarkLimit(auth.session.id, auth.user.id);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json({
      data: await issueActingStaff(getTenantContext(req), {
        deviceId,
        sessionId: auth.session.id,
        sessionUserId: auth.user.id,
        userId: input.userId,
        pin: input.pin,
      }),
    });
  },
);

posActingStaffRouter.post(
  "/pos-session/end",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  async (req, res) => {
    await endActingStaff(getTenantContext(req), {
      deviceId: await signedDeviceId(req),
      sessionId: getAuth(req).session.id,
    });
    res.status(204).end();
  },
);
