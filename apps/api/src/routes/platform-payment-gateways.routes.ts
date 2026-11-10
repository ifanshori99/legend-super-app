// Super Admin payment gateway registry (sub-302 D10). Same guards as
// platform.routes.ts: platform session, trusted origin, live platform_admins
// registry entry and a fresh MFA. The change history is written by the service
// in the same transaction as the update.

import { Router } from "express";
import {
  platformPaymentGatewayEndpoints,
  updatePlatformGatewayInputSchema,
} from "@starter/shared/platform";
import { getAuth } from "../middleware/auth";
import { requireSessionMfa } from "../middleware/identity";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  listPlatformGateways,
  updatePlatformGateway,
} from "../services/platform-payment-gateway.service";

export const platformPaymentGatewaysRouter = Router();

platformPaymentGatewaysRouter.use(
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

platformPaymentGatewaysRouter.get("/", async (_req, res) => {
  res.json({ data: [...(await listPlatformGateways())] });
});

platformPaymentGatewaysRouter.put("/:provider", jsonBody, async (req, res) => {
  const { provider } =
    platformPaymentGatewayEndpoints.updatePlatformGateway.params.parse(
      req.params,
    );
  const input = updatePlatformGatewayInputSchema.parse(req.body);
  res.json({
    data: await updatePlatformGateway(provider, input, getAuth(req).user.id),
  });
});
