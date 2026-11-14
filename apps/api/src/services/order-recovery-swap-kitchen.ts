// legend-zm1e6 / legend-v32bv: the kitchen side of a failed-item swap. The
// resolve step (order-recovery.service.ts) only settles the issue and appends
// `order_issue.resolved`; this consumer, wired in worker-main.ts, turns a
// `swap` resolution into order lines: a replacement line on the same order
// (priced from the swap price frozen at resolve, daily limit reserved, cost frozen), the old
// line voided, and the replacement routed to its KDS station.
//
// Idempotent: the issue row is locked and `replacement_order_item_id` is the
// once-only marker, so a replayed or concurrent event changes nothing. No
// extra charge: order totals and payments are NOT recalculated (a credit goes
// through the apology voucher; a dearer swap is only recorded, legend-i83ls).
// Events of another tenant or outlet, and every other event, are ignored.

import { and, eq, gte, ne, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { auditLogs } from "../db/schema/core-audit.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { posOrderItems, posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import {
  cancelKitchenItemsForVoidedLines,
  lockKitchenTicketNo,
  routeFiredItemsToKitchen,
} from "./kds.service.ts";
import {
  releaseMenuItemDailyLimit,
  reserveMenuItemDailyLimit,
} from "./menu-availability.ts";
import type { Tx } from "./menu-internals.ts";
import { computeLineCostSnapshots } from "./order-cost-snapshot.service.ts";
import { priceMenuItemForOutlet } from "./qr-order.service.ts";
import { applySwapStockAdjustment } from "./recipe-deduction.service.ts";

const SWAP_VOID_REASON = "item_failed_swap";
const AUDIT_ACTION = "order_issue.swap_kitchen_applied";
const AUDIT_BLOCKED_ACTION = "order_issue.swap_kitchen_blocked";
const AUDIT_SKIPPED_ACTION = "order_issue.swap_kitchen_skipped";
const AUDIT_SAFE_FIELDS = [
  "id",
  "orderItemId",
  "replacementItemId",
  "replacementOrderItemId",
  "oldLine",
  "orderStatus",
  "blockedReason",
];

const payloadSchema = z.looseObject({
  resolution: z.string(),
  orderIssueId: z.string().min(1),
});

/**
 * Applies one `order_issue.resolved` swap event in the consumption
 * transaction `tx`. Anything that is not a swap of this tenant and outlet is
 * a no-op. A replacement that is not orderable (sold out, out of schedule,
 * limit full, price gone) and a voided order do not throw, as a retry cannot
 * fix them and would dead-letter the event: the old line stays, the issue keeps
 * no replacement, and an audit row says why. Technical errors still throw so
 * the outbox retries the event.
 */
export async function deliverSwapKitchenEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
): Promise<void> {
  if (event.name !== "order_issue.resolved") return;
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return;
  const payload = payloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.resolution !== "swap") return;
  const issueId = payload.data.orderIssueId;

  const [issue] = await tx
    .select()
    .from(orderIssues)
    .where(and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.id, issueId)))
    .for("update");
  if (!issue) return;
  if (
    issue.resolution !== "swap" ||
    issue.status !== "resolved" ||
    issue.replacementItemId === null ||
    event.outletId !== issue.outletId
  )
    return;
  // The once-only marker: a replayed event finds the line already created.
  if (issue.replacementOrderItemId !== null) return;

  const [order] = await tx
    .select({
      id: orders.id,
      outletId: orders.outletId,
      status: orders.status,
      businessDate: orders.businessDate,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, issue.orderId)))
    // Lock order after issue (always this sequence): the status read below
    // cannot change to completed/voided between this read and the new line.
    .for("update");
  if (!order || order.outletId !== issue.outletId) return;
  const [oldLine] = await tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        eq(orderItems.id, issue.orderItemId),
      ),
    );
  if (!oldLine) return;

  const now = new Date();
  const actorUserId = event.actor.type === "user" ? event.actor.id : null;
  const auditSwap = (
    action: string,
    after: Record<string, string>,
  ): Promise<void> =>
    recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: order.outletId,
        actorType: actorUserId === null ? "system" : "user",
        actorId: actorUserId,
        deviceId: null,
        action,
        objectType: "order",
        objectId: order.id,
        reason: null,
        maskedChanges: { before: null, after },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );

  // Blocked and skipped leave the once-only marker unset, so a replayed event
  // reaches here again: the issue row lock held above makes this check safe.
  // The audit row is written after the issue was resolved, so a one-day margin
  // before resolvedAt bounds the scan to audit_logs_retention_idx
  // (tenant_id, created_at); the object id narrows it to this order.
  const auditSince = new Date(
    (issue.resolvedAt ?? issue.createdAt).getTime() - 24 * 60 * 60 * 1000,
  );
  const auditSwapOnce = async (
    action: string,
    after: Record<string, string>,
  ): Promise<void> => {
    const [existing] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          gte(auditLogs.createdAt, auditSince),
          sql`${auditLogs.event}->>'objectId' = ${order.id}`,
          sql`${auditLogs.event}->>'action' = ${action}`,
          sql`${auditLogs.event}->'maskedChanges'->'after'->>'id' = ${issue.id}`,
        ),
      )
      .limit(1);
    if (!existing) await auditSwap(action, after);
  };

  // A voided order takes no new line: nothing to cook or to reserve.
  if (order.status === "voided") {
    await auditSwapOnce(AUDIT_SKIPPED_ACTION, {
      id: issue.id,
      orderItemId: oldLine.id,
      replacementItemId: issue.replacementItemId,
      orderStatus: order.status,
    });
    return;
  }

  const priced = (
    await priceMenuItemForOutlet(
      tx,
      context,
      order.outletId,
      [issue.replacementItemId],
      now,
    )
  ).get(issue.replacementItemId);
  if (!priced) {
    // Sold out, out of schedule, limit full, price gone: the catalogue gives no
    // finer reason, and a retry cannot fix it.
    await auditSwapOnce(AUDIT_BLOCKED_ACTION, {
      id: issue.id,
      orderItemId: oldLine.id,
      replacementItemId: issue.replacementItemId,
      blockedReason: "not_orderable",
    });
    return;
  }
  const reservation = await reserveMenuItemDailyLimit(tx, context, {
    outletId: order.outletId,
    menuItemId: priced.menuItemId,
    businessDate: order.businessDate,
    quantity: oldLine.quantity,
    now,
  });
  if (!reservation.allowed) {
    await auditSwapOnce(AUDIT_BLOCKED_ACTION, {
      id: issue.id,
      orderItemId: oldLine.id,
      replacementItemId: priced.menuItemId,
      blockedReason: reservation.reason,
    });
    return;
  }
  const [costSnapshot] = await computeLineCostSnapshots(
    tx,
    context,
    order.outletId,
    [
      {
        menuItemId: priced.menuItemId,
        variantId: null,
        modifierIds: [],
        quantity: oldLine.quantity,
      },
    ],
  );

  // A completed order keeps its sales value on the old line, so the
  // replacement is recorded at zero and revenue is not counted twice. Any other
  // order bills the price frozen at resolve time (the catalogue price only for
  // an older issue without a snapshot).
  const orderCompleted = order.status === "completed";
  const unitPrice = orderCompleted
    ? 0
    : (issue.replacementUnitPriceIdr ?? priced.unitPriceIdr);

  const replacementId = createUlid(now.getTime());
  await tx.insert(orderItems).values({
    id: replacementId,
    tenantId,
    outletId: order.outletId,
    orderId: order.id,
    menuItemId: priced.menuItemId,
    variantId: null,
    name: priced.name,
    quantity: oldLine.quantity,
    unitPriceIdr: idr(unitPrice),
    modifiersTotalIdr: idr(0),
    lineTotalIdr: idr(unitPrice * oldLine.quantity),
    costSnapshotIdr:
      costSnapshot === null || costSnapshot === undefined
        ? null
        : idr(costSnapshot),
    modifiers: [],
    note: null,
    course: oldLine.course,
    fireStatus: "fired",
    status: "queued",
    reservedBusinessDate: order.businessDate,
    createdAt: now,
    updatedAt: now,
  });
  // A POS bill keeps its per-line POS state beside the line.
  const [pos] = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    );
  if (pos)
    await tx.insert(posOrderItems).values({
      itemId: replacementId,
      tenantId,
      outletId: order.outletId,
      orderId: order.id,
      heldByCashier: false,
      firedAt: now,
      createdAt: now,
      updatedAt: now,
    });

  // Lock order (kds.service.ts lockKitchenTicketNo): ticket-no lock BEFORE any
  // station-feed lock. The void below locks a station feed; the routing after
  // it locks ticket-no; a concurrent POS fire does ticket-no then feed. Taking
  // ticket-no first (same `now` as the routing) keeps one order for all three.
  await lockKitchenTicketNo(tx, context, order.outletId, now);

  // The trigger freezes the lines of a completed order: the old
  // line then stays as it is and the audit row says so.
  const frozen = orderCompleted;
  let oldLineOutcome = frozen ? "kept_final_order" : "already_voided";
  if (!frozen) {
    const voided = await tx
      .update(orderItems)
      .set({
        status: "voided",
        voidReason: SWAP_VOID_REASON,
        voidedBy: actorUserId,
        voidApprovedBy: issue.approvedBy,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.id, oldLine.id),
          ne(orderItems.status, "voided"),
        ),
      )
      .returning({ id: orderItems.id });
    if (voided.length > 0) {
      oldLineOutcome = "voided";
      await releaseMenuItemDailyLimit(tx, context, {
        outletId: order.outletId,
        menuItemId: oldLine.menuItemId,
        businessDate: oldLine.reservedBusinessDate,
        quantity: oldLine.quantity,
        now,
      });
      await tx
        .update(posOrderItems)
        .set({
          voidedAt: now,
          voidReasonNote: SWAP_VOID_REASON,
          updatedAt: now,
        })
        .where(
          and(
            eq(posOrderItems.tenantId, tenantId),
            eq(posOrderItems.itemId, oldLine.id),
          ),
        );
      await cancelKitchenItemsForVoidedLines(tx, context, {
        outletId: order.outletId,
        orderId: order.id,
        itemIds: [oldLine.id],
        reason: SWAP_VOID_REASON,
        actor:
          actorUserId === null ? null : { userId: actorUserId, deviceId: null },
        now,
      });
    }
  }

  // A menu without a station is not a kitchen item: the line stays unrouted.
  await routeFiredItemsToKitchen(tx, context, {
    outletId: order.outletId,
    orderId: order.id,
    itemIds: [replacementId],
    actor:
      actorUserId === null ? null : { userId: actorUserId, deviceId: null },
    now,
    onUnresolved: "skip",
  });

  await tx
    .update(orderIssues)
    .set({ replacementOrderItemId: replacementId })
    .where(
      and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.id, issue.id)),
    );

  // legend-v51rh: stock. Before payment nothing to do here (order.paid draws
  // the replacement and skips the swapped-away line); after payment the old
  // line returns to stock and the replacement is drawn.
  await applySwapStockAdjustment(tx, context, {
    outletId: order.outletId,
    orderId: order.id,
    issueId: issue.id,
    businessDate: order.businessDate,
    oldLineId: oldLine.id,
    oldLine: {
      menuItemId: oldLine.menuItemId,
      variantId: oldLine.variantId ?? null,
      modifierIds: (oldLine.modifiers ?? []).map((m) => m.modifierId),
      quantity: oldLine.quantity,
    },
    replacement: {
      menuItemId: priced.menuItemId,
      variantId: null,
      modifierIds: [],
      quantity: oldLine.quantity,
    },
    recordedBy: actorUserId,
    occurredAt: now.toISOString(),
  });

  await auditSwap(AUDIT_ACTION, {
    id: issue.id,
    orderItemId: oldLine.id,
    replacementItemId: priced.menuItemId,
    replacementOrderItemId: replacementId,
    oldLine: oldLineOutcome,
  });
}
