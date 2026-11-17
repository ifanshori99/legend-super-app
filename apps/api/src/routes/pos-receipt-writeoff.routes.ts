// Audited write-off of a lost receipt number (legend-0hzqw). Owner only
// (`pos.receipt.writeoff`); cloud only (the service refuses on an edge).
//
// Mounts (routes/index.ts): apiRouter.use("/outlets/:outletId/pos", ...)

import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import {
  AccessError,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
} from "@starter/shared/access";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import { receiptNumberWriteoffInputSchema } from "@starter/shared/pos";
import { rejectActingStaff } from "../middleware/acting-staff.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { loadSessionRow } from "../services/identity-session.service.ts";
import * as writeoff from "../services/pos-receipt-writeoff.service.ts";

export const posReceiptWriteoffRouter = Router({ mergeParams: true });

// Per route, not router `.use` (legend-3z0ds): the router shares its URL prefix
// with the POS routers, so a strict `.use` would refuse their shared-device
// requests (shifts, day close) before they reach their own router.
const session = [requireAuth, requireTrustedOrigin, requireTenantContext];

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const owner = requireOutletPermission("pos.receipt.writeoff", outletOf);

const params = z.strictObject({ outletId: outletIdSchema });

// Owner-only and session-bound (second factor): an active cashier token is
// refused outright (403 ACTING_STAFF_NOT_ALLOWED), before any permission
// check. It sits on the routes, not the router `.use`: the router shares its
// URL prefix with the other POS routers, so a `.use` would also refuse their
// requests.

// The permission code alone is not enough: a tenant admin can put it in a
// custom role (top-authority path), and that holder would pass the middleware.
// Only an assignment of the owner TEMPLATE counts; a custom role (templateKey
// null) never does, and the owner template cannot be granted through top
// authority nor edited. Runs after the permission check, which loads the
// access snapshot.
const ownerTemplateOnly: RequestHandler = (req, _res, next) => {
  const allowed = getAccessSnapshot(req).allowsVia(
    "owner",
    "pos.receipt.writeoff",
    { type: "outlet", id: outletOf(req) },
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
  next();
};

// A write-off hides a missing number from the receipt trail for good and
// cannot be undone, so the session's second factor must be recent, not just
// verified once (same rule and age expression as the role-grant path in
// grants.ts): no verification is MFA_REQUIRED (403), a stale or future one is
// REAUTH_REQUIRED (401). A revoked or expired session row never counts, even
// with a fresh stamp (same rule as sessionMfaVerifiedAt in lib/mfa.ts).
const recentSecondFactor: RequestHandler = async (req, _res, next) => {
  const session = await loadSessionRow(getAuth(req).session.id);
  const now = Date.now();
  if (
    session &&
    (session.revokedAt !== null || session.expiresAt.getTime() <= now)
  )
    throw new AccessError("REAUTH_REQUIRED");
  const verifiedAt = session?.mfaVerifiedAt ?? null;
  if (verifiedAt === null) throw new AccessError("MFA_REQUIRED");
  const age = now - verifiedAt.getTime();
  if (!(age >= 0 && age <= ROLE_GRANT_REAUTH_MAX_AGE_MS))
    throw new AccessError("REAUTH_REQUIRED");
  next();
};

posReceiptWriteoffRouter.post(
  "/receipt-writeoffs",
  ...session,
  rejectActingStaff,
  owner,
  ownerTemplateOnly,
  recentSecondFactor,
  jsonBody,
  async (req, res) => {
    const { outletId } = params.parse(req.params);
    const body = receiptNumberWriteoffInputSchema.parse(req.body);
    res.status(201).json({
      data: await writeoff.writeOffReceiptNumber(
        getScopedTenantContext(req),
        { userId: userIdSchema.parse(getAuth(req).user.id) },
        outletId,
        body,
      ),
    });
  },
);

posReceiptWriteoffRouter.get(
  "/receipt-writeoffs",
  ...session,
  rejectActingStaff,
  owner,
  ownerTemplateOnly,
  async (req, res) => {
    const { outletId } = params.parse(req.params);
    res.json({
      data: await writeoff.listReceiptNumberWriteoffs(
        getScopedTenantContext(req),
        outletId,
      ),
    });
  },
);
