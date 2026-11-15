// Cloud side of the edge -> cloud `order.paid` cost snapshot (bead legend-pd9t).
// `order.paid` is parked verbatim by edge/deferred-event-applier.ts (no
// outbox row, no deduction: the edge already deducted stock). Its payload has
// only totals and tenders, and the cloud holds no order_items for an edge
// order, so the order's cost (HPP) comes from the edge `stock.moved` rows that
// the edge posted for it (sourceType 'order', movementType 'sale').
//
// `edge_deferred_events.cost_snapshot_idr` of the parked `order.paid` row is a
// CONVERGENT RECOMPUTE, an assignment and never an increment: after the
// order.paid is parked and after every order-sourced stock.moved is applied,
// it is set to Σ |quantity| x unit cost over the order's ledger rows, rounded
// once. The stock rows arrive after order.paid and possibly in separate
// batches, so any arrival order, replay or retry converges to the same value
// and can never double. No ledger row yet -> the column stays NULL (never
// guessed). Only this module writes the column. The value is informational
// (HPP); it is never a payment, refund or GL source.
//
// legend-8qm1d: when the order is voided (a parked `order.voided` exists), its
// `return` rows (stock given back, valued at their own unit cost) are
// subtracted from the sale cost before the single rounding, clamped at 0. The
// result is still an assignment, so a replayed return row never subtracts
// twice, and a void before or after its return rows converges to one value.
// Without a parked void the return rows are ignored.
import { and, eq, inArray } from "drizzle-orm";
import {
  CoreError,
  idr,
  parseDecimal4,
  uuidToUlid,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import { stockLedger } from "../db/schema/inventory.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";
import { scaledCostToIdr } from "../services/inventory-ops.shared.ts";
import {
  ingestEdgeOrderPaid,
  ingestEdgeOrderVoided,
  lockOrderSource,
} from "./order-ingest.ts";
import {
  ORDER_AGGREGATE,
  registerEdgeParkedEventHook,
  type EdgeParkedEventHook,
} from "./deferred-event-applier.ts";

export const ORDER_PAID_EVENT = "order.paid";
export const ORDER_VOIDED_EVENT = "order.voided";
/** Ledger source type and movement type of an order's recipe deduction. */
const ORDER_SOURCE_TYPE = "order";
const SALE_MOVEMENT_TYPE = "sale";
/** legend-8qm1d: a voided order's stock given back (positive quantity). */
const RETURN_MOVEMENT_TYPE = "return";

/** Any hex 8-4-4-4-12 value; ULID-derived ids are not RFC-versioned uuids. */
const DB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both id forms an edge may use for the same order (ULID and UUID). */
function orderIdForms(orderId: string): string[] {
  const dbId = sourceIdToDb(orderId);
  return [...new Set([orderId, dbId, uuidToUlid(dbId)])];
}

/**
 * Sets the parked `order.paid` row's `cost_snapshot_idr` of `orderId` from the
 * order's edge sale ledger rows (same tenant and outlet). Assigns, never adds:
 * safe to call any number of times, in any order. Does nothing when there is
 * no parked row yet or no ledger row yet. The caller must be inside the edge
 * link's receive transaction.
 */
export async function recomputeEdgeOrderCost(
  tx: EdgeTx,
  tenantId: TenantId,
  orderId: string,
): Promise<void> {
  const dbId = sourceIdToDb(orderId);
  // Not an order id of either form: nothing of ours can match it.
  if (!DB_UUID_PATTERN.test(dbId)) return;
  // Same advisory lock as the stock row insert (inventory.service.ts
  // lockStockSource) and the order ingest (R4), so a concurrent stock.moved
  // and order.paid for one order serialise: the later one always reads the
  // earlier one's rows.
  await lockOrderSource(tx, tenantId, dbId);
  const parked = await tx
    .select({
      eventId: edgeDeferredEvents.eventId,
      outletId: edgeDeferredEvents.outletId,
    })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, tenantId),
        eq(edgeDeferredEvents.aggregateType, ORDER_AGGREGATE),
        eq(edgeDeferredEvents.eventName, ORDER_PAID_EVENT),
        inArray(edgeDeferredEvents.aggregateId, orderIdForms(orderId)),
      ),
    );
  if (parked.length === 0) return;
  const [voided] = await tx
    .select({ eventId: edgeDeferredEvents.eventId })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, tenantId),
        eq(edgeDeferredEvents.aggregateType, ORDER_AGGREGATE),
        eq(edgeDeferredEvents.eventName, ORDER_VOIDED_EVENT),
        inArray(edgeDeferredEvents.aggregateId, orderIdForms(orderId)),
      ),
    )
    .limit(1);
  for (const row of parked) {
    const total = await sumOrderSaleCost(
      tx,
      tenantId,
      row.outletId,
      dbId,
      voided !== undefined,
    );
    if (total === null) continue;
    await tx
      .update(edgeDeferredEvents)
      .set({ costSnapshotIdr: idr(total) })
      .where(
        and(
          eq(edgeDeferredEvents.tenantId, tenantId),
          eq(edgeDeferredEvents.eventId, row.eventId),
        ),
      );
  }
}

/**
 * Σ |quantity| x unit cost of the order's sale rows, minus (voided only) the
 * same for its return rows, clamped at 0, rounded once; null = no sale rows.
 */
async function sumOrderSaleCost(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: OutletId,
  orderDbId: string,
  voided: boolean,
): Promise<number | null> {
  const rows = await tx
    .select({
      movementType: stockLedger.movementType,
      quantity: stockLedger.quantity,
      unitCostIdr: stockLedger.unitCostIdr,
    })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, tenantId),
        eq(stockLedger.outletId, outletId),
        eq(stockLedger.sourceType, ORDER_SOURCE_TYPE),
        eq(stockLedger.sourceId, orderDbId),
        inArray(stockLedger.movementType, [
          SALE_MOVEMENT_TYPE,
          RETURN_MOVEMENT_TYPE,
        ]),
      ),
    );
  let sold = 0n;
  let returned = 0n;
  let hasSale = false;
  for (const row of rows) {
    const quantity = parseDecimal4(row.quantity);
    const value =
      (quantity < 0n ? -quantity : quantity) * parseDecimal4(row.unitCostIdr);
    if (row.movementType === SALE_MOVEMENT_TYPE) {
      hasSale = true;
      sold += value;
    } else returned += value;
  }
  if (!hasSale) return null;
  const net = voided ? sold - returned : sold;
  return scaledCostToIdr(net < 0n ? 0n : net);
}

// Stable identity: the hook registry treats a different hook as a wiring bug.
const costAfterOrderPaidParked: EdgeParkedEventHook = async (
  tx,
  event,
  meta,
) => {
  // A refusal here rolls back the parking of this one event (savepoint) and the
  // link records it as a conflict: a malformed order.paid is never parked.
  if (!orderPaidPayloadSchema.safeParse(event.payload).success)
    throw new CoreError("VALIDATION_ERROR", "Invalid order.paid payload");
  await recomputeEdgeOrderCost(
    tx,
    meta.context.tenant.tenantId,
    event.aggregateId,
  );
  // legend-771dl: rebuild the cloud order. Never throws (refusals are
  // recorded in edge_order_ingests), so parking is never undone.
  await ingestEdgeOrderPaid(tx, event, meta);
};

// Stable identity (see above). Same never-throw rule.
const ingestAfterOrderVoidedParked: EdgeParkedEventHook = async (
  tx,
  event,
  meta,
) => {
  await ingestEdgeOrderVoided(tx, event, meta);
  // legend-8qm1d: the void is parked now; net the order's return rows.
  await recomputeEdgeOrderCost(
    tx,
    meta.context.tenant.tenantId,
    event.aggregateId,
  );
};

/**
 * Cloud boot (registerEdgeLink): after `order.paid` is parked, recompute its
 * cost snapshot from the order's stock rows already received, then ingest
 * the order; `order.voided` ingests the void, then recomputes the cost net of
 * returns. Idempotent.
 * Call alongside registerPosDeferredEdgeApplier.
 */
export function registerOrderEdgeApplier(): void {
  registerEdgeParkedEventHook(ORDER_PAID_EVENT, costAfterOrderPaidParked);
  registerEdgeParkedEventHook(ORDER_VOIDED_EVENT, ingestAfterOrderVoidedParked);
}
