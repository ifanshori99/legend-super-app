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
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { posSessionRequestSchema } from "@starter/shared/pos/acting-staff";
import { verifyDeviceToken } from "../lib/device-token";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import {
  endActingStaff,
  issueActingStaff,
} from "../services/pos-acting-staff.service";

/** The signed device id, only when the token names the resolved tenant. */
function deviceIdOf(req: Request): string {
  const tenant = getTenantContext(req);
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (
    tenant.source !== "device" ||
    payload === null ||
    payload.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase()
  )
    throw new CoreError(
      "UNAUTHORIZED",
      "Hanya perangkat outlet terdaftar yang dapat memakai PIN.",
    );
  return payload.deviceId;
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
    const deviceId = deviceIdOf(req);
    const input = posSessionRequestSchema.parse(req.body);
    const auth = getAuth(req);
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
      deviceId: deviceIdOf(req),
      sessionId: getAuth(req).session.id,
    });
    res.status(204).end();
  },
);
