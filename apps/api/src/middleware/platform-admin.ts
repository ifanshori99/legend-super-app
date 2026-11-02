import type { RequestHandler } from "express";
import { isPlatformAdmin } from "../services/platform-support.service";
import { getAuth } from "./auth";
import { HttpError } from "../lib/http-error";

/** Platform access is tied to the revocable registry, never a global auth role. */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  if (!(await isPlatformAdmin(getAuth(req).user.id))) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action.",
    );
  }
  next();
};
