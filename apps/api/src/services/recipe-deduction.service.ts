// Automatic stock deduction from recipes (PRD v1.7 §16 "Pemotongan Otomatis",
// INV-02; remake/comp KDS-07; duty meal; bead legend-db6).
//
// One `recipe_deductions` row records one thing that consumed stock: a paid
// order (sale), a remake or comp of an order line, or a staff duty meal. The
// recipe engine (recipe-bom.service.ts) explodes the menu lines into base-unit
// item quantities; this file decides when they leave stock:
//   - real_time    -> ledger rows are posted in the same transaction;
//   - close_of_day -> the deduction stays `pending` until `day.closed`.
// The mode is read per outlet (override) then per tenant, and captured on the
// row when the deduction is recorded. Every item is drawn from the outlet's
// `sale_location_id`.
//
// Event consumer rules (worker-main.ts runs it inside the outbox consumption
// transaction): a throw would retry the delivery and block the aggregate, so a
// business or configuration gap (no recipe, no sale location, inactive or
// broken recipe) is recorded as a `skipped` deduction instead. Re-delivery is
// a no-op: the deduction key is unique per tenant and the ledger keys are
// `recipe-deduction:<deductionId>:<itemId>`.
//
// Ledger mapping: sale/remake/comp -> movement `sale`, source `order`,
// sourceId = the order id (an `order_issue` deduction stores the ORDER id as
// its sourceId, the issue id lives in the idempotency key); duty_meal ->
// movement `duty_meal`, source `duty_meal`, sourceId = the deduction id.
//
// Reversal (legend-9w46): the sale deduction of an order is reversed once when
// the order is finally voided (`order.voided` with `voidedFinalOrder`). A refund,
// full or partial, never reverses stock: the food was consumed. A posted deduction gets one
// `return/order` ledger row per line at the line's ORIGINAL unit cost, so the
// GL return journal offsets the HPP journal exactly; a pending one is just
// marked reversed. A reversal that arrives before `order.paid` leaves a
// line-less `reversed` tombstone under the sale key, so the later paid event
// draws nothing. Remake/comp/duty meal deductions are never reversed.
//
// Swap (legend-v51rh): an unfulfillable line swapped for another was never
// cooked. The sale deduction therefore skips a swapped-away line (it is already
// voided on an open order) and counts the replacement line like any other. When
// the order was ALREADY paid, `applySwapStockAdjustment` returns the old line's
// ingredients (original unit cost, key `recipe-swap-return:...`) and draws the
// replacement as a `remake` deduction (key `swap:issue:<issueId>`). A later
// final void then returns only what the swap did not already return.

import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  businessDateOf,
  CoreError,
  createUlid,
  encodeCursor,
  formatDecimal4,
  idr,
  parseDecimal4,
  ulidToUuid,
  uuidToUlid,
  type Decimal4,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  DEFAULT_RECIPE_DEDUCTION_MODE,
  InventoryError,
  orderIssueRecordedPayloadSchema,
  outletDeductionSettingsSchema,
  recipeDeductionSchema,
  type OutletDeductionSettings,
  type PutOutletDeductionSettingsInput,
  type RecipeDeduction,
  type RecipeDeductionKind,
  type RecipeDeductionSkipReason,
  type RecipeDeductionSourceType,
  type RecordDutyMealInput,
  type RecipeDeductionMode,
} from "@starter/shared/inventory";
import {
  dayClosedPayloadSchema,
  orderPaidPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { inventorySettings } from "../db/schema/inventory-setup.ts";
import {
  stockBalances,
  stockLedger,
  stockLocations,
} from "../db/schema/inventory.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { posOrderItems } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import {
  outletInventorySettings,
  recipeDeductionLines,
  recipeDeductions,
} from "../db/schema/recipe.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  assertOutlet,
  canViewCost,
  claimIdempotency,
  completeIdempotency,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  loadOutletClock,
  lockLocations,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  scaledCostToIdr,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { recordAudit } from "./core-audit.ts";
import { isTrainingOrder } from "./device-training.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";
import { explodeMenuLines } from "./recipe-bom.service.ts";

/** One menu selection to deduct (a sold, remade, comped or eaten portion). */
export type DeductionMenuLine = {
  menuItemId: string;
  variantId: string | null;
  modifierIds: string[];
  quantity: number;
};

export type RecordRecipeDeductionInput = {
  /** Pre-allocated id (duty meal needs it as the ledger source id). */
  id?: string;
  outletId: string;
  kind: RecipeDeductionKind;
  sourceType: RecipeDeductionSourceType;
  sourceId: string;
  businessDate: string;
  idempotencyKey: string;
  lines: readonly DeductionMenuLine[];
  reason?: string | null;
  recordedBy?: string | null;
  /** Duty meal only: who ate it. */
  beneficiaryUserId?: string | null;
  /** Duty meal only: the shift it was eaten in. */
  shiftId?: string | null;
  /** ISO instant the stock left (paid at / issue time / meal time). */
  occurredAt: string;
};

export type RecipeDeductionListQuery = {
  outletId: string;
  businessDate?: string;
  kind?: RecipeDeductionKind;
  cursor?: string;
  limit?: number;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const DUTY_MEAL_KEY_PREFIX = "duty_meal:";
const DUTY_MEAL_OPERATION = "duty_meal.record";
/** Pending deductions one day close posts; the rest waits for the next one. */
const MAX_POSTED_PER_DAY_CLOSE = 2000;
const DEDUCTION_AUDIT_FIELDS = [
  "kind",
  "status",
  "mode",
  "businessDate",
  "menuItemId",
  "variantId",
  "quantity",
  "employeeUserId",
  "shiftId",
  "skipReason",
] as const;
const SETTINGS_AUDIT_FIELDS = [
  "recipeDeductionMode",
  "saleLocationId",
] as const;

type DeductionRow = typeof recipeDeductions.$inferSelect;
type DeductionLineRow = typeof recipeDeductionLines.$inferSelect;

// ------------------------------------------------------------------ config

type DeductionConfig = {
  mode: RecipeDeductionMode;
  saleLocationId: string | null;
};

async function loadDeductionConfig(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<DeductionConfig & { overrideMode: RecipeDeductionMode | null }> {
  const tenantId = context.tenant.tenantId;
  const [outletRow] = await tx
    .select()
    .from(outletInventorySettings)
    .where(
      and(
        eq(outletInventorySettings.tenantId, tenantId),
        eq(outletInventorySettings.outletId, outletId),
      ),
    );
  const [tenantRow] = await tx
    .select({ recipeDeductionMode: inventorySettings.recipeDeductionMode })
    .from(inventorySettings)
    .where(eq(inventorySettings.tenantId, tenantId));
  return {
    overrideMode: outletRow?.recipeDeductionMode ?? null,
    mode:
      outletRow?.recipeDeductionMode ??
      tenantRow?.recipeDeductionMode ??
      DEFAULT_RECIPE_DEDUCTION_MODE,
    saleLocationId: outletRow?.saleLocationId ?? null,
  };
}

/** Outlet override, else the tenant setting, else real_time. */
export async function effectiveDeductionMode(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<RecipeDeductionMode> {
  return (await loadDeductionConfig(tx, context, outletId)).mode;
}

// ---------------------------------------------------------------- mapping

function toDeduction(
  row: DeductionRow,
  lines: readonly DeductionLineRow[],
  withCost: boolean,
): RecipeDeduction {
  return recipeDeductionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    kind: row.kind,
    status: row.status,
    mode: row.mode,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    businessDate: row.businessDate,
    costIdr: withCost ? row.costIdr : null,
    skipReason: row.skipReason,
    reason: row.reason,
    recordedBy: row.recordedBy,
    beneficiaryUserId: row.beneficiaryUserId,
    shiftId: row.shiftId,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversalReason: row.reversalReason,
    lines: [...lines].sort(byItemThenLocation).map((line) => ({
      inventoryItemId: line.inventoryItemId,
      locationId: line.locationId,
      quantity: line.quantity,
      unitCostIdr: withCost ? line.unitCostIdr : null,
      ledgerEntryId: line.ledgerEntryId ? uuidToUlid(line.ledgerEntryId) : null,
    })),
  });
}

async function loadDeduction(
  tx: Tx,
  tenantId: TenantId,
  id: string,
  withCost: boolean,
): Promise<RecipeDeduction> {
  const [row] = await tx
    .select()
    .from(recipeDeductions)
    .where(
      and(eq(recipeDeductions.tenantId, tenantId), eq(recipeDeductions.id, id)),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Deduction not found.");
  const lines = await tx
    .select()
    .from(recipeDeductionLines)
    .where(
      and(
        eq(recipeDeductionLines.tenantId, tenantId),
        eq(recipeDeductionLines.deductionId, id),
      ),
    );
  return toDeduction(row, lines, withCost);
}

async function findByKey(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: recipeDeductions.id })
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.idempotencyKey, idempotencyKey),
      ),
    );
  return row ?? null;
}

// ------------------------------------------------------------------ record

/** One planned draw: `quantity` of `itemId` from `locationId` (resolved). */
type PlannedDraw = { locationId: string; itemId: string; quantity: bigint };

type DeductionPlan =
  | { ok: true; draws: PlannedDraw[]; note: string | null }
  | { ok: false; reason: RecipeDeductionSkipReason };

/**
 * Ledger idempotency key suffix of a deduction line: the item, plus the
 * location only when the deduction holds the item at more than one location
 * (so the key of a single-location line never changes).
 */
function lineKeySuffix(
  line: { inventoryItemId: string; locationId: string },
  lines: readonly { inventoryItemId: string }[],
): string {
  const sameItem = lines.filter(
    (other) => other.inventoryItemId === line.inventoryItemId,
  ).length;
  return sameItem > 1
    ? `${line.inventoryItemId}:${line.locationId}`
    : line.inventoryItemId;
}

function byItemThenLocation(
  a: { inventoryItemId: string; locationId: string },
  b: { inventoryItemId: string; locationId: string },
): number {
  return (
    a.inventoryItemId.localeCompare(b.inventoryItemId) ||
    a.locationId.localeCompare(b.locationId)
  );
}

/**
 * Explodes all lines through the recipe engine. A menu item without a recipe
 * (retail, service) is left out and its id noted on the deduction `reason`
 * (completeness report); an inactive or broken recipe skips the whole
 * deduction, so stock is never drawn partially by surprise.
 *
 * legend-89zm: each draw comes from its recipe line's own location, else the
 * outlet sale location. With no sale location, any draw that names no location
 * skips the whole deduction as `no_sale_location` (nothing is half posted);
 * with no sale location any other failure also reads `no_sale_location`, as
 * before. A named location that is not a location of this outlet (recipes are
 * brand-wide, locations belong to one outlet) is a `recipe_error`.
 */
async function planDeduction(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  saleLocationId: string | null,
  lines: readonly DeductionMenuLine[],
): Promise<DeductionPlan> {
  const failed = (reason: RecipeDeductionSkipReason): DeductionPlan => ({
    ok: false,
    reason: saleLocationId === null ? "no_sale_location" : reason,
  });
  const sellable = lines.filter((line) => line.quantity >= 1);
  if (sellable.length === 0) return failed("no_recipe");
  let result: Awaited<ReturnType<typeof explodeMenuLines>>;
  try {
    result = await explodeMenuLines(tx, context, sellable);
  } catch (error) {
    // A recipe/config problem must not fail (and block) the whole delivery.
    if (error instanceof HttpError || error instanceof InventoryError)
      return failed("recipe_error");
    throw error;
  }
  if (!result.ok) return failed(result.reason);
  const namedLocations = [
    ...new Set(
      result.draws.flatMap((draw) =>
        draw.locationId === null ? [] : [draw.locationId],
      ),
    ),
  ];
  if (namedLocations.length > 0) {
    const own = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(
        and(
          eq(stockLocations.tenantId, context.tenant.tenantId),
          eq(stockLocations.outletId, outletId),
          inArray(stockLocations.id, namedLocations),
        ),
      );
    if (own.length !== namedLocations.length) return failed("recipe_error");
  }
  const merged = new Map<string, PlannedDraw>();
  for (const draw of result.draws) {
    const locationId = draw.locationId ?? saleLocationId;
    if (locationId === null) return failed("no_sale_location");
    const scaled = parseDecimal4(draw.quantity);
    if (scaled <= 0n) continue;
    const key = `${locationId}|${draw.itemId}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += scaled;
    else merged.set(key, { locationId, itemId: draw.itemId, quantity: scaled });
  }
  if (merged.size === 0) return failed("no_recipe");
  const draws = [...merged.values()];
  const note =
    result.unmappedMenuItemIds.length === 0
      ? null
      : `no recipe: ${result.unmappedMenuItemIds.join(",")}`;
  return { ok: true, draws, note };
}

/**
 * Records one deduction. Idempotent on `idempotencyKey` (a replay returns the
 * stored deduction unchanged). Skipped when it cannot be computed; otherwise
 * posted now (real_time) or left pending for the day close.
 */
export async function recordRecipeDeduction(
  tx: Tx,
  context: ScopedTenantContext,
  input: RecordRecipeDeductionInput,
): Promise<RecipeDeduction> {
  const tenantId = context.tenant.tenantId;
  const existing = await findByKey(tx, tenantId, input.idempotencyKey);
  if (existing) return loadDeduction(tx, tenantId, existing.id, true);

  const config = await loadDeductionConfig(tx, context, input.outletId);
  const plan = await planDeduction(
    tx,
    context,
    input.outletId,
    config.saleLocationId,
    input.lines,
  );
  const id = input.id ?? randomUUID();
  const reason =
    [input.reason ?? null, plan.ok ? plan.note : null]
      .filter((part): part is string => part !== null && part !== "")
      .join("; ")
      .slice(0, 200) || null;
  const [inserted] = await tx
    .insert(recipeDeductions)
    .values({
      id,
      tenantId,
      outletId: input.outletId,
      kind: input.kind,
      status: plan.ok ? "pending" : "skipped",
      mode: config.mode,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      businessDate: input.businessDate,
      idempotencyKey: input.idempotencyKey,
      costIdr: null,
      skipReason: plan.ok ? null : plan.reason,
      reason,
      recordedBy: input.recordedBy ?? null,
      beneficiaryUserId: input.beneficiaryUserId ?? null,
      shiftId: input.shiftId ?? null,
      occurredAt: new Date(input.occurredAt),
    })
    .onConflictDoNothing({
      target: [recipeDeductions.tenantId, recipeDeductions.idempotencyKey],
    })
    .returning({ id: recipeDeductions.id });
  if (!inserted) {
    // A concurrent delivery won the key; return what it stored.
    const winner = await findByKey(tx, tenantId, input.idempotencyKey);
    if (!winner) throw new Error("Recipe deduction disappeared");
    return loadDeduction(tx, tenantId, winner.id, true);
  }
  if (!plan.ok) return loadDeduction(tx, tenantId, id, true);

  await tx.insert(recipeDeductionLines).values(
    [...plan.draws]
      .sort(
        (a, b) =>
          a.itemId.localeCompare(b.itemId) ||
          a.locationId.localeCompare(b.locationId),
      )
      .map((draw) => ({
        tenantId,
        outletId: input.outletId,
        deductionId: id,
        inventoryItemId: draw.itemId,
        locationId: draw.locationId,
        quantity: formatDecimal4(draw.quantity),
        unitCostIdr: null,
        ledgerEntryId: null,
      })),
  );
  if (config.mode === "real_time") return postRecipeDeduction(tx, context, id);
  return loadDeduction(tx, tenantId, id, true);
}

/**
 * Ingredient cost (whole rupiah) of drawing `lines` from the outlet sale
 * location now: exploded recipe quantities x the location moving-average cost
 * (KDS-07 "biaya bahan", computed server-side). 0 when it cannot be computed
 * (no sale location, no recipe, broken recipe) or an item has no balance yet.
 */
export async function estimateDeductionCostIdr(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  lines: readonly DeductionMenuLine[],
): Promise<number> {
  const config = await loadDeductionConfig(tx, context, outletId);
  const plan = await planDeduction(
    tx,
    context,
    outletId,
    config.saleLocationId,
    lines,
  );
  if (!plan.ok) return 0;
  const balances = await tx
    .select({
      locationId: stockBalances.locationId,
      inventoryItemId: stockBalances.inventoryItemId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, context.tenant.tenantId),
        inArray(stockBalances.locationId, [
          ...new Set(plan.draws.map((draw) => draw.locationId)),
        ]),
        inArray(stockBalances.inventoryItemId, [
          ...new Set(plan.draws.map((draw) => draw.itemId)),
        ]),
      ),
    );
  const avgCost = new Map(
    balances.map((balance) => [
      `${balance.locationId}|${balance.inventoryItemId}`,
      parseDecimal4(balance.avgCostIdr),
    ]),
  );
  let scaled = 0n;
  for (const draw of plan.draws)
    scaled +=
      draw.quantity * (avgCost.get(`${draw.locationId}|${draw.itemId}`) ?? 0n);
  return scaledCostToIdr(scaled);
}

// -------------------------------------------------------------------- post

/**
 * Posts a pending deduction to the stock ledger (one negative movement per
 * item, valued at the location average), then stores each line's unit cost and
 * ledger entry and the deduction cost (Σ qty x unit cost, rounded once). Not
 * pending (already posted or skipped) -> returned unchanged.
 */
export async function postRecipeDeduction(
  tx: Tx,
  context: ScopedTenantContext,
  deductionId: string,
): Promise<RecipeDeduction> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select()
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.id, deductionId),
      ),
    )
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Deduction not found.");
  if (row.status !== "pending")
    return loadDeduction(tx, tenantId, row.id, true);

  const lines = (
    await tx
      .select()
      .from(recipeDeductionLines)
      .where(
        and(
          eq(recipeDeductionLines.tenantId, tenantId),
          eq(recipeDeductionLines.deductionId, row.id),
        ),
      )
  ).sort(byItemThenLocation);
  await lockLocations(
    tx,
    tenantId,
    lines.map((line) => line.locationId),
  );
  const isDutyMeal = row.kind === "duty_meal";
  const actor = row.recordedBy
    ? ({ type: "user", id: row.recordedBy } as const)
    : ({ type: "system" } as const);
  let scaledCost = 0n;
  for (const line of lines) {
    const entry = await recordStockMovementInTransaction(tx, context, {
      outletId: row.outletId,
      locationId: line.locationId,
      inventoryItemId: line.inventoryItemId,
      movementType: isDutyMeal ? "duty_meal" : "sale",
      quantity: formatDecimal4(-parseDecimal4(line.quantity)),
      sourceType: isDutyMeal ? "duty_meal" : "order",
      sourceId: isDutyMeal ? row.id : row.sourceId,
      occurredAt: row.occurredAt.toISOString() as never,
      idempotencyKey: `recipe-deduction:${row.id}:${lineKeySuffix(line, lines)}`,
      actor,
    });
    scaledCost +=
      parseDecimal4(line.quantity) * parseDecimal4(entry.unitCostIdr);
    await tx
      .update(recipeDeductionLines)
      .set({
        unitCostIdr: entry.unitCostIdr,
        ledgerEntryId: ulidToUuid(entry.id),
      })
      .where(eq(recipeDeductionLines.id, line.id));
  }
  await tx
    .update(recipeDeductions)
    .set({
      status: "posted",
      postedAt: new Date(),
      costIdr: idr(scaledCostToIdr(scaledCost)),
    })
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.id, row.id),
      ),
    );
  return loadDeduction(tx, tenantId, row.id, true);
}

/**
 * Day close: posts the pending deductions of the outlet whose business date
 * is on or before the closed date, oldest first, at most
 * MAX_POSTED_PER_DAY_CLOSE per call (the rest stays pending and the next
 * `day.closed` picks it up: the filter is `business_date <=`). Each deduction
 * posts inside its own savepoint, so one that fails (e.g. a stock rule) rolls
 * back alone and stays pending; it never fails the consumer transaction.
 * Returns the posted deduction ids.
 */
export async function postPendingDeductions(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; businessDate: string },
): Promise<string[]> {
  // legend-13avp: a pending deduction of a training order (recorded before
  // training orders stopped deducting) never posts and stays pending. The page
  // walk keeps those rows from taking the places of real ones in the batch.
  const pending: string[] = [];
  for (
    let offset = 0;
    pending.length < MAX_POSTED_PER_DAY_CLOSE;
    offset += MAX_POSTED_PER_DAY_CLOSE
  ) {
    const page = await tx
      .select({
        id: recipeDeductions.id,
        sourceType: recipeDeductions.sourceType,
        sourceId: recipeDeductions.sourceId,
      })
      .from(recipeDeductions)
      .where(
        and(
          eq(recipeDeductions.tenantId, context.tenant.tenantId),
          eq(recipeDeductions.outletId, input.outletId),
          eq(recipeDeductions.status, "pending"),
          lte(recipeDeductions.businessDate, input.businessDate),
        ),
      )
      .orderBy(recipeDeductions.occurredAt, recipeDeductions.id)
      .limit(MAX_POSTED_PER_DAY_CLOSE)
      .offset(offset);
    for (const { id, sourceType, sourceId } of page) {
      if (pending.length >= MAX_POSTED_PER_DAY_CLOSE) break;
      if (
        (sourceType === "order" || sourceType === "order_issue") &&
        (await isTrainingOrder(tx, context.tenant.tenantId, sourceId))
      )
        continue;
      pending.push(id);
    }
    if (page.length < MAX_POSTED_PER_DAY_CLOSE) break;
  }
  const posted: string[] = [];
  for (const id of pending) {
    try {
      await tx.transaction(async (savepoint) => {
        await postRecipeDeduction(savepoint, context, id);
      });
      posted.push(id);
    } catch (error) {
      logger.warn(
        { err: error, deductionId: id, outletId: input.outletId },
        "Pending recipe deduction not posted at day close; left pending",
      );
    }
  }
  return posted;
}

// ---------------------------------------------------------------- reversal

export type ReverseOrderSaleDeductionInput = {
  outletId: string;
  orderId: string;
  reason: "void";
  /** Void id that caused the reversal. */
  reversalSourceId: string;
  /** ISO instant of the void. */
  occurredAt: string;
};

/**
 * Reverses the sale deduction of an order (key `sale:order:<orderId>`), once.
 * Posted -> one `return/order` ledger row per line at the line's stored unit
 * cost (never the current average); pending -> marked reversed, nothing
 * posted; skipped or already reversed -> no-op. No sale deduction yet -> a
 * line-less `reversed` tombstone, so a later `order.paid` draws nothing.
 */
export async function reverseOrderSaleDeduction(
  tx: Tx,
  context: ScopedTenantContext,
  input: ReverseOrderSaleDeductionInput,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const key = `sale:order:${input.orderId}`;
  const occurredAt = new Date(input.occurredAt);
  // Two rounds: a concurrent order.paid can win the tombstone insert, then the
  // second round finds and locks its row.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [row] = await tx
      .select()
      .from(recipeDeductions)
      .where(
        and(
          eq(recipeDeductions.tenantId, tenantId),
          eq(recipeDeductions.idempotencyKey, key),
        ),
      )
      .for("update");
    if (!row) {
      const config = await loadDeductionConfig(tx, context, input.outletId);
      const clock = await loadOutletClock(tx, input.outletId);
      const [inserted] = await tx
        .insert(recipeDeductions)
        .values({
          tenantId,
          outletId: input.outletId,
          kind: "sale",
          status: "reversed",
          mode: config.mode,
          sourceType: "order",
          sourceId: input.orderId,
          businessDate: businessDateOf(occurredAt, clock),
          idempotencyKey: key,
          costIdr: null,
          skipReason: null,
          reason: null,
          recordedBy: null,
          occurredAt,
          reversedAt: occurredAt,
          reversalReason: input.reason,
          reversalSourceId: input.reversalSourceId,
        })
        .onConflictDoNothing({
          target: [recipeDeductions.tenantId, recipeDeductions.idempotencyKey],
        })
        .returning({ id: recipeDeductions.id });
      if (inserted) return;
      continue;
    }
    if (row.kind !== "sale") return;
    if (row.status === "reversed" || row.status === "skipped") return;

    if (row.status === "posted") {
      const lines = (
        await tx
          .select()
          .from(recipeDeductionLines)
          .where(
            and(
              eq(recipeDeductionLines.tenantId, tenantId),
              eq(recipeDeductionLines.deductionId, row.id),
            ),
          )
      ).sort(byItemThenLocation);
      await lockLocations(
        tx,
        tenantId,
        lines.map((line) => line.locationId),
      );
      const swapReturned = await swapReturnedQuantities(tx, tenantId, row);
      for (const line of lines) {
        if (line.unitCostIdr === null) continue; // posted lines always carry it
        // A swap on the paid order already returned part of this line.
        const remaining =
          parseDecimal4(line.quantity) -
          (swapReturned.get(`${line.inventoryItemId}|${line.locationId}`) ??
            0n);
        if (remaining <= 0n) continue;
        await recordStockMovementInTransaction(tx, context, {
          outletId: row.outletId,
          locationId: line.locationId,
          inventoryItemId: line.inventoryItemId,
          movementType: "return",
          quantity: formatDecimal4(remaining),
          unitCostIdr: formatDecimal4(parseDecimal4(line.unitCostIdr)),
          sourceType: "order",
          sourceId: row.sourceId,
          occurredAt: occurredAt.toISOString() as never,
          idempotencyKey: `recipe-reversal:${row.id}:${lineKeySuffix(line, lines)}`,
          actor: { type: "system" },
        });
      }
    }
    await tx
      .update(recipeDeductions)
      .set({
        status: "reversed",
        reversedAt: occurredAt,
        reversalReason: input.reason,
        reversalSourceId: input.reversalSourceId,
        reversalFailedAt: null,
      })
      .where(
        and(
          eq(recipeDeductions.tenantId, tenantId),
          eq(recipeDeductions.id, row.id),
        ),
      );
    return;
  }
}

const SWAP_RETURN_KEY_PREFIX = "recipe-swap-return:";

/** Base-unit quantities per item that swaps already returned for a sale row. */
async function swapReturnedQuantities(
  tx: Tx,
  tenantId: TenantId,
  sale: DeductionRow,
): Promise<Map<string, bigint>> {
  const rows = await tx
    .select({
      inventoryItemId: stockLedger.inventoryItemId,
      locationId: stockLedger.locationId,
      quantity: stockLedger.quantity,
    })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, tenantId),
        eq(stockLedger.sourceType, "order"),
        eq(stockLedger.sourceId, ulidToUuid(sale.sourceId)),
        eq(stockLedger.movementType, "return"),
        like(
          stockLedger.idempotencyKey,
          `${SWAP_RETURN_KEY_PREFIX}${sale.id}:%`,
        ),
      ),
    );
  const returned = new Map<string, bigint>();
  for (const row of rows) {
    const key = `${row.inventoryItemId}|${row.locationId}`;
    returned.set(key, (returned.get(key) ?? 0n) + parseDecimal4(row.quantity));
  }
  return returned;
}

export type SwapStockAdjustmentInput = {
  outletId: string;
  orderId: string;
  /** The swap issue: the once-only key of every row written here. */
  issueId: string;
  businessDate: string;
  /** Order line id of the swapped-away line (it may itself be a replacement). */
  oldLineId: string;
  /** The unfulfillable line swapped away (never cooked). */
  oldLine: DeductionMenuLine;
  /** The replacement line (same quantity). */
  replacement: DeductionMenuLine;
  recordedBy: string | null;
  occurredAt: string;
};

/**
 * Stock side of a swap on an order that was ALREADY paid (legend-v51rh). With no
 * sale deduction yet nothing is done: `order.paid` later skips the swapped-away
 * line and counts the replacement. With one: the old line's ingredients return
 * to stock (posted: `return` rows at the sale line's unit cost; pending: the
 * sale lines shrink; reversed: nothing) and the replacement is drawn as a
 * `remake` deduction. A chained swap (the old line was itself a replacement)
 * returns from the earlier swap's `remake` deduction, which is what drew it.
 * Idempotent on the issue id (the `remake` key is checked first). The caller
 * holds the issue row lock. A stock rule refusing the return rolls that part
 * back alone, so the event is not dead-lettered; the return is then parked on
 * the `remake` row (`reversal_failed_at`, reason `swap`, source = issue id) and
 * `day.closed` retries it, like a parked void reversal (legend-nzbi8).
 */
export async function applySwapStockAdjustment(
  tx: Tx,
  context: ScopedTenantContext,
  input: SwapStockAdjustmentInput,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  if (await isTrainingOrder(tx, tenantId, input.orderId)) return;
  if (await findByKey(tx, tenantId, `swap:issue:${input.issueId}`)) return;
  const [sale] = await tx
    .select()
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.idempotencyKey, `sale:order:${input.orderId}`),
      ),
    )
    .for("update");
  if (!sale || sale.status === "reversed") return;

  const source = await swapReturnSource(tx, tenantId, sale, input.oldLineId);

  let returnRefused = false;
  if (source.status === "posted" || source.status === "pending") {
    try {
      await tx.transaction(async (savepoint) => {
        await returnSwappedLine(savepoint, context, source, input);
      });
    } catch (error) {
      if (!isBusinessRefusal(error)) throw error;
      returnRefused = true;
      logger.warn(
        { err: error, orderId: input.orderId, issueId: input.issueId },
        "Swapped line stock not returned; parked for retry at day close",
      );
    }
  }
  await recordRecipeDeduction(tx, context, {
    outletId: input.outletId,
    kind: "remake",
    sourceType: "order_issue",
    sourceId: input.orderId,
    businessDate: input.businessDate,
    idempotencyKey: `swap:issue:${input.issueId}`,
    lines: [input.replacement],
    reason: "swap",
    recordedBy: input.recordedBy,
    occurredAt: input.occurredAt,
  });
  if (returnRefused) {
    const [parked] = await tx
      .update(recipeDeductions)
      .set({
        reversalFailedAt: new Date(),
        reversalReason: "swap",
        reversalSourceId: input.issueId,
      })
      .where(
        and(
          eq(recipeDeductions.tenantId, tenantId),
          eq(recipeDeductions.idempotencyKey, `swap:issue:${input.issueId}`),
          eq(recipeDeductions.kind, "remake"),
        ),
      )
      .returning({ id: recipeDeductions.id });
    if (parked)
      await auditSwapReturnFailed(tx, context, {
        outletId: input.outletId,
        deductionId: parked.id,
        orderId: input.orderId,
        issueId: input.issueId,
        stage: "swap",
      });
  }
}

/** HTTP, inventory and core rule errors are refusals; anything else rethrows. */
function isBusinessRefusal(error: unknown): boolean {
  return (
    error instanceof HttpError ||
    error instanceof InventoryError ||
    error instanceof CoreError
  );
}

/**
 * What drew the old line: the sale row, or the `remake` of the earlier swap
 * that created the old line (a chained swap). Locks the earlier remake row.
 */
async function swapReturnSource(
  tx: Tx,
  tenantId: TenantId,
  sale: DeductionRow,
  oldLineId: string,
): Promise<DeductionRow> {
  const [earlier] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.replacementOrderItemId, oldLineId),
      ),
    );
  if (!earlier) return sale;
  const [earlierDrawn] = await tx
    .select()
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.idempotencyKey, `swap:issue:${earlier.id}`),
      ),
    )
    .for("update");
  return earlierDrawn ?? sale;
}

const SWAP_AUDIT_SAFE_FIELDS = ["orderId", "issueId", "stage"];

/**
 * A swap return refused by a stock rule (at the swap or at a day-close retry)
 * is left visible in the audit log, on top of the parked marker.
 */
async function auditSwapReturnFailed(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    deductionId: string;
    orderId: string;
    issueId: string;
    stage: "swap" | "retry";
  },
): Promise<void> {
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "recipe_deduction.swap_return_failed",
      objectType: "recipe_deduction",
      objectId: input.deductionId,
      reason: null,
      maskedChanges: {
        before: null,
        after: {
          orderId: input.orderId,
          issueId: input.issueId,
          stage: input.stage,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    SWAP_AUDIT_SAFE_FIELDS,
  );
}

async function returnSwappedLine(
  tx: Tx,
  context: ScopedTenantContext,
  sale: DeductionRow,
  input: Pick<
    SwapStockAdjustmentInput,
    "outletId" | "issueId" | "oldLine" | "occurredAt"
  >,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const alreadyReturned = await swapReturnedQuantities(tx, tenantId, sale);
  const config = await loadDeductionConfig(tx, context, input.outletId);
  const plan = await planDeduction(
    tx,
    context,
    input.outletId,
    config.saleLocationId,
    [input.oldLine],
  );
  if (!plan.ok) return;
  const saleLines = await tx
    .select()
    .from(recipeDeductionLines)
    .where(
      and(
        eq(recipeDeductionLines.tenantId, tenantId),
        eq(recipeDeductionLines.deductionId, sale.id),
      ),
    );
  // The sale line of a planned draw: same item and location; failing that, the
  // item's only sale line (the sale location may have changed since the sale).
  const saleLineOf = (draw: PlannedDraw) => {
    const ofItem = saleLines.filter(
      (line) => line.inventoryItemId === draw.itemId,
    );
    return (
      ofItem.find((line) => line.locationId === draw.locationId) ??
      (ofItem.length === 1 ? ofItem[0] : undefined)
    );
  };
  const draws = [...plan.draws].sort(
    (a, b) =>
      a.itemId.localeCompare(b.itemId) ||
      a.locationId.localeCompare(b.locationId),
  );
  await lockLocations(
    tx,
    tenantId,
    draws.flatMap((draw) => saleLineOf(draw)?.locationId ?? []),
  );
  for (const draw of draws) {
    const line = saleLineOf(draw);
    if (!line) continue;
    const itemId = draw.itemId;
    const planned = draw.quantity;
    const available =
      parseDecimal4(line.quantity) -
      (alreadyReturned.get(`${itemId}|${line.locationId}`) ?? 0n);
    const back = planned < available ? planned : available;
    if (back <= 0n) continue;
    if (sale.status === "posted") {
      if (line.unitCostIdr === null) continue; // posted lines always carry it
      await recordStockMovementInTransaction(tx, context, {
        outletId: sale.outletId,
        locationId: line.locationId,
        inventoryItemId: itemId,
        movementType: "return",
        quantity: formatDecimal4(back),
        unitCostIdr: formatDecimal4(parseDecimal4(line.unitCostIdr)),
        sourceType: "order",
        sourceId: sale.sourceId,
        occurredAt: input.occurredAt as never,
        idempotencyKey: `${SWAP_RETURN_KEY_PREFIX}${sale.id}:${input.issueId}:${lineKeySuffix(line, saleLines)}`,
        actor: { type: "system" },
      });
    } else if (back === available) {
      await tx
        .delete(recipeDeductionLines)
        .where(
          and(
            eq(recipeDeductionLines.tenantId, tenantId),
            eq(recipeDeductionLines.deductionId, sale.id),
            eq(recipeDeductionLines.inventoryItemId, itemId),
            eq(recipeDeductionLines.locationId, line.locationId),
          ),
        );
    } else {
      await tx
        .update(recipeDeductionLines)
        .set({ quantity: formatDecimal4(available - back) })
        .where(
          and(
            eq(recipeDeductionLines.tenantId, tenantId),
            eq(recipeDeductionLines.deductionId, sale.id),
            eq(recipeDeductionLines.inventoryItemId, itemId),
            eq(recipeDeductionLines.locationId, line.locationId),
          ),
        );
    }
  }
}

/**
 * Reversal inside a savepoint: a stock rule that refuses the return rolls the
 * reversal back alone and never fails (and blocks) the consumer. The posted
 * sale row is then parked: `reversal_failed_at` set, reason/source kept (the
 * first ones when already parked), so `day.closed` retries it.
 */
async function reverseSafely(
  tx: Tx,
  context: ScopedTenantContext,
  input: ReverseOrderSaleDeductionInput,
): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      await reverseOrderSaleDeduction(savepoint, context, input);
    });
  } catch (error) {
    // Business refusals (HTTP, inventory, core rule errors such as a reused
    // ledger key) park the reversal; anything else (DB down, bug) rethrows so
    // the delivery retries.
    if (!(
      error instanceof HttpError ||
      error instanceof InventoryError ||
      error instanceof CoreError
    ))
      throw error;
    logger.warn(
      { err: error, orderId: input.orderId, outletId: input.outletId },
      "Recipe deduction reversal not posted; parked for retry at day close",
    );
    await tx
      .update(recipeDeductions)
      .set({
        reversalFailedAt: new Date(),
        reversalReason: sql`coalesce(${recipeDeductions.reversalReason}, ${input.reason})`,
        reversalSourceId: sql`coalesce(${recipeDeductions.reversalSourceId}, ${input.reversalSourceId})`,
      })
      .where(
        and(
          eq(recipeDeductions.tenantId, context.tenant.tenantId),
          eq(recipeDeductions.idempotencyKey, `sale:order:${input.orderId}`),
          eq(recipeDeductions.status, "posted"),
        ),
      );
  }
}

/**
 * Day close: retries the parked reversals of the outlet (posted sale rows with
 * `reversal_failed_at`), oldest first, each in its own savepoint with the
 * stored reason/source. The original event time is not stored, so the return
 * is dated at the failure time. A retry that fails again only bumps
 * `reversal_failed_at` (see reverseSafely).
 */
async function retryParkedReversals(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<void> {
  const parked = await tx
    .select({
      sourceId: recipeDeductions.sourceId,
      reason: recipeDeductions.reversalReason,
      reversalSourceId: recipeDeductions.reversalSourceId,
      failedAt: recipeDeductions.reversalFailedAt,
    })
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, context.tenant.tenantId),
        eq(recipeDeductions.outletId, outletId),
        eq(recipeDeductions.kind, "sale"),
        eq(recipeDeductions.status, "posted"),
        sql`${recipeDeductions.reversalFailedAt} IS NOT NULL`,
      ),
    )
    .orderBy(recipeDeductions.reversalFailedAt, recipeDeductions.id)
    .limit(MAX_POSTED_PER_DAY_CLOSE);
  for (const row of parked) {
    if (!row.reason || !row.reversalSourceId || !row.failedAt) continue;
    await reverseSafely(tx, context, {
      outletId,
      orderId: row.sourceId,
      reason: row.reason as ReverseOrderSaleDeductionInput["reason"],
      reversalSourceId: row.reversalSourceId,
      occurredAt: row.failedAt.toISOString(),
    });
  }
}

/**
 * Day close: retries the parked swap returns of the outlet (`remake` rows with
 * `reversal_failed_at` and reason `swap`), oldest first, each in its own
 * savepoint. The return keeps its once-only ledger key per issue and item, so a
 * retry never returns twice. A sale reversed by a void meanwhile already got the
 * whole line back: the park is just cleared. A return refused again bumps
 * `reversal_failed_at` and is audited (`recipe_deduction.swap_return_failed`).
 */
async function retryParkedSwapReturns(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const parked = await tx
    .select({
      id: recipeDeductions.id,
      orderId: recipeDeductions.sourceId,
      issueId: recipeDeductions.reversalSourceId,
      occurredAt: recipeDeductions.occurredAt,
    })
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.outletId, outletId),
        eq(recipeDeductions.kind, "remake"),
        eq(recipeDeductions.reversalReason, "swap"),
        sql`${recipeDeductions.reversalFailedAt} IS NOT NULL`,
      ),
    )
    .orderBy(recipeDeductions.reversalFailedAt, recipeDeductions.id)
    .limit(MAX_POSTED_PER_DAY_CLOSE);
  const clear = () => ({
    reversalFailedAt: null,
    reversalReason: null,
    reversalSourceId: null,
  });
  for (const row of parked) {
    if (!row.issueId) continue;
    const issueId = row.issueId;
    const [sale] = await tx
      .select()
      .from(recipeDeductions)
      .where(
        and(
          eq(recipeDeductions.tenantId, tenantId),
          eq(recipeDeductions.idempotencyKey, `sale:order:${row.orderId}`),
        ),
      )
      .for("update");
    const [issue] = await tx
      .select({ orderItemId: orderIssues.orderItemId })
      .from(orderIssues)
      .where(
        and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.id, issueId)),
      );
    const [oldLine] = issue
      ? await tx
          .select()
          .from(orderItems)
          .where(
            and(
              eq(orderItems.tenantId, tenantId),
              eq(orderItems.id, issue.orderItemId),
            ),
          )
      : [];
    let failure: unknown = null;
    let returned = false;
    if (!sale) {
      returned = true; // no sale deduction: nothing was drawn
    } else if (!oldLine) {
      failure = new Error("Swapped order line not found");
    } else {
      const source = await swapReturnSource(tx, tenantId, sale, oldLine.id);
      if (source.id === sale.id && sale.status === "reversed") {
        returned = true; // the void gave the whole sale line back
      } else if (source.status !== "posted" && source.status !== "pending") {
        returned = true; // nothing was drawn for the old line
      } else {
        try {
          await tx.transaction(async (savepoint) => {
            await returnSwappedLine(savepoint, context, source, {
              outletId,
              issueId,
              oldLine: {
                menuItemId: oldLine.menuItemId,
                variantId: oldLine.variantId ?? null,
                modifierIds: (oldLine.modifiers ?? []).map((m) => m.modifierId),
                quantity: oldLine.quantity,
              },
              occurredAt: row.occurredAt.toISOString(),
            });
          });
          returned = true;
        } catch (error) {
          if (!isBusinessRefusal(error)) throw error;
          failure = error;
        }
      }
    }
    if (returned) {
      await tx
        .update(recipeDeductions)
        .set(clear())
        .where(
          and(
            eq(recipeDeductions.tenantId, tenantId),
            eq(recipeDeductions.id, row.id),
          ),
        );
      continue;
    }
    logger.warn(
      { err: failure, orderId: row.orderId, issueId },
      "Swapped line stock return refused again; stays parked",
    );
    await tx
      .update(recipeDeductions)
      .set({
        reversalFailedAt: new Date(),
        reversalReason: "swap",
        reversalSourceId: issueId,
      })
      .where(
        and(
          eq(recipeDeductions.tenantId, tenantId),
          eq(recipeDeductions.id, row.id),
        ),
      );
    await auditSwapReturnFailed(tx, context, {
      outletId,
      deductionId: row.id,
      orderId: row.orderId,
      issueId,
      stage: "retry",
    });
  }
}

// ---------------------------------------------------------------- consumer

/** The sellable lines of a paid order: not voided at the kitchen nor the POS. */
async function paidOrderLines(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  outletId: string,
): Promise<DeductionMenuLine[]> {
  const rows = await tx
    .select({
      menuItemId: orderItems.menuItemId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      modifiers: orderItems.modifiers,
    })
    .from(orderItems)
    .leftJoin(
      posOrderItems,
      and(
        eq(posOrderItems.tenantId, orderItems.tenantId),
        eq(posOrderItems.itemId, orderItems.id),
      ),
    )
    .where(
      and(
        eq(orderItems.tenantId, context.tenant.tenantId),
        eq(orderItems.outletId, outletId as OutletId),
        eq(orderItems.orderId, orderId),
        sql`${orderItems.status} <> 'voided'`,
        isNull(posOrderItems.voidedAt),
        // legend-v51rh: a line swapped away was never cooked, even when a
        // completed order keeps it frozen and non-voided.
        notExists(
          tx
            .select({ one: sql`1` })
            .from(orderIssues)
            .where(
              and(
                eq(orderIssues.tenantId, orderItems.tenantId),
                eq(orderIssues.orderItemId, orderItems.id),
                sql`${orderIssues.replacementOrderItemId} IS NOT NULL`,
              ),
            ),
        ),
      ),
    )
    .orderBy(orderItems.id);
  return rows.map((row) => ({
    menuItemId: row.menuItemId,
    variantId: row.variantId ?? null,
    modifierIds: (row.modifiers ?? []).map((modifier) => modifier.modifierId),
    quantity: row.quantity,
  }));
}

/** A `sale:order:<orderId>` deduction row exists (any status). */
async function saleDeductionExists(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: recipeDeductions.id })
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.idempotencyKey, `sale:order:${orderId}`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function consumeInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
): Promise<void> {
  if (event.name === "order.paid") {
    const parsed = orderPaidPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const payload = parsed.data;
    // legend-13avp (founder Q63): a training order never deducts stock.
    if (await isTrainingOrder(tx, context.tenant.tenantId, payload.orderId))
      return;
    // legend-v51rh: read the lines under a shared order lock, so a swap that
    // runs at the same time (it locks the order FOR UPDATE) is seen whole.
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, context.tenant.tenantId),
          eq(orders.id, payload.orderId),
        ),
      )
      .for("share");
    await recordRecipeDeduction(tx, context, {
      outletId: payload.outletId,
      kind: "sale",
      sourceType: "order",
      sourceId: payload.orderId,
      businessDate: payload.businessDate,
      idempotencyKey: `sale:order:${payload.orderId}`,
      lines: await paidOrderLines(
        tx,
        context,
        payload.orderId,
        payload.outletId,
      ),
      occurredAt: payload.paidAt,
    });
  } else if (event.name === "order_issue.recorded") {
    // remake: the kitchen cooks the line again, so the ingredients leave stock
    // a second time (the sale deduction stays). comp: goods given free that
    // are NOT on a billed/paid line. The emitter must void the comp'd line or
    // never bill it; a comp'd line that is also paid is deducted twice (once
    // by order.paid, once here).
    const parsed = orderIssueRecordedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const payload = parsed.data;
    if (await isTrainingOrder(tx, context.tenant.tenantId, payload.orderId))
      return;
    await recordRecipeDeduction(tx, context, {
      outletId: payload.outletId,
      kind: payload.type,
      sourceType: "order_issue",
      // The ledger source of a remake/comp is its order (see the header).
      sourceId: payload.orderId,
      businessDate: payload.businessDate,
      idempotencyKey: `order_issue:${payload.issueId}`,
      lines: [
        {
          menuItemId: payload.menuItemId,
          variantId: payload.variantId,
          modifierIds: payload.modifierIds,
          quantity: payload.quantity,
        },
      ],
      reason: payload.reason,
      recordedBy: payload.recordedBy,
      occurredAt: payload.occurredAt,
    });
  } else if (event.name === "order.voided") {
    const parsed = orderVoidedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const payload = parsed.data;
    // A void before payment never drew stock; only a final-order void reverses.
    if (!payload.voidedFinalOrder || payload.voidId === null) return;
    // legend-13avp: a training order drew no stock, so its void has nothing to
    // reverse (and must not leave a tombstone). A sale deduction made before
    // this rule existed is still reversed.
    if (
      (await isTrainingOrder(tx, context.tenant.tenantId, payload.orderId)) &&
      !(await saleDeductionExists(tx, context.tenant.tenantId, payload.orderId))
    )
      return;
    await reverseSafely(tx, context, {
      outletId: payload.outletId,
      orderId: payload.orderId,
      reason: "void",
      reversalSourceId: payload.voidId,
      occurredAt: payload.voidedAt,
    });
  } else if (event.name === "day.closed") {
    const parsed = dayClosedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return;
    await postPendingDeductions(tx, context, {
      outletId: parsed.data.outletId,
      businessDate: parsed.data.businessDate,
    });
    await retryParkedReversals(tx, context, parsed.data.outletId);
    await retryParkedSwapReturns(tx, context, parsed.data.outletId);
  }
}

export const RECIPE_DEDUCTION_EVENT_NAMES = [
  "order.paid",
  "order_issue.recorded",
  "order.voided",
  "day.closed",
] as const;

/**
 * Outbox consumer (cloud-sync branch of worker-main.ts). Ignores every other
 * event, and an event of another tenant. Idempotent: a re-delivery finds the
 * deduction by key and posts nothing twice. With `tx` the deduction commits
 * with the consumed offset; without it a tenant transaction is opened.
 */
export async function deliverRecipeDeductionEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx?: Tx,
): Promise<void> {
  if (!(RECIPE_DEDUCTION_EVENT_NAMES as readonly string[]).includes(event.name))
    return;
  if (event.tenantId !== context.tenant.tenantId) return;
  if (tx) return consumeInTransaction(tx, context, event);
  await withTenant(db, context, (own) =>
    consumeInTransaction(own, context, event),
  );
}

// -------------------------------------------------------------- duty meal

/**
 * A staff meal eaten from the menu (PRD §16): deducts the dish's recipe as
 * `duty_meal`, on its own movement type so it never reads as a sale. Needs
 * `inventory.waste.record` at the outlet. Retrying the same key with the same
 * full input by the same user returns the first deduction; any difference is
 * IDEMPOTENCY_KEY_REUSED.
 */
export async function recordDutyMeal(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RecordDutyMealInput,
): Promise<RecipeDeduction> {
  assertOutlet(context, input.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.waste.record",
      input.outletId,
    );
    // The beneficiary must be someone in this tenant; a stranger or a typo
    // is a validation error, not an FK failure (500) or a cross-tenant id.
    const [member] = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.tenantId, context.tenant.tenantId),
          eq(roleAssignments.userId, input.employeeUserId),
        ),
      )
      .limit(1);
    if (!member)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The employee is not a member of this tenant.",
      );
    const key = `${DUTY_MEAL_KEY_PREFIX}${input.idempotencyKey}`;
    const withCost = canViewCost(snapshot, input.outletId);
    const claim = {
      operation: DUTY_MEAL_OPERATION,
      key: input.idempotencyKey,
      outletId: input.outletId,
      fingerprint: requestFingerprint(DUTY_MEAL_OPERATION, actorUserId, {
        menuItemId: input.menuItemId,
        variantId: input.variantId,
        modifierIds: [...input.modifierIds].sort(),
        quantity: input.quantity,
        outletId: input.outletId,
        employeeUserId: input.employeeUserId,
        shiftId: input.shiftId,
        note: input.note,
      }),
    };
    // Same key + same request + same actor replays the stored deduction (a
    // concurrent retry waits on the claim, then replays); anything else is
    // IDEMPOTENCY_KEY_REUSED. Only the claim owner writes the audit row.
    const replay = await claimIdempotency(tx, context, claim);
    if (replay) {
      const stored = recipeDeductionSchema.parse(replay.replay);
      return withCost ? stored : hideCost(stored);
    }
    const clock = await loadOutletClock(tx, input.outletId);
    const now = new Date();
    const id = randomUUID();
    const deduction = await recordRecipeDeduction(tx, context, {
      id,
      outletId: input.outletId,
      kind: "duty_meal",
      sourceType: "duty_meal",
      sourceId: id,
      businessDate: businessDateOf(now, clock),
      idempotencyKey: key,
      lines: [
        {
          menuItemId: input.menuItemId,
          variantId: input.variantId,
          modifierIds: input.modifierIds,
          quantity: input.quantity,
        },
      ],
      reason: input.note,
      recordedBy: actorUserId,
      beneficiaryUserId: input.employeeUserId,
      shiftId: input.shiftId,
      occurredAt: now.toISOString(),
    });
    if (deduction.id !== id)
      // The deduction key exists without our claim: unverifiable, fail closed.
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was used for a different request.",
      );
    await recordOpsAudit(tx, context, {
      actorUserId,
      outletId: input.outletId,
      action: "inventory.duty_meal_recorded",
      objectType: "recipe_deduction",
      objectId: deduction.id,
      before: null,
      after: {
        kind: deduction.kind,
        status: deduction.status,
        mode: deduction.mode,
        businessDate: deduction.businessDate,
        menuItemId: input.menuItemId,
        variantId: input.variantId,
        quantity: input.quantity,
        employeeUserId: input.employeeUserId,
        shiftId: input.shiftId,
        skipReason: deduction.skipReason,
      },
      safeFields: DEDUCTION_AUDIT_FIELDS,
      reason: input.note,
    });
    await completeIdempotency(tx, context, claim, deduction);
    return withCost ? deduction : hideCost(deduction);
  });
}

function hideCost(deduction: RecipeDeduction): RecipeDeduction {
  return {
    ...deduction,
    costIdr: null,
    lines: deduction.lines.map((line) => ({ ...line, unitCostIdr: null })),
  };
}

// -------------------------------------------------------------------- list

/**
 * Deductions of one outlet, newest first. Needs `inventory.stock.view`; cost
 * fields are null without `inventory.cost.view`.
 */
export async function listRecipeDeductions(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RecipeDeductionListQuery,
): Promise<CursorPage<RecipeDeduction>> {
  assertOutlet(context, query.outletId);
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  return withTenant(db, context, async (tx) => {
    const snapshot = await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    const withCost = canViewCost(snapshot, query.outletId);
    const filters = [
      eq(recipeDeductions.tenantId, context.tenant.tenantId),
      eq(recipeDeductions.outletId, query.outletId),
    ];
    if (query.businessDate)
      filters.push(eq(recipeDeductions.businessDate, query.businessDate));
    if (query.kind) filters.push(eq(recipeDeductions.kind, query.kind));
    const [occurredAt, id] = cursorKeys(query.cursor, 2);
    if (occurredAt !== undefined && id !== undefined) {
      const at = cursorInstant(occurredAt);
      filters.push(
        or(
          lt(recipeDeductions.occurredAt, at),
          and(
            eq(recipeDeductions.occurredAt, at),
            sql`${recipeDeductions.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(recipeDeductions)
      .where(and(...filters))
      .orderBy(desc(recipeDeductions.occurredAt), desc(recipeDeductions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const lineRows =
      page.length === 0
        ? []
        : await tx
            .select()
            .from(recipeDeductionLines)
            .where(
              and(
                eq(recipeDeductionLines.tenantId, context.tenant.tenantId),
                inArray(
                  recipeDeductionLines.deductionId,
                  page.map((row) => row.id),
                ),
              ),
            );
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        toDeduction(
          row,
          lineRows.filter((line) => line.deductionId === row.id),
          withCost,
        ),
      ),
      meta: {
        limit,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([last.occurredAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// ---------------------------------------------------- outlet settings

async function toOutletSettings(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletDeductionSettings> {
  const config = await loadDeductionConfig(tx, context, outletId);
  const [row] = await tx
    .select({ updatedAt: outletInventorySettings.updatedAt })
    .from(outletInventorySettings)
    .where(
      and(
        eq(outletInventorySettings.tenantId, context.tenant.tenantId),
        eq(outletInventorySettings.outletId, outletId),
      ),
    );
  return outletDeductionSettingsSchema.parse({
    tenantId: context.tenant.tenantId,
    outletId,
    recipeDeductionMode: config.overrideMode,
    effectiveMode: config.mode,
    saleLocationId: config.saleLocationId,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  });
}

export async function getOutletDeductionSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
): Promise<OutletDeductionSettings> {
  assertOutlet(context, outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      outletId,
    );
    return toOutletSettings(tx, context, outletId);
  });
}

/**
 * Sets the outlet's deduction mode override (null = follow the tenant) and
 * sale location. Same permission as the tenant mode
 * (`inventory.adjustment.approve`); the location must be an active location
 * of this outlet. A full replacement, so a retry is naturally idempotent.
 */
export async function putOutletDeductionSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  input: PutOutletDeductionSettingsInput,
): Promise<OutletDeductionSettings> {
  assertOutlet(context, outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.adjustment.approve",
      outletId,
    );
    if (input.saleLocationId !== null) {
      const [location] = await tx
        .select({ id: stockLocations.id })
        .from(stockLocations)
        .where(
          and(
            eq(stockLocations.tenantId, tenantId),
            eq(stockLocations.outletId, outletId),
            eq(stockLocations.id, input.saleLocationId),
            eq(stockLocations.isActive, true),
          ),
        );
      if (!location)
        throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
    }
    const before = await toOutletSettings(tx, context, outletId);
    const now = new Date();
    await tx
      .insert(outletInventorySettings)
      .values({
        tenantId,
        outletId,
        recipeDeductionMode: input.recipeDeductionMode,
        saleLocationId: input.saleLocationId,
        updatedBy: actorUserId,
      })
      .onConflictDoUpdate({
        target: [
          outletInventorySettings.tenantId,
          outletInventorySettings.outletId,
        ],
        set: {
          recipeDeductionMode: input.recipeDeductionMode,
          saleLocationId: input.saleLocationId,
          updatedBy: actorUserId,
          updatedAt: now,
        },
      });
    const after = await toOutletSettings(tx, context, outletId);
    await recordOpsAudit(tx, context, {
      actorUserId,
      outletId,
      action: "inventory.outlet_deduction_settings_updated",
      objectType: "outlet_inventory_settings",
      objectId: outletId,
      before: {
        recipeDeductionMode: before.recipeDeductionMode,
        saleLocationId: before.saleLocationId,
      },
      after: {
        recipeDeductionMode: after.recipeDeductionMode,
        saleLocationId: after.saleLocationId,
      },
      safeFields: SETTINGS_AUDIT_FIELDS,
    });
    return after;
  });
}

export type { Decimal4 };
