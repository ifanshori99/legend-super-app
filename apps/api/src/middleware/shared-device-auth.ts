import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { auth } from "../lib/auth";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error";
import {
  anySharedDeviceActive,
  sharedDeviceMarkLimit,
  stampSharedDeviceFromToken,
} from "../services/shared-device.service";

// legend-wa9n7: a login session that has been used on a shared device (a
// cashier tablet) must not reach account management under /api/auth: profile,
// password, email, session lists and revocation, two-factor, passkeys, account
// links, user deletion and the admin plugin all stay on a personal device.
// requireAuth cannot guard them because Better Auth and identityAuthRouter
// authenticate on their own. Only these stay open: reading the session,
// and signing in (also social callbacks). The idle keep-alive
// (POST sessions/current/activity, legend-hlmbk) is open too: it only extends
// the caller's own current session, and without it a tablet signs out when
// idle. Its route uses requireAuthAllowSharedDevice.
const SHARED_DEVICE_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-out",
]);
const GET_SESSION_PATH = "/api/auth/get-session";
const SHARED_DEVICE_KEEP_ALIVE_PATH = "/api/auth/sessions/current/activity";
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

/** Open paths that stay reachable for a marked session but still record a mark. */
function isStampOnlyPath(path: string | null, method: string): boolean {
  if (path === GET_SESSION_PATH) return true;
  return path === SHARED_DEVICE_KEEP_ALIVE_PATH && method === "POST";
}

function isAllowedOnSharedDevice(path: string | null, method: string): boolean {
  if (path === null) return false;
  if (SHARED_DEVICE_ALLOWED_PATHS.has(path)) return true;
  if (path === SHARED_DEVICE_KEEP_ALIVE_PATH) return method === "POST";
  return path.startsWith(SIGN_IN_PREFIX) && path.length > SIGN_IN_PREFIX.length;
}

const REFUSED = (): HttpError =>
  new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.NOT_ALLOWED,
    "Perangkat bersama: fitur ini hanya bisa dibuka dari perangkat pribadi.",
  );

/**
 * Mounted on /api/auth before the login-challenge router, identityAuthRouter
 * and Better Auth. A request without credentials passes, and so do sign-in and
 * sign-out with no lookup (sign-in is stamped at session creation, sign-out
 * must stay reachable). The open get-session and keep-alive paths pass with no
 * lookup unless they carry an X-Device-Token; with one, the session is read and
 * the token is stamped (legend-5pipx) but the request is never refused. Every
 * other path reads the session (no cookie cache) and stamps the token FIRST, so
 * even a refused request records the mark and a header-less replay of the same
 * cookie is closed too. It is then refused 403 ACTING_STAFF_NOT_ALLOWED when the
 * session carries any mark in session.sharedDeviceIds (a mark never lapses, even
 * if those devices are now unflagged or revoked) or the validly signed
 * X-Device-Token is of an active shared device. A full list of 8 active marks
 * refuses the 9th device with 403 SHARED_DEVICE_MARK_LIMIT. A personal-device
 * session is untouched. Reads headers only, never the body.
 */
export const guardSharedDeviceAuthRoutes: RequestHandler = async (
  req,
  _res,
  next,
) => {
  const path = normalizedPathOf(req);
  const method = req.method;
  if (!req.headers.cookie && !req.headers.authorization) return next();
  const stampOnly = isStampOnlyPath(path, method);
  if (!stampOnly && isAllowedOnSharedDevice(path, method)) return next();
  const rawToken = req.get(DEVICE_TOKEN_HEADER);
  if (stampOnly && !rawToken) return next();
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!session) return next();
  const marks = await stampSharedDeviceFromToken(
    session.session.id,
    session.session.sharedDeviceIds,
    rawToken,
  );
  if (marks === null)
    throw await sharedDeviceMarkLimit(session.session.id, session.user.id);
  if (stampOnly) return next();
  if (marks.length > 0) throw REFUSED();
  if (!rawToken) return next();
  let deviceId: string | null = null;
  try {
    deviceId = verifyDeviceToken(rawToken)?.deviceId ?? null;
  } catch {
    // A badly signed token adds nothing.
  }
  if (deviceId === null || !(await anySharedDeviceActive([deviceId])))
    return next();
  throw REFUSED();
};
