// Tenant config import (PRD v1.7 §3 F4, TEN-09). Mount at /api/org (after
// orgRouter). The target tenant is the server-minted context, never the request
// (TEN-02): the body has no tenant id and stored templates are not accepted
// (they are shared across tenants), only an uploaded bundle. The tenant admin
// that sees the config screen holds `org.config.export`; import writes, so it
// has its own `org.config.import` permission, separate from export.
// Sections in TENANT_IMPORT_BLOCKED_SECTIONS (access, money, tax, loyalty,
// payroll, facility rules) are refused here with 403 FORBIDDEN, whether named
// in `sections` or present in the bundle; they stay on the platform admin path.

import { Router } from "express";
import { apiErrorBody } from "@starter/shared/core";
import {
  orgEndpoints,
  TENANT_IMPORT_BLOCKED_SECTIONS,
} from "@starter/shared/platform";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { HttpError } from "../lib/http-error.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  ConfigDetailedError,
  importConfig,
} from "../services/tenant-config.service.ts";

export const orgConfigRouter = Router();

function effectiveSections(input: {
  bundle?: unknown;
  sections?: readonly string[];
}): string[] {
  if (input.sections) return [...input.sections];
  const bundle = input.bundle;
  if (typeof bundle !== "object" || bundle === null) return [];
  const sections = (bundle as { sections?: unknown }).sections;
  if (typeof sections !== "object" || sections === null) return [];
  return Object.keys(sections);
}

orgConfigRouter.post(
  "/config/import",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireTenantPermission("org.config.import"),
  jsonBody,
  async (req, res) => {
    const input = orgEndpoints.importConfig.body.parse(req.body);
    const blocked = effectiveSections(input).filter((section) =>
      (TENANT_IMPORT_BLOCKED_SECTIONS as readonly string[]).includes(section),
    );
    if (blocked.length > 0)
      throw new HttpError(
        403,
        "FORBIDDEN",
        `Tenant import cannot apply these sections: ${blocked.join(", ")}. Ask a platform admin to import them.`,
      );
    const context = getScopedTenantContext(req);
    try {
      res.json({
        data: await importConfig(
          context.tenant.tenantId,
          { bundle: input.bundle, sections: input.sections },
          getAuth(req).user.id,
        ),
      });
    } catch (error) {
      if (!(error instanceof ConfigDetailedError)) throw error;
      // The shared error handler drops `details`; these errors carry them.
      res.status(error.status).json(
        apiErrorBody(error.code, error.message, {
          details: error.details,
          ...(typeof req.id === "string" ? { requestId: req.id } : {}),
        }),
      );
    }
  },
);
