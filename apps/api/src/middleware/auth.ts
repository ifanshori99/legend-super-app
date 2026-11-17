import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Permissions } from "@starter/shared/permissions";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { auth } from "../lib/auth";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error";
import { setRequestAuthMethod, setRequestUser } from "../lib/request-context";
import {
  anySharedDeviceActive,
  sharedDeviceMarkLimit,
  stampSharedDeviceFromToken,
} from "../services/shared-device.service";
import { enforceSupportSession } from "./support-session";

// legend-3z0ds (brief 1012): a login session that has been used on a shared
// device (session.shared_device_ids, or a valid token of an active flagged shared
// device on this very request) is a cashier tablet's session. Its owner cookie
// must never reach a back-office route. requireAuth therefore refuses such a
// session by default (403 ACTING_STAFF_NOT_ALLOWED); a router that cashiers
// really use opts in with requireAuthAllowSharedDevice and then mounts
// resolveActingStaff + requireActingStaffOnSharedDevice (POS routers) or is a
// reviewed shell read. The list of opted-in routers is pinned by
// test/shared-device-router-decisions.test.ts. A mark never lapses (legend
// 1027): a session with any entry in session.shared_device_ids stays a shared
// device session even when every marked device is later unflagged, revoked or
// gone. Only a token-only request (no mark yet) needs its device to be active.
async function refuseSharedDeviceSession(
  req: Request,
  marked: readonly string[] | null | undefined,
): Promise<void> {
  if ((marked?.length ?? 0) > 0)
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.NOT_ALLOWED,
      "Perangkat bersama: fitur ini hanya bisa dibuka dari perangkat pribadi.",
    );
  const raw = req.get(DEVICE_TOKEN_HEADER);
  if (!raw) return;
  let deviceId: string | null = null;
  try {
    deviceId = verifyDeviceToken(raw)?.deviceId ?? null;
  } catch {
    // A badly signed token adds nothing.
  }
  if (deviceId === null || !(await anySharedDeviceActive([deviceId]))) return;
  throw new HttpError(
    403,
    ACTING_STAFF_ERROR_CODES.NOT_ALLOWED,
    "Perangkat bersama: fitur ini hanya bisa dibuka dari perangkat pribadi.",
  );
}

function createRequireAuth(options: {
  allowSharedDevice: boolean;
}): RequestHandler {
  // Authenticates against the database on every request (no cookie cache), so a
  // signed-out or revoked session stops working immediately. Answers JSON 401.
  return async (req, _res, next) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      query: { disableCookieCache: true },
    });
    if (!session)
      throw new HttpError(401, "UNAUTHORIZED", "Sign in to continue.");
    req.auth = session;
    setRequestUser(session.user.id);
    // legend-k2l: only a password session may use staff role assignments
    // (services/permission-resolver.ts reads it through requestMayUseStaffRoles).
    setRequestAuthMethod(session.session.authMethod ?? "legacy");
    // legend-jqurl: a signed token of a flagged shared device marks the session
    // on every authenticated route, not only the guarded POS ones. A full list of
    // 8 active marks refuses the 9th device (legend-dn7uo). Otherwise never throws.
    const stamped = await stampSharedDeviceFromToken(
      session.session.id,
      session.session.sharedDeviceIds,
      req.get(DEVICE_TOKEN_HEADER),
    );
    if (!stamped)
      throw await sharedDeviceMarkLimit(session.session.id, session.user.id);
    if (!options.allowSharedDevice)
      await refuseSharedDeviceSession(req, session.session.sharedDeviceIds);
    // A support (impersonated) session is checked against its support access
    // grant here, the one chokepoint of every cookie router. See
    // middleware/support-session.ts.
    await enforceSupportSession(req);
    next();
  };
}

/** Default guard: authenticated, and not a session of a shared cashier device. */
export const requireAuth: RequestHandler = createRequireAuth({
  allowSharedDevice: false,
});

/**
 * Authenticated, shared-device sessions allowed. Only for routers a cashier uses
 * on a shared device; POS routers add resolveActingStaff +
 * requireActingStaffOnSharedDevice right after it.
 */
export const requireAuthAllowSharedDevice: RequestHandler = createRequireAuth({
  allowSharedDevice: true,
});

// Role check for endpoints that reach past the caller's own rows. Reads the
// stored role, so a revoked role takes effect on the next request. Mount after
// requireAuth. Hiding UI in the web app is never the access check.
export function requirePermission(permissions: Permissions): RequestHandler {
  return async (req, _res, next) => {
    // legend-k2l (design ws08 M2): a member sign-in method never stands in
    // for the staff password, also for user.role checks.
    if ((getAuth(req).session.authMethod ?? "legacy") !== "password")
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Your account cannot perform this action.",
      );
    const { success } = await auth.api.userHasPermission({
      body: { userId: getAuth(req).user.id, permissions },
    });
    if (!success)
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Your account cannot perform this action.",
      );
    next();
  };
}

// The verified session inside a handler mounted after requireAuth.
export function getAuth(req: Request) {
  if (!req.auth)
    throw new Error("getAuth() used on a route without requireAuth");
  return req.auth;
}
