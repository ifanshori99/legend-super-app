// Re-posting skipped recipe deductions (bead legend-q55i; INV-02).
//
// A sale or order issue whose deduction was skipped (`no_sale_location`,
// `no_recipe`, `recipe_inactive`, `recipe_error`) is a terminal
// `recipe_deductions` row: a replay of the source event returns it unchanged.
// Once the configuration is fixed, an operator with
// `inventory.adjustment.approve` re-posts the skipped rows of one outlet and
// business date:
//   - the lines are rebuilt from the source of truth, not from a stored
//     payload: `order_items` of the paid order (sale) or the `order_issues` row
//     and its order line (remake/comp, swap remake);
//   - the SAME row is updated (skipped -> pending -> posted); no row is added.
//     The deduction key and the ledger keys `recipe-deduction:<id>:<item>` stay,
//     so posting twice is impossible: the second repost finds no skipped row;
//   - a row that still cannot be planned stays skipped (its reason is refreshed);
//   - a training order, a voided order (status `voided` or a POS correction
//     void) and a cancelled issue are never posted;
//   - a sale never counts a line a swap deduction (`swap:issue:<id>`) already
//     drew (a swap on the paid order while the sale was skipped);
//   - lock order is the swap's: the order row (FOR SHARE) first, then the
//     deduction row (FOR UPDATE); rows are walked by keyset (occurredAt, id), so
//     rows that cannot be posted never crowd out the ones behind them;
//   - each row runs in its own savepoint: a stock rule refusing the posting
//     rolls that row back alone and leaves it skipped.
// Duty meals are not re-postable (their menu line is not stored).

import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  formatDecimal4,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  skippedDeductionSummarySchema,
  type RecipeDeductionSkipReason,
  type RepostSkippedDeductionsResult,
  type SkippedDeductionSummary,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { posOrderVoids } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recipeDeductionLines, recipeDeductions } from "../db/schema/recipe.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { isTrainingOrder } from "./device-training.ts";
import {
  assertOutlet,
  recordOpsAudit,
  requireOpsPermission,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  loadDeductionConfig,
  paidOrderLines,
  planDeduction,
  postRecipeDeduction,
  type DeductionMenuLine,
} from "./recipe-deduction.service.ts";

/** Rows reposted by one call (bounds the audit rows); the rest stays skipped. */
const MAX_REPOST_PER_CALL = 500;
const SCAN_PAGE_SIZE = 200;
const REPOST_PERMISSION = "inventory.adjustment.approve";
const REPOST_AUDIT_FIELDS = [
  "kind",
  "status",
  "mode",
  "businessDate",
  "skipReason",
] as const;
const REPOSTABLE_KINDS = ["sale", "remake", "comp"] as const;
const ISSUE_KEY = /^(?:order_issue|swap:issue):([0-9a-f-]{36})$/;

type SkippedRow = typeof recipeDeductions.$inferSelect;

/**
 * Replacement lines of the order's swaps whose own `swap:issue:<id>` deduction
 * exists: that deduction drew them, so the sale must not count them again.
 */
async function swapDrawnLineIds(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<string[]> {
  const swaps = await tx
    .select({
      id: orderIssues.id,
      lineId: orderIssues.replacementOrderItemId,
    })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.orderId, orderId),
        isNotNull(orderIssues.replacementOrderItemId),
      ),
    );
  if (swaps.length === 0) return [];
  const drawn = await tx
    .select({ key: recipeDeductions.idempotencyKey })
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        inArray(
          recipeDeductions.idempotencyKey,
          swaps.map((swap) => `swap:issue:${swap.id}`),
        ),
      ),
    );
  const keys = new Set(drawn.map((row) => row.key));
  return swaps.flatMap((swap) =>
    swap.lineId !== null && keys.has(`swap:issue:${swap.id}`)
      ? [swap.lineId]
      : [],
  );
}

/** The menu lines of the source of a skipped row; null = nothing to post. */
async function sourceLines(
  tx: Tx,
  context: ScopedTenantContext,
  row: SkippedRow,
): Promise<DeductionMenuLine[] | null> {
  const tenantId = context.tenant.tenantId;
  if (row.sourceType === "order")
    return paidOrderLines(
      tx,
      context,
      row.sourceId,
      row.outletId,
      await swapDrawnLineIds(tx, tenantId, row.sourceId),
    );
  if (row.sourceType !== "order_issue") return null;
  const match = ISSUE_KEY.exec(row.idempotencyKey);
  if (!match) return null;
  const isSwap = row.idempotencyKey.startsWith("swap:issue:");
  const [issue] = await tx
    .select({
      orderId: orderIssues.orderId,
      orderItemId: orderIssues.orderItemId,
      replacementOrderItemId: orderIssues.replacementOrderItemId,
      status: orderIssues.status,
    })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, tenantId),
        eq(orderIssues.outletId, row.outletId as OutletId),
        eq(orderIssues.id, match[1]!),
      ),
    );
  if (!issue || issue.status === "cancelled") return null;
  if (issue.orderId !== row.sourceId) return null;
  const lineId = isSwap ? issue.replacementOrderItemId : issue.orderItemId;
  if (!lineId) return null;
  const [line] = await tx
    .select({
      menuItemId: orderItems.menuItemId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      modifiers: orderItems.modifiers,
    })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.outletId, row.outletId as OutletId),
        eq(orderItems.orderId, row.sourceId),
        eq(orderItems.id, lineId),
      ),
    );
  if (!line) return null;
  return [
    {
      menuItemId: line.menuItemId,
      variantId: line.variantId ?? null,
      modifierIds: (line.modifiers ?? []).map((m) => m.modifierId),
      quantity: line.quantity,
    },
  ];
}

type RepostOutcome = "reposted" | "still_skipped" | "gone";

/**
 * Tries to post one skipped row: locks its order, then the row. `reposted` =
 * it left `skipped` (posted, or pending for the day close); `gone` = it was no
 * longer skipped once locked.
 */
async function repostRow(
  tx: Tx,
  context: ScopedTenantContext,
  candidate: SkippedRow,
): Promise<RepostOutcome> {
  const tenantId = context.tenant.tenantId;
  if (await isTrainingOrder(tx, tenantId, candidate.sourceId))
    return "still_skipped";
  // Lock order of a swap: the order first (here FOR SHARE, as the consumer),
  // then the deduction row. A voided or missing order is never posted (a final
  // void found this row skipped and had nothing to reverse).
  const [order] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, candidate.outletId as OutletId),
        eq(orders.id, candidate.sourceId),
      ),
    )
    .for("share");
  const [row] = await tx
    .select()
    .from(recipeDeductions)
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.id, candidate.id),
        eq(recipeDeductions.status, "skipped"),
      ),
    )
    .for("update");
  // Posted (or reversed) by a concurrent call since the page was read.
  if (!row) return "gone";
  if (!order || order.status === "voided") return "still_skipped";
  // A POS correction void leaves the order status alone (pos_order_voids).
  const [voided] = await tx
    .select({ id: posOrderVoids.id })
    .from(posOrderVoids)
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.orderId, row.sourceId),
      ),
    )
    .limit(1);
  if (voided) return "still_skipped";

  const lines = await sourceLines(tx, context, row);
  if (lines === null) return "still_skipped";
  const config = await loadDeductionConfig(tx, context, row.outletId);
  const plan = await planDeduction(
    tx,
    context,
    row.outletId,
    config.saleLocationId,
    lines,
  );
  if (!plan.ok) {
    if (plan.reason !== row.skipReason)
      await tx
        .update(recipeDeductions)
        .set({ skipReason: plan.reason })
        .where(
          and(
            eq(recipeDeductions.tenantId, tenantId),
            eq(recipeDeductions.id, row.id),
          ),
        );
    return "still_skipped";
  }

  const reason =
    [row.reason, plan.note]
      .filter((part): part is string => part !== null && part !== "")
      .join("; ")
      .slice(0, 200) || null;
  await tx
    .delete(recipeDeductionLines)
    .where(
      and(
        eq(recipeDeductionLines.tenantId, tenantId),
        eq(recipeDeductionLines.deductionId, row.id),
      ),
    );
  await tx.insert(recipeDeductionLines).values(
    [...plan.draws]
      .sort(
        (a, b) =>
          a.itemId.localeCompare(b.itemId) ||
          a.locationId.localeCompare(b.locationId),
      )
      .map((draw) => ({
        tenantId,
        outletId: row.outletId,
        deductionId: row.id,
        inventoryItemId: draw.itemId,
        locationId: draw.locationId,
        quantity: formatDecimal4(draw.quantity),
        unitCostIdr: null,
        ledgerEntryId: null,
      })),
  );
  await tx
    .update(recipeDeductions)
    .set({ status: "pending", mode: config.mode, skipReason: null, reason })
    .where(
      and(
        eq(recipeDeductions.tenantId, tenantId),
        eq(recipeDeductions.id, row.id),
      ),
    );
  if (config.mode === "real_time")
    await postRecipeDeduction(tx, context, row.id);
  return "reposted";
}

/**
 * Re-posts the skipped deductions of one outlet and business date. Needs
 * `inventory.adjustment.approve` at the outlet. Idempotent: posted rows are no
 * longer skipped, so a second call posts nothing.
 */
export async function repostSkippedDeductions(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId: string; businessDate: string },
): Promise<RepostSkippedDeductionsResult> {
  assertOutlet(context, input.outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      REPOST_PERMISSION,
      input.outletId,
    );
    const skippedOfDay = and(
      eq(recipeDeductions.tenantId, tenantId),
      eq(recipeDeductions.outletId, input.outletId),
      eq(recipeDeductions.businessDate, input.businessDate),
      eq(recipeDeductions.status, "skipped"),
      inArray(recipeDeductions.kind, [...REPOSTABLE_KINDS]),
    );
    // Keyset walk (occurredAt, id) without row locks: each row is locked in
    // repostRow, after its order. Rows that cannot be posted (training, void,
    // cancelled issue, config still wrong) never crowd out the ones behind them.
    let cursor: { occurredAt: Date; id: string } | null = null;
    let reposted = 0;
    let stillSkipped = 0;
    let capped = false;
    while (!capped) {
      const page: SkippedRow[] = await tx
        .select()
        .from(recipeDeductions)
        .where(
          cursor === null
            ? skippedOfDay
            : and(
                skippedOfDay,
                or(
                  gt(recipeDeductions.occurredAt, cursor.occurredAt),
                  and(
                    eq(recipeDeductions.occurredAt, cursor.occurredAt),
                    gt(recipeDeductions.id, cursor.id),
                  ),
                ),
              ),
        )
        .orderBy(asc(recipeDeductions.occurredAt), asc(recipeDeductions.id))
        .limit(SCAN_PAGE_SIZE);
      for (const row of page) {
        cursor = { occurredAt: row.occurredAt, id: row.id };
        if (reposted >= MAX_REPOST_PER_CALL) {
          capped = true;
          break;
        }
        let outcome = "still_skipped" as RepostOutcome;
        try {
          await tx.transaction(async (savepoint) => {
            outcome = await repostRow(savepoint, context, row);
          });
        } catch (error) {
          // A stock rule (or other refusal) rolls this row back alone.
          outcome = "still_skipped";
          logger.warn(
            { err: error, deductionId: row.id, outletId: input.outletId },
            "Skipped recipe deduction not reposted; left skipped",
          );
        }
        if (outcome === "gone") continue;
        if (outcome === "still_skipped") {
          stillSkipped += 1;
          continue;
        }
        reposted += 1;
        const [after] = await tx
          .select({
            status: recipeDeductions.status,
            mode: recipeDeductions.mode,
          })
          .from(recipeDeductions)
          .where(
            and(
              eq(recipeDeductions.tenantId, tenantId),
              eq(recipeDeductions.id, row.id),
            ),
          );
        await recordOpsAudit(tx, context, {
          actorUserId,
          outletId: input.outletId,
          action: "inventory.recipe_deduction_reposted",
          objectType: "recipe_deduction",
          objectId: row.id,
          before: { status: "skipped", skipReason: row.skipReason },
          after: {
            kind: row.kind,
            status: after?.status ?? "pending",
            mode: after?.mode ?? row.mode,
            businessDate: row.businessDate,
            skipReason: null,
          },
          safeFields: REPOST_AUDIT_FIELDS,
        });
      }
      if (page.length < SCAN_PAGE_SIZE) break;
    }
    if (capped && cursor !== null) {
      // The cap stopped the walk: what is left is still skipped (the row at the
      // cursor was not tried either).
      const last: { occurredAt: Date; id: string } = cursor;
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(recipeDeductions)
        .where(
          and(
            skippedOfDay,
            or(
              gt(recipeDeductions.occurredAt, last.occurredAt),
              and(
                eq(recipeDeductions.occurredAt, last.occurredAt),
                sql`${recipeDeductions.id} >= ${last.id}::uuid`,
              ),
            ),
          ),
        );
      stillSkipped += left?.n ?? 0;
    }
    return { reposted, stillSkipped };
  });
}

/**
 * Skipped deductions of one outlet and business date per skip reason (all
 * kinds). Needs `inventory.adjustment.approve` at the outlet.
 */
export async function getSkippedDeductionSummary(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId: string; businessDate: string },
): Promise<SkippedDeductionSummary> {
  assertOutlet(context, input.outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      REPOST_PERMISSION,
      input.outletId,
    );
    const rows = await tx
      .select({
        reason: recipeDeductions.skipReason,
        n: sql<number>`count(*)::int`,
      })
      .from(recipeDeductions)
      .where(
        and(
          eq(recipeDeductions.tenantId, context.tenant.tenantId as TenantId),
          eq(recipeDeductions.outletId, input.outletId),
          eq(recipeDeductions.businessDate, input.businessDate),
          eq(recipeDeductions.status, "skipped"),
        ),
      )
      .groupBy(recipeDeductions.skipReason);
    const byReason: Record<RecipeDeductionSkipReason, number> = {
      no_recipe: 0,
      no_sale_location: 0,
      recipe_inactive: 0,
      recipe_error: 0,
    };
    for (const row of rows)
      if (row.reason !== null && row.reason in byReason)
        byReason[row.reason as RecipeDeductionSkipReason] = row.n;
    return skippedDeductionSummarySchema.parse({
      outletId: input.outletId,
      businessDate: input.businessDate,
      byReason,
      total: Object.values(byReason).reduce((sum, n) => sum + n, 0),
    });
  });
}
