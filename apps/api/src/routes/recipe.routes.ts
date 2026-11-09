// Recipe / BOM routes (PRD v1.7 §17 "Resep Bertingkat", §16 "Pemotongan
// Otomatis"; INV-02, KDS-07; bead legend-db6).
//
// Mount at `/api/inventory` next to `inventoryOpsRouter`. Recipe and modifier
// rule paths come from `@starter/shared/inventory` (`inventoryEndpoints`,
// `recipeBomEndpoints`). Recipes are brand-owned: the route mints the caller's
// reachable scope (`requireMenuPermission`) and the service re-checks the
// permission against the recipe's own brand. Modifier rules are tenant-wide
// master data (`requireTenantPermission`). The outlet routes (deduction
// settings, duty meals, deduction list) take the outlet from the path, body or
// query and require that outlet in the caller's role (TEN-03).

import { AccessError } from "@starter/shared/access";
import {
  createRecipeInputSchema,
  createRecipeVersionInputSchema,
  putModifierRecipeRulesInputSchema,
  putOutletDeductionSettingsInputSchema,
  recipeDeductionQuerySchema,
  recipeIdSchema,
  recipeQuerySchema,
  recordDutyMealInputSchema,
} from "@starter/shared/inventory";
import { outletIdSchema, uuidSchema } from "@starter/shared/core";
import { Router, type Request, type RequestHandler } from "express";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  createRecipe,
  createRecipeVersion,
  deactivateRecipe,
  getRecipe,
  listModifierRecipeRules,
  listRecipes,
  putModifierRecipeRules,
} from "../services/recipe.service.ts";
import {
  getOutletDeductionSettings,
  listRecipeDeductions,
  putOutletDeductionSettings,
  recordDutyMeal,
} from "../services/recipe-deduction.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);
const pathOutlet = (req: Request) => String(req.params.outletId);
const bodyOutlet = (req: Request) =>
  String((req.body as { outletId?: unknown } | undefined)?.outletId);

/**
 * Passes when the caller reaches the scope for ANY of the permissions (reading
 * a recipe needs `recipe.manage` or `inventory.stock.view`). The first denial
 * is tried against the next permission; other errors propagate.
 */
function anyMenuPermission(
  ...permissions: Parameters<typeof requireMenuPermission>[0][]
): RequestHandler {
  const gates = permissions.map((permission) =>
    requireMenuPermission(permission),
  );
  return async (req, res, next) => {
    let denial: unknown;
    for (const gate of gates) {
      let passed = false;
      try {
        await gate(req, res, () => {
          passed = true;
        });
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
        denial = error;
      }
      if (passed) return next();
    }
    throw denial;
  };
}

export function createRecipeRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const readRecipes = anyMenuPermission(
    "recipe.manage",
    "inventory.stock.view",
  );
  const writeRecipes = requireMenuPermission("recipe.manage");
  const manageRules = requireTenantPermission("recipe.manage");

  // --------------------------------------------------------------- recipes

  router.get("/recipes", readRecipes, async (req, res) => {
    const query = recipeQuerySchema.parse(req.query);
    res.json(
      await listRecipes(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post("/recipes", jsonBody, writeRecipes, async (req, res) => {
    const input = createRecipeInputSchema.parse(req.body);
    const detail = await createRecipe(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/inventory/recipes/${detail.recipe.id}`)
      .json({ data: detail });
  });

  router.get("/recipes/:recipeId", readRecipes, async (req, res) => {
    const recipeId = recipeIdSchema.parse(req.params.recipeId);
    res.json({
      data: await getRecipe(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        recipeId,
      ),
    });
  });

  router.post(
    "/recipes/:recipeId/versions",
    jsonBody,
    writeRecipes,
    async (req, res) => {
      const recipeId = recipeIdSchema.parse(req.params.recipeId);
      const input = createRecipeVersionInputSchema.parse(req.body);
      const detail = await createRecipeVersion(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        recipeId,
        input,
      );
      res.status(201).json({ data: detail });
    },
  );

  router.post(
    "/recipes/:recipeId/deactivate",
    writeRecipes,
    async (req, res) => {
      const recipeId = recipeIdSchema.parse(req.params.recipeId);
      res.json({
        data: await deactivateRecipe(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          recipeId,
        ),
      });
    },
  );

  // ------------------------------------------------- modifier recipe rules

  router.get(
    "/modifiers/:modifierId/recipe-rules",
    manageRules,
    async (req, res) => {
      const modifierId = uuidSchema.parse(req.params.modifierId);
      res.json({
        data: await listModifierRecipeRules(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          modifierId,
        ),
      });
    },
  );

  router.put(
    "/modifiers/:modifierId/recipe-rules",
    jsonBody,
    manageRules,
    async (req, res) => {
      const modifierId = uuidSchema.parse(req.params.modifierId);
      const input = putModifierRecipeRulesInputSchema.parse(req.body);
      res.json({
        data: await putModifierRecipeRules(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          modifierId,
          input,
        ),
      });
    },
  );

  // ------------------------------------------- auto deduction (per outlet)

  router.get(
    "/outlets/:outletId/deduction-settings",
    requireOutletPermission("inventory.stock.view", pathOutlet),
    async (req, res) => {
      const outletId = outletIdSchema.parse(req.params.outletId);
      res.json({
        data: await getOutletDeductionSettings(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          outletId,
        ),
      });
    },
  );

  router.put(
    "/outlets/:outletId/deduction-settings",
    jsonBody,
    // Same manager-level permission as the tenant deduction mode.
    requireOutletPermission("inventory.adjustment.approve", pathOutlet),
    async (req, res) => {
      const outletId = outletIdSchema.parse(req.params.outletId);
      const input = putOutletDeductionSettingsInputSchema.parse(req.body);
      res.json({
        data: await putOutletDeductionSettings(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          outletId,
          input,
        ),
      });
    },
  );

  router.post(
    "/duty-meals",
    jsonBody,
    requireOutletPermission("inventory.waste.record", bodyOutlet),
    async (req, res) => {
      const input = recordDutyMealInputSchema.parse(req.body);
      const deduction = await recordDutyMeal(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: deduction });
    },
  );

  router.get(
    "/recipe-deductions",
    requireOutletPermission("inventory.stock.view", queryOutlet),
    async (req, res) => {
      const query = recipeDeductionQuerySchema.parse(req.query);
      res.json(
        await listRecipeDeductions(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          query,
        ),
      );
    },
  );

  return router;
}
