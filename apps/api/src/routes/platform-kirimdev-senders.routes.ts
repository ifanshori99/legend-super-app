// Super Admin Kirimdev sender mapping (legend-nqxtb). Same guards as
// platformUsageRouter: platform session, trusted origin, live platform_admins
// registry entry and a fresh MFA. No tenant-facing endpoint exposes numbers.

import { Router } from "express";
import {
  deleteKirimdevSenderMappingQuerySchema,
  kirimdevSenderMappingParamsSchema,
  listKirimdevSenderMappingsQuerySchema,
  upsertKirimdevSenderMappingInputSchema,
} from "@starter/shared/validators/kirimdev-sender";
import { getAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireSessionMfa } from "../middleware/identity";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin";
import {
  deleteKirimdevSenderMappingAny,
  listKirimdevSenderMappingsAny,
  upsertKirimdevSenderMappingAny,
} from "../services/kirimdev-sender-mapping.service";

export const platformKirimdevSendersRouter = Router();

const platformGuard = [
  noStore,
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
];

platformKirimdevSendersRouter.get(
  "/messaging/kirimdev-senders",
  ...platformGuard,
  async (req, res) => {
    const query = listKirimdevSenderMappingsQuerySchema.parse(req.query);
    res.json(await listKirimdevSenderMappingsAny(query, getAuth(req).user.id));
  },
);

platformKirimdevSendersRouter.put(
  "/messaging/kirimdev-senders",
  ...platformGuard,
  jsonBody,
  async (req, res) => {
    const input = upsertKirimdevSenderMappingInputSchema.parse(req.body);
    res.json({
      data: await upsertKirimdevSenderMappingAny(input, getAuth(req).user.id),
    });
  },
);

platformKirimdevSendersRouter.delete(
  "/messaging/kirimdev-senders/:id",
  ...platformGuard,
  async (req, res) => {
    const { id } = kirimdevSenderMappingParamsSchema.parse(req.params);
    const { tenantId } = deleteKirimdevSenderMappingQuerySchema.parse(
      req.query,
    );
    await deleteKirimdevSenderMappingAny(id, tenantId, getAuth(req).user.id);
    res.status(204).end();
  },
);
