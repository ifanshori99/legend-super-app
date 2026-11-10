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

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  businessDateOf,
  CoreError,
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
import { stockBalances, stockLocations } from "../db/schema/inventory.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { posOrderItems } from "../db/schema/pos-order.ts";
import { orderItems } from "../db/schema/qr-order.ts";
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
    lines: [...lines]
      .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))
      .map((line) => ({
        inventoryItemId: line.inventoryItemId,
        locationId: line.locationId,
        quantity: line.quantity,
        unitCostIdr: withCost ? line.unitCostIdr : null,
        ledgerEntryId: line.ledgerEntryId
          ? uuidToUlid(line.ledgerEntryId)
          : null,
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

type DeductionPlan =
  | { ok: true; items: Map<string, bigint>; note: string | null }
  | { ok: false; reason: RecipeDeductionSkipReason };

/**
 * Explodes all lines through the recipe engine. A menu item without a recipe
 * (retail, service) is left out and its id noted on the deduction `reason`
 * (completeness report); an inactive or broken recipe skips the whole
 * deduction, so stock is never drawn partially by surprise.
 */
async function planDeduction(
  tx: Tx,
  context: ScopedTenantContext,
  saleLocationId: string | null,
  lines: readonly DeductionMenuLine[],
): Promise<DeductionPlan> {
  if (saleLocationId === null) return { ok: false, reason: "no_sale_location" };
  const sellable = lines.filter((line) => line.quantity >= 1);
  if (sellable.length === 0) return { ok: false, reason: "no_recipe" };
  let result: Awaited<ReturnType<typeof explodeMenuLines>>;
  try {
    result = await explodeMenuLines(tx, context, sellable);
  } catch (error) {
    // A recipe/config problem must not fail (and block) the whole delivery.
    if (error instanceof HttpError || error instanceof InventoryError)
      return { ok: false, reason: "recipe_error" };
    throw error;
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  const items = new Map<string, bigint>();
  for (const [itemId, quantity] of result.items) {
    const scaled = parseDecimal4(quantity);
    if (scaled > 0n) items.set(itemId, scaled);
  }
  if (items.size === 0) return { ok: false, reason: "no_recipe" };
  const note =
    result.unmappedMenuItemIds.length === 0
      ? null
      : `no recipe: ${result.unmappedMenuItemIds.join(",")}`;
  return { ok: true, items, note };
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
    [...plan.items.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([inventoryItemId, quantity]) => ({
        tenantId,
        outletId: input.outletId,
        deductionId: id,
        inventoryItemId,
        locationId: config.saleLocationId!,
        quantity: formatDecimal4(quantity),
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
  if (config.saleLocationId === null) return 0;
  const plan = await planDeduction(tx, context, config.saleLocationId, lines);
  if (!plan.ok) return 0;
  const balances = await tx
    .select({
      inventoryItemId: stockBalances.inventoryItemId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, context.tenant.tenantId),
        eq(stockBalances.locationId, config.saleLocationId),
        inArray(stockBalances.inventoryItemId, [...plan.items.keys()]),
      ),
    );
  let scaled = 0n;
  for (const balance of balances)
    scaled +=
      (plan.items.get(balance.inventoryItemId) ?? 0n) *
      parseDecimal4(balance.avgCostIdr);
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
  ).sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
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
      idempotencyKey: `recipe-deduction:${row.id}:${line.inventoryItemId}`,
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
      ).sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
      await lockLocations(
        tx,
        tenantId,
        lines.map((line) => line.locationId),
      );
      for (const line of lines) {
        if (line.unitCostIdr === null) continue; // posted lines always carry it
        await recordStockMovementInTransaction(tx, context, {
          outletId: row.outletId,
          locationId: line.locationId,
          inventoryItemId: line.inventoryItemId,
          movementType: "return",
          quantity: line.quantity,
          unitCostIdr: formatDecimal4(parseDecimal4(line.unitCostIdr)),
          sourceType: "order",
          sourceId: row.sourceId,
          occurredAt: occurredAt.toISOString() as never,
          idempotencyKey: `recipe-reversal:${row.id}:${line.inventoryItemId}`,
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
