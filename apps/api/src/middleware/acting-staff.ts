// Active cashier per device (DECISIONS 2026-11-10, "Kasir aktif per perangkat
// lewat token server"). A POS request may carry `X-Acting-Staff`, the opaque
// token issued by POST /api/staff-pins/pos-session. When it is present and
// valid the staff member it names becomes the actor AND the subject of every
// permission check (middleware/permissions.ts); the login session owner's
// permissions and second factor are not inherited. Without the header the
// session owner stays the actor (old behaviour).
//
// Mount after requireAuth + requireTrustedOrigin + requireTenantContext and
// before any permission guard. Several POS routers share one URL prefix, so a
// request can pass through this middleware more than once: the token is
// resolved on the first pass only.

import type { Request, RequestHandler } from "express";
import {
  ACTING_STAFF_ERROR_CODES,
  ACTING_STAFF_HEADER,
} from "@starter/shared/pos/acting-staff";
import { HttpError } from "../lib/http-error";
import { setRequestActingStaff } from "../lib/request-context";
import { deviceIdOf } from "../routes/device-id.ts";
import { resolveActingStaffToken } from "../services/pos-acting-staff.service";
import { getAuth } from "./auth";
import { getTenantContext } from "./tenant";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation
  namespace Express {
    interface Request {
      // Set by resolveActingStaff when X-Acting-Staff resolved to a live token.
      actingStaff?: {
        staffUserId: string;
        sessionUserId: string;
        tokenId: string;
        outletId: string;
      };
    }
  }
}

/** True when the client sent the header, even an empty or malformed one. */
export function hasActingStaffHeader(req: Request): boolean {
  return req.headers[ACTING_STAFF_HEADER] !== undefined;
}

export const resolveActingStaff: RequestHandler = async (req, _res, next) => {
  if (!hasActingStaffHeader(req) || req.actingStaff) return next();
  const deviceId = deviceIdOf(req);
  // The token is bound to a signed device; a request without one cannot use it.
  if (deviceId === null)
    throw new HttpError(
      401,
      ACTING_STAFF_ERROR_CODES.INVALID,
      "Kasir aktif tidak valid untuk perangkat ini.",
    );
  const outletParam = req.params.outletId;
  const resolved = await resolveActingStaffToken(getTenantContext(req), {
    token: String(req.get(ACTING_STAFF_HEADER) ?? ""),
    deviceId,
    sessionId: getAuth(req).session.id,
    // Routes without :outletId in the path (pos-overrides, order customer) are
    // checked against the token's outlet by the handler or the permission guard.
    outletId: typeof outletParam === "string" ? outletParam : null,
  });
  req.actingStaff = {
    staffUserId: resolved.staffUserId,
    sessionUserId: resolved.sessionUserId,
    tokenId: resolved.tokenId,
    outletId: resolved.outletId,
  };
  setRequestActingStaff(req.actingStaff);
  next();
};

/** For owner-only routes that never accept an acting cashier. */
export const rejectActingStaff: RequestHandler = (req, _res, next) => {
  if (hasActingStaffHeader(req))
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.NOT_ALLOWED,
      "Aksi ini tidak dapat dilakukan sebagai kasir aktif.",
    );
  next();
};

/**
 * The user a request acts as: the acting cashier when a token resolved, else
 * the login session owner. `getAuth` stays the session (MFA, support session,
 * "self" checks); only actor and permission subject use this.
 */
export function actorOf(req: Request): string {
  return req.actingStaff?.staffUserId ?? getAuth(req).user.id;
}
