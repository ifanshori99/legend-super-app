// Member PWA API (legend-111j, docs/design/ws08-member-loyalty.md §M4, §M7).
// Paths, bodies and queries come from the WS-08 contract
// (`@starter/shared/crm` member endpoints). Mount at /api/member.
//
// Chain: tenant from the PWA host (TEN-02) → requireAuth → requireTrustedOrigin
// (mutations; safe methods pass) → jsonBody (POST with a body) →
// requireMember({ allow }). The profile always comes from the session; this
// module imports `withMemberScope` and never `withTenant`.

import { Router, type RequestHandler } from "express";
import {
  crmErrorMessages,
  customerProfileDtoSchema,
  listMemberPoints as listMemberPointsEndpoint,
  updateMemberConsentInputSchema,
} from "@starter/shared/crm";
import { memberQrTokenMintInputSchema } from "@starter/shared/validators/member-qr-token";
import { db } from "../db/index.ts";
import { withMemberScope } from "../db/member-scope.ts";
import { HttpError } from "../lib/http-error.ts";
import { issueMemberQrToken } from "../lib/member-qr-token.ts";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  getMemberScope,
  memberAnonymousScope,
  requireMember,
} from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  activeConsentPolicies,
  recordMemberConsent,
} from "../services/consent.service.ts";
import { expiringSoonOf } from "../services/loyalty-expiry.service.ts";
import { ensureReferralCode } from "../services/referral.service.ts";
import { listLedgerForProfile } from "../services/point-ledger.service.ts";
import {
  findProfileByUser,
  toCustomerProfileDto,
} from "../services/member-profile.service.ts";

export const memberRouter = Router();

const base = [requireTenantContext, requireAuth, requireTrustedOrigin];

/** A member with a session but no profile yet gets 404 CUSTOMER_NOT_FOUND. */
function profileIdOf(scope: ReturnType<typeof getMemberScope>): string {
  if (!scope.customerProfileId)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      crmErrorMessages.CUSTOMER_NOT_FOUND,
    );
  return scope.customerProfileId;
}

memberRouter.get(
  "/profile",
  ...base,
  requireMember({ allow: "pending" }),
  async (req, res) => {
    const scope = getMemberScope(req);
    // legend-3zd1: a member from before referrals get their code on the first read.
    const profile = await withMemberScope(db, scope, async (tx) => {
      const found = await findProfileByUser(tx, scope.tenantId, scope.userId);
      if (!found || found.referralCode) return found;
      const referralCode = await ensureReferralCode(
        tx,
        scope.tenantId,
        found.id,
      );
      return referralCode ? { ...found, referralCode } : found;
    });
    if (!profile)
      throw new HttpError(
        404,
        "CUSTOMER_NOT_FOUND",
        crmErrorMessages.CUSTOMER_NOT_FOUND,
      );
    const { whatsappHash, ...dto } = toCustomerProfileDto(profile);
    void whatsappHash; // never leaves the server
    res.json({ data: customerProfileDtoSchema.parse(dto) });
  },
);

memberRouter.get("/points", ...base, requireMember(), async (req, res) => {
  const scope = getMemberScope(req);
  const query = listMemberPointsEndpoint.query.parse(req.query);
  const profileId = profileIdOf(scope);
  const { page, expiringSoon } = await withMemberScope(
    db,
    scope,
    async (tx) => ({
      page: await listLedgerForProfile(tx, scope.tenantId, profileId, {
        cursor: query.cursor,
        limit: query.limit,
      }),
      expiringSoon: await expiringSoonOf(
        tx,
        scope.tenantId,
        profileId,
        new Date(),
      ),
    }),
  );
  res.json({
    data: page.items,
    meta: { limit: query.limit, nextCursor: page.nextCursor, expiringSoon },
  });
});

memberRouter.post(
  "/consents",
  ...base,
  jsonBody,
  requireMember({ allow: "signup" }),
  async (req, res) => {
    const input = updateMemberConsentInputSchema.parse(req.body);
    res.json({ data: await recordMemberConsent(getMemberScope(req), input) });
  },
);

// Tenant data, no profile needed: tenant host + session only.
memberRouter.get("/consent-policies", ...base, async (req, res) => {
  const scope = memberAnonymousScope(req);
  res.json({
    data: await withMemberScope(db, scope, (tx) =>
      activeConsentPolicies(tx, scope.tenantId, new Date()),
    ),
  });
});

// A body is optional here (the PWA's attach QR sends none): parse JSON only
// when the request carries one, so an empty POST keeps issuing an attach token.
const optionalJsonBody: RequestHandler = (req, res, next) => {
  const hasBody =
    req.get("transfer-encoding") !== undefined ||
    Number(req.get("content-length") ?? 0) > 0;
  if (hasBody) jsonBody(req, res, next);
  else next();
};

// Mints an attach token, or a redeem token when `{ orderId, points }` come
// along. The mint does not trust the order: the POS verifies it on redeem.
memberRouter.post(
  "/qr-token",
  ...base,
  optionalJsonBody,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    const input = memberQrTokenMintInputSchema.parse(req.body ?? {});
    res.json({
      data: issueMemberQrToken(
        {
          tenantId: scope.tenantId,
          customerProfileId: profileIdOf(scope),
          orderId: input.orderId,
          points: input.points,
        },
        new Date(),
      ),
    });
  },
);
