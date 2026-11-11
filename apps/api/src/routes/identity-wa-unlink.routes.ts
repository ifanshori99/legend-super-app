// Audited WhatsApp unlink by staff (bead legend-7wzy; contract
// `unlinkWhatsAppIdentity` in @starter/shared/identity). The path carries the
// outlet the staff member works in; the tenant comes from the Host (TEN-02) and
// any tenant id in the query or body is ignored. `crm.customer.identity.unlink`
// (not the read permission) must reach that outlet (TEN-03), the session's
// second factor must be fresh, and the body carries the reason; the service
// re-checks the tenant and audits.
//
// Paths are absolute under /api, so the router is mounted without a prefix and
// guards each route itself (same shape as customers.routes.ts).

import { Router, type RequestHandler } from "express";
import {
  AccessError,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
} from "@starter/shared/access";
import {
  unlinkWhatsAppIdentityBodySchema,
  unlinkWhatsAppIdentityParamsSchema,
} from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { loadSessionRow } from "../services/identity-session.service";
import { unlinkWhatsAppIdentity } from "../services/identity-wa-unlink.service";

export const identityWaUnlinkRouter = Router();

// Clearing a customer's WhatsApp link is destructive, so the session's second
// factor must be recent, not just verified once (same rule and age expression
// as the receipt write-off route): no verification is MFA_REQUIRED (403), a
// stale or future one is REAUTH_REQUIRED (401). A revoked or expired session
// row never counts, even with a fresh stamp.
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

// DELETE normally has no body; this one needs the reason. A request without a
// JSON body reaches the schema as `{}` and fails there with 400.
const optionalJsonBody: RequestHandler = (req, res, next) => {
  const type = req.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type === "application/json") return jsonBody(req, res, next);
  next();
};

identityWaUnlinkRouter.delete(
  "/outlets/:outletId/customers/:userId/identities/:identityId",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireOutletPermission("crm.customer.identity.unlink", (req) =>
    String(req.params.outletId),
  ),
  recentSecondFactor,
  optionalJsonBody,
  async (req, res) => {
    const params = unlinkWhatsAppIdentityParamsSchema.parse(req.params);
    const body = unlinkWhatsAppIdentityBodySchema.parse(req.body ?? {});
    await unlinkWhatsAppIdentity(getScopedTenantContext(req), {
      actorUserId: getAuth(req).user.id,
      outletId: params.outletId,
      customerUserId: params.userId,
      identityId: params.identityId,
      reason: body.reason,
    });
    res.status(204).end();
  },
);
