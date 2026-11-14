// Per-tenant AI provider routes (WS-12, bead legend-dwrr; docs/DECISIONS.md
// "WS-12 provider AI per tenant" item 7). Paths and bodies come from the
// contract (`@starter/shared/ai` endpoints); mounted at `/api/ai`, so each
// path drops that prefix. Gates sit on each route (never router-wide): this
// router shares the mount point with the other AI routers. No response carries
// the API key.
import { Router } from "express";
import {
  patchAiProviderConfig as patchEndpoint,
  testAiProviderConfig as testEndpoint,
  upsertAiProviderConfig as upsertEndpoint,
} from "@starter/shared/ai";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getAiProviderView,
  patchAiProviderCapabilities,
  removeAiProviderConfig,
  saveAiProviderConfig,
  testAiProviderConnection,
} from "../services/ai-provider-config.service.ts";

export function createAiProviderRouter(): Router {
  const router = Router();
  const gate = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireBackOfficeSurface(),
    requireTenantPermission("ai.governance.manage"),
  ];

  router.get("/provider", ...gate, async (req, res) => {
    res.json({ data: await getAiProviderView(getScopedTenantContext(req)) });
  });

  router.put(
    "/provider",
    ...gate,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = upsertEndpoint.body.parse(req.body);
      res.json({
        data: await saveAiProviderConfig(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          body,
        ),
      });
    },
  );

  router.patch(
    "/provider",
    ...gate,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = patchEndpoint.body.parse(req.body);
      res.json({
        data: await patchAiProviderCapabilities(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          body,
        ),
      });
    },
  );

  router.delete("/provider", ...gate, async (req, res) => {
    res.json({
      data: await removeAiProviderConfig(
        getScopedTenantContext(req),
        getAuth(req).user.id,
      ),
    });
  });

  router.post(
    "/provider/test",
    ...gate,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      testEndpoint.body.parse(req.body);
      res.json({
        data: await testAiProviderConnection(getScopedTenantContext(req)),
      });
    },
  );

  return router;
}

export const aiProviderRouter = createAiProviderRouter();
