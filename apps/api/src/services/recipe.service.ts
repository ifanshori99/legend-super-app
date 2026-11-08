// Recipe / BOM master data (PRD v1.7 §17 "Resep Bertingkat", §6 E `recipes`,
// `recipe_lines`; INV-02; bead legend-db6).
//
// - A recipe belongs to a brand. Reading needs `recipe.manage` or
//   `inventory.stock.view` (tenant, the brand, or any outlet of the brand);
//   writing needs `recipe.manage` on the brand. `theoreticalCostIdr` is
//   financial data: masked to 0 without `recipe.cost.view`.
// - A new version (POST versions) replaces the lines, version + 1. Every
//   component must exist in the tenant, a nested recipe must be measured in its
//   own yield unit, an item line must convert to the item base unit, and the
//   nested-recipe graph stays acyclic (checked through the DB under a tenant
//   advisory lock so two concurrent writes cannot close a loop).
// - Modifier recipe rules (add / replace / remove) are tenant-wide master data
//   next to the modifier catalogue, so they need `recipe.manage` over the tenant.
// - Every write is audited (`auditSetupChange`); create is idempotent per key.

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  convertQuantity,
  InventoryError,
  recipeDetailSchema,
  recipeLineSchema,
  recipeSchema,
  modifierRecipeRuleSchema,
  type createRecipeInputSchema,
  type ModifierRecipeRule,
  type PutModifierRecipeRulesInput,
  type recipeQuerySchema,
  type RecipeDetail,
  type Recipe,
  type UomConversion,
  type createRecipeVersionInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  inventoryItems,
  uomConversions,
  uoms,
} from "../db/schema/inventory.ts";
import { modifiers } from "../db/schema/menu.ts";
import { brands, outlets } from "../db/schema/platform-org.ts";
import {
  modifierRecipeRules,
  recipeLines,
  recipes,
} from "../db/schema/recipe.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  cursorKeys,
  ROUNDING_MODE,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  auditSetupChange,
  findIdempotentResource,
  rememberIdempotentResource,
  setupFingerprint,
} from "./inventory-setup.service.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

export type CreateRecipeInput = z.infer<typeof createRecipeInputSchema>;
export type CreateRecipeVersionInput = z.infer<
  typeof createRecipeVersionInputSchema
>;
export type RecipeListQuery = z.infer<typeof recipeQuerySchema>;

type RecipeRow = typeof recipes.$inferSelect;
type RecipeLineRow = typeof recipeLines.$inferSelect;
type RuleRow = typeof modifierRecipeRules.$inferSelect;
type LineInput = CreateRecipeInput["lines"][number];
/** Header + lines a write validates and stores. */
type UpdateRecipeBody = {
  name: string;
  outputItemId: string | null;
  yieldQuantity: Decimal4;
  yieldUomId: string;
  lines: readonly LineInput[];
};

const CREATE_OPERATION = "recipe.create";
const VERSION_OPERATION = "recipe.version";
const RECIPE_AUDIT_FIELDS = [
  "brandId",
  "name",
  "outputItemId",
  "yieldQuantity",
  "yieldUomId",
  "version",
  "isActive",
  "lineCount",
] as const;
/** Version audits also keep the lines (old version stays readable). */
const VERSION_AUDIT_FIELDS = [
  ...RECIPE_AUDIT_FIELDS,
  "lines",
  "componentType",
  "componentId",
  "quantity",
  "uomId",
  "wastePctBp",
  "changeNote",
] as const;
const RULES_AUDIT_FIELDS = ["modifierId", "ruleCount"] as const;
const MAX_NESTING_DEPTH = 10;

// --------------------------------------------------------------- access

/**
 * Permission lookups over one open transaction. `reaches` answers a read
 * question (tenant, the brand, or any outlet of the brand, TEN-03); `manages`
 * is the write rule (the brand or the whole tenant).
 */
async function loadAccess(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
) {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  const outletRows = await tx
    .select({ id: outlets.id, brandId: outlets.brandId })
    .from(outlets)
    .where(eq(outlets.tenantId, context.tenant.tenantId));
  const reaches = (permission: PermissionCode, brandId: string): boolean =>
    snapshot.allows(permission, { type: "tenant" }) ||
    snapshot.allows(permission, { type: "brand", id: brandId }) ||
    outletRows.some(
      (outlet) =>
        outlet.brandId === brandId &&
        snapshot.allows(permission, { type: "outlet", id: outlet.id }),
    );
  const manages = (brandId: string): boolean =>
    snapshot.allows("recipe.manage", { type: "tenant" }) ||
    snapshot.allows("recipe.manage", { type: "brand", id: brandId });
  const canRead = (brandId: string): boolean =>
    reaches("recipe.manage", brandId) ||
    reaches("inventory.stock.view", brandId);
  return { snapshot, reaches, manages, canRead };
}

type Access = Awaited<ReturnType<typeof loadAccess>>;

function denied(message: string): AccessError {
  return new AccessError("PERMISSION_DENIED", message);
}

const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} not found.`);

const invalid = (code: string, message: string) =>
  new HttpError(422, code, message);

// -------------------------------------------------------------- mapping

const decimalZero = formatDecimal4(0n);

function toRecipe(row: RecipeRow, withCost: boolean): Recipe {
  return recipeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    name: row.name,
    outputItemId: row.outputItemId,
    yieldQuantity: row.yieldQuantity,
    yieldUomId: row.yieldUomId,
    version: row.version,
    isActive: row.isActive,
    theoreticalCostIdr: withCost ? row.theoreticalCostIdr : decimalZero,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toRecipeLine(row: RecipeLineRow) {
  return recipeLineSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    recipeId: row.recipeId,
    componentType: row.componentType,
    componentId: row.componentId,
    quantity: row.quantity,
    uomId: row.uomId,
    wastePctBp: row.wastePctBp,
  });
}

function toRule(row: RuleRow): ModifierRecipeRule {
  return modifierRecipeRuleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    modifierId: row.modifierId,
    action: row.action,
    targetComponentType: row.targetComponentType,
    targetComponentId: row.targetComponentId,
    componentType: row.componentType,
    componentId: row.componentId,
    quantity: row.quantity,
    uomId: row.uomId,
    wastePctBp: row.wastePctBp,
  });
}

async function loadDetail(
  tx: Tx,
  recipeId: string,
  access: Access,
  forUpdate = false,
): Promise<{ row: RecipeRow; detail: RecipeDetail }> {
  const query = tx.select().from(recipes).where(eq(recipes.id, recipeId));
  const [row] = await (forUpdate ? query.for("update") : query);
  if (!row || !access.canRead(row.brandId)) throw notFound("Recipe");
  const lines = await tx
    .select()
    .from(recipeLines)
    .where(eq(recipeLines.recipeId, recipeId))
    .orderBy(asc(recipeLines.sortOrder), asc(recipeLines.id));
  return {
    row,
    detail: recipeDetailSchema.parse({
      recipe: toRecipe(row, access.reaches("recipe.cost.view", row.brandId)),
      lines: lines.map(toRecipeLine),
    }),
  };
}

function auditLines(lines: readonly z.infer<typeof recipeLineSchema>[]) {
  return lines.map((line) => ({
    componentType: line.componentType,
    componentId: line.componentId,
    quantity: line.quantity,
    uomId: line.uomId,
    wastePctBp: line.wastePctBp,
  }));
}

/** Lines as sent, canonical decimals, for the idempotency fingerprint. */
function canonicalLines(lines: readonly LineInput[]) {
  return lines.map((line) => [
    line.componentType,
    line.componentId,
    formatDecimal4(parseDecimal4(line.quantity)),
    line.uomId,
    line.wastePctBp,
  ]);
}

function auditView(recipe: Recipe, lineCount: number) {
  return {
    brandId: recipe.brandId,
    name: recipe.name,
    outputItemId: recipe.outputItemId,
    yieldQuantity: recipe.yieldQuantity,
    yieldUomId: recipe.yieldUomId,
    version: recipe.version,
    isActive: recipe.isActive,
    lineCount,
  };
}

/** Serialises BOM writes of one tenant so two edits cannot close a loop. */
async function lockRecipeGraph(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recipe:graph:${tenantId}`}, 0))`,
  );
}

// ----------------------------------------------------------- validation

type ComponentRef = {
  componentType: "item" | "recipe";
  componentId: string;
  /** Unit the quantity is measured in; null = existence check only. */
  uomId: string | null;
  path: string;
};

/**
 * Components exist in the tenant, nested recipes are measured in their own
 * yield unit, item lines convert to the item base unit and every unit exists.
 */
async function validateComponents(
  tx: Tx,
  refs: readonly ComponentRef[],
  extraUomIds: readonly string[] = [],
): Promise<void> {
  const itemIds = [
    ...new Set(
      refs
        .filter((ref) => ref.componentType === "item")
        .map((r) => r.componentId),
    ),
  ];
  const recipeIds = [
    ...new Set(
      refs
        .filter((ref) => ref.componentType === "recipe")
        .map((ref) => ref.componentId),
    ),
  ];
  const uomIds = [
    ...new Set([
      ...extraUomIds,
      ...refs.flatMap((ref) => (ref.uomId ? [ref.uomId] : [])),
    ]),
  ];
  const [items, nested, units] = await Promise.all([
    itemIds.length
      ? tx
          .select({
            id: inventoryItems.id,
            baseUomId: inventoryItems.baseUomId,
            isActive: inventoryItems.isActive,
          })
          .from(inventoryItems)
          .where(inArray(inventoryItems.id, itemIds))
      : [],
    recipeIds.length
      ? tx
          .select({
            id: recipes.id,
            yieldUomId: recipes.yieldUomId,
            isActive: recipes.isActive,
          })
          .from(recipes)
          .where(inArray(recipes.id, recipeIds))
      : [],
    uomIds.length
      ? tx.select({ id: uoms.id }).from(uoms).where(inArray(uoms.id, uomIds))
      : [],
  ]);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const recipeById = new Map(nested.map((recipe) => [recipe.id, recipe]));
  const knownUoms = new Set(units.map((unit) => unit.id));
  for (const uomId of uomIds)
    if (!knownUoms.has(uomId))
      throw invalid("VALIDATION_ERROR", `Unit ${uomId} does not exist.`);

  const conversionRows = itemIds.length
    ? await tx
        .select()
        .from(uomConversions)
        .where(inArray(uomConversions.inventoryItemId, itemIds))
    : [];
  const conversions = conversionRows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    inventoryItemId: row.inventoryItemId,
    fromUomId: row.fromUomId,
    toUomId: row.toUomId,
    factor: row.factor,
  })) as UomConversion[];

  for (const ref of refs) {
    if (ref.componentType === "item") {
      const item = itemById.get(ref.componentId);
      if (!item)
        throw invalid(
          "RECIPE_COMPONENT_MISSING",
          `${ref.path}: inventory item ${ref.componentId} does not exist.`,
        );
      if (!item.isActive)
        throw invalid(
          "VALIDATION_ERROR",
          `${ref.path}: inventory item ${ref.componentId} is inactive.`,
        );
      if (ref.uomId)
        try {
          convertQuantity(
            formatDecimal4(10_000n),
            ref.uomId,
            item.baseUomId,
            conversions.filter(
              (conversion) => conversion.inventoryItemId === item.id,
            ),
            ROUNDING_MODE,
          );
        } catch (error) {
          if (!(error instanceof InventoryError)) throw error;
          throw invalid(
            "UOM_CONVERSION_MISSING",
            `${ref.path}: the unit does not convert to the item base unit.`,
          );
        }
    } else {
      const nestedRecipe = recipeById.get(ref.componentId);
      if (!nestedRecipe)
        throw invalid(
          "RECIPE_COMPONENT_MISSING",
          `${ref.path}: recipe ${ref.componentId} does not exist.`,
        );
      if (!nestedRecipe.isActive)
        throw invalid(
          "VALIDATION_ERROR",
          `${ref.path}: recipe ${ref.componentId} is inactive.`,
        );
      if (ref.uomId && ref.uomId !== nestedRecipe.yieldUomId)
        throw invalid(
          "RECIPE_UOM_MISMATCH",
          `${ref.path}: a nested recipe must be measured in its own yield unit.`,
        );
    }
  }
}

/** Every recipe -> nested recipe edge except those of `recipeId` itself. */
async function nestedEdges(tx: Tx, recipeId: string) {
  return tx
    .select({
      recipeId: recipeLines.recipeId,
      componentId: recipeLines.componentId,
    })
    .from(recipeLines)
    .where(
      and(
        eq(recipeLines.componentType, "recipe"),
        sql`${recipeLines.recipeId} <> ${recipeId}::uuid`,
      ),
    );
}

/** `recipeId` may not be reachable from any of its new nested components. */
async function assertAcyclic(
  tx: Tx,
  recipeId: string,
  nestedIds: readonly string[],
): Promise<void> {
  if (nestedIds.includes(recipeId))
    throw invalid("RECIPE_CYCLE", "A recipe cannot contain itself.");
  if (nestedIds.length === 0) return;
  // Every nested edge except those of the recipe being replaced.
  const edges = await nestedEdges(tx, recipeId);
  const children = new Map<string, string[]>();
  for (const edge of edges)
    children.set(edge.recipeId, [
      ...(children.get(edge.recipeId) ?? []),
      edge.componentId,
    ]);
  const seen = new Set<string>();
  const stack = [...nestedIds];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === recipeId)
      throw invalid(
        "RECIPE_CYCLE",
        "These components would make the recipe contain itself.",
      );
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(children.get(current) ?? []));
  }
}

/** Nesting deeper than the stock engine explodes is rejected up front. */
async function assertDepth(
  tx: Tx,
  recipeId: string,
  nestedIds: readonly string[],
): Promise<void> {
  if (nestedIds.length === 0) return;
  const edges = await nestedEdges(tx, recipeId);
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    children.set(edge.recipeId, [
      ...(children.get(edge.recipeId) ?? []),
      edge.componentId,
    ]);
    parents.set(edge.componentId, [
      ...(parents.get(edge.componentId) ?? []),
      edge.recipeId,
    ]);
  }
  // Acyclic is checked first, so these walks terminate.
  const downward = (id: string): number =>
    1 + Math.max(0, ...(children.get(id) ?? []).map(downward));
  const upward = (id: string): number =>
    1 + Math.max(0, ...(parents.get(id) ?? []).map(upward));
  const below = Math.max(...nestedIds.map(downward));
  const above = upward(recipeId) - 1;
  if (above + 1 + below > MAX_NESTING_DEPTH)
    throw invalid(
      "RECIPE_TOO_DEEP",
      `Recipes can be nested at most ${MAX_NESTING_DEPTH} levels deep.`,
    );
}

async function validateRecipeBody(
  tx: Tx,
  recipeId: string,
  brandId: string,
  input: UpdateRecipeBody,
): Promise<void> {
  const [brand] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.id, brandId));
  if (!brand) throw notFound("Brand");
  const refs: ComponentRef[] = input.lines.map((line, index) => ({
    componentType: line.componentType,
    componentId: line.componentId,
    uomId: line.uomId,
    path: `lines[${index}]`,
  }));
  await validateComponents(tx, refs, [input.yieldUomId]);
  if (input.outputItemId) {
    const [output] = await tx
      .select({
        baseUomId: inventoryItems.baseUomId,
        isActive: inventoryItems.isActive,
      })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, input.outputItemId));
    if (!output)
      throw invalid(
        "RECIPE_COMPONENT_MISSING",
        "The output item does not exist.",
      );
    // The yield unit must convert to the output item base unit, so a
    // production batch can book its output.
    await validateComponents(tx, [
      {
        componentType: "item",
        componentId: input.outputItemId,
        uomId: input.yieldUomId,
        path: "outputItemId",
      },
    ]);
  }
  const nestedIds = [
    ...new Set(
      input.lines
        .filter((line) => line.componentType === "recipe")
        .map((line) => line.componentId),
    ),
  ];
  await assertAcyclic(tx, recipeId, nestedIds);
  await assertDepth(tx, recipeId, nestedIds);
}

function lineValues(
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  recipeId: string,
  lines: readonly LineInput[],
) {
  return lines.map((line, index) => ({
    tenantId,
    recipeId,
    sortOrder: index,
    componentType: line.componentType,
    componentId: line.componentId,
    quantity: line.quantity,
    uomId: line.uomId,
    wastePctBp: line.wastePctBp,
  }));
}

// ---------------------------------------------------------------- reads

/**
 * GET recipes, by name. A caller sees only the brands it reaches with
 * `recipe.manage` or `inventory.stock.view`; the HPP needs `recipe.cost.view`.
 */
export async function listRecipes(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RecipeListQuery,
): Promise<CursorPage<Recipe>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadAccess(tx, context, actorUserId);
    const brandRows = await tx.select({ id: brands.id }).from(brands);
    const readable = brandRows
      .map((brand) => brand.id)
      .filter((brandId) => access.canRead(brandId));
    if (query.brandId && !readable.includes(query.brandId))
      return { data: [], meta: { limit: query.limit, nextCursor: null } };
    const scope = query.brandId ? [query.brandId] : readable;
    if (scope.length === 0) throw denied("You cannot view recipes.");
    const filters = [inArray(recipes.brandId, scope)];
    if (query.outputItemId)
      filters.push(eq(recipes.outputItemId, query.outputItemId));
    const [name, id] = cursorKeys(query.cursor, 2);
    if (name !== undefined && id !== undefined)
      filters.push(
        or(
          gt(recipes.name, name),
          and(eq(recipes.name, name), sql`${recipes.id} > ${id}::uuid`),
        )!,
      );
    const rows = await tx
      .select()
      .from(recipes)
      .where(and(...filters))
      .orderBy(asc(recipes.name), asc(recipes.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        toRecipe(row, access.reaches("recipe.cost.view", row.brandId)),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

export async function getRecipe(
  context: ScopedTenantContext,
  actorUserId: string,
  recipeId: string,
): Promise<RecipeDetail> {
  return withTenant(db, context, async (tx) => {
    const access = await loadAccess(tx, context, actorUserId);
    return (await loadDetail(tx, recipeId, access)).detail;
  });
}

// --------------------------------------------------------------- writes

/** POST recipe (version 1). Retries of one idempotency key return the first. */
export async function createRecipe(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateRecipeInput,
): Promise<RecipeDetail> {
  return withTenant(db, context, async (tx) => {
    const access = await loadAccess(tx, context, actorUserId);
    if (!access.manages(input.brandId))
      throw denied("You cannot manage recipes of this brand.");
    const fingerprint = setupFingerprint(CREATE_OPERATION, [
      input.brandId,
      input.name,
      input.outputItemId ?? null,
      formatDecimal4(parseDecimal4(input.yieldQuantity)),
      input.yieldUomId,
      canonicalLines(input.lines),
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      CREATE_OPERATION,
      fingerprint,
    );
    if (replayId) return (await loadDetail(tx, replayId, access)).detail;

    await lockRecipeGraph(tx, context.tenant.tenantId);
    const body: UpdateRecipeBody = {
      name: input.name,
      outputItemId: input.outputItemId ?? null,
      yieldQuantity: input.yieldQuantity,
      yieldUomId: input.yieldUomId,
      lines: input.lines,
    };
    const id = randomUUID();
    await validateRecipeBody(tx, id, input.brandId, body);
    await tx.insert(recipes).values({
      id,
      tenantId: context.tenant.tenantId,
      brandId: input.brandId,
      name: body.name,
      outputItemId: body.outputItemId,
      yieldQuantity: body.yieldQuantity,
      yieldUomId: body.yieldUomId,
      updatedBy: actorUserId,
    });
    await tx
      .insert(recipeLines)
      .values(lineValues(context.tenant.tenantId, id, body.lines));
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      CREATE_OPERATION,
      fingerprint,
      id,
    );
    const { detail } = await loadDetail(tx, id, access);
    await auditSetupChange(tx, context, actorUserId, {
      action: "recipe.created",
      objectType: "recipe",
      objectId: id,
      outletId: null,
      before: null,
      after: auditView(detail.recipe, detail.lines.length),
      safeFields: RECIPE_AUDIT_FIELDS,
    });
    return detail;
  });
}

/**
 * POST version: edits a recipe in place as its next version (same id, version
 * + 1, lines replaced; omitted header fields keep their value). The previous
 * version stays readable through the audit trail, which records the lines
 * before and after. Retries of one idempotency key return the recipe.
 */
export async function createRecipeVersion(
  context: ScopedTenantContext,
  actorUserId: string,
  recipeId: string,
  input: CreateRecipeVersionInput,
): Promise<RecipeDetail> {
  return withTenant(db, context, async (tx) => {
    const access = await loadAccess(tx, context, actorUserId);
    const fingerprint = setupFingerprint(VERSION_OPERATION, [
      recipeId,
      input.name ?? null,
      input.yieldQuantity === undefined
        ? null
        : formatDecimal4(parseDecimal4(input.yieldQuantity)),
      input.yieldUomId ?? null,
      canonicalLines(input.lines),
      input.changeNote ?? null,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      VERSION_OPERATION,
      fingerprint,
    );
    await lockRecipeGraph(tx, context.tenant.tenantId);
    const before = await loadDetail(tx, recipeId, access, true);
    if (!access.manages(before.row.brandId))
      throw denied("You cannot manage recipes of this brand.");
    if (replayId) {
      if (replayId !== recipeId)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was used for a different request.",
        );
      return before.detail;
    }
    const body: UpdateRecipeBody = {
      name: input.name ?? before.row.name,
      outputItemId: before.row.outputItemId,
      yieldQuantity: input.yieldQuantity ?? before.row.yieldQuantity,
      yieldUomId: input.yieldUomId ?? before.row.yieldUomId,
      lines: input.lines,
    };
    await validateRecipeBody(tx, recipeId, before.row.brandId, body);
    if (body.yieldUomId !== before.row.yieldUomId)
      await assertNoBreakingParents(tx, recipeId, body.yieldUomId);
    await tx
      .update(recipes)
      .set({
        name: body.name,
        yieldQuantity: body.yieldQuantity,
        yieldUomId: body.yieldUomId,
        version: sql`${recipes.version} + 1`,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(recipes.id, recipeId));
    await tx.delete(recipeLines).where(eq(recipeLines.recipeId, recipeId));
    await tx
      .insert(recipeLines)
      .values(lineValues(context.tenant.tenantId, recipeId, body.lines));
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      VERSION_OPERATION,
      fingerprint,
      recipeId,
    );
    const { detail } = await loadDetail(tx, recipeId, access);
    await auditSetupChange(tx, context, actorUserId, {
      action: "recipe.version_created",
      objectType: "recipe",
      objectId: recipeId,
      outletId: null,
      before: {
        ...auditView(before.detail.recipe, before.detail.lines.length),
        lines: auditLines(before.detail.lines),
      },
      after: {
        ...auditView(detail.recipe, detail.lines.length),
        lines: auditLines(detail.lines),
        changeNote: input.changeNote ?? null,
      },
      safeFields: VERSION_AUDIT_FIELDS,
    });
    return detail;
  });
}

/**
 * Refuses a change that would break ACTIVE parent recipes nesting `recipeId`:
 * deactivation (`newYieldUomId` null) or a yield unit that differs from the
 * unit a parent line uses. Lists at most 5 parent names.
 */
async function assertNoBreakingParents(
  tx: Tx,
  recipeId: string,
  newYieldUomId: string | null,
): Promise<void> {
  const parents = await tx
    .selectDistinct({ id: recipes.id, name: recipes.name })
    .from(recipeLines)
    .innerJoin(
      recipes,
      and(
        eq(recipes.tenantId, recipeLines.tenantId),
        eq(recipes.id, recipeLines.recipeId),
      ),
    )
    .where(
      and(
        eq(recipeLines.componentType, "recipe"),
        eq(recipeLines.componentId, recipeId),
        eq(recipes.isActive, true),
        newYieldUomId === null
          ? undefined
          : sql`${recipeLines.uomId} <> ${newYieldUomId}::uuid`,
      ),
    )
    .orderBy(asc(recipes.name), asc(recipes.id));
  if (parents.length === 0) return;
  const names = parents
    .slice(0, 5)
    .map((parent) => parent.name)
    .join(", ");
  const more = parents.length > 5 ? ` and ${parents.length - 5} more` : "";
  throw new HttpError(
    409,
    "RECIPE_IN_USE",
    newYieldUomId === null
      ? `Recipe is used by active recipes: ${names}${more}.`
      : `Changing the yield unit would break active recipes that use this recipe: ${names}${more}.`,
  );
}

/**
 * POST deactivate. Idempotent. An inactive recipe is skipped by the stock
 * engine (`recipe_inactive`) and refused as a nested component.
 */
export async function deactivateRecipe(
  context: ScopedTenantContext,
  actorUserId: string,
  recipeId: string,
): Promise<RecipeDetail> {
  return withTenant(db, context, async (tx) => {
    // Serialise with create/version so a parent added concurrently is seen.
    await lockRecipeGraph(tx, context.tenant.tenantId);
    const access = await loadAccess(tx, context, actorUserId);
    const before = await loadDetail(tx, recipeId, access, true);
    if (!access.manages(before.row.brandId))
      throw denied("You cannot manage recipes of this brand.");
    if (!before.row.isActive) return before.detail;
    await assertNoBreakingParents(tx, recipeId, null);
    await tx
      .update(recipes)
      .set({ isActive: false, updatedBy: actorUserId, updatedAt: new Date() })
      .where(eq(recipes.id, recipeId));
    const { detail } = await loadDetail(tx, recipeId, access);
    await auditSetupChange(tx, context, actorUserId, {
      action: "recipe.deactivated",
      objectType: "recipe",
      objectId: recipeId,
      outletId: null,
      before: auditView(before.detail.recipe, before.detail.lines.length),
      after: auditView(detail.recipe, detail.lines.length),
      safeFields: RECIPE_AUDIT_FIELDS,
    });
    return detail;
  });
}

// -------------------------------------------------- modifier recipe rules

async function requireModifier(tx: Tx, modifierId: string): Promise<void> {
  const [row] = await tx
    .select({ id: modifiers.id })
    .from(modifiers)
    .where(
      and(eq(modifiers.id, modifierId), sql`${modifiers.deletedAt} IS NULL`),
    );
  if (!row) throw notFound("Modifier");
}

async function requireTenantRecipeManager(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  if (!snapshot.allows("recipe.manage", { type: "tenant" }))
    throw denied("You cannot manage recipe rules in this tenant.");
}

export async function listModifierRecipeRules(
  context: ScopedTenantContext,
  actorUserId: string,
  modifierId: string,
): Promise<ModifierRecipeRule[]> {
  return withTenant(db, context, async (tx) => {
    await requireTenantRecipeManager(tx, context, actorUserId);
    await requireModifier(tx, modifierId);
    const rows = await tx
      .select()
      .from(modifierRecipeRules)
      .where(eq(modifierRecipeRules.modifierId, modifierId))
      .orderBy(asc(modifierRecipeRules.sortOrder), asc(modifierRecipeRules.id));
    return rows.map(toRule);
  });
}

/** PUT: replaces every rule of the modifier; an empty list clears them. */
export async function putModifierRecipeRules(
  context: ScopedTenantContext,
  actorUserId: string,
  modifierId: string,
  input: PutModifierRecipeRulesInput,
): Promise<ModifierRecipeRule[]> {
  return withTenant(db, context, async (tx) => {
    await requireTenantRecipeManager(tx, context, actorUserId);
    await requireModifier(tx, modifierId);
    await lockRecipeGraph(tx, context.tenant.tenantId);
    const refs: ComponentRef[] = [];
    input.rules.forEach((rule, index) => {
      if (rule.componentType && rule.componentId)
        refs.push({
          componentType: rule.componentType,
          componentId: rule.componentId,
          uomId: rule.uomId,
          path: `rules[${index}].component`,
        });
      if (rule.targetComponentType && rule.targetComponentId)
        refs.push({
          componentType: rule.targetComponentType,
          componentId: rule.targetComponentId,
          uomId: null,
          path: `rules[${index}].target`,
        });
    });
    await validateComponents(tx, refs);
    const existing = await tx
      .select({ id: modifierRecipeRules.id })
      .from(modifierRecipeRules)
      .where(eq(modifierRecipeRules.modifierId, modifierId));
    await tx
      .delete(modifierRecipeRules)
      .where(eq(modifierRecipeRules.modifierId, modifierId));
    const rows = input.rules.length
      ? await tx
          .insert(modifierRecipeRules)
          .values(
            input.rules.map((rule, index) => ({
              tenantId: context.tenant.tenantId,
              modifierId,
              sortOrder: index,
              action: rule.action,
              targetComponentType: rule.targetComponentType,
              targetComponentId: rule.targetComponentId,
              componentType: rule.componentType,
              componentId: rule.componentId,
              quantity: rule.quantity,
              uomId: rule.uomId,
              wastePctBp: rule.wastePctBp,
            })),
          )
          .returning()
      : [];
    rows.sort((a, b) => a.sortOrder - b.sortOrder);
    await auditSetupChange(tx, context, actorUserId, {
      action: "modifier_recipe_rules.replaced",
      objectType: "modifier",
      objectId: modifierId,
      outletId: null,
      before: { modifierId, ruleCount: existing.length },
      after: { modifierId, ruleCount: rows.length },
      safeFields: RULES_AUDIT_FIELDS,
    });
    return rows.map(toRule);
  });
}
