import { Router } from "express";
import { tenantIdSchema, z } from "@starter/shared/core";
import { searchTenantAccountsQuerySchema } from "@starter/shared/platform";
import { getAuth } from "../middleware/auth.ts";
import { requireSessionMfa } from "../middleware/identity.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin.ts";
import {
  listTenantOwnersAny,
  searchTenantAccountsAny,
  TenantAccountSearchRateLimitError,
} from "../services/platform-tenant-directory.service.ts";

export const platformTenantDirectoryRouter = Router();
platformTenantDirectoryRouter.use(
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });

platformTenantDirectoryRouter.get(
  "/tenants/:tenantId/owners",
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    const auth = getAuth(req);
    res.json(
      await listTenantOwnersAny({
        tenantId,
        actorUserId: auth.user.id,
        impersonatedBy: auth.session.impersonatedBy ?? null,
      }),
    );
  },
);

platformTenantDirectoryRouter.get(
  "/tenants/:tenantId/accounts",
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    const query = searchTenantAccountsQuerySchema.parse(req.query);
    const auth = getAuth(req);
    try {
      res.json(
        await searchTenantAccountsAny({
          tenantId,
          actorUserId: auth.user.id,
          impersonatedBy: auth.session.impersonatedBy ?? null,
          query,
        }),
      );
    } catch (error) {
      if (error instanceof TenantAccountSearchRateLimitError)
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  },
);
