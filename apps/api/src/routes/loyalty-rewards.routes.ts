// Reward catalog, missions and redemption fulfilment for staff (legend-m4p5;
// contract `@starter/shared/crm` endpoints). Paths are absolute under /api
// (`/loyalty/rewards`, `/loyalty/missions`, `/loyalty/redemptions/fulfil`), so
// the router is mounted without a prefix and guards each route itself (same
// shape as loyalty-program.routes.ts).
//
// Catalog and mission edits are tenant-wide (`crm.loyalty.manage`). Fulfil is
// outlet-bound: the permission must reach the body's `outletId`, and the
// tenant comes from the server-minted context, never the request.

import { Router } from "express";
import {
  createMissionInputSchema,
  createRewardInputSchema,
  fulfilRedemptionInputSchema,
  listMissions as listMissionsEndpoint,
  listRewards as listRewardsEndpoint,
  updateMission as updateMissionEndpoint,
  updateMissionInputSchema,
  updateReward as updateRewardEndpoint,
  updateRewardInputSchema,
} from "@starter/shared/crm";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as rewardsAdmin from "../services/loyalty-rewards-admin.service";
import * as missions from "../services/missions.service";
import { fulfilRedemption } from "../services/reward-redemption.service";

export const loyaltyRewardsRouter = Router();

const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];
const manage = requireTenantPermission("crm.loyalty.manage");
// The outlet is read from the already-parsed JSON body (`jsonBody` runs first).
const fulfil = requireOutletPermission("crm.loyalty.fulfil", (req) =>
  String(
    typeof req.body === "object" && req.body !== null
      ? (req.body as { outletId?: unknown }).outletId
      : "",
  ),
);

loyaltyRewardsRouter.get(
  "/loyalty/rewards",
  ...staffGuard,
  manage,
  async (req, res) => {
    const query = listRewardsEndpoint.query.parse(req.query);
    res.json(
      await rewardsAdmin.listRewards(getScopedTenantContext(req), query),
    );
  },
);

loyaltyRewardsRouter.post(
  "/loyalty/rewards",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = createRewardInputSchema.parse(req.body);
    res.status(201).json({
      data: await rewardsAdmin.createReward(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);

loyaltyRewardsRouter.patch(
  "/loyalty/rewards/:rewardId",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const { rewardId } = updateRewardEndpoint.params.parse(req.params);
    const patch = updateRewardInputSchema.parse(req.body);
    res.json({
      data: await rewardsAdmin.updateReward(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        rewardId,
        patch,
      ),
    });
  },
);

loyaltyRewardsRouter.get(
  "/loyalty/missions",
  ...staffGuard,
  manage,
  async (req, res) => {
    const query = listMissionsEndpoint.query.parse(req.query);
    res.json(await missions.listMissions(getScopedTenantContext(req), query));
  },
);

loyaltyRewardsRouter.post(
  "/loyalty/missions",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = createMissionInputSchema.parse(req.body);
    res.status(201).json({
      data: await missions.createMission(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);

loyaltyRewardsRouter.patch(
  "/loyalty/missions/:missionId",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const { missionId } = updateMissionEndpoint.params.parse(req.params);
    const patch = updateMissionInputSchema.parse(req.body);
    res.json({
      data: await missions.updateMission(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        missionId,
        patch,
      ),
    });
  },
);

loyaltyRewardsRouter.post(
  "/loyalty/redemptions/fulfil",
  ...staffGuard,
  jsonBody,
  fulfil,
  async (req, res) => {
    const input = fulfilRedemptionInputSchema.parse(req.body);
    const context = getScopedTenantContext(req);
    const data = await withTenant(db, context, (tx) =>
      fulfilRedemption(tx, context, getAuth(req).user.id, input, new Date()),
    );
    res.json({ data });
  },
);
