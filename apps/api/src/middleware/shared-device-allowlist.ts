// Shared tablet screen allowlist (legend-iq0jz, founder Q29). requireAuth calls
// `enforceSharedDeviceAllowlist` in the requireAuthAllowSharedDevice branch, so
// every router that opts in, present and future, is closed on a shared tablet
// unless lib/shared-device-allowlist.ts names the route. A router that did not
// opt in is refused earlier (ACTING_STAFF_NOT_ALLOWED), and /api/auth has its
// own guard (shared-device-auth.ts). The cashier PIN rule
// (requireActingStaffOnSharedDevice) is a separate guard and is not touched.

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { auth } from "../lib/auth";
import { verifyDeviceToken } from "../lib/device-token";
import { HttpError } from "../lib/http-error";
import { isSharedDeviceApiAllowed } from "../lib/shared-device-allowlist";
import { anySharedDeviceActive } from "../services/shared-device.service";

/**
 * True when the request's session carries a shared-device mark. requireAuth has
 * already stamped the device token into `req.auth.session.sharedDeviceIds`, and
 * a mark never lapses (legend 1027), so this is synchronous and costs no query.
 */
export function isRequestOnSharedDevice(req: Request): boolean {
  return (req.auth?.session.sharedDeviceIds?.length ?? 0) > 0;
}

/**
 * Throws 403 SHARED_DEVICE_SCREEN_CLOSED for a marked session whose method and
 * path are outside the allowlist. `marks` are the marks after the early stamp
 * (so a first request with the device header counts). A session without marks
 * is a personal device and is untouched.
 */
export function enforceSharedDeviceAllowlist(
  req: Request,
  marks: readonly string[],
): void {
  if (marks.length === 0) return;
  if (isSharedDeviceApiAllowed(req.method, req.originalUrl)) return;
  throw new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED,
    "Layar ini tidak tersedia di tablet bersama.",
  );
}

/**
 * The same question from raw headers, for code that never ran requireAuth (a
 * WebSocket upgrade): true when the cookie's session carries any mark, or the
 * validly signed device token names an active shared device. Reads only (no
 * stamp). No session and no token: false (the caller authenticates on its own).
 */
export async function isOnSharedDeviceByHeaders(
  headers: IncomingHttpHeaders,
): Promise<boolean> {
  const session =
    headers.cookie || headers.authorization
      ? await auth.api.getSession({
          headers: fromNodeHeaders(headers),
          query: { disableCookieCache: true },
        })
      : null;
  if ((session?.session.sharedDeviceIds?.length ?? 0) > 0) return true;
  const rawToken = headers[DEVICE_TOKEN_HEADER.toLowerCase()];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!token) return false;
  let deviceId: string | null = null;
  try {
    deviceId = verifyDeviceToken(token)?.deviceId ?? null;
  } catch {
    // A badly signed token adds nothing.
  }
  return deviceId !== null && (await anySharedDeviceActive([deviceId]));
}

/** `isOnSharedDeviceByHeaders` for a WebSocket upgrade. */
export function isUpgradeOnSharedDevice(
  request: IncomingMessage,
): Promise<boolean> {
  return isOnSharedDeviceByHeaders(request.headers);
}
