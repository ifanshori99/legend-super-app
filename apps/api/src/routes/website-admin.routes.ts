// Staff editor of a brand's public website content (WS-08 F21). Mount at
// /api/website. Same permission as the brand's theme settings
// (`org.theme.manage`, tenant-wide); the tenant comes from the server-minted
// context, never the request (TEN-02).

import { Router } from "express";
import {
  brandWebsiteParamsSchema,
  saveBrandWebsiteInputSchema,
} from "@starter/shared/website";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getBrandWebsiteContent,
  saveBrandWebsiteContent,
} from "../services/public-site.service.ts";

export const websiteAdminRouter = Router();

const websiteAuth = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireTenantPermission("org.theme.manage"),
];

// Contract `getBrandWebsiteContent`.
websiteAdminRouter.get(
  "/brands/:brandId/content",
  ...websiteAuth,
  async (req, res) => {
    const { brandId } = brandWebsiteParamsSchema.parse(req.params);
    res.json({
      data: await getBrandWebsiteContent(getScopedTenantContext(req), brandId),
    });
  },
);

// Contract `saveBrandWebsiteContent`.
websiteAdminRouter.put(
  "/brands/:brandId/content",
  ...websiteAuth,
  jsonBody,
  async (req, res) => {
    const { brandId } = brandWebsiteParamsSchema.parse(req.params);
    const input = saveBrandWebsiteInputSchema.parse(req.body);
    res.json({
      data: await saveBrandWebsiteContent(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        brandId,
        input,
      ),
    });
  },
);
