// Staff table-session operations (PRD v1.7 §3 "9. Denah & Meja": pindah meja,
// gabung meja, pindah item; contracts moveTableSession, mergeTableSessions,
// moveSessionItems in packages/shared/src/qr-order/table-operations.ts).
//
// Money rules (tingkat K: a customer's bill changes hands):
// - Every operation keeps the sum of the live bill unchanged. A move and a merge
//   only re-point rows (`table_sessions.table_id`, `orders.table_session_id`);
//   an item move re-points whole orders, or splits one order so that the
//   discount, service charge, tax and rounding of the order are allocated to the
//   two halves and sum back to the original (no cent is created or lost).
// - Any rupiah already paid on either session (partial payment, deposit credit)
//   locks merge and item moves (shared `assertSessionHasNoPayment`), and a fully
//   paid bill cannot move: its settlement is closed.
// - A repeat of a request that already succeeded is answered from the stored
//   outbox event of that request and writes nothing again (one event, one audit).

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  idr,
  type Idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  assertItemsCanMove,
  assertSessionPaymentModeMatches,
  assertSessionsCanMerge,
  isOperableSession,
  tableSessionIdSchema,
  type TableSession,
} from "@starter/shared/qr-order";
import { PosError } from "@starter/shared/pos";
import { sealSecret } from "../lib/secrets";
import { db } from "../db";
import {
  domainEventOutbox,
  floorZones,
  orderItems,
  orders,
  serviceRequests,
  sessionParticipants,
  tableSessions,
  tables,
} from "../db/schema";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues";
import { posOrderTenders } from "../db/schema/pos-order";
import { activeHoldOf } from "./pos-qris-hold";
import { reservationTables } from "../db/schema/reservation";
import { withTenant } from "../db/tenant";
import {
  activeSessionForTable,
  appendSessionEvent,
  audit,
  cancelOpenServiceRequests,
  emitTableStatusChanged,
  loadSession,
  loadSettlement,
  lockTableLiveState,
  newSessionCredential,
  readTableStates,
  sessionDto,
  sessionSealAad,
  toTable,
  type SessionRow,
  type Tx,
} from "./table-session.service";
import {
  followMovedSession,
  releaseLinksOfSession,
} from "./table-link.service";

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

export type MoveTableSessionResult = {
  session: TableSession;
  fromTable: ReturnType<typeof toTable>;
  toTable: ReturnType<typeof toTable>;
};

export type MergeTableSessionsResult = {
  target: TableSession;
  source: TableSession;
  movedItemCount: number;
  movedTotalIdr: number;
};

export type MoveSessionItemsResult = {
  fromSessionId: string;
  toSessionId: string;
  movedItemCount: number;
  movedTotalIdr: number;
};

// ---- Shared helpers -------------------------------------------------------

/** The shape the shared guards read: branded id plus the server's paid total. */
function gateOf(row: SessionRow, paidIdr: number) {
  return {
    id: tableSessionIdSchema.parse(row.id),
    outletId: row.outletId,
    status: row.status,
    paymentMode: row.paymentMode,
    paidIdr,
  };
}

/**
 * The table lock is taken on a table id read before locking. A concurrent move
 * may have changed it, so the locked row must still sit on that table.
 */
function assertTableUnchanged(locked: SessionRow, located: SessionRow): void {
  if (locked.tableId !== located.tableId)
    throw new CoreError(
      "CONFLICT",
      "Sesi baru saja berpindah meja; muat ulang denah lalu coba lagi.",
    );
}

/** Locks tables in ascending id order, the order every writer uses. */
async function lockTables(
  tx: Tx,
  context: ScopedTenantContext,
  tableIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(tableIds)].sort())
    await lockTableLiveState(tx, context.tenant.tenantId, id);
}

/**
 * The bill of one session. Fails closed (409) when the orders module cannot
 * verify it: a bill that cannot be proven must not change hands.
 */
async function paidOf(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
): Promise<{ billTotalIdr: number; paidIdr: number }> {
  const settlement = await loadSettlement(tx, context, sessionId);
  if (settlement === null)
    throw new CoreError(
      "CONFLICT",
      "Tagihan sesi belum dapat diverifikasi; coba lagi sebentar lagi.",
    );
  // POS and captain orders are paid through tenders, which the QR settlement
  // port does not read: a captured tender locks the session like any payment.
  const [tenders] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderTenders)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posOrderTenders.tenantId),
        eq(orders.id, posOrderTenders.orderId),
      ),
    )
    .where(
      and(
        eq(posOrderTenders.tenantId, context.tenant.tenantId),
        eq(orders.tableSessionId, sessionId),
        ne(orders.status, "voided"),
        inArray(posOrderTenders.status, ["authorized", "captured"]),
      ),
    );
  return {
    billTotalIdr: settlement.billTotalIdr,
    paidIdr: settlement.paidIdr + Number(tenders?.total ?? 0),
  };
}

/**
 * One session, one pricing formula (legend-zmc2): QR checkout refuses an order
 * whose `prices_include_tax` differs from the session's live orders, so a move
 * that mixes the two would break every later order of that session.
 */
function assertSamePricingMode(
  groups: readonly (readonly Pick<OrderRow, "pricesIncludeTax">[])[],
): void {
  const modes = new Set(groups.flat().map((order) => order.pricesIncludeTax));
  if (modes.size > 1)
    throw new CoreError(
      "CONFLICT",
      "Pesanan memakai aturan harga yang berbeda (harga sudah termasuk pajak vs belum); tidak dapat digabung ke satu tagihan.",
    );
}

async function liveOrdersOf(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
): Promise<OrderRow[]> {
  return tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, sessionId),
        ne(orders.status, "voided"),
      ),
    );
}

/** Latest stored event of one request, used to answer a repeat of it. */
async function findPriorEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: string,
  aggregateId: string,
  matches: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  const rows = await tx
    .select({ event: domainEventOutbox.event })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.aggregateId, aggregateId),
        sql`${domainEventOutbox.event}->>'name' = ${name}`,
      ),
    )
    .orderBy(desc(domainEventOutbox.sequence))
    .limit(25);
  for (const row of rows) {
    const payload = (row.event as { payload?: Record<string, unknown> })
      .payload;
    if (payload && matches(payload)) return payload;
  }
  return null;
}

async function lockSessionsInOrder(
  tx: Tx,
  context: ScopedTenantContext,
  ids: readonly string[],
): Promise<Map<string, SessionRow>> {
  const rows = new Map<string, SessionRow>();
  for (const id of [...new Set(ids)].sort())
    rows.set(
      id,
      await loadSession(tx, context.tenant.tenantId, id, { forUpdate: true }),
    );
  return rows;
}

// ---- Move table -----------------------------------------------------------

export async function moveTableSessionOperation(
  context: ScopedTenantContext,
  sessionId: string,
  input: { toTableId: string; note?: string | undefined },
  actorUserId: string,
  now = new Date(),
): Promise<MoveTableSessionResult> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const located = await loadSession(tx, tenantId, sessionId);
    await lockTables(tx, context, [located.tableId, input.toTableId]);
    const row = await loadSession(tx, tenantId, sessionId, { forUpdate: true });
    assertOutletInScope(context.outletScope, row.outletId);
    assertTableUnchanged(row, located);

    if (row.tableId === input.toTableId && isOperableSession(row)) {
      // Repeat of a move that already succeeded.
      const prior = await findPriorEvent(
        tx,
        context,
        "table_session.moved",
        row.id,
        (payload) => payload.toTableId === input.toTableId,
      );
      if (prior) {
        const [fromRow, toRow] = await Promise.all([
          tableRow(tx, context, String(prior.fromTableId)),
          tableRow(tx, context, input.toTableId),
        ]);
        return {
          session: await sessionDto(tx, row),
          fromTable: toTable(fromRow),
          toTable: toTable(toRow),
        };
      }
    }

    if (!isOperableSession(row))
      throw new CoreError(
        "CONFLICT",
        "Hanya sesi yang sedang berjalan (open atau menunggu tagihan) yang dapat dipindah.",
      );
    const bill = await paidOf(tx, context, row.id);
    // Open bill: a fully paid bill is settled and the session closes instead.
    // Pay first: every placed order is already paid, and guests may still
    // change seats.
    if (
      row.paymentMode === "open_bill" &&
      bill.billTotalIdr > 0 &&
      bill.paidIdr >= bill.billTotalIdr
    )
      throw new CoreError(
        "CONFLICT",
        "Tagihan sesi ini sudah lunas dan tidak dapat dipindah.",
      );

    const [target] = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, input.toTableId)))
      .for("update");
    if (!target)
      throw new CoreError("NOT_FOUND", "Meja tujuan tidak ditemukan.");
    assertOutletInScope(context.outletScope, target.outletId);
    if (target.outletId !== row.outletId)
      throw new CoreError(
        "CONFLICT",
        "Meja tujuan berada di outlet yang berbeda.",
      );
    if (target.id === row.tableId)
      throw new CoreError("CONFLICT", "Sesi sudah berada di meja ini.");
    if (
      target.status !== "available" ||
      (await activeSessionForTable(tx, tenantId, target.id)) !== undefined
    )
      throw new CoreError("CONFLICT", "Meja tujuan tidak kosong.");
    const [zone] = await tx
      .select()
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, tenantId),
          eq(floorZones.id, target.zoneId),
        ),
      );
    if (!zone)
      throw new CoreError("NOT_FOUND", "Zona meja tujuan tidak ditemukan.");
    assertSessionPaymentModeMatches({
      sessionPaymentMode: row.paymentMode,
      targetPaymentMode: zone.paymentMode,
    });
    if (row.reservationId) {
      const otherHolds = await holdsOtherTables(
        tx,
        tenantId,
        row.reservationId,
        row.tableId,
      );
      if (otherHolds)
        throw new CoreError(
          "CONFLICT",
          "Sesi dari reservasi beberapa meja tidak dapat dipindah; pecah reservasinya dulu.",
        );
      // The hold on the old table ends with the move: it must not keep
      // blocking that table, nor make the next move look like a party.
      await releaseHolds(tx, tenantId, row.reservationId, row.tableId, now);
    }

    const fromTableId = row.tableId;
    const [updated] = await tx
      .update(tableSessions)
      .set({ tableId: target.id, lastActivityAt: now })
      .where(
        and(eq(tableSessions.tenantId, tenantId), eq(tableSessions.id, row.id)),
      )
      .returning();
    if (!updated) throw new Error("Session move returned no row");
    // Open calls (waiter, bill) belong to the guests, not to the old table.
    await tx
      .update(serviceRequests)
      .set({ tableId: target.id, updatedAt: now })
      .where(
        and(
          eq(serviceRequests.tenantId, tenantId),
          eq(serviceRequests.tableSessionId, row.id),
          inArray(serviceRequests.status, ["pending", "acknowledged"]),
        ),
      );
    const statesBefore = await readTableStates(tx, tenantId, [
      fromTableId,
      target.id,
    ]);
    const [fromTable] = await tx
      .update(tables)
      .set({ status: "dirty", updatedAt: now })
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, fromTableId)))
      .returning();
    const [toTableRow] = await tx
      .update(tables)
      .set({ status: "occupied", updatedAt: now })
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, target.id)))
      .returning();
    if (!fromTable || !toTableRow)
      throw new Error("Table update returned no row");
    for (const [id, to, zoneId] of [
      [fromTableId, "dirty", fromTable.zoneId],
      [target.id, "occupied", target.zoneId],
    ] as const) {
      const before = statesBefore.get(id);
      if (!before) continue;
      await emitTableStatusChanged(tx, context, {
        tableId: id,
        outletId: row.outletId,
        zoneId,
        from: before.status,
        to,
        cause: "session_moved",
        actor: { type: "user", id: actorUserId },
        now,
      });
    }
    // A linked session keeps its link: the member follows it to the new table.
    await followMovedSession(tx, tenantId, row.id, target.id);

    await appendSessionEvent(tx, context, "table_session.moved", {
      sessionId: row.id,
      outletId: row.outletId,
      payload: {
        sessionId: row.id,
        fromTableId,
        toTableId: target.id,
        billTotalIdr: bill.billTotalIdr,
      },
      actor: { type: "user", id: actorUserId },
      now,
    });
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.moved",
        outletId: row.outletId,
        objectId: row.id,
        before: { id: row.id, tableId: fromTableId },
        after: {
          id: row.id,
          fromTableId,
          toTableId: target.id,
          billTotalIdr: bill.billTotalIdr,
        },
      },
      now,
    );
    return {
      session: await sessionDto(tx, updated),
      fromTable: toTable(fromTable),
      toTable: toTable(toTableRow),
    };
  });
}

/** Ends the live hold of one reservation on one table. */
async function releaseHolds(
  tx: Tx,
  tenantId: TenantId,
  reservationId: string,
  tableId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(reservationTables)
    .set({ releasedAt: now })
    .where(
      and(
        eq(reservationTables.tenantId, tenantId),
        eq(reservationTables.reservationId, reservationId),
        eq(reservationTables.tableId, tableId),
        isNull(reservationTables.releasedAt),
      ),
    );
}

/** True when the reservation still holds tables other than `tableId`. */
async function holdsOtherTables(
  tx: Tx,
  tenantId: TenantId,
  reservationId: string,
  tableId: string,
): Promise<boolean> {
  const holds = await tx
    .select({ id: reservationTables.id })
    .from(reservationTables)
    .where(
      and(
        eq(reservationTables.tenantId, tenantId),
        eq(reservationTables.reservationId, reservationId),
        isNull(reservationTables.releasedAt),
        ne(reservationTables.tableId, tableId),
      ),
    )
    .limit(1);
  return holds.length > 0;
}

async function tableRow(
  tx: Tx,
  context: ScopedTenantContext,
  tableId: string,
): Promise<typeof tables.$inferSelect> {
  const [row] = await tx
    .select()
    .from(tables)
    .where(
      and(eq(tables.tenantId, context.tenant.tenantId), eq(tables.id, tableId)),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
  return row;
}

// ---- Merge ----------------------------------------------------------------

export async function mergeTableSessionsOperation(
  context: ScopedTenantContext,
  targetSessionId: string,
  input: { sourceSessionId: string; note?: string | undefined },
  actorUserId: string,
  now = new Date(),
): Promise<MergeTableSessionsResult> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    if (targetSessionId === input.sourceSessionId)
      throw new CoreError(
        "CONFLICT",
        "Sesi sumber dan tujuan tidak boleh sama.",
      );
    const locatedTarget = await loadSession(tx, tenantId, targetSessionId);
    const locatedSource = await loadSession(
      tx,
      tenantId,
      input.sourceSessionId,
    );
    await lockTables(tx, context, [
      locatedTarget.tableId,
      locatedSource.tableId,
    ]);
    const locked = await lockSessionsInOrder(tx, context, [
      targetSessionId,
      input.sourceSessionId,
    ]);
    const target = locked.get(targetSessionId)!;
    const source = locked.get(input.sourceSessionId)!;
    assertOutletInScope(context.outletScope, target.outletId);
    assertOutletInScope(context.outletScope, source.outletId);
    assertTableUnchanged(target, locatedTarget);
    assertTableUnchanged(source, locatedSource);

    if (source.status === "closed" && source.closedReason === "voided") {
      // Repeat of a merge that already succeeded.
      const prior = await findPriorEvent(
        tx,
        context,
        "table_session.merged",
        target.id,
        (payload) => payload.sourceSessionId === source.id,
      );
      if (prior)
        return {
          target: await sessionDto(tx, target),
          source: await sessionDto(tx, source),
          movedItemCount: Number(prior.movedItemCount),
          movedTotalIdr: Number(prior.movedTotalIdr),
        };
    }

    // Lock the orders of both sessions (ascending order id, the same order
    // every order writer uses) BEFORE reading what is paid: a POS tender that
    // commits while the merge runs waits here, so the payment check below sees
    // it and a merge never moves an order whose bill just changed.
    const lockedOrders = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.tableSessionId, [target.id, source.id]),
        ),
      )
      .orderBy(asc(orders.id))
      .for("update");

    const targetBill = await paidOf(tx, context, target.id);
    const sourceBill = await paidOf(tx, context, source.id);
    assertSessionsCanMerge({
      target: gateOf(target, targetBill.paidIdr),
      source: gateOf(source, sourceBill.paidIdr),
    });

    // A party that holds several tables keeps tables nobody would free after
    // the merge (the source session no longer closes them).
    if (
      source.reservationId &&
      (await holdsOtherTables(
        tx,
        tenantId,
        source.reservationId,
        source.tableId,
      ))
    )
      throw new CoreError(
        "CONFLICT",
        "Sesi dari reservasi beberapa meja tidak dapat digabung; pecah reservasinya dulu.",
      );
    const moved = lockedOrders.filter(
      (order) => order.tableSessionId === source.id,
    );
    const liveOrders = moved.filter((order) => order.status !== "voided");
    assertSamePricingMode([
      liveOrders,
      await liveOrdersOf(tx, tenantId, target.id),
    ]);
    if (source.reservationId)
      await releaseHolds(
        tx,
        tenantId,
        source.reservationId,
        source.tableId,
        now,
      );
    let movedItemCount = 0;
    if (liveOrders.length > 0) {
      const items = await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            inArray(
              orderItems.orderId,
              liveOrders.map((order) => order.id),
            ),
            ne(orderItems.status, "voided"),
          ),
        );
      movedItemCount = items.length;
    }
    const movedTotalIdr = liveOrders.reduce(
      (sum, order) => sum + order.totalIdr,
      0,
    );
    if (moved.length > 0)
      await tx
        .update(orders)
        .set({ tableSessionId: target.id, updatedAt: now })
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(
              orders.id,
              moved.map((order) => order.id),
            ),
          ),
        );

    // An open dearer-swap charge rides on the source session; without this it
    // would be lost when the source closes below.
    await tx
      .update(orderIssueCharges)
      .set({ tableSessionId: target.id, updatedAt: now })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.tableSessionId, source.id),
          eq(orderIssueCharges.status, "open"),
        ),
      );

    // Guests of the source join the shared bill; a device already in the
    // target stays one participant (unique device per session).
    const targetDevices = (
      await tx
        .select({ deviceHash: sessionParticipants.deviceHash })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.tenantId, tenantId),
            eq(sessionParticipants.tableSessionId, target.id),
          ),
        )
    ).map((participant) => participant.deviceHash);
    await tx
      .update(sessionParticipants)
      .set({ tableSessionId: target.id })
      .where(
        and(
          eq(sessionParticipants.tenantId, tenantId),
          eq(sessionParticipants.tableSessionId, source.id),
          targetDevices.length > 0
            ? sql`${sessionParticipants.deviceHash} NOT IN (${sql.join(
                targetDevices.map((hash) => sql`${hash}`),
                sql`, `,
              )})`
            : sql`true`,
        ),
      );

    await cancelOpenServiceRequests(tx, tenantId, source.id, now);
    const credential = newSessionCredential();
    const [closedSource] = await tx
      .update(tableSessions)
      .set({
        status: "closed",
        closedAt: now,
        closedReason: "voided",
        lastActivityAt: now,
        sessionTokenHash: credential.hash,
        sessionTokenSealed: sealSecret(
          credential.token,
          sessionSealAad(source.tenantId, source.id),
        ),
      })
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, source.id),
        ),
      )
      .returning();
    const [mergedTarget] = await tx
      .update(tableSessions)
      .set({ lastActivityAt: now })
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, target.id),
        ),
      )
      .returning();
    if (!closedSource || !mergedTarget)
      throw new Error("Session merge returned no row");
    // The source table has no session of its own any more but its guests may
    // still sit there: "dirty" keeps a rescan from opening a second bill on it
    // (ORD-10) until staff mark it available.
    const sourceTableBefore = (
      await readTableStates(tx, tenantId, [source.tableId])
    ).get(source.tableId);
    await tx
      .update(tables)
      .set({ status: "dirty", updatedAt: now })
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, source.tableId)));
    if (sourceTableBefore)
      await emitTableStatusChanged(tx, context, {
        tableId: source.tableId,
        outletId: source.outletId,
        zoneId: sourceTableBefore.zoneId,
        from: sourceTableBefore.status,
        to: "dirty",
        cause: "session_merged",
        actor: { type: "user", id: actorUserId },
        now,
      });
    // The source session ends here, so it leaves its link group.
    await releaseLinksOfSession(
      tx,
      context,
      source.id,
      "session_merged",
      { type: "user", id: actorUserId },
      now,
    );

    await appendSessionEvent(tx, context, "table_session.merged", {
      sessionId: target.id,
      outletId: target.outletId,
      payload: {
        targetSessionId: target.id,
        sourceSessionId: source.id,
        targetTableId: target.tableId,
        sourceTableId: source.tableId,
        movedItemCount,
        movedTotalIdr,
      },
      actor: { type: "user", id: actorUserId },
      now,
    });
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.merged",
        outletId: target.outletId,
        objectId: target.id,
        before: { id: target.id, status: target.status },
        after: {
          id: target.id,
          // No "session" in an audit key: the masker redacts such keys.
          sourceId: source.id,
          movedItemCount,
          movedTotalIdr,
        },
      },
      now,
    );
    return {
      target: await sessionDto(tx, mergedTarget),
      source: await sessionDto(tx, closedSource),
      movedItemCount,
      movedTotalIdr,
    };
  });
}

// ---- Move items -----------------------------------------------------------

/** floor(amount * numerator / denominator), exact in integers (toward zero). */
function share(amount: number, numerator: number, denominator: number): number {
  return Number((BigInt(amount) * BigInt(numerator)) / BigInt(denominator));
}

type Components = {
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
};

function totalOf(order: Pick<OrderRow, "pricesIncludeTax">, c: Components) {
  return order.pricesIncludeTax
    ? c.subtotalIdr - c.discountIdr + c.roundingIdr
    : c.subtotalIdr -
        c.discountIdr +
        c.serviceChargeIdr +
        c.taxIdr +
        c.roundingIdr;
}

/** The same invariants the database enforces on `orders`. */
function validComponents(
  order: Pick<OrderRow, "pricesIncludeTax">,
  c: Components,
): boolean {
  const total = totalOf(order, c);
  if (
    c.subtotalIdr < 0 ||
    c.discountIdr < 0 ||
    c.serviceChargeIdr < 0 ||
    c.taxIdr < 0 ||
    total < 0
  )
    return false;
  return (
    !order.pricesIncludeTax ||
    c.serviceChargeIdr + c.taxIdr <= c.subtotalIdr - c.discountIdr
  );
}

/**
 * Splits one order's money between the moved lines and the rest. The smaller
 * side is rounded down per component and the larger side takes the remainder,
 * so every component sums back exactly.
 */
function splitComponents(
  order: OrderRow,
  movedSubtotal: number,
): { moved: Components; kept: Components } | null {
  const whole: Components = {
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.discountIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    roundingIdr: order.roundingIdr,
  };
  if (order.subtotalIdr <= 0 || movedSubtotal <= 0) return null;
  if (movedSubtotal >= order.subtotalIdr) return null;
  const movedIsSmall = movedSubtotal * 2 <= order.subtotalIdr;
  const smallSubtotal = movedIsSmall
    ? movedSubtotal
    : order.subtotalIdr - movedSubtotal;
  const small: Components = {
    subtotalIdr: smallSubtotal,
    discountIdr: share(order.discountIdr, smallSubtotal, order.subtotalIdr),
    serviceChargeIdr: share(
      order.serviceChargeIdr,
      smallSubtotal,
      order.subtotalIdr,
    ),
    taxIdr: share(order.taxIdr, smallSubtotal, order.subtotalIdr),
    roundingIdr: share(order.roundingIdr, smallSubtotal, order.subtotalIdr),
  };
  const large: Components = {
    subtotalIdr: whole.subtotalIdr - small.subtotalIdr,
    discountIdr: whole.discountIdr - small.discountIdr,
    serviceChargeIdr: whole.serviceChargeIdr - small.serviceChargeIdr,
    taxIdr: whole.taxIdr - small.taxIdr,
    roundingIdr: whole.roundingIdr - small.roundingIdr,
  };
  const moved = movedIsSmall ? small : large;
  const kept = movedIsSmall ? large : small;
  return validComponents(order, moved) && validComponents(order, kept)
    ? { moved, kept }
    : null;
}

export async function moveSessionItemsOperation(
  context: ScopedTenantContext,
  fromSessionId: string,
  input: { toSessionId: string; orderItemIds: readonly string[] },
  actorUserId: string,
  now = new Date(),
): Promise<MoveSessionItemsResult> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const itemIds = [...new Set(input.orderItemIds)];
    if (fromSessionId === input.toSessionId)
      throw new CoreError("CONFLICT", "Pilih sesi tujuan yang berbeda.");
    const locatedFrom = await loadSession(tx, tenantId, fromSessionId);
    const locatedTo = await loadSession(tx, tenantId, input.toSessionId);
    await lockTables(tx, context, [locatedFrom.tableId, locatedTo.tableId]);
    const locked = await lockSessionsInOrder(tx, context, [
      fromSessionId,
      input.toSessionId,
    ]);
    const from = locked.get(fromSessionId)!;
    const to = locked.get(input.toSessionId)!;
    assertOutletInScope(context.outletScope, from.outletId);
    assertOutletInScope(context.outletScope, to.outletId);
    assertTableUnchanged(from, locatedFrom);
    assertTableUnchanged(to, locatedTo);

    const requestedEarly = await tx
      .select({ item: orderItems, order: orders })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderItems.tenantId),
          eq(orders.id, orderItems.orderId),
        ),
      )
      .where(
        and(eq(orderItems.tenantId, tenantId), inArray(orderItems.id, itemIds)),
      );

    // Repeat of a move that already succeeded: every item sits in the
    // destination now and the earlier request is on record.
    if (
      requestedEarly.length === itemIds.length &&
      requestedEarly.every((row) => row.order.tableSessionId === to.id)
    ) {
      const wanted = new Set(itemIds);
      const prior = await findPriorEvent(
        tx,
        context,
        "table_session.items_moved",
        from.id,
        (payload) =>
          payload.toSessionId === to.id &&
          Array.isArray(payload.orderItemIds) &&
          payload.orderItemIds.length === wanted.size &&
          payload.orderItemIds.every((id) => wanted.has(String(id))),
      );
      if (prior)
        return {
          fromSessionId: from.id,
          toSessionId: to.id,
          movedItemCount: Number(prior.movedItemCount),
          movedTotalIdr: Number(prior.movedTotalIdr),
        };
    }

    // Lock the orders of both sessions (ascending order id, the same order
    // every order writer uses) BEFORE reading what is paid: a POS tender that
    // commits while the move runs waits here, so the payment check below sees
    // it and a move never touches an order whose bill just changed.
    const sessionOrders = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.tableSessionId, [from.id, to.id]),
        ),
      )
      .orderBy(asc(orders.id))
      .for("update");

    // Re-read the requested lines under the same lock: a POS void of one line
    // that committed after the first read must not be missed (legend-ekxy2).
    const freshItems = await tx
      .select()
      .from(orderItems)
      .where(
        and(eq(orderItems.tenantId, tenantId), inArray(orderItems.id, itemIds)),
      );
    const freshItemById = new Map(freshItems.map((item) => [item.id, item]));
    const freshOrderById = new Map(
      sessionOrders.map((order) => [order.id, order]),
    );
    const requested = requestedEarly.flatMap((row) => {
      const item = freshItemById.get(row.item.id);
      return item
        ? [{ item, order: freshOrderById.get(row.order.id) ?? row.order }]
        : [];
    });

    const fromBill = await paidOf(tx, context, from.id);
    const toBill = await paidOf(tx, context, to.id);
    assertItemsCanMove({
      from: gateOf(from, fromBill.paidIdr),
      to: gateOf(to, toBill.paidIdr),
    });
    // Pay-first orders are settled one by one, open-bill orders on one bill:
    // an order may not change from one way of paying to the other.
    assertSessionPaymentModeMatches({
      sessionPaymentMode: from.paymentMode,
      targetPaymentMode: to.paymentMode,
    });

    if (
      requested.length !== itemIds.length ||
      requested.some((row) => row.order.tableSessionId !== from.id)
    )
      throw new CoreError(
        "NOT_FOUND",
        "Item pesanan tidak ditemukan di sesi ini.",
      );
    if (
      requested.some(
        (row) => row.item.status === "voided" || row.order.status === "voided",
      )
    )
      throw new CoreError(
        "CONFLICT",
        "Item yang sudah dibatalkan tidak dapat dipindah.",
      );

    assertSamePricingMode([
      requested.map((row) => row.order),
      await liveOrdersOf(tx, tenantId, to.id),
    ]);

    // The touched orders, as re-read under the lock taken above.
    const orderIds = [...new Set(requested.map((row) => row.order.id))].sort();
    const lockedOrders = new Map<string, OrderRow>();
    for (const id of orderIds) {
      const order = sessionOrders.find((row) => row.id === id);
      if (!order || order.tableSessionId !== from.id)
        throw new CoreError(
          "NOT_FOUND",
          "Item pesanan tidak ditemukan di sesi ini.",
        );
      if (order.status === "voided")
        throw new CoreError(
          "CONFLICT",
          "Item yang sudah dibatalkan tidak dapat dipindah.",
        );
      lockedOrders.set(id, order);
    }

    let movedTotalIdr = 0;
    for (const orderId of orderIds) {
      const order = lockedOrders.get(orderId)!;
      const selected = requested
        .filter((row) => row.order.id === orderId)
        .map((row) => row.item);
      const liveItems = await tx
        .select()
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            eq(orderItems.orderId, orderId),
            ne(orderItems.status, "voided"),
          ),
        )
        .orderBy(asc(orderItems.id));
      const selectedIds = new Set(selected.map((item) => item.id));
      if (liveItems.every((item) => selectedIds.has(item.id))) {
        await tx
          .update(orders)
          .set({ tableSessionId: to.id, updatedAt: now })
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
        movedTotalIdr += order.totalIdr;
        continue;
      }
      movedTotalIdr += await splitOrder(tx, {
        order,
        selected,
        liveItems,
        to,
        actorUserId,
        now,
      });
    }

    await tx
      .update(tableSessions)
      .set({ lastActivityAt: now })
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          inArray(tableSessions.id, [from.id, to.id]),
        ),
      );
    await appendSessionEvent(tx, context, "table_session.items_moved", {
      sessionId: from.id,
      outletId: from.outletId,
      payload: {
        fromSessionId: from.id,
        toSessionId: to.id,
        orderItemIds: itemIds,
        movedItemCount: itemIds.length,
        movedTotalIdr,
      },
      actor: { type: "user", id: actorUserId },
      now,
    });
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.items_moved",
        outletId: from.outletId,
        objectId: from.id,
        before: { id: from.id },
        after: {
          id: from.id,
          toId: to.id,
          movedItemCount: itemIds.length,
          movedTotalIdr,
        },
      },
      now,
    );
    return {
      fromSessionId: from.id,
      toSessionId: to.id,
      movedItemCount: itemIds.length,
      movedTotalIdr,
    };
  });
}

/** Moves some lines of an order into a new order of the destination session. */
async function splitOrder(
  tx: Tx,
  input: {
    order: OrderRow;
    selected: readonly OrderItemRow[];
    liveItems: readonly OrderItemRow[];
    to: SessionRow;
    actorUserId: string;
    now: Date;
  },
): Promise<number> {
  const { order, selected, liveItems, to, actorUserId, now } = input;
  // legend-yhia9: its money columns are frozen while a QRIS can still be paid.
  if (await activeHoldOf(tx, order.tenantId, order.id))
    throw new PosError("QRIS_HOLD_ACTIVE");
  // A part of an order cannot leave while something else still depends on the
  // whole: a payment link or intent was opened for the full amount, a deposit
  // credit was applied, or the kitchen has not fired it (PBJT snapshots are
  // recorded from the whole order when it fires).
  if (order.channel !== "qr")
    throw new CoreError(
      "CONFLICT",
      "Pesanan kasir atau captain tidak dapat dipisah; pindahkan seluruh pesanan.",
    );
  if (
    order.paymentLinkId !== null ||
    order.paymentIntentId !== null ||
    order.depositAppliedIdr > 0
  )
    throw new CoreError(
      "CONFLICT",
      "Pesanan ini sudah punya tautan pembayaran atau deposit; pindahkan seluruh pesanan, bukan sebagian itemnya.",
    );
  if (order.firedAt === null || liveItems.some((i) => i.fireStatus !== "fired"))
    throw new CoreError(
      "CONFLICT",
      "Pesanan belum dikirim ke dapur; kirim dulu atau pindahkan seluruh pesanan.",
    );
  const liveSubtotal = liveItems.reduce((sum, i) => sum + i.lineTotalIdr, 0);
  const movedSubtotal = selected.reduce((sum, i) => sum + i.lineTotalIdr, 0);
  const parts =
    liveSubtotal === order.subtotalIdr
      ? splitComponents(order, movedSubtotal)
      : null;
  if (!parts)
    throw new CoreError(
      "CONFLICT",
      "Item tidak dapat dipisah dari pesanannya; pindahkan seluruh pesanan.",
    );

  // legend-pc51h: a kitchen-swap replacement line stays with the order whose
  // frozen subtotal carries the replaced line's value; moving it alone would
  // leave that order's lines and subtotal out of step.
  const [swapLine] = await tx
    .select({ id: orderIssues.id })
    .from(orderIssues)
    .where(
      and(
        eq(orderIssues.tenantId, order.tenantId),
        inArray(
          orderIssues.replacementOrderItemId,
          selected.map((item) => item.id),
        ),
      ),
    )
    .limit(1);
  if (swapLine)
    throw new CoreError(
      "CONFLICT",
      "Item pengganti dari penukaran menu tidak dapat dipindah sendiri; pindahkan seluruh pesanan.",
    );

  const newOrderId = createUlid(now.getTime());
  await tx
    .update(orders)
    .set({
      subtotalIdr: idr(parts.kept.subtotalIdr),
      discountIdr: idr(parts.kept.discountIdr),
      serviceChargeIdr: idr(parts.kept.serviceChargeIdr),
      taxIdr: idr(parts.kept.taxIdr),
      roundingIdr: idr(parts.kept.roundingIdr),
      totalIdr: idr(totalOf(order, parts.kept)),
      updatedAt: now,
    })
    .where(and(eq(orders.tenantId, order.tenantId), eq(orders.id, order.id)));
  await tx.insert(orders).values({
    id: newOrderId,
    tenantId: order.tenantId,
    outletId: order.outletId,
    number: `MOV-${newOrderId.slice(-12)}`,
    channel: order.channel,
    serviceType: order.serviceType,
    tableSessionId: to.id,
    customerProfileId: order.customerProfileId,
    externalRef: null,
    paymentMode: to.paymentMode,
    subtotalIdr: idr(parts.moved.subtotalIdr),
    discountIdr: idr(parts.moved.discountIdr),
    serviceChargeIdr: idr(parts.moved.serviceChargeIdr),
    taxIdr: idr(parts.moved.taxIdr),
    roundingIdr: idr(parts.moved.roundingIdr),
    totalIdr: idr(totalOf(order, parts.moved)),
    pricesIncludeTax: order.pricesIncludeTax,
    depositAppliedIdr: idr(0),
    status: order.status,
    businessDate: order.businessDate,
    taxResult: null,
    paymentLinkId: null,
    paymentLinkTokenSealed: null,
    paymentIntentId: null,
    note: order.note,
    createdBy: actorUserId,
    placedAt: order.placedAt,
    firedAt: order.firedAt,
  });
  await tx
    .update(orderItems)
    .set({ orderId: newOrderId, updatedAt: now })
    .where(
      and(
        eq(orderItems.tenantId, order.tenantId),
        inArray(
          orderItems.id,
          selected.map((item) => item.id),
        ),
      ),
    );
  return totalOf(order, parts.moved);
}

export type { Idr };
