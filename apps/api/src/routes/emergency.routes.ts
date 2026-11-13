// Emergency receiver sessions (bead legend-bod; design
// docs/design/edge-emergency.md D-03). Thin routes; the rules are in
// services/panic-receiver-session.ts. Mount at /api/emergency/sessions.
//
//   POST   /          registered pos / waiter_phone device (X-Device-Token) +
//                     trusted Origin; body { staffUserId, pin }. 201 and the
//                     HttpOnly cookie `legend_emergency` (never in the body).
//                     401 PIN_INVALID, 423 PIN_LOCKED, 429 PIN_DEVICE_THROTTLED
//                     (+ Retry-After), 403 NOT_ON_DUTY / no permission.
//   DELETE /current   ends the cookie's session at once (trusted Origin);
//                     204 and the cookie is cleared.
//
// The cookie reaches no other route: the press, acknowledge and fallback
// routes and the socket have their own guards.
import { Router, type Request, type Response } from "express";
import {
  EMERGENCY_COOKIE_NAME,
  EMERGENCY_COOKIE_PATH,
  panicSessionBodySchema,
} from "@starter/shared/facility";
import { HttpError } from "../lib/http-error";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { findTenantContext } from "../middleware/tenant";
import {
  endReceiverSessionByCookie,
  openReceiverSession,
} from "../services/panic-receiver-session";
import { PinDeviceThrottledError } from "../services/staff-pin-proof.service";
import { registeredDeviceIdOf } from "./device-id.ts";

const cookieOptions = (req: Request) =>
  ({
    httpOnly: true,
    sameSite: "strict",
    path: EMERGENCY_COOKIE_PATH,
    secure: req.secure,
  }) as const;

function unregisteredDevice(): HttpError {
  return new HttpError(
    401,
    "DEVICE_NOT_REGISTERED",
    "Hanya perangkat outlet terdaftar yang dapat membuka sesi darurat.",
  );
}

export const emergencySessionRouter = Router();

emergencySessionRouter.post(
  "/",
  requireTrustedOrigin,
  jsonBody,
  async (req, res: Response) => {
    // No token, a forged one or a revoked device resolves no tenant: 401 before
    // the body is read for a PIN, so a stranger cannot guess PINs.
    const tenant = findTenantContext(req);
    if (tenant === undefined) throw unregisteredDevice();
    const deviceId = await registeredDeviceIdOf(req);
    if (deviceId === null) throw unregisteredDevice();
    const input = panicSessionBodySchema.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const opened = await openReceiverSession(tenant, {
        deviceId,
        staffUserId: input.staffUserId,
        pin: input.pin,
      });
      res.cookie(EMERGENCY_COOKIE_NAME, opened.cookieValue, {
        ...cookieOptions(req),
        expires: opened.expiresAt,
      });
      res.status(201).json({
        data: {
          outletId: opened.outletId,
          expiresAt: opened.expiresAt.toISOString(),
          user: opened.user,
        },
      });
    } catch (error) {
      // 429 tells the device when its PIN window ends.
      if (error instanceof PinDeviceThrottledError)
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  },
);

emergencySessionRouter.delete(
  "/current",
  requireTrustedOrigin,
  async (req, res) => {
    await endReceiverSessionByCookie(req.get("cookie"), "logout");
    res.setHeader("Cache-Control", "private, no-store");
    res.clearCookie(EMERGENCY_COOKIE_NAME, cookieOptions(req));
    res.status(204).end();
  },
);
