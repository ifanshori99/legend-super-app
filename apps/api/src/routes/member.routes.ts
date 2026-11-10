// Member PWA API (legend-111j, docs/design/ws08-member-loyalty.md §M4, §M7).
// Paths, bodies and queries come from the WS-08 contract
// (`@starter/shared/crm` member endpoints). Mount at /api/member.
//
// Chain: tenant from the PWA host (TEN-02) → requireAuth → requireTrustedOrigin
// (mutations; safe methods pass) → jsonBody (POST with a body) →
// requireMember({ allow }). The profile always comes from the session; this
// module imports `withMemberScope` and never `withTenant`.

import { Router } from "express";
import {
  crmErrorMessages,
  customerProfileDtoSchema,
  listMemberPoints as listMemberPointsEndpoint,
  updateMemberConsentInputSchema,
} from "@starter/shared/crm";
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
    const profile = await withMemberScope(db, scope, (tx) =>
      findProfileByUser(tx, scope.tenantId, scope.userId),
    );
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
  const { items, nextCursor } = await withMemberScope(db, scope, (tx) =>
    listLedgerForProfile(tx, scope.tenantId, profileIdOf(scope), {
      cursor: query.cursor,
      limit: query.limit,
    }),
  );
  res.json({ data: items, meta: { limit: query.limit, nextCursor } });
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

memberRouter.post("/qr-token", ...base, requireMember(), async (req, res) => {
  const scope = getMemberScope(req);
  res.json({
    data: issueMemberQrToken(
      {
        tenantId: scope.tenantId,
        customerProfileId: profileIdOf(scope),
      },
      new Date(),
    ),
  });
});
