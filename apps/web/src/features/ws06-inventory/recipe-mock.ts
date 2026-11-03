// Mock mode for recipes and production batches (bead legend-w0v; PRD v1.7 §3
// F17 "Resep Bertingkat, Produksi Batch", §6.E). Serves and mutates the shared
// Cafe Legend inventory fixtures, so the screens work with VITE_API_MOCK=true
// and the Playwright spec covers the happy path (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: strict input parsing is done by the mock
// runtime, document creates are idempotent by the Idempotency-Key header, the
// production state machine is the contract's (`transitionProductionOrder`), and
// the theoretical HPP is recomputed with `theoreticalRecipeCost` (INV-02/04).
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  extendCostIdr,
  formatDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  cafeLegendInventoryFixtures,
  createProductionOrder,
  createRecipe,
  createRecipeVersion,
  getRecipe,
  listProductionOrders,
  listRecipes,
  postProductionOrderTransition,
  productionOrderSchema,
  recipeLineSchema,
  recipeSchema,
  theoreticalRecipeCost,
  transitionProductionOrder,
  type ProductionOrder,
  type Recipe,
  type RecipeComponentType,
  type RecipeCostBook,
  type RecipeLine,
} from "@starter/shared/inventory";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { weightedUnitCosts } from "./recipe-lib.ts";

const fixtures = cafeLegendInventoryFixtures;
const tenantId = fixtures.recipes[0].tenantId;
const brandId = fixtures.recipes[0].brandId;
const fixtureOutletId = fixtures.locations[0].outletId;
const fixtureUserId = fixtures.recipes[0].updatedBy;

type RecipeState = {
  recipes: Recipe[];
  lines: RecipeLine[];
  productionOrders: ProductionOrder[];
};

function seedState(): RecipeState {
  const seeded = structuredClone(fixtures);
  return {
    recipes: seeded.recipes,
    lines: seeded.recipeLines,
    productionOrders: seeded.productionOrders,
  };
}

const store = createMockStore<RecipeState>(seedState);
/** Idempotency for creates: key → the document the first request minted. */
const documents = createMockStore(() => new Map<string, unknown>());

const state = () => store.get();
const now = () => new Date().toISOString();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function invalid(field: string, message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, [{ field, message }]);
}

/**
 * Creates a document once per idempotency key, like the API will. The caller
 * forwards its key in the header; the body key is the same value, and the
 * fallback keeps a handler callable without the transport header in tests.
 */
function once<T>(
  scope: string,
  keys: (string | undefined)[],
  create: () => T,
): T {
  const key = keys.find((value) => value !== undefined && value !== "");
  if (key === undefined) return create();
  const id = `${scope}:${key}`;
  const seen = documents.get().get(id);
  if (seen !== undefined) return seen as T;
  const value = create();
  documents.get().set(id, value);
  return value;
}

function requireRecipe(recipeId: string): Recipe {
  const recipe = state().recipes.find((row) => row.id === recipeId);
  return recipe ?? notFound("Resep");
}

function requireItem(componentId: string) {
  const item = fixtures.items.find((row) => row.id === componentId);
  return item ?? null;
}

function requireComponent(
  componentType: RecipeComponentType,
  componentId: string,
): void {
  if (componentType === "item") {
    if (!requireItem(componentId))
      invalid("componentId", "Item bahan tidak ditemukan.");
    return;
  }
  if (!state().recipes.some((row) => row.id === componentId))
    invalid("componentId", "Resep komponen tidak ditemukan.");
}

/**
 * The current cost book: moving-average costs from the fixtures' balances,
 * then each semi-finished recipe's HPP for output items that have no balance
 * yet (a freshly created semi-finished recipe). Resolving in passes handles a
 * nested recipe that only becomes costable once its own component is resolved.
 */
function costBook(current: RecipeState): RecipeCostBook {
  const unitCosts = weightedUnitCosts(fixtures.balances);
  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of current.recipes) {
      if (!recipe.outputItemId) continue;
      if (unitCosts.has(recipe.outputItemId)) continue;
      try {
        const cost = theoreticalRecipeCost(
          {
            recipes: current.recipes,
            recipeLines: current.lines,
            items: fixtures.items,
            conversions: fixtures.uomConversions,
            unitCosts,
          },
          recipe.id,
          "half_up",
        );
        unitCosts.set(recipe.outputItemId, cost.unitCostIdr);
        changed = true;
      } catch {
        // A dependency is still missing; try again after the next pass.
      }
    }
  }
  return {
    recipes: current.recipes,
    recipeLines: current.lines,
    items: fixtures.items,
    conversions: fixtures.uomConversions,
    unitCosts,
  };
}

/** HPP per yield unit, or zero while a component has no cost yet. */
function theoreticalUnitCost(current: RecipeState, recipeId: string): Decimal4 {
  try {
    return theoreticalRecipeCost(costBook(current), recipeId, "half_up")
      .unitCostIdr;
  } catch {
    return formatDecimal4(0n);
  }
}

function lineRows(
  recipeId: string,
  lines: {
    componentType: RecipeComponentType;
    componentId: string;
    quantity: string;
    uomId: string;
    wastePctBp: number;
  }[],
): RecipeLine[] {
  return lines.map((line) =>
    recipeLineSchema.parse({
      id: newIdempotencyKey(),
      tenantId,
      recipeId,
      componentType: line.componentType,
      componentId: line.componentId,
      quantity: line.quantity,
      uomId: line.uomId,
      wastePctBp: line.wastePctBp,
    }),
  );
}

// ---- Recipes -------------------------------------------------------------

registerMock(listRecipes, ({ query, scenario }) => {
  const rows = state()
    .recipes.filter(
      (row) => query.brandId === undefined || row.brandId === query.brandId,
    )
    .filter(
      (row) =>
        query.outputItemId === undefined ||
        row.outputItemId === query.outputItemId,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getRecipe, ({ params, scenario }) => {
  // The "empty" scenario has no recipes, so the editor shows its not-found
  // state instead of an empty BOM.
  if (scenario === "empty") notFound("Resep");
  const recipe = requireRecipe(params.recipeId);
  return {
    data: {
      recipe,
      lines: state().lines.filter((line) => line.recipeId === recipe.id),
    },
  };
});

registerMock(createRecipe, ({ body, headers }) => {
  const detail = once(
    "recipe",
    [headers?.["Idempotency-Key"], body.idempotencyKey],
    () => {
      if (body.brandId !== brandId) invalid("brandId", "Brand tidak dikenal.");
      if (body.outputItemId !== null && body.outputItemId !== undefined) {
        const output = requireItem(body.outputItemId);
        if (!output) invalid("outputItemId", "Item keluaran tidak ditemukan.");
        // PRD §17 "Resep Bertingkat": a recipe output is a semi-finished item.
        if (output.type !== "semi_finished")
          invalid("outputItemId", "Item keluaran harus bahan setengah jadi.");
      }
      for (const line of body.lines)
        requireComponent(line.componentType, line.componentId);

      const id = newIdempotencyKey();
      const recipe = recipeSchema.parse({
        id,
        tenantId,
        brandId,
        name: body.name,
        outputItemId: body.outputItemId ?? null,
        yieldQuantity: body.yieldQuantity,
        yieldUomId: body.yieldUomId,
        version: 1,
        isActive: true,
        theoreticalCostIdr: "0.0000",
        updatedBy: fixtureUserId,
        updatedAt: now(),
      });
      const lines = lineRows(recipe.id, body.lines);
      const created: { recipe: Recipe; lines: RecipeLine[] } = {
        recipe: {
          ...recipe,
          theoreticalCostIdr: theoreticalUnitCost(
            {
              ...state(),
              recipes: [...state().recipes, recipe],
              lines: [...state().lines, ...lines],
            },
            recipe.id,
          ),
        },
        lines,
      };
      store.set({
        ...state(),
        recipes: [...state().recipes, created.recipe],
        lines: [...state().lines, ...created.lines],
      });
      return created;
    },
  );
  return { data: detail };
});

registerMock(createRecipeVersion, ({ params, body, headers }) => {
  const detail = once(
    `recipe-version:${params.recipeId}`,
    [headers?.["Idempotency-Key"], body.idempotencyKey],
    () => {
      const current = requireRecipe(params.recipeId);
      for (const line of body.lines) {
        // The line contract forbids a recipe containing itself; the API
        // rejects it, so the mock must too.
        if (line.componentType === "recipe" && line.componentId === current.id)
          invalid("componentId", "Resep tidak boleh memakai dirinya sendiri.");
        requireComponent(line.componentType, line.componentId);
      }
      const lines = lineRows(current.id, body.lines);
      const next = recipeSchema.parse({
        ...current,
        name: body.name ?? current.name,
        yieldQuantity: body.yieldQuantity ?? current.yieldQuantity,
        yieldUomId: body.yieldUomId ?? current.yieldUomId,
        version: current.version + 1,
        updatedBy: fixtureUserId,
        updatedAt: now(),
        theoreticalCostIdr: "0.0000",
      });
      const recipes = state().recipes.map((row) =>
        row.id === next.id ? next : row,
      );
      const keptLines = state().lines.filter(
        (line) => line.recipeId !== current.id,
      );
      const allLines = [...keptLines, ...lines];
      const costed: Recipe = {
        ...next,
        theoreticalCostIdr: theoreticalUnitCost(
          { ...state(), recipes, lines: allLines },
          next.id,
        ),
      };
      store.set({
        ...state(),
        recipes: recipes.map((row) => (row.id === costed.id ? costed : row)),
        lines: allLines,
      });
      return { recipe: costed, lines };
    },
  );
  return { data: detail };
});

// ---- Production batches --------------------------------------------------

registerMock(listProductionOrders, ({ query, scenario }) => {
  const rows = state()
    .productionOrders.filter((row) => row.outletId === query.outletId)
    .filter(
      (row) => query.recipeId === undefined || row.recipeId === query.recipeId,
    )
    .filter((row) => query.status === undefined || row.status === query.status)
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(createProductionOrder, ({ body, headers }) => {
  const order = once(
    "production-order",
    [headers?.["Idempotency-Key"], body.idempotencyKey],
    () => {
      if (body.outletId !== fixtureOutletId)
        invalid("outletId", "Outlet tidak dikenal.");
      requireRecipe(body.recipeId);
      const created = productionOrderSchema.parse({
        id: newIdempotencyKey(),
        tenantId,
        outletId: body.outletId,
        recipeId: body.recipeId,
        plannedQty: body.plannedQty,
        actualQty: null,
        status: "draft",
        costIdr: null,
        createdAt: now(),
        completedAt: null,
      });
      store.set({
        ...state(),
        productionOrders: [created, ...state().productionOrders],
      });
      return created;
    },
  );
  return { data: order };
});

registerMock(postProductionOrderTransition, ({ params, body, headers }) => {
  const order = once(
    `production-transition:${params.productionOrderId}`,
    [headers?.["Idempotency-Key"], body.idempotencyKey],
    () => {
      const current = state().productionOrders.find(
        (row) => row.id === params.productionOrderId,
      );
      if (!current) notFound("Perintah produksi");
      const status = transitionProductionOrder(current.status, body.action);
      if (body.action === "complete" && body.actualQty === undefined)
        invalid("actualQty", "Hasil aktual wajib diisi saat menyelesaikan.");
      const recipe = requireRecipe(current.recipeId);
      const unitCost = theoreticalUnitCost(state(), recipe.id);
      const next = productionOrderSchema.parse({
        ...current,
        status,
        actualQty:
          body.action === "complete"
            ? (body.actualQty ?? null)
            : current.actualQty,
        // A completed batch carries its whole-rupiah cost (PRD §17 "Produksi
        // Batch"); the value is actual output x the recipe's HPP per unit.
        costIdr:
          body.action === "complete"
            ? extendCostIdr(
                body.actualQty ?? formatDecimal4(0n),
                unitCost,
                "half_up",
              )
            : current.costIdr,
        completedAt: body.action === "complete" ? now() : null,
      });
      store.set({
        ...state(),
        productionOrders: state().productionOrders.map((row) =>
          row.id === next.id ? next : row,
        ),
      });
      return next;
    },
  );
  return { data: order };
});
