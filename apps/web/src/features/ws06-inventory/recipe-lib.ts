// Pure helpers for the recipe and production screens (bead legend-w0v; PRD v1.7
// §3 F17 "Resep Bertingkat, Produksi Batch", §6.E, owner decisions Q19/Q20).
// No React and no `@/` alias, so the screens' arithmetic stays easy to test.
//
// The invariants live in the contract (@starter/shared/inventory) and are
// imported, never reimplemented: `grossRecipeQuantity` (waste is a yield loss),
// `recipeLineCostIdr`, `convertQuantity` and `transitionProductionOrder`. This
// file only joins rows for the screens and turns form text into contract input.

import {
  brandIdSchema,
  divideRounded,
  formatDecimal4,
  idr,
  parseDecimal4,
  sumIdr,
  type Decimal4,
  type Idr,
} from "@starter/shared/core";
import {
  convertQuantity,
  grossRecipeQuantity,
  recipeLineCostIdr,
  transitionProductionOrder,
  type InventoryItem,
  type ProductionOrderAction,
  type ProductionOrderStatus,
  type Recipe,
  type RecipeComponentType,
  type UomConversion,
} from "@starter/shared/inventory";
import { decimalFromInput, formatQuantity, quantityFromInput } from "./lib.ts";

/**
 * The brand the inventory back office belongs to.
 *
 * The brand context (session, TEN-02) has not landed yet, so the app runs one
 * brand: the one the shared fixtures describe. The constant is the only thing that
 * changes when the brand context bead lands.
 */
export const RECIPE_BRAND_ID = brandIdSchema.parse(
  "3c9e5a71-2b84-4f6d-8e10-5a7b9c2d4e61",
);

/** The back office lists whole catalogs; screens filter and page in memory. */
export const RECIPE_LIST_LIMIT = 100;

/** Rows per page inside a loaded list (DataTableShell pagination). */
export const RECIPE_PAGE_SIZE = 20;

/** Rounding mode used everywhere the contract takes one. */
export const RECIPE_ROUNDING = "half_up" as const;

// ---- Form <-> contract text -------------------------------------------------

/**
 * Form text for a line's net quantity. `quantityFromInput` accepts the
 * comma separator and grouping, and returns a positive Decimal4 or null.
 */
export function quantityInputValue(value: string): Decimal4 | null {
  return quantityFromInput(value);
}

/**
 * Decimal4 text → the editable form text, without grouping: "150.0000" → "150",
 * "0.0600" → "0.06". The contract text uses a dot decimal, and `decimalFromInput`
 * reads a lone dot as the decimal point, so this round-trips exactly (an id-ID
 * grouped "1.000" would be read as one, not a thousand).
 */
export function decimalInputText(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole : `${whole}.${trimmed}`;
}

/**
 * Waste percent shown in the form (basis points → text): 200 → "2",
 * 250 → "2,5". Basis points have two decimals of a percent.
 */
export function wastePctText(wastePctBp: number): string {
  return formatQuantity(formatDecimal4(BigInt(wastePctBp) * 100n));
}

/**
 * Waste percent form text → basis points (200 = 2%). The contract stores
 * integer basis points below 10,000 (waste is a yield loss, Q19), so a value
 * with more than two decimals or at/above 100% is invalid and returns null.
 * Zero is a valid waste (no yield loss).
 */
export function wastePctFromInput(value: string): number | null {
  const percent = decimalFromInput(value);
  if (percent === null) return null;
  const scaled = parseDecimal4(percent);
  if (scaled < 0n || scaled % 100n !== 0n) return null;
  const basisPoints = Number(scaled / 100n);
  if (!Number.isSafeInteger(basisPoints) || basisPoints >= 10_000) return null;
  return basisPoints;
}

/** Gross quantity drawn from stock for a net line quantity (Q19). */
export function lineGrossQuantity(
  netQuantity: string,
  wastePctBp: number,
): Decimal4 | null {
  const net = quantityInputValue(netQuantity);
  if (net === null || wastePctBp < 0 || wastePctBp >= 10_000) return null;
  return grossRecipeQuantity(net, wastePctBp, RECIPE_ROUNDING);
}

/** NUMERIC(14,4) rupiah → whole rupiah for <Money>. */
export function idrFromDecimal4(value: Decimal4): Idr {
  return idr(
    Number(divideRounded(parseDecimal4(value), 10_000n, RECIPE_ROUNDING)),
  );
}

// ---- BOM line drafts -------------------------------------------------------

/** One editable BOM row. Form text stays text until the user saves. */
export type RecipeLineDraft = {
  key: number;
  componentType: RecipeComponentType;
  componentId: string;
  quantity: string;
  uomId: string;
  wastePct: string;
};

/** Contract-shaped line input, as `createRecipeVersionInputSchema` takes it. */
export type RecipeLineInput = {
  componentType: RecipeComponentType;
  componentId: string;
  quantity: Decimal4;
  uomId: string;
  wastePctBp: number;
};

export function lineDraftsFromDetail(
  lines: {
    componentType: RecipeComponentType;
    componentId: string;
    quantity: string;
    uomId: string;
    wastePctBp: number;
  }[],
): RecipeLineDraft[] {
  return lines.map((line, index) => ({
    key: index,
    componentType: line.componentType,
    componentId: line.componentId,
    quantity: decimalInputText(line.quantity),
    uomId: line.uomId,
    wastePct: wastePctText(line.wastePctBp),
  }));
}

/** Base unit of a component: an item's base UOM or a recipe's yield UOM. */
export function componentBaseUomId(
  componentType: RecipeComponentType,
  componentId: string,
  items: readonly InventoryItem[],
  recipes: readonly Recipe[],
): string | null {
  if (componentType === "item")
    return items.find((item) => item.id === componentId)?.baseUomId ?? null;
  return (
    recipes.find((recipe) => recipe.id === componentId)?.yieldUomId ?? null
  );
}

/**
 * Conversions that apply to a line's component. For an item its own
 * conversions; for a nested recipe the output item's conversions (the recipe
 * yields that item, so its yield unit converts through it).
 */
export function componentConversions(
  componentType: RecipeComponentType,
  componentId: string,
  items: readonly InventoryItem[],
  recipes: readonly Recipe[],
  conversionsByItem: ReadonlyMap<string, readonly UomConversion[]>,
): readonly UomConversion[] {
  if (componentType === "item") return conversionsByItem.get(componentId) ?? [];
  const recipe = recipes.find((row) => row.id === componentId);
  if (!recipe?.outputItemId) return [];
  return conversionsByItem.get(recipe.outputItemId) ?? [];
}

/**
 * The line quantity in the component's base unit, or null when the unit pair
 * has no conversion path yet (the contract throws UOM_CONVERSION_MISSING).
 */
export function lineBaseQuantity(
  line: Pick<
    RecipeLineDraft,
    "componentType" | "componentId" | "quantity" | "uomId"
  >,
  items: readonly InventoryItem[],
  recipes: readonly Recipe[],
  conversionsByItem: ReadonlyMap<string, readonly UomConversion[]>,
): { quantity: Decimal4; uomId: string } | null {
  const quantity = quantityInputValue(line.quantity);
  if (quantity === null || line.uomId === "") return null;
  const baseUomId = componentBaseUomId(
    line.componentType,
    line.componentId,
    items,
    recipes,
  );
  if (baseUomId === null) return null;
  try {
    return {
      quantity: convertQuantity(
        quantity,
        line.uomId,
        baseUomId,
        componentConversions(
          line.componentType,
          line.componentId,
          items,
          recipes,
          conversionsByItem,
        ),
        RECIPE_ROUNDING,
      ),
      uomId: baseUomId,
    };
  } catch {
    return null;
  }
}

export type LineCostContext = {
  items: readonly InventoryItem[];
  recipes: readonly Recipe[];
  conversionsByItem: ReadonlyMap<string, readonly UomConversion[]>;
  /** Moving-average unit cost per item, keyed by inventory item id. */
  unitCosts: ReadonlyMap<string, Decimal4>;
};

/**
 * Cost of one line with the contract helper (INV-02/INV-04): the quantity is
 * converted to the component's base unit, then valued with the line's yield
 * loss. A nested recipe is valued at its stored HPP per yield unit, so the
 * total follows the server-computed cost of the semi-finished item.
 */
export function lineCostIdr(
  line: RecipeLineDraft,
  context: LineCostContext,
): Idr | null {
  const wastePctBp = wastePctFromInput(line.wastePct);
  if (wastePctBp === null) return null;
  if (line.componentId === "") return null;
  const base = lineBaseQuantity(
    line,
    context.items,
    context.recipes,
    context.conversionsByItem,
  );
  if (base === null) return null;

  let unitCostIdr: Decimal4;
  if (line.componentType === "item") {
    const unitCost = context.unitCosts.get(line.componentId);
    if (unitCost === undefined) return null;
    unitCostIdr = unitCost;
  } else {
    const nested = context.recipes.find((row) => row.id === line.componentId);
    if (!nested) return null;
    // A nested recipe's cost is per one yield unit (recipe.theoreticalCostIdr).
    unitCostIdr = nested.theoreticalCostIdr;
  }
  return recipeLineCostIdr(
    { baseQuantity: base.quantity, unitCostIdr, wastePctBp },
    RECIPE_ROUNDING,
  );
}

export type RecipeTotals = {
  /** Sum of every line, whole rupiah for the batch. */
  totalIdr: Idr | null;
  /** HPP per one yield unit at NUMERIC(14,4), null when a line is incomplete. */
  perUnitIdr: Decimal4 | null;
};

/**
 * Live total of the edited lines. Each line goes through `recipeLineCostIdr`
 * (the same helper INV-02 uses), the sum through `sumIdr`, and the per-unit
 * figure through the contract's scaling (HPP is NUMERIC(14,4), PRD §6.E).
 * Null while any line cannot be valued, so the screen never shows a fake 0.
 */
export function recipeTotals(
  lines: readonly RecipeLineDraft[],
  yieldQuantity: string,
  yieldUomId: string,
  context: LineCostContext,
): RecipeTotals {
  const yieldQty = quantityInputValue(yieldQuantity);
  if (yieldQty === null || yieldUomId === "" || lines.length === 0)
    return { totalIdr: null, perUnitIdr: null };
  const costs: Idr[] = [];
  for (const line of lines) {
    const cost = lineCostIdr(line, context);
    if (cost === null) return { totalIdr: null, perUnitIdr: null };
    costs.push(cost);
  }
  const totalIdr = sumIdr(costs);
  const perUnitIdr = formatDecimal4(
    divideRounded(
      BigInt(totalIdr) * 10_000n * 10_000n,
      parseDecimal4(yieldQty),
      RECIPE_ROUNDING,
    ),
  );
  return { totalIdr, perUnitIdr };
}

/**
 * Moving-average unit cost per item across the outlet's locations, the same
 * derivation the shared fixtures use (PRD §16 "Metode Biaya"). Items with no
 * positive balance stay absent, so their lines show "biaya belum tersedia".
 */
export function weightedUnitCosts(
  balances: readonly {
    inventoryItemId: string;
    quantity: string;
    avgCostIdr: string;
  }[],
): Map<string, Decimal4> {
  const totals = new Map<string, { quantity: bigint; value: bigint }>();
  for (const balance of balances) {
    const quantity = parseDecimal4(balance.quantity);
    if (quantity <= 0n) continue;
    const total = totals.get(balance.inventoryItemId) ?? {
      quantity: 0n,
      value: 0n,
    };
    total.quantity += quantity;
    total.value += quantity * parseDecimal4(balance.avgCostIdr);
    totals.set(balance.inventoryItemId, total);
  }
  const costs = new Map<string, Decimal4>();
  for (const [itemId, total] of totals)
    costs.set(
      itemId,
      total.quantity === 0n
        ? formatDecimal4(0n)
        : formatDecimal4(
            divideRounded(total.value, total.quantity, RECIPE_ROUNDING),
          ),
    );
  return costs;
}

/**
 * Builds the contract line input from a draft; null when the form is not a
 * valid contract line (empty component, zero quantity, waste at/above 100%).
 */
export function lineInputFromDraft(
  draft: RecipeLineDraft,
): RecipeLineInput | null {
  const quantity = quantityInputValue(draft.quantity);
  const wastePctBp = wastePctFromInput(draft.wastePct);
  if (
    quantity === null ||
    wastePctBp === null ||
    draft.componentId === "" ||
    draft.uomId === ""
  )
    return null;
  return {
    componentType: draft.componentType,
    componentId: draft.componentId,
    quantity,
    uomId: draft.uomId,
    wastePctBp,
  };
}

// ---- List filters ----------------------------------------------------------

export type RecipeFilter = "all" | "active" | "inactive";

export function recipeMatchesFilter(
  recipe: Pick<Recipe, "isActive">,
  filter: RecipeFilter,
): boolean {
  if (filter === "all") return true;
  return filter === "active" ? recipe.isActive : !recipe.isActive;
}

export function recipeMatchesSearch(
  recipe: Pick<Recipe, "name">,
  outputName: string,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return true;
  return (
    recipe.name.toLocaleLowerCase("id-ID").includes(needle) ||
    outputName.toLocaleLowerCase("id-ID").includes(needle)
  );
}

export type ProductionFilter = "all" | ProductionOrderStatus;

export function productionMatchesFilter(
  order: { status: ProductionOrderStatus },
  filter: ProductionFilter,
): boolean {
  return filter === "all" || order.status === filter;
}

/**
 * Actions the contract state machine allows from `status` (PRD §17 "Produksi
 * Batch"). Asking the contract itself means the screen can never offer an
 * invalid transition (e.g. starting a completed batch).
 */
export function allowedProductionActions(
  status: ProductionOrderStatus,
): ProductionOrderAction[] {
  const actions: ProductionOrderAction[] = [];
  for (const action of ["start", "complete", "cancel"] as const) {
    try {
      transitionProductionOrder(status, action);
      actions.push(action);
    } catch {
      // Not a transition from this status.
    }
  }
  return actions;
}
