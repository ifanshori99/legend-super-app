import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Permissions } from "@starter/shared/permissions";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { HttpError } from "../lib/http-error";
import { setRequestAuthMethod, setRequestUser } from "../lib/request-context";
import { stampSharedDeviceFromToken } from "../services/shared-device.service";
import { enforceSupportSession } from "./support-session";

// Authenticates against the database on every request (no cookie cache), so a
// signed-out or revoked session stops working immediately. Answers JSON 401.
export const requireAuth: RequestHandler = async (req, _res, next) => {
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
  // on every authenticated route, not only the guarded POS ones. Never throws.
  await stampSharedDeviceFromToken(
    session.session.id,
    session.session.sharedDeviceIds,
    req.get(DEVICE_TOKEN_HEADER),
  );
  // A support (impersonated) session is checked against its support access
  // grant here, the one chokepoint of every cookie router. See
  // middleware/support-session.ts.
  await enforceSupportSession(req);
  next();
};

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
