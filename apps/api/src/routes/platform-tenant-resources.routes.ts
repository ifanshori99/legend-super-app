// U5a / legend-utnll: platform organisation reads use the selected tenant,
// never a host, session tenant, support grant, or client tenant header.
import { Router, type RequestHandler } from "express";
import { platformEndpoints } from "@starter/shared/platform";
import { getAuth } from "../middleware/auth.ts";
import { requireSessionMfa } from "../middleware/identity.ts";
import { noStore } from "../middleware/no-store.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin.ts";
import {
  listPlatformTenantBrandsAny,
  listPlatformTenantLegalEntitiesAny,
  listPlatformTenantOutletsAny,
} from "../services/platform-tenant-resources.service.ts";

export const platformTenantResourcesRouter = Router();

// Attach guards only to owned paths: this router shares /api/platform with
// other routers, whose unmatched paths must retain their own auth chains.
const platformGuards: RequestHandler[] = [
  noStore,
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
];

platformTenantResourcesRouter.get(
  "/tenants/:tenantId/brands",
  ...platformGuards,
  async (req, res) => {
    const { tenantId } = platformEndpoints.listTenantBrands.params.parse(
      req.params,
    );
    res.json(await listPlatformTenantBrandsAny(tenantId, getAuth(req).user.id));
  },
);

platformTenantResourcesRouter.get(
  "/tenants/:tenantId/outlets",
  ...platformGuards,
  async (req, res) => {
    const { tenantId } = platformEndpoints.listTenantOutlets.params.parse(
      req.params,
    );
    const query = platformEndpoints.listTenantOutlets.query.parse(req.query);
    res.json(
      await listPlatformTenantOutletsAny(tenantId, getAuth(req).user.id, query),
    );
  },
);

platformTenantResourcesRouter.get(
  "/tenants/:tenantId/legal-entities",
  ...platformGuards,
  async (req, res) => {
    const { tenantId } = platformEndpoints.listTenantLegalEntities.params.parse(
      req.params,
    );
    res.json(
      await listPlatformTenantLegalEntitiesAny(tenantId, getAuth(req).user.id),
    );
  },
);
