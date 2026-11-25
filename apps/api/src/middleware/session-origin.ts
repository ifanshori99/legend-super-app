import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth";
import { isEdgeNode } from "../edge/mode.ts";
import { sessionAcceptedHere, sessionReadableHere } from "../lib/edge-session";
import { HttpError } from "../lib/http-error";

// A browser must always be able to drop its cookie, and to ask who it is: the
// web server reads the session during SSR without the device token.
const SIGN_OUT_PATH = "/api/auth/sign-out";
const GET_SESSION_PATH = "/api/auth/get-session";

/**
 * E2 (brief 1269) for everything under /api/auth, which never runs requireAuth.
 * The cloud refuses an `edge_staff_pin` session; an edge refuses every other
 * session, and lets a PIN session call sign-out and get-session only (no
 * account, device, MFA or login-challenge route). Reads headers only.
 */
export const guardSessionOriginAuthRoutes: RequestHandler = async (
  req,
  _res,
  next,
) => {
  const path = (req.originalUrl.split("?")[0] ?? "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
  if (path === SIGN_OUT_PATH) return next();
  if (!req.headers.cookie && !req.headers.authorization) return next();
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!session) return next();
  const allowed =
    path === GET_SESSION_PATH
      ? sessionReadableHere(session.session)
      : sessionAcceptedHere(session.session);
  if (!allowed)
    throw new HttpError(401, "UNAUTHORIZED", "Sign in to continue.");
  if (isEdgeNode() && path !== GET_SESSION_PATH)
    throw new HttpError(
      403,
      "EDGE_STAFF_SESSION_LIMITED",
      "Fitur akun hanya bisa dibuka saat masuk lewat internet.",
    );
  next();
};
