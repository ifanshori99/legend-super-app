// Staff table link (PRD "Operasi Meja", legend-1nmh): group tables for service
// only; bills stay separate. Same guard and permission as the session routes.

import { Router } from "express";
import {
  linkTablesInputSchema,
  tableLinkGroupIdSchema,
  unlinkTablesInputSchema,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { requireTenantContext } from "../middleware/tenant";
import {
  linkTablesOperation,
  unlinkTablesOperation,
} from "../services/table-link.service";
import { resolveFloorContext } from "./floor-access";

const groupParams = z.strictObject({ groupId: tableLinkGroupIdSchema });

export const tableLinksRouter = Router();

const staffGuard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

tableLinksRouter.post("/", ...staffGuard, jsonBody, async (req, res) => {
  const input = linkTablesInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.operate");
  res.json({
    data: await linkTablesOperation(context, input, actorOf(req)),
  });
});

tableLinksRouter.post(
  "/:groupId/unlink",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { groupId } = groupParams.parse(req.params);
    const input = unlinkTablesInputSchema.parse(req.body);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await unlinkTablesOperation(context, groupId, input, actorOf(req)),
    });
  },
);
