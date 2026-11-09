import type { RequestHandler } from "express";
import { isPlatformAdmin } from "../services/platform-support.service";
import { getAuth } from "./auth";
import { HttpError } from "../lib/http-error";

/**
 * Platform access is tied to the revocable registry, never a global auth role.
 * An impersonated session (the target user's identity, acted by an admin) is
 * never a platform admin, even when the target user is one.
 */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  const auth = getAuth(req);
  const impersonated = Boolean(
    (auth.session as { impersonatedBy?: string | null }).impersonatedBy,
  );
  if (impersonated || !(await isPlatformAdmin(auth.user.id))) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action.",
    );
  }
  next();
};
