import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { auth } from "../lib/auth";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error";
import { anySharedDeviceActive } from "../services/shared-device.service";

// legend-wa9n7: a login session that has been used on a shared device (a
// cashier tablet) must not reach account management under /api/auth: profile,
// password, email, session lists and revocation, two-factor, passkeys, account
// links, user deletion and the admin plugin all stay on a personal device.
// requireAuth cannot guard them because Better Auth and identityAuthRouter
// authenticate on their own. Only these stay open: reading the session,
// and signing in (also social callbacks). The idle keep-alive
// (sessions/current/activity) is not listed: identityAuthRouter's requireAuth
// already refuses a shared-device session there (1012, default restrict).
const SHARED_DEVICE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-out",
]);
const SIGN_IN_PREFIX = "/api/auth/sign-in/";

/**
 * Lowercased path of the request without query, repeated slashes and trailing
 * slash, percent-decoded once. Null when the path cannot be normalised safely
 * (bad escape or a `..` segment): such a path is never allowlisted.
 */
function normalizedPathOf(req: Request): string | null {
  const raw = (req.originalUrl.split("?")[0] ?? "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const path = decoded.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (path.split("/").includes("..") || path.includes("\\")) return null;
  return path.toLowerCase();
}

function isAllowedOnSharedDevice(path: string | null): boolean {
  if (path === null) return false;
  if (SHARED_DEVICE_ALLOWED_PATHS.has(path)) return true;
  return path.startsWith(SIGN_IN_PREFIX) && path.length > SIGN_IN_PREFIX.length;
}

/**
 * Mounted on /api/auth before the login-challenge router, identityAuthRouter
 * and Better Auth. An allowlisted path passes with no lookup, and so does a
 * request without credentials. Otherwise the session is read (no cookie cache)
 * and, when its marks (session.sharedDeviceIds plus the device of a validly
 * signed X-Device-Token) include an active shared device, the request is
 * refused 403 ACTING_STAFF_NOT_ALLOWED. A personal-device session is untouched.
 * Reads headers only, never the body.
 */
export const guardSharedDeviceAuthRoutes: RequestHandler = async (
  req,
  _res,
  next,
) => {
  if (isAllowedOnSharedDevice(normalizedPathOf(req))) return next();
  if (!req.headers.cookie && !req.headers.authorization) return next();
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!session) return next();
  const ids = new Set(session.session.sharedDeviceIds ?? []);
  const rawToken = req.get(DEVICE_TOKEN_HEADER);
  if (rawToken) {
    try {
      const payload = verifyDeviceToken(rawToken);
      if (payload !== null) ids.add(payload.deviceId);
    } catch {
      // A badly signed token adds nothing; the session's own marks still count.
    }
  }
  if (ids.size === 0 || !(await anySharedDeviceActive([...ids]))) return next();
  throw new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.NOT_ALLOWED,
    "Perangkat bersama: fitur ini hanya bisa dibuka dari perangkat pribadi.",
  );
};
