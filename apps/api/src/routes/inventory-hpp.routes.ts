// HPP report routes (PRD v1.7 §17; bead legend-2qq): menu costs with gross
// margin, recipe coverage, actual vs theoretical food cost and menu
// engineering. Mount at `/api/inventory` next to the recipe router; paths come
// from `@starter/shared/inventory` (`inventoryEndpoints`).
//
// All four are financial reports and need `recipe.cost.view`. The outlet
// reports take the outlet from the query and require that outlet in the
// caller's role (TEN-03); recipe coverage is brand-owned catalogue data, so
// the route mints the caller's reachable scope (`requireMenuPermission`). The
// services re-check the permission, independent of these gates.

import {
  foodCostQuerySchema,
  menuCostQuerySchema,
  menuEngineeringQuerySchema,
  recipeCoverageQuerySchema,
} from "@starter/shared/inventory";
import { Router, type Request } from "express";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  listFoodCostComparisons,
  listMenuCosts,
  listMenuEngineering,
  listRecipeCoverage,
} from "../services/hpp-report.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);

export function createInventoryHppRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const outletCost = requireOutletPermission("recipe.cost.view", queryOutlet);
  const brandCost = requireMenuPermission("recipe.cost.view");

  router.get("/menu-costs", outletCost, async (req, res) => {
    const query = menuCostQuerySchema.parse(req.query);
    res.json(
      await listMenuCosts(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.get("/food-cost", outletCost, async (req, res) => {
    const query = foodCostQuerySchema.parse(req.query);
    res.json(
      await listFoodCostComparisons(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.get("/menu-engineering", outletCost, async (req, res) => {
    const query = menuEngineeringQuerySchema.parse(req.query);
    res.json(
      await listMenuEngineering(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.get("/recipe-coverage", brandCost, async (req, res) => {
    const query = recipeCoverageQuerySchema.parse(req.query);
    res.json(
      await listRecipeCoverage(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  return router;
}
