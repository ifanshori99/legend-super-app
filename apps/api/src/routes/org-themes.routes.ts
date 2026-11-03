// Tenant Theme routes (PRD v1.7 §3 F4 "Whitelabel", TEN-10). Mount at /api/org
// (after orgRouter). The tenant comes from the server-minted context, never the
// request (TEN-02). Activation re-validates contrast on the server (TEN-10) and
// answers 422 THEME_CONTRAST_FAILED with the failing pairs in `details`.

import { Router } from "express";
import { apiErrorBody, brandIdSchema, z } from "@starter/shared/core";
import {
  createThemeDraftInputSchema,
  tenantThemeIdSchema,
  themeTokensSchema,
} from "@starter/shared/platform";
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
  activateTheme,
  checkTheme,
  createThemeDraft,
  listThemes,
  ThemeContrastError,
} from "../services/platform-theme.service.ts";

export const orgThemesRouter = Router();

// Scoped to the theme paths: this router is mounted next to orgRouter on the
// same prefix, so a blanket `use` would also run for the other /api/org paths.
const themeAuth = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireTenantPermission("org.theme.manage"),
];

orgThemesRouter.get("/themes", ...themeAuth, async (req, res) => {
  const query = z.strictObject({ brandId: brandIdSchema }).parse(req.query);
  res.json(await listThemes(getScopedTenantContext(req), query.brandId));
});

orgThemesRouter.post("/themes/check", ...themeAuth, jsonBody, (req, res) => {
  const body = z.strictObject({ tokens: themeTokensSchema }).parse(req.body);
  res.json({ data: checkTheme(body.tokens) });
});

orgThemesRouter.post("/themes", ...themeAuth, jsonBody, async (req, res) => {
  const input = createThemeDraftInputSchema.parse(req.body);
  const theme = await createThemeDraft(
    getScopedTenantContext(req),
    input,
    getAuth(req).user.id,
  );
  res.status(201).location(`/api/org/themes/${theme.id}`).json({ data: theme });
});

orgThemesRouter.post(
  "/themes/:themeId/activate",
  ...themeAuth,
  jsonBody,
  async (req, res) => {
    const themeId = tenantThemeIdSchema.parse(req.params.themeId);
    try {
      res.json({
        data: await activateTheme(
          getScopedTenantContext(req),
          themeId,
          getAuth(req).user.id,
        ),
      });
    } catch (error) {
      if (error instanceof ThemeContrastError)
        return void res.status(error.status).json(
          apiErrorBody(error.code, error.message, {
            details: error.details,
            ...(typeof req.id === "string" ? { requestId: req.id } : {}),
          }),
        );
      throw error;
    }
  },
);
