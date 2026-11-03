// POS / captain / manual-ojol order lifecycle on the edge (bead legend-kk7;
// PRD v1.7 §3 F8 "POS Kasir & Captain Order": Pesanan Langsung, Captain
// Order, Hold & Fire; §6 C orders, order_items, order_events; POS-01, POS-04;
// contract @starter/shared/pos endpoints.ts).
//
// - POS-01 "Transaksi standar tersimpan ≤ 1 detik di edge node": every write
//   is one tenant transaction on the local database (the same image runs in
//   EDGE_MODE, legend-2pi), with no network call except a QRIS tender.
// - POS-04: final orders (completed / voided) are never edited or deleted —
//   `assertMutable` here, the immutability triggers in pos-order.custom.sql
//   underneath. A completed sale is corrected only by a linked void/refund
//   record (pos-order-corrections.ts).
// - Hold & fire (F8): lines are stored `held`; submit fires the lines the
//   cashier did not hold; the fire endpoint releases held lines by item or by
//   course. The first fire moves the order awaiting_payment -> sent; later
//   courses fire without a status change (the contract has no sent -> sent
//   transition).
// - ORD-05 reused: each line reserves its outlet-business-date daily limit
//   inside the order transaction; a void releases exactly once per line, in
//   the transaction that moves it to `voided`, on the date it reserved.
// - Every state change appends `order_events`; the contract events
//   (order.submitted, order.paid, order.voided, order.refunded) go to the
//   transactional outbox in the same transaction. Sensitive writes (void,
//   discount, refund, override use) are audited.

import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  ulidToUuid,
  z,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  canTransitionPosOrder,
  createPosOrder as createPosOrderEndpoint,
  firePosOrderItems as fireEndpoint,
  listPosOrderEvents as listEventsEndpoint,
  listPosOrders as listEndpoint,
  POS_ORDER_ACTIONS,
  posApprovalPolicySchema,
  posOrderEventSchema,
  posOrderEventTypeSchema,
  PosError,
  tenderBucket,
  transitionPosOrder,
  voidPosOrder as voidEndpoint,
  voidPosOrderItem as voidItemEndpoint,
  completePosOrder as completeEndpoint,
  submitPosOrder as submitEndpoint,
  type PosApprovalPolicy,
  type PosOrderAction,
  type PosOrderDetail,
  type PosOrderEvent,
  type PosOrderSummary,
} from "@starter/shared/pos";
import { resolveTaxSettings } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { tableSessions } from "../db/schema/index.ts";
import {
  orderEvents,
  posApprovalPolicies,
  posOrderItems,
  posOrders,
  posOrderTenders,
} from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  releaseMenuItemDailyLimit,
  reserveMenuItemDailyLimit,
} from "./menu-availability.ts";
import type { Tx } from "./menu-internals.ts";
import {
  computePosBill,
  loadPosCatalogue,
  loadPosTaxConfig,
  posPriceChannel,
  resolveLine,
} from "./pos-order-pricing.ts";
import {
  posOrderPromoPort,
  posReceiptPort,
  posShiftLookup,
} from "./pos-order-ports.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  assertExpectedStatus,
  assertExpectedVersion,
  assertMutable,
  assertNoPendingGatewayTender,
  auditPos,
  businessDateFor,
  bumpPos,
  capturedIdr,
  consumeApproval,
  itemsOf,
  liveDiscountsOf,
  loadOutlet,
  lockPosOrder,
  orderDetail,
  posDepositFor,
  posIdempotent,
  readPosOrder,
  remainingIdr,
  repriceOrder,
  summaryDto,
  tendersOf,
  zoneOfSession,
  type Locked,
  type OrderRow,
  type PosCaller,
} from "./pos-order-support.ts";
import { recordTaxSnapshots } from "./tax.service.ts";
import { loadTaxConfig } from "./qr-order-pricing.ts";
import { lockTableLiveState } from "./table-session.service.ts";

type CreateInput = z.output<typeof createPosOrderEndpoint.body>;
type SubmitInput = z.output<typeof submitEndpoint.body>;
type FireInput = z.output<typeof fireEndpoint.body>;
type CompleteInput = z.output<typeof completeEndpoint.body>;
type VoidInput = z.output<typeof voidEndpoint.body>;
type VoidItemInput = z.output<typeof voidItemEndpoint.body>;
type ListQuery = z.output<typeof listEndpoint.query>;
type EventsQuery = z.output<typeof listEventsEndpoint.query>;

const OJOL_CHANNELS = new Set(["gofood", "grabfood", "shopeefood"]);
const ACTIVE_SESSION_STATUSES = new Set(["open", "bill_requested"]);

/**
 * A POS mutation: one tenant transaction, idempotent under the request key,
 * the order locked, the client's version checked. `run` returns the stored
 * (replayable) response.
 */
export async function mutatePosOrder<T>(
  context: ScopedTenantContext,
  caller: PosCaller,
  input: {
    outletId: OutletId;
    orderId: string;
    key: string;
    operation: string;
    request: unknown;
  },
  run: (tx: Tx, locked: Locked) => Promise<T>,
): Promise<T> {
  return withTenant(db, context, (tx) =>
    posIdempotent(
      tx,
      context,
      {
        outletId: input.outletId,
        actorId: caller.userId,
        key: input.key,
        operation: input.operation,
        target: input.orderId,
        request: {
          body: input.request,
          expectedVersion: caller.expectedVersion,
        },
      },
      async () => {
        const locked = await lockPosOrder(
          tx,
          context,
          input.outletId,
          input.orderId,
        );
        assertExpectedVersion(locked.pos, caller.expectedVersion);
        return run(tx, locked);
      },
    ),
  );
}

function orderNumberFor(
  channel: string,
  businessDate: string,
  orderId: string,
): string {
  const prefix =
    {
      pos: "P",
      captain: "C",
      gofood: "GF",
      grabfood: "GR",
      shopeefood: "SF",
      reservation: "R",
      kiosk: "K",
    }[channel] ?? "P";
  return `${prefix}${businessDate.replaceAll("-", "").slice(2)}-${orderId.slice(-8)}`;
}

/** Re-reads the order + POS row after writes and renders the contract DTO. */
export async function freshDetail(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<PosOrderDetail> {
  return orderDetail(
    tx,
    context,
    await readPosOrder(tx, context, outletId, orderId),
  );
}

// ---- Reads --------------------------------------------------------------------

/** GET /api/outlets/:outletId/pos/orders — newest first, keyset on the ULID. */
export async function listPosOrders(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: ListQuery,
): Promise<CursorPage<PosOrderSummary>> {
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const tenantId = context.tenant.tenantId;
    const filters = [
      eq(orders.tenantId, tenantId),
      eq(orders.outletId, outletId),
    ];
    if (query.status) filters.push(eq(orders.status, query.status));
    if (query.channel) filters.push(eq(orders.channel, query.channel));
    if (query.serviceType)
      filters.push(eq(orders.serviceType, query.serviceType));
    if (query.shiftId) filters.push(eq(posOrders.shiftId, query.shiftId));
    if (query.deviceId) filters.push(eq(posOrders.deviceId, query.deviceId));
    if (query.cursor) {
      let after: string;
      try {
        const [id] = decodeCursor(query.cursor);
        after = z.string().min(26).max(26).parse(id);
      } catch {
        throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
      }
      filters.push(lt(orders.id, after));
    }
    const rows = await tx
      .select({ order: orders, pos: posOrders })
      .from(orders)
      .innerJoin(
        posOrders,
        and(
          eq(posOrders.tenantId, orders.tenantId),
          eq(posOrders.orderId, orders.id),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(orders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const ids = page.map((row) => row.order.id);
    const counts = new Map<
      string,
      { itemCount: number; heldItemCount: number }
    >();
    if (ids.length > 0) {
      const countRows = await tx
        .select({
          orderId: orderItems.orderId,
          itemCount: sql<number>`count(*)::int`,
          heldItemCount: sql<number>`count(*) FILTER (WHERE ${orderItems.fireStatus} = 'held')::int`,
        })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            inArray(orderItems.orderId, ids),
            ne(orderItems.status, "voided"),
          ),
        )
        .groupBy(orderItems.orderId);
      for (const row of countRows)
        counts.set(row.orderId, {
          itemCount: Number(row.itemCount),
          heldItemCount: Number(row.heldItemCount),
        });
    }
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        summaryDto(
          row.order,
          row.pos,
          counts.get(row.order.id) ?? { itemCount: 0, heldItemCount: 0 },
        ),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.order.id])
            : null,
      },
    };
  });
}

export async function getPosOrder(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<{ detail: PosOrderDetail; version: number }> {
  return withTenant(db, context, async (tx) => {
    const locked = await readPosOrder(tx, context, outletId, orderId);
    return {
      detail: await orderDetail(tx, context, locked),
      version: locked.pos.version,
    };
  });
}

/** The current order version, for the `ETag` header after a write. */
export async function posOrderVersion(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<number> {
  return withTenant(db, context, async (tx) => {
    const locked = await readPosOrder(tx, context, outletId, orderId);
    return locked.pos.version;
  });
}

/**
 * GET .../events — the §6 append-only log, oldest first, keyset on sequence.
 * Only the event types the contract declares (posOrderEventTypeSchema) are
 * returned; the other state-change rows (created, fired, item voided,
 * discount, tender, completed) stay in the log for edge sync until the
 * contract widens its type list (follow-up bead).
 */
export async function listPosOrderEvents(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
  query: EventsQuery,
): Promise<CursorPage<PosOrderEvent>> {
  return withTenant(db, context, async (tx) => {
    await readPosOrder(tx, context, outletId, orderId);
    const filters = [
      eq(orderEvents.tenantId, context.tenant.tenantId),
      eq(orderEvents.orderId, orderId),
      inArray(orderEvents.type, [...posOrderEventTypeSchema.options]),
    ];
    if (query.cursor) {
      let after: number;
      try {
        const [sequence] = decodeCursor(query.cursor);
        after = z.number().int().positive().parse(sequence);
      } catch {
        throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
      }
      filters.push(gt(orderEvents.sequence, after));
    }
    const rows = await tx
      .select()
      .from(orderEvents)
      .where(and(...filters))
      .orderBy(asc(orderEvents.sequence))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        posOrderEventSchema.parse({
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          orderId: row.orderId,
          type: row.type,
          payload: row.payload,
          actorId: row.actorId,
          deviceId: row.deviceId,
          sequence: row.sequence,
          occurredAt: row.occurredAt.toISOString(),
        }),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.sequence])
            : null,
      },
    };
  });
}

/**
 * GET .../pos/policy (POS-02 threshold). The outlet row wins over the tenant
 * row. Fail closed without one: a 1 bp threshold, so every manual discount
 * needs approval. The cash rounding increment is the tax settings' bill
 * rounding (F11), 1 when none is configured.
 */
export async function getPosApprovalPolicy(
  context: ScopedTenantContext,
  outletId: OutletId,
  now = new Date(),
): Promise<PosApprovalPolicy> {
  return withTenant(db, context, async (tx) => {
    const outlet = await loadOutlet(tx, context, outletId);
    const thresholdBp = await discountThresholdBp(tx, context, outletId);
    let increment = 1;
    try {
      const config = await loadTaxConfig(tx, context, outletId);
      const settings = resolveTaxSettings(
        config.settings,
        outletId as OutletId,
        businessDateFor(outlet, now),
      );
      increment = settings.billRounding?.incrementIdr ?? 1;
    } catch {
      increment = 1;
    }
    return posApprovalPolicySchema.parse({
      tenantId: context.tenant.tenantId,
      outletId,
      discountThresholdBp: thresholdBp,
      cashRoundingIncrementIdr: Math.min(Math.max(1, increment), 1_000),
    });
  });
}

export async function discountThresholdBp(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<number> {
  const rows = await tx
    .select()
    .from(posApprovalPolicies)
    .where(eq(posApprovalPolicies.tenantId, context.tenant.tenantId));
  const outletRow = rows.find((row) => row.outletId === outletId);
  const tenantRow = rows.find((row) => row.outletId === null);
  return (outletRow ?? tenantRow)?.discountThresholdBp ?? 1;
}

/** GET .../actions — what the payment panel may offer now. */
export async function getPosOrderActions(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<{
  allowed: PosOrderAction[];
  canSettle: boolean;
  canCorrect: boolean;
}> {
  return withTenant(db, context, async (tx) => {
    const { order } = await readPosOrder(tx, context, outletId, orderId);
    const items = await itemsOf(tx, context, orderId);
    const held = items.some(
      ({ item }) => item.status !== "voided" && item.fireStatus === "held",
    );
    const tenders = await tendersOf(tx, context, orderId);
    const status = order.status;
    const allowed = POS_ORDER_ACTIONS.filter((action) => {
      if (action === "fire")
        return (status === "awaiting_payment" || status === "sent") && held;
      if (!canTransitionPosOrder(status, action)) return false;
      if (action === "void") return capturedIdr(tenders) === 0;
      if (action === "complete")
        return !held && remainingIdr(order, tenders) === 0;
      return true;
    });
    const settleable = status === "awaiting_payment" || status === "sent";
    return {
      allowed,
      canSettle: settleable && remainingIdr(order, tenders) > 0,
      canCorrect: status === "completed",
    };
  });
}

// ---- Create -------------------------------------------------------------------

/**
 * POST .../pos/orders. Server-priced lines (ORD-03), daily limits reserved in
 * this transaction (ORD-05), stored as a `draft` with every line held.
 * Manual ojol orders carry the platform order number (`externalRef`), unique
 * per outlet and channel so a driver's order is never injected twice.
 */
export async function createPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  input: CreateInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  if (input.channel === "qr")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pesanan QR dibuat dari meja pelanggan, bukan dari POS.",
    );
  const ojol = OJOL_CHANNELS.has(input.channel);
  const externalRef = input.externalRef ?? null;
  if (ojol && externalRef === null)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pesanan ojek online wajib mencantumkan nomor pesanan platform.",
    );
  if (!ojol && externalRef !== null)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Nomor pesanan platform hanya untuk kanal ojek online.",
    );
  if (ojol && input.serviceType === "dine_in")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pesanan ojek online tidak makan di tempat.",
    );
  const tableSessionId = input.tableSessionId ?? null;
  if (tableSessionId !== null && input.serviceType !== "dine_in")
    throw new CoreError(
      "VALIDATION_ERROR",
      "Sesi meja hanya untuk pesanan makan di tempat.",
    );
  if (input.channel === "captain" && tableSessionId === null)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Captain order dicatat untuk sesi meja yang sedang berjalan.",
    );

  return withTenant(db, context, (tx) =>
    posIdempotent(
      tx,
      context,
      {
        outletId,
        actorId: caller.userId,
        key: idempotencyKey,
        operation: "order.create",
        target: outletId,
        request,
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        const outlet = await loadOutlet(tx, context, outletId);
        if (tableSessionId !== null) {
          const [found] = await tx
            .select({ tableId: tableSessions.tableId })
            .from(tableSessions)
            .where(
              and(
                eq(tableSessions.tenantId, tenantId),
                eq(tableSessions.id, tableSessionId),
                eq(tableSessions.outletId, outletId),
              ),
            );
          if (!found)
            throw new CoreError("NOT_FOUND", "Sesi meja tidak ditemukan.");
          // Serializes with session confirm/close/move (table-session.service).
          await lockTableLiveState(tx, tenantId, found.tableId);
          const [session] = await tx
            .select()
            .from(tableSessions)
            .where(
              and(
                eq(tableSessions.tenantId, tenantId),
                eq(tableSessions.id, tableSessionId),
              ),
            )
            .for("share");
          if (!session || !ACTIVE_SESSION_STATUSES.has(session.status))
            throw new CoreError(
              "CONFLICT",
              "Sesi meja ini tidak sedang berjalan.",
            );
        }
        if (externalRef !== null) {
          const [duplicate] = await tx
            .select({ orderId: posOrders.orderId })
            .from(posOrders)
            .where(
              and(
                eq(posOrders.tenantId, tenantId),
                eq(posOrders.outletId, outletId),
                eq(posOrders.channel, input.channel),
                eq(posOrders.externalRef, externalRef),
              ),
            );
          if (duplicate)
            throw new CoreError(
              "CONFLICT",
              "Pesanan platform dengan nomor ini sudah tercatat.",
            );
        }

        const businessDate = businessDateFor(outlet, now);
        const channel = posPriceChannel(input.channel, input.serviceType);
        const catalogue = await loadPosCatalogue(tx, context, {
          brandId: outlet.brandId,
          outletId: outlet.id as OutletId,
          timeZone: outlet.timezone,
          businessDate,
          channel,
          itemIds: input.items.map((line) => line.menuItemId),
          now,
        });
        const orderId = createUlid(now.getTime());
        const resolved = input.items.map((line, index) => {
          const item = catalogue.get(line.menuItemId);
          const resolution = resolveLine(item, {
            menuItemId: line.menuItemId,
            variantId: line.variantId ?? null,
            quantity: line.quantity,
            modifierIds: line.modifierIds,
          });
          if (!resolution.ok || !item)
            throw resolution.ok || resolution.reason === "sold_out"
              ? new CoreError(
                  "CONFLICT",
                  `ORD-05: menu baris ${index + 1} sedang tidak dapat dijual.`,
                )
              : new CoreError("VALIDATION_ERROR", resolution.message);
          return {
            id: createUlid(now.getTime() + index + 1),
            line,
            item,
            priced: resolution.line,
          };
        });
        // ORD-05: reserve each line's daily stock in this transaction; one
        // line that cannot be reserved refuses the order (nothing is kept).
        for (const entry of resolved) {
          const reservation = await reserveMenuItemDailyLimit(tx, context, {
            outletId,
            menuItemId: entry.line.menuItemId,
            businessDate,
            quantity: entry.line.quantity,
            now,
          });
          if (!reservation.allowed)
            throw new CoreError(
              "CONFLICT",
              `ORD-05: ${entry.priced.name} sudah habis untuk hari ini.`,
            );
        }
        const zone =
          tableSessionId !== null
            ? await zoneOfSession(tx, context, tableSessionId)
            : null;
        const bill = computePosBill({
          context,
          outletId: outlet.id as OutletId,
          businessDate,
          channel,
          zone,
          lines: resolved.map((entry) => ({
            lineId: entry.id,
            menuItemId: entry.line.menuItemId,
            categoryId: entry.item.categoryId,
            quantity: entry.line.quantity,
            unitPriceIdr: entry.priced.unitPriceIdr,
            modifiersTotalIdr: entry.priced.modifiersTotalIdr,
          })),
          orderDiscountIdr: 0,
          taxConfig: await loadPosTaxConfig(tx, context, outletId),
        });
        const deposit = await posDepositFor(
          tx,
          context,
          { id: orderId, tableSessionId },
          bill.totalIdr,
        );
        const [order] = await tx
          .insert(orders)
          .values({
            id: orderId,
            tenantId,
            outletId,
            number: orderNumberFor(input.channel, businessDate, orderId),
            channel: input.channel,
            serviceType: input.serviceType,
            tableSessionId,
            customerProfileId: input.customerProfileId ?? null,
            externalRef,
            // POS bills are settled at the cashier; the kitchen may fire first.
            paymentMode: "open_bill",
            subtotalIdr: bill.subtotalIdr,
            discountIdr: bill.discountIdr,
            serviceChargeIdr: bill.serviceChargeIdr,
            taxIdr: bill.taxIdr,
            roundingIdr: bill.roundingIdr,
            totalIdr: bill.totalIdr,
            depositAppliedIdr: idr(deposit),
            status: "draft",
            businessDate,
            taxResult: bill.tax,
            createdBy: caller.userId,
            placedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!order) throw new Error("Order insert returned no row");
        await tx.insert(posOrders).values({
          orderId,
          tenantId,
          outletId: outlet.id as OutletId,
          channel: input.channel,
          externalRef,
          deviceId: caller.deviceId,
          cashierId: caller.userId,
          holdItems: input.holdItems ?? false,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(orderItems).values(
          resolved.map((entry) => ({
            id: entry.id,
            tenantId,
            outletId: outlet.id as OutletId,
            orderId,
            menuItemId: entry.line.menuItemId,
            variantId: entry.line.variantId ?? null,
            name: entry.priced.name,
            quantity: entry.line.quantity,
            unitPriceIdr: entry.priced.unitPriceIdr,
            modifiersTotalIdr: entry.priced.modifiersTotalIdr,
            lineTotalIdr: idr(
              (entry.priced.unitPriceIdr + entry.priced.modifiersTotalIdr) *
                entry.line.quantity,
            ),
            modifiers: entry.priced.modifiers,
            note: entry.line.note ?? null,
            course: entry.line.course ?? entry.item.course,
            fireStatus: "held" as const,
            status: "queued" as const,
            reservedBusinessDate: businessDate,
            createdAt: now,
            updatedAt: now,
          })),
        );
        await tx.insert(posOrderItems).values(
          resolved.map((entry) => ({
            itemId: entry.id,
            tenantId,
            outletId: outlet.id as OutletId,
            orderId,
            heldByCashier: input.holdItems ?? false,
            createdAt: now,
            updatedAt: now,
          })),
        );
        await appendOrderEvent(tx, context, {
          order,
          type: "order.created",
          payload: {
            channel: input.channel,
            serviceType: input.serviceType,
            itemCount: resolved.length,
            totalIdr: bill.totalIdr,
            externalRef,
            holdItems: input.holdItems ?? false,
          },
          caller,
          now,
        });
        await auditPos(
          tx,
          context,
          {
            action: "pos_order.created",
            order,
            caller,
            before: null,
            after: {
              id: orderId,
              number: order.number,
              status: "draft",
              channel: input.channel,
              serviceType: input.serviceType,
              totalIdr: bill.totalIdr,
              itemCount: resolved.length,
            },
          },
          now,
        );
        return freshDetail(tx, context, outletId, orderId);
      },
    ),
  );
}

// ---- Submit and fire (F8 hold & fire) -------------------------------------------

/**
 * Releases held live lines to the kitchen inside the caller's transaction.
 * The first fire moves awaiting_payment -> sent; later courses keep `sent`.
 */
async function fireLines(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
  caller: PosCaller,
  select: {
    itemIds?: readonly string[];
    course?: string;
    unheldOnly?: boolean;
  },
  now: Date,
): Promise<Locked> {
  const { order } = locked;
  if (order.status !== "awaiting_payment" && order.status !== "sent")
    throw new PosError("ORDER_TRANSITION_INVALID");
  const rows = await itemsOf(tx, context, order.id);
  if (select.itemIds) {
    const known = new Set(rows.map(({ item }) => item.id));
    if (select.itemIds.some((id) => !known.has(id)))
      throw new CoreError("NOT_FOUND", "Item pesanan tidak ditemukan.");
  }
  const targets = rows.filter(({ item, pos }) => {
    if (item.status === "voided" || item.fireStatus !== "held") return false;
    if (select.unheldOnly) return pos?.heldByCashier !== true;
    if (select.itemIds) return select.itemIds.includes(item.id);
    if (select.course !== undefined) return item.course === select.course;
    return false;
  });
  if (targets.length === 0) {
    if (select.unheldOnly) return locked;
    throw new PosError("ORDER_HAS_NO_HELD_ITEMS");
  }
  const ids = targets.map(({ item }) => item.id);
  const tenantId = context.tenant.tenantId;
  await tx
    .update(orderItems)
    .set({ fireStatus: "fired", updatedAt: now })
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        inArray(orderItems.id, ids),
        eq(orderItems.fireStatus, "held"),
      ),
    );
  await tx
    .update(posOrderItems)
    .set({ firedAt: now, updatedAt: now })
    .where(
      and(
        eq(posOrderItems.tenantId, tenantId),
        inArray(posOrderItems.itemId, ids),
      ),
    );
  let current = order;
  if (order.status === "awaiting_payment") {
    const next = transitionPosOrder(order.status, "fire");
    const [fired] = await tx
      .update(orders)
      .set({ status: next, firedAt: order.firedAt ?? now, updatedAt: now })
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)))
      .returning();
    if (!fired) throw new Error("Order fire returned no row");
    current = fired;
  }
  await appendOrderEvent(tx, context, {
    order,
    type: "order.fired",
    payload: {
      itemIds: ids,
      course: select.course ?? null,
      status: current.status,
    },
    caller,
    now,
  });
  await auditPos(
    tx,
    context,
    {
      action: "pos_order.fired",
      order,
      caller,
      before: { id: order.id, status: order.status },
      after: {
        id: order.id,
        status: current.status,
        itemIds: ids,
        course: select.course ?? null,
      },
    },
    now,
  );
  return { order: current, pos: locked.pos };
}

/**
 * POST .../submit: draft -> awaiting_payment (`order.submitted`), attributed
 * to the cashier's open shift (POS-03 port). Lines the cashier did not hold
 * fire at once (F8: held lines wait for an explicit fire).
 */
export async function submitPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: SubmitInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.submit",
      request,
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      assertExpectedStatus(order, input.expectedStatus);
      assertMutable(order);
      const next = transitionPosOrder(order.status, "submit");
      const shiftId = await posShiftLookup()(tx, context, {
        outletId,
        deviceId: caller.deviceId,
        cashierId: caller.userId,
      });
      const bumped = await bumpPos(tx, context, pos, now, {
        submittedAt: now,
        shiftId,
        cashierId: caller.userId,
        deviceId: pos.deviceId ?? caller.deviceId,
      });
      const [submitted] = await tx
        .update(orders)
        .set({ status: next, updatedAt: now })
        .where(
          and(
            eq(orders.tenantId, context.tenant.tenantId),
            eq(orders.id, order.id),
          ),
        )
        .returning();
      if (!submitted) throw new Error("Order submit returned no row");
      const live = (await itemsOf(tx, context, order.id)).filter(
        ({ item }) => item.status !== "voided",
      );
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        channel: order.channel,
        serviceType: order.serviceType,
        status: "awaiting_payment" as const,
        itemCount: Math.max(1, Math.min(999, live.length)),
        totalIdr: submitted.totalIdr,
        shiftId,
        deviceId: bumped.deviceId,
        submittedBy: caller.userId,
        submittedAt: now.toISOString(),
      };
      await appendPosEvent(tx, context, "order.submitted", {
        order,
        payload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.submitted",
        payload,
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.submitted",
          order,
          caller,
          before: { id: order.id, status: order.status },
          after: { id: order.id, status: next, totalIdr: submitted.totalIdr },
        },
        now,
      );
      await fireLines(
        tx,
        context,
        { order: submitted, pos: bumped },
        caller,
        { unheldOnly: true },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}

/** POST .../fire: explicit held items, or every held item of one course. */
export async function firePosOrderItems(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: FireInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.fire",
      request,
    },
    async (tx, locked) => {
      assertExpectedStatus(locked.order, input.expectedStatus);
      assertMutable(locked.order);
      const fired = await fireLines(
        tx,
        context,
        locked,
        caller,
        input.itemIds !== undefined
          ? { itemIds: input.itemIds }
          : { course: input.course },
        now,
      );
      await bumpPos(tx, context, fired.pos, now);
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}

// ---- Complete -------------------------------------------------------------------

/**
 * POST .../complete: sent -> completed once every live line is fired and the
 * captured tenders cover the bill exactly. Issues the receipt (POS-06 port),
 * records the PBJT snapshot of the final sale (F11) and appends `order.paid`
 * — the event WS-07 posts the sales journal from. Leftover unconfirmed
 * gateway tenders are voided first; then the order row is written last, so
 * the POS-04 triggers freeze everything after it.
 */
export async function completePosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: CompleteInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.complete",
      request,
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      const tenantId = context.tenant.tenantId;
      assertExpectedStatus(order, input.expectedStatus);
      assertMutable(order);
      const next = transitionPosOrder(order.status, "complete");
      const items = await itemsOf(tx, context, order.id);
      if (
        items.some(
          ({ item }) => item.status !== "voided" && item.fireStatus === "held",
        )
      )
        throw new CoreError(
          "CONFLICT",
          "Masih ada item yang ditahan; kirim ke dapur atau void dulu.",
        );
      const tenders = await tendersOf(tx, context, order.id);
      const captured = tenders.filter((tender) => tender.status === "captured");
      const paid = captured.reduce((sum, tender) => sum + tender.amountIdr, 0);
      if (paid + order.depositAppliedIdr !== order.totalIdr)
        throw new PosError("TENDER_TOTAL_MISMATCH");
      // Decision (contract gap): order.paid has no deposit bucket, so a sale
      // part-paid by a reservation deposit cannot post a balanced journal.
      // Fail closed until the contract carries the deposit (follow-up bead).
      if (order.depositAppliedIdr > 0)
        throw new CoreError(
          "CONFLICT",
          "Tagihan dengan deposit reservasi belum dapat diselesaikan di POS.",
        );
      await tx
        .update(posOrderTenders)
        .set({ status: "voided", resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            eq(posOrderTenders.orderId, order.id),
            eq(posOrderTenders.status, "authorized"),
          ),
        );
      const receipt = await posReceiptPort().issueForSale(tx, context, {
        orderId: order.id,
        outletId,
        deviceId: pos.deviceId,
        at: now,
      });
      if (order.taxResult)
        await recordTaxSnapshots(tx, context, {
          sourceType: "order",
          sourceId: ulidToUuid(order.id),
          outletId,
          businessDate: order.businessDate,
          result: order.taxResult,
        });
      await bumpPos(tx, context, pos, now, { completedAt: now });
      const [completed] = await tx
        .update(orders)
        .set({ status: next, updatedAt: now })
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)))
        .returning();
      if (!completed) throw new Error("Order complete returned no row");
      const bucket = (name: string) =>
        captured
          .filter((tender) => tenderBucket(tender.method as never) === name)
          .reduce((sum, tender) => sum + tender.amountIdr, 0);
      const paidPayload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        channel: order.channel,
        serviceType: order.serviceType,
        grossSalesIdr: order.subtotalIdr,
        discountIdr: order.discountIdr,
        serviceChargeIdr: order.serviceChargeIdr,
        pbjtIdr: order.taxIdr,
        roundingIdr: order.roundingIdr,
        totalIdr: order.totalIdr,
        paidCashIdr: bucket("cash"),
        paidGatewayIdr: bucket("gateway"),
        paidEdcIdr: bucket("edc"),
        paidPointsIdr: bucket("points"),
        tenders: captured.map((tender) => ({
          method: tender.method,
          amountIdr: tender.amountIdr,
        })),
        shiftId: pos.shiftId,
        cashierId: pos.cashierId,
        deviceId: pos.deviceId,
        paidAt: now.toISOString(),
      };
      // A fully discounted sale (staff meal, comp) settles nothing: order.paid
      // requires a positive total and a tender, so only the log records it.
      if (order.totalIdr > 0)
        await appendPosEvent(tx, context, "order.paid", {
          order,
          payload: paidPayload,
          caller,
          now,
        });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.paid",
        payload: paidPayload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.completed",
        payload: { receiptNumber: receipt.number, totalIdr: order.totalIdr },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.completed",
          order,
          caller,
          before: { id: order.id, status: order.status },
          after: {
            id: order.id,
            status: next,
            totalIdr: order.totalIdr,
            receiptNumber: receipt.number,
          },
        },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}

// ---- Voids before the sale is final (POS-02) ---------------------------------------

/** Moves live lines to `voided` once each and releases their daily limit once. */
async function voidLines(
  tx: Tx,
  context: ScopedTenantContext,
  order: OrderRow,
  input: {
    itemIds: readonly string[] | null;
    reason: string;
    reasonNote: string;
    voidedBy: string;
    approvedBy: string;
    approvalRequestId: string;
    now: Date;
  },
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const filters = [
    eq(orderItems.tenantId, tenantId),
    eq(orderItems.orderId, order.id),
    ne(orderItems.status, "voided"),
  ];
  if (input.itemIds !== null)
    filters.push(inArray(orderItems.id, [...input.itemIds]));
  // The UPDATE ... WHERE status <> 'voided' RETURNING is the once-only key:
  // a line already voided is not returned and releases nothing again.
  const voided = await tx
    .update(orderItems)
    .set({
      status: "voided",
      voidReason: input.reason,
      voidedBy: input.voidedBy,
      voidApprovedBy: input.approvedBy,
      updatedAt: input.now,
    })
    .where(and(...filters))
    .returning();
  for (const item of voided)
    await releaseMenuItemDailyLimit(tx, context, {
      outletId: order.outletId,
      menuItemId: item.menuItemId,
      businessDate: item.reservedBusinessDate,
      quantity: item.quantity,
      now: input.now,
    });
  if (voided.length > 0)
    await tx
      .update(posOrderItems)
      .set({
        voidedAt: input.now,
        voidReasonNote: input.reasonNote,
        voidApprovalRequestId: input.approvalRequestId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(posOrderItems.tenantId, tenantId),
          inArray(
            posOrderItems.itemId,
            voided.map((item) => item.id),
          ),
        ),
      );
  return voided.length;
}

/**
 * POST .../void (POS-02): void an order that is not final, with a verified
 * supervisor approval. Refused once money was captured (decision: a paid
 * sale is completed and then corrected by a linked void/refund, POS-04).
 */
export async function voidPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: VoidInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.void",
      request,
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      const tenantId = context.tenant.tenantId;
      assertExpectedStatus(order, input.expectedStatus);
      assertMutable(order);
      const next = transitionPosOrder(order.status, "void");
      const tenders = await tendersOf(tx, context, order.id);
      if (capturedIdr(tenders) > 0)
        throw new CoreError(
          "CONFLICT",
          "Pesanan sudah dibayar sebagian; selesaikan lalu koreksi dengan void/refund tertaut.",
        );
      await consumeApproval(tx, context, {
        action: "void",
        purpose: "order_void",
        outletId,
        orderId: order.id,
        objectType: "order",
        objectId: order.id,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        minValueIdr: order.totalIdr,
      });
      const outlet = await loadOutlet(tx, context, outletId);
      const lineCount = await voidLines(tx, context, order, {
        itemIds: null,
        reason: input.reason,
        reasonNote: input.reasonNote,
        voidedBy: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        now,
      });
      await tx
        .update(posOrderTenders)
        .set({ status: "voided", resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(posOrderTenders.tenantId, tenantId),
            eq(posOrderTenders.orderId, order.id),
            eq(posOrderTenders.status, "authorized"),
          ),
        );
      await posOrderPromoPort().release(tx, context, {
        orderId: order.id,
        reason: input.reason,
        actorUserId: caller.userId,
        at: now,
      });
      // The voided order keeps its whole sale as frozen history (contract:
      // every line counts once voided) and gives the deposit back.
      let priced = order;
      try {
        priced = await repriceOrder(tx, context, {
          order,
          outlet,
          now,
          allLines: true,
          releaseDeposit: true,
        });
      } catch {
        priced = order;
      }
      await bumpPos(tx, context, pos, now, {
        voidReasonNote: input.reasonNote,
        voidApprovedBy: input.approvedBy,
        voidApprovalRequestId: input.approvalRequestId,
      });
      const [voided] = await tx
        .update(orders)
        .set({
          status: next,
          voidedAt: now,
          voidReason: input.reason,
          depositAppliedIdr: idr(0),
          updatedAt: now,
        })
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)))
        .returning();
      if (!voided) throw new Error("Order void returned no row");
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        amountIdr: priced.totalIdr,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        voidedFinalOrder: false,
        voidId: null,
        receiptNumber: null,
        voidedAt: now.toISOString(),
      };
      await appendPosEvent(tx, context, "order.voided", {
        order,
        payload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.voided",
        payload,
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.voided",
          order,
          caller,
          before: {
            id: order.id,
            status: order.status,
            totalIdr: order.totalIdr,
          },
          after: {
            id: order.id,
            status: next,
            itemCount: lineCount,
            reason: input.reason,
            approvedBy: input.approvedBy,
            approvalRequestId: input.approvalRequestId,
          },
          reason: input.reasonNote,
        },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}

/**
 * POST .../items/:itemId/void (POS-02): one line, with a verified approval.
 * Decisions (PRD silent): the last live line is not voided alone (void the
 * order); a line is not voided while a promo/voucher discount is applied
 * (remove it first, the engine's result was computed on these lines); and the
 * new total may not fall below the money already captured.
 */
export async function voidPosOrderItem(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  itemId: string,
  input: VoidItemInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.item_void",
      request: { ...request, itemId },
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      assertMutable(order);
      const rows = await itemsOf(tx, context, order.id);
      const target = rows.find(({ item }) => item.id === itemId);
      if (!target)
        throw new CoreError("NOT_FOUND", "Item pesanan tidak ditemukan.");
      if (target.item.status === "voided")
        throw new CoreError("CONFLICT", "Item ini sudah di-void.");
      const live = rows.filter(({ item }) => item.status !== "voided");
      if (live.length <= 1)
        throw new CoreError(
          "CONFLICT",
          "Ini item terakhir pesanan; void pesanannya.",
        );
      assertNoPendingGatewayTender(await tendersOf(tx, context, order.id));
      const discounts = await liveDiscountsOf(tx, context, order.id);
      if (discounts.some((row) => row.source !== "manual"))
        throw new CoreError(
          "CONFLICT",
          "Lepas promo/voucher dulu sebelum mem-void item.",
        );
      await consumeApproval(tx, context, {
        action: "void",
        purpose: "item_void",
        outletId,
        orderId: order.id,
        objectType: "order_item",
        objectId: itemId,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        minValueIdr: target.item.lineTotalIdr,
      });
      await voidLines(tx, context, order, {
        itemIds: [itemId],
        reason: input.reason,
        reasonNote: input.reasonNote,
        voidedBy: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        now,
      });
      const outlet = await loadOutlet(tx, context, outletId);
      const repriced = await repriceOrder(tx, context, { order, outlet, now });
      const tenders = await tendersOf(tx, context, order.id);
      if (capturedIdr(tenders) > repriced.totalIdr - repriced.depositAppliedIdr)
        throw new CoreError(
          "CONFLICT",
          "Total baru lebih kecil dari pembayaran yang sudah diterima.",
        );
      await bumpPos(tx, context, pos, now);
      await appendOrderEvent(tx, context, {
        order,
        type: "order.item_voided",
        payload: {
          itemId,
          wasFired: target.item.fireStatus === "fired",
          reason: input.reason,
          approvedBy: input.approvedBy,
          approvalRequestId: input.approvalRequestId,
          totalIdr: repriced.totalIdr,
        },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.item_voided",
          order,
          caller,
          objectType: "order_item",
          objectId: itemId,
          before: { id: itemId, status: target.item.status },
          after: {
            id: itemId,
            status: "voided",
            reason: input.reason,
            approvedBy: input.approvedBy,
            approvalRequestId: input.approvalRequestId,
            totalIdr: repriced.totalIdr,
          },
          reason: input.reasonNote,
        },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}
