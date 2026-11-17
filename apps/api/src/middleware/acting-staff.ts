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
import {
  currentDeviceIdOf,
  registeredDeviceIdOf,
} from "../routes/device-id.ts";
import { resolveActingStaffToken } from "../services/pos-acting-staff.service";
import {
  anySharedDeviceActive,
  isActiveSharedDevice,
  markSessionSharedDevice,
  sharedDeviceMarkLimit,
} from "../services/shared-device.service";
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
  if (!hasActingStaffHeader(req)) return next();
  if (req.actingStaff) {
    // A later pass (shared URL prefix): the token was resolved already, but
    // this router may see an :outletId the first one did not (Express params
    // are per router). The token's outlet is still the only one it may act in.
    const later = req.params.outletId;
    if (
      typeof later === "string" &&
      later.toLowerCase() !== req.actingStaff.outletId.toLowerCase()
    )
      throw new HttpError(
        403,
        ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
        "Kasir aktif ini bertugas di outlet lain.",
      );
    return next();
  }
  // The token is bound to a signed device whose token is still current in the
  // registry; a request without one (or with a rotated-out one) cannot use it.
  const deviceId = await registeredDeviceIdOf(req);
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

/**
 * Shared-device mode (legend-f586w), an explicit per-device flag
 * (`devices.shared_mode`). Only a flagged device is guarded; every other
 * request keeps the old behaviour (session owner is the actor).
 *  - A request from a flagged device must carry a live cashier token. The login
 *    session is marked with that device first (shared_device_ids, newest 8), so
 *    the same cookie replayed without the device header is refused too.
 *  - A marked session is refused while ANY marked device is still active and
 *    flagged, in any tenant of the login (the cookie is shared across tenants),
 *    whether the request has no device header or carries the token of another,
 *    unflagged device; once every marked device is unflagged, revoked or gone
 *    the marks lapse.
 * When the session already holds 8 active marks, a 9th flagged device cannot be
 * recorded: its request is refused 403 SHARED_DEVICE_MARK_LIMIT (never passed
 * as owner). A device token that is present but no longer accepted is a 401
 * from currentDeviceIdOf, never the old behaviour. Mount right after
 * resolveActingStaff: an invalid header has already failed there with its own
 * error. Not for device-pin, customer-display, edge or rejectActingStaff routes.
 */
export const requireActingStaffOnSharedDevice: RequestHandler = async (
  req,
  _res,
  next,
) => {
  const tenant = getTenantContext(req);
  const { session, user } = getAuth(req);
  if (req.actingStaff) {
    // A tokened request passes, but a device flagged after the cashier session
    // started must still mark the session, or the same cookie replayed without
    // the device header would keep the old behaviour. No device header: skip.
    const tokenDeviceId = await currentDeviceIdOf(req);
    if (
      tokenDeviceId !== null &&
      (await isActiveSharedDevice(tenant, tokenDeviceId)) &&
      !(await markSessionSharedDevice(session.id, tokenDeviceId))
    )
      throw await sharedDeviceMarkLimit(session.id, user.id);
    return next();
  }
  const deviceId = await currentDeviceIdOf(req);
  const marked = session.sharedDeviceIds ?? [];
  if (deviceId !== null && (await isActiveSharedDevice(tenant, deviceId))) {
    if (!(await markSessionSharedDevice(session.id, deviceId)))
      throw await sharedDeviceMarkLimit(session.id, user.id);
    throw sharedDeviceRequired();
  }
  // No device header, or another (unflagged) device's valid token: neither may
  // lift the marks of a session used on a device that is still active and
  // flagged.
  if (await anySharedDeviceActive(marked)) throw sharedDeviceRequired();
  next();
};

function sharedDeviceRequired(): HttpError {
  return new HttpError(
    401,
    ACTING_STAFF_ERROR_CODES.REQUIRED,
    "Perangkat bersama: masuk dengan PIN kasir dulu.",
  );
}

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
