// Integrations store + quota/cost usage routes (PRD v1.7 §3 F4 "Integrasi per
// Tenant", "Kuota & Plafon"; TEN-06, PAY-06). Contract:
// @starter/shared/platform endpoints.ts (orgEndpoints.listIntegrations,
// upsertIntegration, setIntegrationStatus, getUsage; the gateway
// `POST /integrations/:integrationId/test` is declared here only);
// platformEndpoints.getTenantUsage).
//
// Guards are attached per route, not with router.use(), so mounting these
// routers next to orgRouter/platformRouter on the same prefix never runs a
// second auth chain for the other routers' paths.
//
// - `orgIntegrationsRouter` (mount at /api/org): requireAuth, origin check,
//   server-minted tenant (TEN-02), AUTH-05 back-office gate, then the tenant
//   permission from stored role assignments (TEN-03). Credentials in a PUT
//   body are write-only: responses carry only the secret reference.
// - `platformUsageRouter` (mount at /api/platform): requireAuth, origin
//   check, the revocable platform_admins registry, then session MFA — the
//   same chain as platform.routes.ts.

import { Router, type RequestHandler } from "express";
import {
  setIntegrationStatusInputSchema,
  tenantIntegrationIdSchema,
  upsertIntegrationInputSchema,
} from "@starter/shared/platform";
import { tenantIdSchema, z } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireSessionMfa } from "../middleware/identity.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { noStore } from "../middleware/no-store.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { supportSessionOf } from "../middleware/support-session.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  listIntegrations,
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import { testGatewayConnection } from "../services/payment-gateway-connection.service.ts";
import {
  getLoginReplySettings,
  updateLoginReplySettings,
} from "../services/wa-login-reply-settings.service.ts";
import {
  getOrgUsage,
  getTenantUsageForPlatform,
} from "../services/platform-usage.service.ts";

// ------------------------------------------------------------- tenant org

const tenantGuard: RequestHandler[] = [
  noStore,
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
];
const manageIntegrations = requireTenantPermission("org.integration.manage");
const viewUsage = requireTenantPermission("org.settings.manage");

const integrationParams = z.strictObject({
  integrationId: tenantIntegrationIdSchema,
});

export const orgIntegrationsRouter = Router();

orgIntegrationsRouter.get(
  "/integrations",
  ...tenantGuard,
  manageIntegrations,
  async (req, res) => {
    res.json(await listIntegrations(getScopedTenantContext(req)));
  },
);

orgIntegrationsRouter.put(
  "/integrations",
  ...tenantGuard,
  manageIntegrations,
  jsonBody,
  async (req, res) => {
    const input = upsertIntegrationInputSchema.parse(req.body);
    res.json({
      data: await upsertIntegration(
        getScopedTenantContext(req),
        input,
        getAuth(req).user.id,
        // Fee caps are the platform's: only a support session may change them.
        { platform: (await supportSessionOf(req)) !== null },
      ),
    });
  },
);

orgIntegrationsRouter.post(
  "/integrations/:integrationId/status",
  ...tenantGuard,
  manageIntegrations,
  jsonBody,
  async (req, res) => {
    const { integrationId } = integrationParams.parse(req.params);
    const input = setIntegrationStatusInputSchema.parse(req.body);
    res.json({
      data: await setIntegrationStatus(
        getScopedTenantContext(req),
        integrationId,
        input,
        getAuth(req).user.id,
      ),
    });
  },
);

orgIntegrationsRouter.post(
  "/integrations/:integrationId/test",
  ...tenantGuard,
  manageIntegrations,
  async (req, res) => {
    const { integrationId } = integrationParams.parse(req.params);
    res.json({
      data: await testGatewayConnection(
        getScopedTenantContext(req),
        integrationId,
        getAuth(req).user.id,
      ),
    });
  },
);

orgIntegrationsRouter.get(
  "/usage",
  ...tenantGuard,
  viewUsage,
  async (req, res) => {
    res.json({ data: await getOrgUsage(getScopedTenantContext(req)) });
  },
);

// AUTH-03: WhatsApp login replies are opt-in per tenant (default off).
const loginReplySettingsBody = z.strictObject({
  enabled: z.boolean(),
  freeMonthlyQuota: z.number().int().min(0).max(1000).optional(),
});

orgIntegrationsRouter.get(
  "/whatsapp/login-replies",
  ...tenantGuard,
  viewUsage,
  async (req, res) => {
    res.json({
      data: await getLoginReplySettings(getScopedTenantContext(req)),
    });
  },
);

orgIntegrationsRouter.put(
  "/whatsapp/login-replies",
  ...tenantGuard,
  viewUsage,
  jsonBody,
  async (req, res) => {
    const input = loginReplySettingsBody.parse(req.body);
    res.json({
      data: await updateLoginReplySettings(
        getScopedTenantContext(req),
        input,
        new Date(),
        getAuth(req).user.id,
      ),
    });
  },
);

// ------------------------------------------------------------ Panel Platform

const platformGuard: RequestHandler[] = [
  noStore,
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
];
const tenantParams = z.strictObject({ tenantId: tenantIdSchema });

export const platformUsageRouter = Router();

platformUsageRouter.get(
  "/tenants/:tenantId/usage",
  ...platformGuard,
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    res.json({ data: await getTenantUsageForPlatform(tenantId) });
  },
);
