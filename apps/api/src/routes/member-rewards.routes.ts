// Member PWA rewards, redemptions, missions and vouchers (legend-m4p5,
// docs/design/ws08-member-loyalty.md §M5). Mounted under /api/member by the
// route index. Same chain as `member.routes.ts`: the profile always comes
// from the session scope; this module imports `withMemberScope` and never
// `withTenant`.

import { Router } from "express";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import {
  cancelMemberRedemption as cancelMemberRedemptionEndpoint,
  crmErrorMessages,
  listMemberRedemptions as listMemberRedemptionsEndpoint,
  listMemberRewards as listMemberRewardsEndpoint,
  listMemberVouchers as listMemberVouchersEndpoint,
  redeemReward as redeemRewardEndpoint,
  voucherDtoSchema,
} from "@starter/shared/crm";
import { decodeCursor, encodeCursor } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withMemberScope } from "../db/member-scope.ts";
import { vouchers } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { getMemberScope, requireMember } from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { toVoucher } from "../services/crm-promo-engine.ts";
import { listMemberMissions } from "../services/missions.service.ts";
import {
  cancelRedemption,
  listActiveRewards,
  listMemberRedemptions,
  redeemReward,
} from "../services/reward-redemption.service.ts";

export const memberRewardsRouter = Router();

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

function voucherCursorKeys(cursor: string): [string, string] {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
  }
  const [at, id] = keys;
  if (typeof at !== "string" || typeof id !== "string")
    throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
  return [at, id];
}

memberRewardsRouter.get(
  "/rewards",
  ...base,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    const query = listMemberRewardsEndpoint.query.parse(req.query);
    const { items, nextCursor } = await withMemberScope(db, scope, (tx) =>
      listActiveRewards(tx, scope.tenantId, {
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    res.json({ data: items, meta: { limit: query.limit, nextCursor } });
  },
);

memberRewardsRouter.post(
  "/rewards/:rewardId/redemptions",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    profileIdOf(scope);
    const { rewardId } = redeemRewardEndpoint.params.parse(req.params);
    const input = redeemRewardEndpoint.body.parse(req.body);
    res.json({
      data: await withMemberScope(db, scope, (tx) =>
        redeemReward(tx, scope, rewardId, input.idempotencyKey, new Date()),
      ),
    });
  },
);

memberRewardsRouter.get(
  "/redemptions",
  ...base,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    profileIdOf(scope);
    const query = listMemberRedemptionsEndpoint.query.parse(req.query);
    const { items, nextCursor } = await withMemberScope(db, scope, (tx) =>
      listMemberRedemptions(tx, scope, {
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    res.json({ data: items, meta: { limit: query.limit, nextCursor } });
  },
);

memberRewardsRouter.post(
  "/redemptions/:redemptionId/cancel",
  ...base,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    profileIdOf(scope);
    const { redemptionId } = cancelMemberRedemptionEndpoint.params.parse(
      req.params,
    );
    res.json({
      data: await withMemberScope(db, scope, (tx) =>
        cancelRedemption(tx, scope, redemptionId, new Date()),
      ),
    });
  },
);

memberRewardsRouter.get(
  "/missions",
  ...base,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    profileIdOf(scope);
    res.json({
      data: await withMemberScope(db, scope, (tx) =>
        listMemberMissions(tx, scope, new Date()),
      ),
    });
  },
);

memberRewardsRouter.get(
  "/vouchers",
  ...base,
  requireMember(),
  async (req, res) => {
    const scope = getMemberScope(req);
    const profileId = profileIdOf(scope);
    const query = listMemberVouchersEndpoint.query.parse(req.query);
    const { items, nextCursor } = await withMemberScope(
      db,
      scope,
      async (tx) => {
        const filters: SQL[] = [
          eq(vouchers.tenantId, scope.tenantId),
          eq(vouchers.customerProfileId, profileId),
        ];
        if (query.cursor) {
          const [at, id] = voucherCursorKeys(query.cursor);
          const atDate = new Date(at);
          if (Number.isNaN(atDate.getTime()))
            throw new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
          filters.push(
            or(
              lt(vouchers.issuedAt, atDate),
              and(eq(vouchers.issuedAt, atDate), lt(vouchers.id, id)),
            ) as SQL,
          );
        }
        const rows = await tx
          .select()
          .from(vouchers)
          .where(and(...filters))
          .orderBy(desc(vouchers.issuedAt), desc(vouchers.id))
          .limit(query.limit + 1);
        const pageRows = rows.slice(0, query.limit);
        const last = pageRows.at(-1);
        return {
          items: pageRows.map((row) => {
            const { codeHash, ...rest } = toVoucher(row);
            void codeHash; // never leaves the server
            return voucherDtoSchema.parse(rest);
          }),
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor([last.issuedAt.toISOString(), last.id])
              : null,
        };
      },
    );
    res.json({ data: items, meta: { limit: query.limit, nextCursor } });
  },
);
