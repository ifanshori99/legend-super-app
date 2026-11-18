// Shared tablet screen allowlist (legend-iq0jz, founder Q29). requireAuth calls
// `enforceSharedDeviceAllowlist` once, so every cookie router, present and
// future, is closed on a shared tablet unless lib/shared-device-allowlist.ts
// names the route. The cashier PIN rule (requireActingStaffOnSharedDevice) is a
// separate guard and is not touched here.

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { verifyDeviceToken } from "../lib/device-token";
import { HttpError } from "../lib/http-error";
import {
  isSharedDeviceApiAllowed,
  isSharedDeviceAuthAllowed,
} from "../lib/shared-device-allowlist";
import { anySharedDeviceActive } from "../services/shared-device.service";

/**
 * True when (a) the device token is valid and names an active shared device, or
 * (b) the session is marked for a still-active shared device. No token and no
 * marks: no query. A broken token counts as no token and never throws.
 */
export async function isOnSharedDevice(
  markedDeviceIds: readonly string[] | null | undefined,
  rawDeviceToken: string | undefined,
): Promise<boolean> {
  if (rawDeviceToken) {
    const payload = verifyDeviceToken(rawDeviceToken);
    if (payload !== null && (await anySharedDeviceActive([payload.deviceId])))
      return true;
  }
  return markedDeviceIds && markedDeviceIds.length > 0
    ? anySharedDeviceActive(markedDeviceIds)
    : false;
}

/** `isOnSharedDevice` for a request that passed requireAuth. */
export function isRequestOnSharedDevice(req: Request): Promise<boolean> {
  return isOnSharedDevice(
    req.auth?.session.sharedDeviceIds,
    req.get(DEVICE_TOKEN_HEADER),
  );
}

/**
 * Throws 403 SHARED_DEVICE_SCREEN_CLOSED for a request on a shared tablet whose
 * method and path are outside the allowlist. An allowed path costs nothing.
 * Run after the early stamp so a first request with the device header counts.
 */
export async function enforceSharedDeviceAllowlist(req: Request) {
  if (isSharedDeviceApiAllowed(req.method, req.originalUrl)) return;
  if (!(await isRequestOnSharedDevice(req))) return;
  throw new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED,
    "Layar ini tidak tersedia di tablet bersama.",
  );
}

/**
 * The same question from raw headers, for code that never ran requireAuth (a
 * WebSocket upgrade, /api/auth): reads the session from the cookie and the
 * token from the header. No session: only the token counts (the caller's own
 * authentication decides the rest).
 */
export async function isOnSharedDeviceByHeaders(
  headers: IncomingHttpHeaders,
): Promise<boolean> {
  const rawToken = headers[DEVICE_TOKEN_HEADER.toLowerCase()];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const session =
    headers.cookie || headers.authorization
      ? await auth.api.getSession({
          headers: fromNodeHeaders(headers),
          query: { disableCookieCache: true },
        })
      : null;
  return isOnSharedDevice(session?.session.sharedDeviceIds, token);
}

/** `isOnSharedDeviceByHeaders` for a WebSocket upgrade. */
export function isUpgradeOnSharedDevice(
  request: IncomingMessage,
): Promise<boolean> {
  return isOnSharedDeviceByHeaders(request.headers);
}

/**
 * /api/auth is mounted ahead of requireAuth, so it gets its own guard (app.ts,
 * next to guardImpersonatedAuthRoutes). On a shared tablet only the paths in
 * isSharedDeviceAuthAllowed pass; the rest answer 403
 * SHARED_DEVICE_SCREEN_CLOSED. An allowed path and a request with neither
 * credentials nor a device token cost no query.
 */
export const guardSharedDeviceAuthRoutes: RequestHandler = async (
  req,
  _res,
  next,
) => {
  if (isSharedDeviceAuthAllowed(req.method, req.originalUrl)) return next();
  if (
    !req.headers.cookie &&
    !req.headers.authorization &&
    !req.get(DEVICE_TOKEN_HEADER)
  )
    return next();
  if (!(await isOnSharedDeviceByHeaders(req.headers))) return next();
  throw new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED,
    "Layar ini tidak tersedia di tablet bersama.",
  );
};
