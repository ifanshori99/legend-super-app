// Legal-entity picker for finance screens (legend-bddb). The accounting
// screens need the tenant's entities to scope every report, but the org
// route is `org.structure.manage` (tenant_admin only), so the finance role
// got 403. This route is read with `accounting.journal.view`, tenant-wide
// (TEN-03), tenant from the server-minted context (TEN-02), and returns only
// the columns a finance screen needs (see accountingLegalEntitySchema).
//
// Mounted under /api/accounting next to the other accounting routers.

import { Router } from "express";
import { listLegalEntities } from "@starter/shared/accounting";
import { requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { listAccountingLegalEntities } from "../services/accounting-legal-entities.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";

export function createAccountingLegalEntitiesRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.get(
    route(listLegalEntities.path),
    requireTenantPermission("accounting.journal.view"),
    async (req, res) => {
      res.json({
        data: await listAccountingLegalEntities(getScopedTenantContext(req)),
      });
    },
  );

  return router;
}
