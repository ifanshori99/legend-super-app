// Recipe / BOM explosion engine (bead legend-db6; PRD v1.7 §17 "Resep
// Bertingkat", INV-02): turns what was sold into the gross base-unit stock
// draw. Two layers:
//   1. `explodeRecipeTree`: pure, no database. Walks a loaded recipe book,
//      applies modifier effects, grosses every line up for prep loss
//      (gross = net / (1 - waste), owner Q19) and returns components in the
//      unit the recipe line used.
//   2. DB helpers: `toBaseQuantities` converts to each item's base UOM,
//      `explodeMenuLines` loads menu/variant/modifier recipes and does the
//      whole job for an order, `recipeBomSource` feeds the inventory
//      operation services (production, menu waste).
// All math is bigint Decimal4, half_up, rounded once per line.

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  divideRounded,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  convertQuantity,
  grossRecipeQuantity,
  InventoryError,
  type RecipeComponentType,
  type UomConversion,
} from "@starter/shared/inventory";
import { inventoryItems, uomConversions } from "../db/schema/inventory.ts";
import { itemVariants, menuItems, modifiers } from "../db/schema/menu.ts";
import {
  modifierRecipeRules,
  recipeLines,
  recipes,
} from "../db/schema/recipe.ts";
import {
  ROUNDING_MODE,
  type InventoryRecipeSource,
  type RecipeForStock,
  type Tx,
} from "./inventory-ops.shared.ts";

/** A nested recipe chain deeper than this is treated as a data error. */
export const MAX_RECIPE_DEPTH = 10;

// ---------------------------------------------------------------- pure core

export type RecipeBookLine = {
  componentType: RecipeComponentType;
  componentId: string;
  quantity: Decimal4;
  uomId: string;
  wastePctBp: number;
  /**
   * legend-89zm: stock location this line draws from; null/absent = the outlet
   * sale location (resolved by the caller).
   */
  locationId?: string | null;
};

export type RecipeBookRecipe = {
  id: string;
  isActive: boolean;
  outputItemId: string | null;
  yieldQuantity: Decimal4;
  yieldUomId: string;
  lines: readonly RecipeBookLine[];
};

export type RecipeBook = { recipes: ReadonlyMap<string, RecipeBookRecipe> };

type ComponentRef = {
  componentType: RecipeComponentType;
  componentId: string;
};

/**
 * What one selected modifier does to the base recipe, per sold unit:
 * `recipe` adds a whole add-on recipe (1 portion per unit); `add` adds a
 * component (quantity per 1 sold unit); `remove` drops the matching top-level
 * base line(s); `replace` is remove + add.
 */
export type ModifierEffect =
  | { kind: "recipe"; recipeId: string }
  | { kind: "add"; line: RecipeBookLine }
  | { kind: "remove"; target: ComponentRef }
  | { kind: "replace"; target: ComponentRef; line: RecipeBookLine };

export type ExplodedComponent = {
  itemId: string;
  /** Stock location of the line it came from; null = the sale location. */
  locationId: string | null;
  uomId: string;
  /** Gross quantity (prep loss included) in `uomId`. */
  quantity: Decimal4;
};

export type ExplosionFailureReason =
  "recipe_inactive" | "recipe_error" | "no_recipe";

export type ExplosionOutcome =
  | { ok: true; components: ExplodedComponent[] }
  | { ok: false; reason: ExplosionFailureReason; detail: string };

class ExplosionFailure extends Error {
  readonly reason: ExplosionFailureReason;

  constructor(reason: ExplosionFailureReason, detail: string) {
    super(detail);
    this.name = "ExplosionFailure";
    this.reason = reason;
  }
}

/**
 * Explodes `rootRecipeId` for `multiplier` yield units (the sold quantity of
 * the menu recipe's yield unit) into stock items.
 *
 * - Base lines scale by multiplier / yieldQuantity.
 * - A `recipe` line whose nested recipe has an `outputItemId` draws that
 *   semi-finished item; otherwise it explodes recursively (the line unit
 *   must equal the nested yield unit, else `recipe_error`).
 * - Waste gross-up applies per line at every level.
 * - Depth beyond {@link MAX_RECIPE_DEPTH} and cycles are `recipe_error`.
 */
export function explodeRecipeTree(
  book: RecipeBook,
  rootRecipeId: string,
  multiplier: Decimal4,
  effects: readonly ModifierEffect[],
): ExplosionOutcome {
  try {
    const root = book.recipes.get(rootRecipeId);
    if (!root)
      return {
        ok: false,
        reason: "no_recipe",
        detail: `Recipe ${rootRecipeId} not found.`,
      };
    const factor = parseDecimal4(multiplier);
    const sums = new Map<string, bigint>();
    const add = (
      itemId: string,
      uomId: string,
      quantity: bigint,
      locationId: string | null = null,
    ): void => {
      if (quantity <= 0n) return;
      const key = `${itemId}|${uomId}|${locationId ?? ""}`;
      sums.set(key, (sums.get(key) ?? 0n) + quantity);
    };

    const removed = effects.flatMap((effect) =>
      effect.kind === "remove" || effect.kind === "replace"
        ? [effect.target]
        : [],
    );
    const isRemoved = (line: RecipeBookLine): boolean =>
      removed.some(
        (target) =>
          target.componentType === line.componentType &&
          target.componentId === line.componentId,
      );

    // A root or add-on recipe with an output item draws that item (qty in its
    // yield unit) instead of exploding its lines, same as a nested line.
    // Returns true when it did.
    const drawOutputItem = (recipeId: string, scale: bigint): boolean => {
      const recipe = book.recipes.get(recipeId);
      if (!recipe?.outputItemId) return false;
      if (!recipe.isActive)
        throw new ExplosionFailure(
          "recipe_inactive",
          `Recipe ${recipeId} is inactive.`,
        );
      add(recipe.outputItemId, recipe.yieldUomId, scale);
      return true;
    };

    const walkRecipe = (
      recipeId: string,
      scale: bigint,
      path: readonly string[],
      skip: (line: RecipeBookLine) => boolean,
    ): void => {
      const recipe = book.recipes.get(recipeId);
      if (!recipe)
        throw new ExplosionFailure(
          "recipe_error",
          `Recipe ${recipeId} is missing from the recipe book.`,
        );
      if (!recipe.isActive)
        throw new ExplosionFailure(
          "recipe_inactive",
          `Recipe ${recipeId} is inactive.`,
        );
      if (path.includes(recipeId))
        throw new ExplosionFailure(
          "recipe_error",
          `Recipe cycle: ${[...path, recipeId].join(" -> ")}.`,
        );
      if (path.length >= MAX_RECIPE_DEPTH)
        throw new ExplosionFailure(
          "recipe_error",
          `Recipe nesting is deeper than ${MAX_RECIPE_DEPTH}.`,
        );
      const yieldQuantity = parseDecimal4(recipe.yieldQuantity);
      if (yieldQuantity <= 0n)
        throw new ExplosionFailure(
          "recipe_error",
          `Recipe ${recipeId} yields nothing.`,
        );
      for (const line of recipe.lines) {
        if (skip(line)) continue;
        // Decimal4 x Decimal4 / Decimal4 stays at Decimal4 scale: one rounding.
        const net = divideRounded(
          parseDecimal4(line.quantity) * scale,
          yieldQuantity,
          ROUNDING_MODE,
        );
        drawLine(line, net, [...path, recipeId]);
      }
    };

    // `net` is the line quantity already scaled to what is being made.
    const drawLine = (
      line: RecipeBookLine,
      net: bigint,
      path: readonly string[],
    ): void => {
      const gross = parseDecimal4(
        grossRecipeQuantity(
          formatDecimal4(net),
          line.wastePctBp,
          ROUNDING_MODE,
        ),
      );
      if (line.componentType === "item") {
        add(line.componentId, line.uomId, gross, line.locationId ?? null);
        return;
      }
      const nested = book.recipes.get(line.componentId);
      if (!nested)
        throw new ExplosionFailure(
          "recipe_error",
          `Nested recipe ${line.componentId} is missing from the recipe book.`,
        );
      if (nested.outputItemId) {
        if (!nested.isActive)
          throw new ExplosionFailure(
            "recipe_inactive",
            `Recipe ${nested.id} is inactive.`,
          );
        add(nested.outputItemId, line.uomId, gross, line.locationId ?? null);
        return;
      }
      if (line.uomId !== nested.yieldUomId)
        throw new ExplosionFailure(
          "recipe_error",
          `Nested recipe ${nested.id} is used in a unit other than its yield unit.`,
        );
      walkRecipe(nested.id, gross, path, () => false);
    };

    const rootExploded = !drawOutputItem(rootRecipeId, factor);
    if (rootExploded) walkRecipe(rootRecipeId, factor, [], isRemoved);

    for (const effect of effects) {
      if (effect.kind === "recipe") {
        // One portion of the add-on recipe per sold unit.
        if (!drawOutputItem(effect.recipeId, factor))
          walkRecipe(effect.recipeId, factor, [], () => false);
      } else if (effect.kind === "add" || effect.kind === "replace") {
        // A replace is a no-op unless its target line was in the base recipe.
        if (
          effect.kind === "replace" &&
          !(
            rootExploded &&
            root.lines.some(
              (line) =>
                line.componentType === effect.target.componentType &&
                line.componentId === effect.target.componentId,
            )
          )
        )
          continue;
        // Effect lines are per 1 sold unit: no yield division.
        const net = divideRounded(
          parseDecimal4(effect.line.quantity) * factor,
          10_000n,
          ROUNDING_MODE,
        );
        drawLine(effect.line, net, []);
      }
    }

    const components: ExplodedComponent[] = [];
    for (const [key, quantity] of sums) {
      const [itemId, uomId, location] = key.split("|") as [
        string,
        string,
        string,
      ];
      components.push({
        itemId,
        locationId: location === "" ? null : location,
        uomId,
        quantity: formatDecimal4(quantity),
      });
    }
    return { ok: true, components };
  } catch (error) {
    if (error instanceof ExplosionFailure)
      return { ok: false, reason: error.reason, detail: error.message };
    throw error;
  }
}

// ------------------------------------------------------------- DB: base UOM

/**
 * Converts exploded components to each item's base UOM (stored conversions,
 * `convertQuantity`) and sums them per item. Throws `InventoryError`
 * (`RECIPE_COMPONENT_MISSING`, `UOM_CONVERSION_MISSING`) when an item or a
 * conversion path does not exist.
 */
export async function toBaseQuantities(
  tx: Tx,
  components: readonly ExplodedComponent[],
): Promise<Map<string, Decimal4>> {
  if (components.length === 0) return new Map();
  return sumBaseQuantities(await loadUomContext(tx, components), components);
}

type UomContext = {
  baseUom: ReadonlyMap<string, string>;
  conversions: readonly UomConversion[];
};

/** One read of base UOMs and conversions for every item in `components`. */
async function loadUomContext(
  tx: Tx,
  components: readonly ExplodedComponent[],
): Promise<UomContext> {
  const itemIds = [...new Set(components.map((component) => component.itemId))];
  if (itemIds.length === 0) return { baseUom: new Map(), conversions: [] };
  const items = await tx
    .select({ id: inventoryItems.id, baseUomId: inventoryItems.baseUomId })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, itemIds));
  const conversionRows = await tx
    .select()
    .from(uomConversions)
    .where(inArray(uomConversions.inventoryItemId, itemIds));
  return {
    baseUom: new Map(items.map((item) => [item.id, item.baseUomId])),
    conversions: conversionRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      inventoryItemId: row.inventoryItemId,
      fromUomId: row.fromUomId,
      toUomId: row.toUomId,
      factor: row.factor,
    })) as UomConversion[],
  };
}

function sumBaseQuantities(
  uom: UomContext,
  components: readonly ExplodedComponent[],
): Map<string, Decimal4> {
  const result = new Map<string, bigint>();
  for (const draw of sumBaseDraws(uom, components))
    result.set(
      draw.itemId,
      (result.get(draw.itemId) ?? 0n) + parseDecimal4(draw.quantity),
    );
  return new Map(
    [...result].map(([itemId, scaled]) => [itemId, formatDecimal4(scaled)]),
  );
}

/**
 * One gross base-unit draw of a stock item from one location (null = the
 * outlet sale location, resolved by the caller).
 */
export type LocationDraw = {
  locationId: string | null;
  itemId: string;
  quantity: Decimal4;
};

/** Base-unit quantities per (location, item), converted before summing. */
function sumBaseDraws(
  uom: UomContext,
  components: readonly ExplodedComponent[],
): LocationDraw[] {
  const sums = new Map<
    string,
    { locationId: string | null; itemId: string; scaled: bigint }
  >();
  for (const component of components) {
    const base = uom.baseUom.get(component.itemId);
    if (!base)
      throw new InventoryError(
        "RECIPE_COMPONENT_MISSING",
        `Recipe references missing item ${component.itemId}.`,
      );
    const converted = convertQuantity(
      component.quantity,
      component.uomId,
      base,
      uom.conversions.filter(
        (conversion) => conversion.inventoryItemId === component.itemId,
      ),
      ROUNDING_MODE,
    );
    const key = `${component.locationId ?? ""}|${component.itemId}`;
    const entry = sums.get(key) ?? {
      locationId: component.locationId,
      itemId: component.itemId,
      scaled: 0n,
    };
    entry.scaled += parseDecimal4(converted);
    sums.set(key, entry);
  }
  return [...sums.values()]
    .filter((entry) => entry.scaled > 0n)
    .map((entry) => ({
      locationId: entry.locationId,
      itemId: entry.itemId,
      quantity: formatDecimal4(entry.scaled),
    }));
}

// ----------------------------------------------------------- DB: recipe book

/**
 * Loads `seedIds` and every recipe reachable through `recipe` lines (BFS,
 * one query pair per level, bounded so a corrupt graph cannot loop). Ids that
 * do not exist are simply absent from the book.
 */
async function loadRecipeBook(
  tx: Tx,
  context: ScopedTenantContext,
  seedIds: readonly string[],
): Promise<RecipeBook> {
  const book = new Map<string, RecipeBookRecipe>();
  const seen = new Set<string>();
  let frontier = [...new Set(seedIds)];
  for (
    let level = 0;
    frontier.length > 0 && level <= MAX_RECIPE_DEPTH + 2;
    level++
  ) {
    for (const id of frontier) seen.add(id);
    const headers = await tx
      .select()
      .from(recipes)
      .where(
        and(
          eq(recipes.tenantId, context.tenant.tenantId),
          inArray(recipes.id, frontier),
        ),
      );
    const lineRows = await tx
      .select()
      .from(recipeLines)
      .where(
        and(
          eq(recipeLines.tenantId, context.tenant.tenantId),
          inArray(recipeLines.recipeId, frontier),
        ),
      )
      .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id));
    const linesByRecipe = new Map<string, RecipeBookLine[]>();
    const next = new Set<string>();
    for (const row of lineRows) {
      const list = linesByRecipe.get(row.recipeId) ?? [];
      list.push({
        componentType: row.componentType,
        componentId: row.componentId,
        quantity: row.quantity,
        uomId: row.uomId,
        wastePctBp: row.wastePctBp,
        locationId: row.deductionLocationId,
      });
      linesByRecipe.set(row.recipeId, list);
      if (row.componentType === "recipe" && !seen.has(row.componentId))
        next.add(row.componentId);
    }
    for (const header of headers)
      book.set(header.id, {
        id: header.id,
        isActive: header.isActive,
        outputItemId: header.outputItemId,
        yieldQuantity: header.yieldQuantity,
        yieldUomId: header.yieldUomId,
        lines: linesByRecipe.get(header.id) ?? [],
      });
    frontier = [...next];
  }
  return { recipes: book };
}

// ----------------------------------------------------------- DB: menu lines

export type MenuLineInput = {
  menuItemId: string;
  variantId: string | null;
  modifierIds: readonly string[];
  quantity: number;
};

export type ExplodeMenuOutcome =
  | {
      ok: true;
      /** Gross base-unit quantity per stock item, all lines merged. */
      items: Map<string, Decimal4>;
      /** The same quantities split per stock location (legend-89zm). */
      draws: LocationDraw[];
      /** Menu items skipped because they carry no recipe (retail, service). */
      unmappedMenuItemIds: string[];
    }
  | { ok: false; reason: ExplosionFailureReason; detail: string };

type MenuLineData = {
  itemRecipe: ReadonlyMap<string, string | null>;
  variantRecipe: ReadonlyMap<string, string | null>;
  /** Effects of one modifier selection per sold unit, or an error message. */
  effectsOf: (modifierId: string) => ModifierEffect[] | string;
};

/** Reads the recipes and modifier rules the menu lines point at. */
async function loadMenuLineData(
  tx: Tx,
  context: ScopedTenantContext,
  lines: readonly MenuLineInput[],
): Promise<MenuLineData> {
  const tenantId = context.tenant.tenantId;
  const menuItemIds = [...new Set(lines.map((line) => line.menuItemId))];
  const variantIds = [
    ...new Set(
      lines.flatMap((line) => (line.variantId ? [line.variantId] : [])),
    ),
  ];
  const modifierIds = [...new Set(lines.flatMap((line) => line.modifierIds))];

  const itemRows = menuItemIds.length
    ? await tx
        .select({ id: menuItems.id, recipeId: menuItems.recipeId })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, tenantId),
            inArray(menuItems.id, menuItemIds),
          ),
        )
    : [];
  const variantRows = variantIds.length
    ? await tx
        .select({ id: itemVariants.id, recipeId: itemVariants.recipeId })
        .from(itemVariants)
        .where(
          and(
            eq(itemVariants.tenantId, tenantId),
            inArray(itemVariants.id, variantIds),
          ),
        )
    : [];
  const modifierRows = modifierIds.length
    ? await tx
        .select({ id: modifiers.id, recipeId: modifiers.recipeId })
        .from(modifiers)
        .where(
          and(
            eq(modifiers.tenantId, tenantId),
            inArray(modifiers.id, modifierIds),
          ),
        )
    : [];
  const ruleRows = modifierIds.length
    ? await tx
        .select()
        .from(modifierRecipeRules)
        .where(
          and(
            eq(modifierRecipeRules.tenantId, tenantId),
            inArray(modifierRecipeRules.modifierId, modifierIds),
          ),
        )
        .orderBy(
          asc(modifierRecipeRules.sortOrder),
          asc(modifierRecipeRules.id),
        )
    : [];

  const itemRecipe = new Map(itemRows.map((row) => [row.id, row.recipeId]));
  const variantRecipe = new Map(
    variantRows.map((row) => [row.id, row.recipeId]),
  );
  const modifierRecipe = new Map(
    modifierRows.map((row) => [row.id, row.recipeId]),
  );

  // Effects of one modifier selection, per sold unit.
  const effectsOf = (modifierId: string): ModifierEffect[] | string => {
    const effects: ModifierEffect[] = [];
    const addOnRecipe = modifierRecipe.get(modifierId);
    if (addOnRecipe) effects.push({ kind: "recipe", recipeId: addOnRecipe });
    for (const rule of ruleRows) {
      if (rule.modifierId !== modifierId) continue;
      const target =
        rule.targetComponentType && rule.targetComponentId
          ? {
              componentType: rule.targetComponentType,
              componentId: rule.targetComponentId,
            }
          : null;
      const line =
        rule.componentType && rule.componentId && rule.quantity && rule.uomId
          ? {
              componentType: rule.componentType,
              componentId: rule.componentId,
              quantity: rule.quantity,
              uomId: rule.uomId,
              wastePctBp: rule.wastePctBp,
            }
          : null;
      if (rule.action === "remove" && target)
        effects.push({ kind: "remove", target });
      else if (rule.action === "add" && line)
        effects.push({ kind: "add", line });
      else if (rule.action === "replace" && target && line)
        effects.push({ kind: "replace", target, line });
      else return `Modifier rule ${rule.id} is incomplete for ${rule.action}.`;
    }
    return effects;
  };
  return { itemRecipe, variantRecipe, effectsOf };
}

/**
 * Stock draw of sold menu lines. Recipe of a line = variant recipe, else
 * menu item recipe. Lines with no recipe are left out (and listed in
 * `unmappedMenuItemIds`); the result is `no_recipe` only when no line has
 * one. An inactive or broken recipe fails the whole result so the caller
 * records one skipped deduction instead of a silent partial draw.
 */
export async function explodeMenuLines(
  tx: Tx,
  context: ScopedTenantContext,
  lines: readonly MenuLineInput[],
): Promise<ExplodeMenuOutcome> {
  const { itemRecipe, variantRecipe, effectsOf } = await loadMenuLineData(
    tx,
    context,
    lines,
  );

  const seeds = new Set<string>();
  const planned: {
    menuItemId: string;
    recipeId: string;
    quantity: number;
    effects: ModifierEffect[];
  }[] = [];
  const unmapped: string[] = [];
  for (const line of lines) {
    const recipeId =
      (line.variantId ? variantRecipe.get(line.variantId) : null) ??
      itemRecipe.get(line.menuItemId) ??
      null;
    if (!recipeId) {
      unmapped.push(line.menuItemId);
      continue;
    }
    const effects: ModifierEffect[] = [];
    for (const modifierId of line.modifierIds) {
      const modifierEffects = effectsOf(modifierId);
      if (typeof modifierEffects === "string")
        return { ok: false, reason: "recipe_error", detail: modifierEffects };
      effects.push(...modifierEffects);
    }
    seeds.add(recipeId);
    for (const effect of effects) {
      if (effect.kind === "recipe") seeds.add(effect.recipeId);
      if (effect.kind !== "remove" && effect.kind !== "recipe")
        if (effect.line.componentType === "recipe")
          seeds.add(effect.line.componentId);
    }
    planned.push({
      menuItemId: line.menuItemId,
      recipeId,
      quantity: line.quantity,
      effects,
    });
  }
  if (planned.length === 0)
    return {
      ok: false,
      reason: "no_recipe",
      detail: "No sold line has a recipe.",
    };

  const book = await loadRecipeBook(tx, context, [...seeds]);
  const components: ExplodedComponent[] = [];
  for (const entry of planned) {
    const outcome = explodeRecipeTree(
      book,
      entry.recipeId,
      formatDecimal4(BigInt(entry.quantity) * 10_000n),
      entry.effects,
    );
    if (!outcome.ok) return outcome;
    components.push(...outcome.components);
  }
  try {
    const uom = await loadUomContext(tx, components);
    return {
      ok: true,
      items: sumBaseQuantities(uom, components),
      draws: sumBaseDraws(uom, components),
      unmappedMenuItemIds: unmapped,
    };
  } catch (error) {
    if (error instanceof InventoryError)
      return { ok: false, reason: "recipe_error", detail: error.message };
    throw error;
  }
}

export type ExplodeLineOutcome =
  | {
      ok: true;
      /** Gross base-unit quantity per stock item for this line alone. */
      items: Map<string, Decimal4>;
      /** The same quantities split per stock location (legend-89zm). */
      draws: LocationDraw[];
    }
  | { ok: false; reason: ExplosionFailureReason; detail: string };

/**
 * Like {@link explodeMenuLines} but one outcome per line, aligned with
 * `lines`: a line with no recipe, or with an inactive or broken one, fails on
 * its own and never poisons the other lines. Each line is exploded with its
 * own quantity; reads are shared across the whole call (no per-line queries).
 */
export async function explodeMenuLinesEach(
  tx: Tx,
  context: ScopedTenantContext,
  lines: readonly MenuLineInput[],
): Promise<ExplodeLineOutcome[]> {
  const { itemRecipe, variantRecipe, effectsOf } = await loadMenuLineData(
    tx,
    context,
    lines,
  );

  const seeds = new Set<string>();
  const planned = new Map<
    number,
    { recipeId: string; effects: ModifierEffect[] }
  >();
  const outcomes: (ExplodeLineOutcome | null)[] = lines.map(() => null);
  lines.forEach((line, index) => {
    const recipeId =
      (line.variantId ? variantRecipe.get(line.variantId) : null) ??
      itemRecipe.get(line.menuItemId) ??
      null;
    if (!recipeId) {
      outcomes[index] = {
        ok: false,
        reason: "no_recipe",
        detail: "Line has no recipe.",
      };
      return;
    }
    const effects: ModifierEffect[] = [];
    for (const modifierId of line.modifierIds) {
      const modifierEffects = effectsOf(modifierId);
      if (typeof modifierEffects === "string") {
        outcomes[index] = {
          ok: false,
          reason: "recipe_error",
          detail: modifierEffects,
        };
        return;
      }
      effects.push(...modifierEffects);
    }
    seeds.add(recipeId);
    for (const effect of effects) {
      if (effect.kind === "recipe") seeds.add(effect.recipeId);
      if (effect.kind !== "remove" && effect.kind !== "recipe")
        if (effect.line.componentType === "recipe")
          seeds.add(effect.line.componentId);
    }
    planned.set(index, { recipeId, effects });
  });
  if (planned.size === 0) return outcomes as ExplodeLineOutcome[];

  const book = await loadRecipeBook(tx, context, [...seeds]);
  const exploded = new Map<number, ExplodedComponent[]>();
  for (const [index, entry] of planned) {
    const outcome = explodeRecipeTree(
      book,
      entry.recipeId,
      formatDecimal4(BigInt(lines[index]!.quantity) * 10_000n),
      entry.effects,
    );
    if (outcome.ok) exploded.set(index, outcome.components);
    else outcomes[index] = outcome;
  }
  const uom = await loadUomContext(tx, [...exploded.values()].flat());
  for (const [index, components] of exploded) {
    try {
      outcomes[index] = {
        ok: true,
        items: sumBaseQuantities(uom, components),
        draws: sumBaseDraws(uom, components),
      };
    } catch (error) {
      if (!(error instanceof InventoryError)) throw error;
      outcomes[index] = {
        ok: false,
        reason: "recipe_error",
        detail: error.message,
      };
    }
  }
  return outcomes as ExplodeLineOutcome[];
}

// ------------------------------------------------------ inventory-ops port

async function loadRecipeForStock(
  tx: Tx,
  context: ScopedTenantContext,
  recipeId: string,
): Promise<RecipeForStock | null> {
  const tenantId = context.tenant.tenantId;
  const [header] = await tx
    .select()
    .from(recipes)
    .where(and(eq(recipes.tenantId, tenantId), eq(recipes.id, recipeId)))
    .limit(1);
  if (!header) return null;
  const lineRows = await tx
    .select()
    .from(recipeLines)
    .where(
      and(
        eq(recipeLines.tenantId, tenantId),
        eq(recipeLines.recipeId, recipeId),
      ),
    )
    .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id));
  const nestedIds = [
    ...new Set(
      lineRows
        .filter((line) => line.componentType === "recipe")
        .map((line) => line.componentId),
    ),
  ];
  const nestedRows = nestedIds.length
    ? await tx
        .select({ id: recipes.id, outputItemId: recipes.outputItemId })
        .from(recipes)
        .where(
          and(eq(recipes.tenantId, tenantId), inArray(recipes.id, nestedIds)),
        )
    : [];
  const nestedOutputItemIds = new Map<string, string | null>(
    nestedRows.map((row) => [row.id, row.outputItemId]),
  );
  return {
    recipeId: header.id,
    isActive: header.isActive,
    outputItemId: header.outputItemId,
    yieldQuantity: header.yieldQuantity,
    yieldUomId: header.yieldUomId,
    lines: lineRows.map((line) => ({
      componentType: line.componentType,
      componentId: line.componentId,
      quantity: line.quantity,
      uomId: line.uomId,
      wastePctBp: line.wastePctBp,
    })),
    nestedOutputItemIds,
  };
}

/** DB-backed recipe source for the inventory operation services. */
export const recipeBomSource: InventoryRecipeSource = {
  loadRecipe: loadRecipeForStock,
  async loadMenuItemRecipe(tx, context, menuItemId) {
    const [row] = await tx
      .select({ recipeId: menuItems.recipeId })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.id, menuItemId),
        ),
      )
      .limit(1);
    if (!row?.recipeId) return null;
    return loadRecipeForStock(tx, context, row.recipeId);
  },
};
