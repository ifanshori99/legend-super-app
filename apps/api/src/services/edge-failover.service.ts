// Edge -> cloud failover windows, cloud side (1271 F3; docs/design/
// edge-cloud-failover.md "Delta rc2", docs/briefs/1271-edge-failover-cards.md).
//
// A manager holding `pos.failover.manage` on the outlet opens a window when
// the outlet's edge is down; while it is `active` the cloud serves the core
// POS paths of the outlet (services/pos-edge-outlet.ts). Transitions:
//
// - activate: EDGE_FAILOVER_ENABLED on, an active primary edge, its heartbeat
//   at least 120 s old (or `override`, owner notified), no open window;
//   idempotent per key. Queues the window state to the edge.
// - cancel: only before any failover order or failover shift exists (a
//   window that touched money ends through the return). Queues the state and
//   the closing event with no switchover count.
// - start return: edge heartbeat < 60 s, no unpaid failover order, no open
//   QRIS hold, every failover shift closed with its count; else
//   FAILOVER_OPEN_WORK with the list. Queues the state and the closing event
//   (per device the switchover count C1, so the edge closes its interrupted
//   shift, D2).
// - finish return: once the edge acknowledged the closing event
//   (sync_cursors.acked_out_seq), on a read of the window or a manager retry.
//
// Every transition locks the window row FOR UPDATE; the POS write gate holds
// it FOR SHARE in the write transaction, so no sale straddles a transition.
// Events are cloud_to_edge on aggregate `pos_failover_window`, with
// deterministic ids (window, kind, transition time), so a retry or a
// re-enqueue for a new primary is the same event. Audited
// (`edge.failover.*`); the outlet's managers are notified, the owner too on
// an override.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  toIsoDateTime,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type Ulid,
} from "@starter/shared/core";
import {
  FAILOVER_RETURN_FRESH_HEARTBEAT_MS,
  FAILOVER_STALE_HEARTBEAT_MS,
  FAILOVER_WINDOW_AGGREGATE,
  failoverOpenWorkSchema,
  failoverWindowClosedEvent,
  failoverWindowSchema,
  failoverWindowStateEvent,
  type ActivateFailoverWindowInput,
  type CancelFailoverWindowInput,
  type FailoverOpenWork,
  type FailoverWindow,
  type FailoverWindowClosedPayload,
  type StartFailoverReturnInput,
} from "@starter/shared/edge";
import { PosError } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { outletFailoverSwitchoverCounts } from "../db/schema/edge-failover-switchover.ts";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { orders } from "../db/schema/qr-order.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./audit-writer.ts";
import { FailoverOpenWorkError } from "./edge-failover-errors.ts";
import { enqueueEdgeEvent, type EdgeTx } from "./edge-queue.service.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import type { FailoverWindowRow } from "./edge-failover-window.ts";
import { edgeFailoverEnabled } from "./pos-edge-outlet.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";
import { assertOutletPermission } from "./pos-shift-support.ts";

export type FailoverCaller = { readonly userId: string };

export { FailoverOpenWorkError };

const MAX_OPEN_WORK = 500;
const MAX_WINDOW_DATES = 31;

function iso(value: Date | null): string | null {
  return value === null ? null : toIsoDateTime(value);
}

export function toFailoverWindow(row: FailoverWindowRow): FailoverWindow {
  return failoverWindowSchema.parse({
    id: row.id,
    outletId: row.outletId,
    edgeNodeId: row.edgeNodeId,
    status: row.status,
    reason: row.reason,
    override: row.override,
    activatedBy: row.activatedBy,
    activatedAt: toIsoDateTime(row.activatedAt),
    edgeHeartbeatAt: iso(row.edgeHeartbeatAt),
    businessDateFrom: row.businessDateFrom,
    businessDateTo: row.businessDateTo,
    returnStartedAt: iso(row.returnStartedAt),
    returnStartedBy: row.returnStartedBy,
    closedAt: iso(row.closedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: row.cancelledBy,
  });
}

/**
 * Deterministic ULID: the transition time as the ULID time, the rest from
 * SHA-256(window, kind). The same transition always yields the same id.
 */
export function failoverEventUlid(
  windowId: string,
  kind: string,
  at: Date,
): Ulid {
  const digest = createHash("sha256")
    .update(`${FAILOVER_WINDOW_AGGREGATE}:${windowId}:${kind}`)
    .digest("hex");
  return uuidToUlid(
    at.getTime().toString(16).padStart(12, "0") + digest.slice(0, 20),
  );
}

async function primaryNode(tx: EdgeTx, tenantId: TenantId, outletId: OutletId) {
  const [node] = await tx
    .select({ id: edgeNodes.id, lastHeartbeatAt: edgeNodes.lastHeartbeatAt })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.status, "active"),
        eq(edgeNodes.role, "primary"),
      ),
    )
    .limit(1);
  return node ?? null;
}

async function lockWindow(
  tx: EdgeTx,
  tenantId: TenantId,
  windowId: string,
): Promise<FailoverWindowRow> {
  const [row] = await tx
    .select()
    .from(outletFailoverWindows)
    .where(
      and(
        eq(outletFailoverWindows.tenantId, tenantId),
        eq(outletFailoverWindows.id, windowId),
      ),
    )
    .for("update");
  if (!row)
    throw new CoreError("NOT_FOUND", "Jendela mode cloud tidak ditemukan.");
  return row;
}

/** The next aggregate sequence of the window on this node's stream. */
async function nextSequence(
  tx: EdgeTx,
  edgeNodeId: string,
  windowId: string,
): Promise<number> {
  const last = await tx.execute(
    sql`SELECT GREATEST(
      (SELECT MAX(aggregate_sequence) FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND aggregate_type = ${FAILOVER_WINDOW_AGGREGATE} AND aggregate_id = ${windowId}),
      (SELECT MAX(aggregate_sequence) FROM edge_link_dead_letters WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND aggregate_type = ${FAILOVER_WINDOW_AGGREGATE} AND aggregate_id = ${windowId})
    ) AS last`,
  );
  return Number(last.rows[0]?.last ?? 0) + 1;
}

async function queueState(
  tx: EdgeTx,
  context: ScopedTenantContext,
  edgeNodeId: string,
  row: FailoverWindowRow,
  actorId: string,
  at: Date,
): Promise<void> {
  const definition = failoverWindowStateEvent;
  const sequence = await nextSequence(tx, edgeNodeId, row.id);
  const id = failoverEventUlid(row.id, `state:${row.status}`, at);
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId,
    direction: "cloud_to_edge",
    // Window state is master data (cloud wins, full state each time).
    kind: "master_data",
    event: definition.envelopeSchema.parse({
      id,
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: FAILOVER_WINDOW_AGGREGATE,
      aggregateId: row.id,
      sequence,
      occurredAt: toIsoDateTime(at),
      actor: { type: "user", id: actorId },
      deviceId: null,
      idempotencyKey: `${definition.name}:${row.id}:${row.status}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: { window: toFailoverWindow(row) },
    }),
  });
}

async function queueClosed(
  tx: EdgeTx,
  context: ScopedTenantContext,
  edgeNodeId: string,
  row: FailoverWindowRow,
  payload: FailoverWindowClosedPayload,
  closingEventId: Ulid,
  actorId: string,
  at: Date,
): Promise<void> {
  const definition = failoverWindowClosedEvent;
  const sequence = await nextSequence(tx, edgeNodeId, row.id);
  await enqueueEdgeEvent(tx, context, {
    edgeNodeId,
    direction: "cloud_to_edge",
    kind: "transaction_event",
    event: definition.envelopeSchema.parse({
      id: closingEventId,
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: FAILOVER_WINDOW_AGGREGATE,
      aggregateId: row.id,
      sequence,
      occurredAt: toIsoDateTime(at),
      actor: { type: "user", id: actorId },
      deviceId: null,
      idempotencyKey: `${definition.name}:${row.id}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload,
    }),
  });
}

type Transition = "activated" | "cancelled" | "return_started" | "closed";

const NOTICE: Record<Transition, { title: string; body: string }> = {
  activated: {
    title: "Outlet pindah ke mode cloud",
    body: "Server lokal outlet tidak tersambung. Kasir berjualan lewat cloud sampai outlet kembali ke server lokal.",
  },
  cancelled: {
    title: "Mode cloud dibatalkan",
    body: "Mode cloud outlet dibatalkan. Kasir kembali berjualan lewat server lokal.",
  },
  return_started: {
    title: "Outlet kembali ke server lokal",
    body: "Penjualan mode cloud sudah ditutup. Server lokal sedang menerima hitungan laci.",
  },
  closed: {
    title: "Mode cloud selesai",
    body: "Server lokal sudah menerima penutupan mode cloud. Kasir buka shift baru di server lokal.",
  },
};

async function auditAndNotify(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: {
    transition: Transition;
    row: FailoverWindowRow;
    actorId: string | null;
    before: Record<string, unknown> | null;
    reason: string | null;
    at: Date;
  },
): Promise<void> {
  const { row, transition, at } = input;
  await recordAudit(
    {
      tenantId: row.tenantId,
      outletId: row.outletId,
      actorType: input.actorId === null ? "system" : "user",
      actorId: input.actorId,
      deviceId: null,
      action: `edge.failover.${transition}`,
      objectType: "outlet_failover_window",
      objectId: row.id,
      reason: input.reason,
      before: input.before,
      after: {
        status: row.status,
        override: row.override,
        edgeNodeId: row.edgeNodeId,
        businessDateFrom: row.businessDateFrom,
        businessDateTo: row.businessDateTo,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: row.tenantId,
      outletId: row.outletId,
      // The owner hears of an override (opened although the edge was alive).
      alsoOwners: transition === "activated" && row.override,
      id: failoverEventUlid(row.id, `notice:${transition}`, at),
      eventName: `edge_failover.${transition}`,
      aggregateType: "edge_failover",
      aggregateId: row.id,
      payload: { windowId: row.id, status: row.status },
      title: NOTICE[transition].title,
      body:
        transition === "activated" && row.override
          ? `${NOTICE.activated.body} Dibuka dengan alasan khusus: ${row.reason}`
          : NOTICE[transition].body,
    },
    at,
  );
}

// ---- Activate ---------------------------------------------------------------

export async function activateFailoverWindow(
  context: ScopedTenantContext,
  caller: FailoverCaller,
  input: ActivateFailoverWindowInput,
  now: Date = new Date(),
): Promise<{ window: FailoverWindow; replayed: boolean }> {
  if (!edgeFailoverEnabled()) throw new PosError("FAILOVER_DISABLED");
  const tenantId = context.tenant.tenantId;
  const outletId = input.outletId;
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "pos.failover.manage",
    );
    const outlet = await loadOutlet(tx, context, outletId);
    // One activation per outlet at a time: replay lookup, open-window check
    // and insert see one state.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-failover:${tenantId}:${outletId}`}, 0))`,
    );
    const [replay] = await tx
      .select()
      .from(outletFailoverWindows)
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.outletId, outletId),
          eq(outletFailoverWindows.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.reason !== input.reason)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return { window: toFailoverWindow(replay), replayed: true };
    }
    const [open] = await tx
      .select({ id: outletFailoverWindows.id })
      .from(outletFailoverWindows)
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.outletId, outletId),
          inArray(outletFailoverWindows.status, ["active", "returning"]),
        ),
      );
    if (open) throw new PosError("FAILOVER_ACTIVE");
    const node = await primaryNode(tx, tenantId, outletId);
    if (!node)
      throw new CoreError(
        "CONFLICT",
        "Outlet ini tidak memakai server lokal, jadi tidak perlu mode cloud.",
      );
    const stale =
      node.lastHeartbeatAt === null ||
      now.getTime() - node.lastHeartbeatAt.getTime() >=
        FAILOVER_STALE_HEARTBEAT_MS;
    if (!stale && !input.override) throw new PosError("FAILOVER_EDGE_HEALTHY");
    const [row] = await tx
      .insert(outletFailoverWindows)
      .values({
        tenantId,
        outletId,
        edgeNodeId: node.id,
        status: "active",
        reason: input.reason,
        // An override only where the heartbeat was in fact fresh.
        override: !stale,
        idempotencyKey: input.idempotencyKey,
        activatedBy: caller.userId,
        activatedAt: now,
        edgeHeartbeatAt: node.lastHeartbeatAt,
        businessDateFrom: businessDateFor(outlet, now),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Failover window insert returned no row");
    await queueState(tx, context, node.id, row, caller.userId, now);
    await auditAndNotify(tx, context, {
      transition: "activated",
      row,
      actorId: caller.userId,
      before: null,
      reason: input.reason,
      at: now,
    });
    return { window: toFailoverWindow(row), replayed: false };
  });
}

// ---- Open work --------------------------------------------------------------

async function openWorkOf(
  tx: EdgeTx,
  tenantId: TenantId,
  windowId: string,
): Promise<FailoverOpenWork> {
  const unpaid = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posOrders.tenantId),
        eq(orders.id, posOrders.orderId),
      ),
    )
    .where(
      and(
        eq(posOrders.tenantId, tenantId),
        eq(posOrders.failoverWindowId, windowId),
        notInArray(orders.status, ["completed", "voided"]),
      ),
    )
    .orderBy(asc(posOrders.orderId))
    .limit(MAX_OPEN_WORK);
  const shifts = await tx
    .select({ id: posShifts.id })
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, tenantId),
        eq(posShifts.failoverWindowId, windowId),
        eq(posShifts.status, "open"),
      ),
    )
    .orderBy(asc(posShifts.id))
    .limit(MAX_OPEN_WORK);
  const holds = await tx
    .selectDistinct({ orderId: posQrisHolds.orderId })
    .from(posQrisHolds)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posQrisHolds.tenantId),
        eq(posOrders.orderId, posQrisHolds.orderId),
      ),
    )
    .where(
      and(
        eq(posQrisHolds.tenantId, tenantId),
        eq(posOrders.failoverWindowId, windowId),
        inArray(posQrisHolds.state, ["open", "cancelling"]),
      ),
    )
    .orderBy(asc(posQrisHolds.orderId))
    .limit(MAX_OPEN_WORK);
  return failoverOpenWorkSchema.parse({
    unpaidOrderIds: unpaid.map((row) => row.orderId),
    openShiftIds: shifts.map((row) => row.id),
    qrisHoldOrderIds: holds.map((row) => row.orderId),
  });
}

function hasOpenWork(work: FailoverOpenWork): boolean {
  return (
    work.unpaidOrderIds.length > 0 ||
    work.openShiftIds.length > 0 ||
    work.qrisHoldOrderIds.length > 0
  );
}

/** Every business date from `from` to `to` (ISO dates, inclusive). */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const day = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (day <= end) {
    dates.push(day.toISOString().slice(0, 10));
    if (dates.length > MAX_WINDOW_DATES)
      throw new CoreError(
        "CONFLICT",
        "Mode cloud berjalan lebih dari 31 hari. Ikuti runbook mode cloud untuk mencabut server lokal.",
      );
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

async function outletOfWindow(
  tx: EdgeTx,
  context: ScopedTenantContext,
  caller: FailoverCaller,
  windowId: string,
): Promise<FailoverWindowRow> {
  const row = await lockWindow(tx, context.tenant.tenantId, windowId);
  await assertOutletPermission(
    tx,
    context,
    caller.userId,
    row.outletId,
    "pos.failover.manage",
  );
  return row;
}

// ---- Cancel -----------------------------------------------------------------

export async function cancelFailoverWindow(
  context: ScopedTenantContext,
  caller: FailoverCaller,
  windowId: string,
  input: CancelFailoverWindowInput,
  now: Date = new Date(),
): Promise<FailoverWindow> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const current = await outletOfWindow(tx, context, caller, windowId);
    if (current.status === "cancelled") return toFailoverWindow(current);
    if (current.status !== "active") throw new PosError("FAILOVER_NOT_ACTIVE");
    // A window that touched money (an order or a drawer) ends through the
    // return, so its counts reach the edge.
    const orderRows = await tx
      .select({ orderId: posOrders.orderId })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.tenantId, tenantId),
          eq(posOrders.failoverWindowId, windowId),
        ),
      )
      .orderBy(asc(posOrders.orderId))
      .limit(MAX_OPEN_WORK);
    const shiftRows = await tx
      .select({ id: posShifts.id })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.failoverWindowId, windowId),
        ),
      )
      .orderBy(asc(posShifts.id))
      .limit(MAX_OPEN_WORK);
    if (orderRows.length > 0 || shiftRows.length > 0)
      throw new FailoverOpenWorkError(
        failoverOpenWorkSchema.parse({
          unpaidOrderIds: orderRows.map((row) => row.orderId),
          openShiftIds: shiftRows.map((row) => row.id),
          qrisHoldOrderIds: [],
        }),
      );
    const outlet = await loadOutlet(tx, context, current.outletId);
    const closingEventId = failoverEventUlid(windowId, "closed", now);
    const [row] = await tx
      .update(outletFailoverWindows)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: caller.userId,
        businessDateTo: businessDateFor(outlet, now),
        closingEventId: ulidToUuid(closingEventId),
        updatedAt: now,
      })
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.id, windowId),
        ),
      )
      .returning();
    if (!row) throw new Error("Failover window update returned no row");
    const node = await primaryNode(tx, tenantId, row.outletId);
    if (node) {
      await queueState(tx, context, node.id, row, caller.userId, now);
      await queueClosed(
        tx,
        context,
        node.id,
        row,
        {
          windowId,
          status: "cancelled",
          businessDates: datesBetween(
            row.businessDateFrom,
            row.businessDateTo ?? row.businessDateFrom,
          ),
          shifts: [],
        },
        closingEventId,
        caller.userId,
        now,
      );
    }
    await auditAndNotify(tx, context, {
      transition: "cancelled",
      row,
      actorId: caller.userId,
      before: { status: current.status },
      reason: input.reason,
      at: now,
    });
    return toFailoverWindow(row);
  });
}

// ---- Return -----------------------------------------------------------------

/**
 * `returning` -> `closed` once the edge acknowledged the closing event: its
 * queue row is acked, or the node's acked_out_seq covers it, or it left the
 * queue without being dead-lettered (pruned after its ack).
 */
async function finishIfAcked(
  tx: EdgeTx,
  context: ScopedTenantContext,
  row: FailoverWindowRow,
  now: Date,
): Promise<FailoverWindowRow> {
  if (row.status !== "returning" || row.closingEventId === null) return row;
  const queued = await tx.execute(
    sql`SELECT q.status, q.link_seq, c.acked_out_seq FROM edge_outbound_queue q LEFT JOIN sync_cursors c ON c.edge_node_id = q.edge_node_id AND c.direction = q.direction WHERE q.tenant_id = ${row.tenantId}::uuid AND q.direction = 'cloud_to_edge' AND q.event_id = ${row.closingEventId}::uuid`,
  );
  let acked = queued.rows.some(
    (queueRow) =>
      queueRow.status === "acked" ||
      (queueRow.acked_out_seq !== null &&
        Number(queueRow.acked_out_seq) >= Number(queueRow.link_seq)),
  );
  if (!acked && queued.rows.length === 0) {
    const dead = await tx.execute(
      sql`SELECT 1 FROM edge_link_dead_letters WHERE tenant_id = ${row.tenantId}::uuid AND direction = 'cloud_to_edge' AND event_id = ${row.closingEventId}::uuid LIMIT 1`,
    );
    acked = dead.rows.length === 0;
  }
  if (!acked) return row;
  const [closed] = await tx
    .update(outletFailoverWindows)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(outletFailoverWindows.tenantId, row.tenantId),
        eq(outletFailoverWindows.id, row.id),
        eq(outletFailoverWindows.status, "returning"),
      ),
    )
    .returning();
  if (!closed) return row;
  await auditAndNotify(tx, context, {
    transition: "closed",
    row: closed,
    actorId: null,
    before: { status: "returning" },
    reason: null,
    at: now,
  });
  return closed;
}

export async function startFailoverReturn(
  context: ScopedTenantContext,
  caller: FailoverCaller,
  windowId: string,
  _input: StartFailoverReturnInput,
  now: Date = new Date(),
): Promise<FailoverWindow> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const current = await outletOfWindow(tx, context, caller, windowId);
    // A retry once the return started: finish it if the edge has acked.
    if (current.status === "returning" || current.status === "closed")
      return toFailoverWindow(await finishIfAcked(tx, context, current, now));
    if (current.status !== "active") throw new PosError("FAILOVER_NOT_ACTIVE");
    const node = await primaryNode(tx, tenantId, current.outletId);
    if (
      !node ||
      node.lastHeartbeatAt === null ||
      now.getTime() - node.lastHeartbeatAt.getTime() >=
        FAILOVER_RETURN_FRESH_HEARTBEAT_MS
    )
      throw new PosError("FAILOVER_EDGE_OFFLINE");
    const work = await openWorkOf(tx, tenantId, windowId);
    if (hasOpenWork(work)) throw new FailoverOpenWorkError(work);
    const counts = await tx
      .select()
      .from(outletFailoverSwitchoverCounts)
      .where(
        and(
          eq(outletFailoverSwitchoverCounts.tenantId, tenantId),
          eq(outletFailoverSwitchoverCounts.windowId, windowId),
        ),
      )
      .orderBy(asc(outletFailoverSwitchoverCounts.countedAt));
    const outlet = await loadOutlet(tx, context, current.outletId);
    const closingEventId = failoverEventUlid(windowId, "closed", now);
    const [row] = await tx
      .update(outletFailoverWindows)
      .set({
        status: "returning",
        returnStartedAt: now,
        returnStartedBy: caller.userId,
        businessDateTo: businessDateFor(outlet, now),
        closingEventId: ulidToUuid(closingEventId),
        updatedAt: now,
      })
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.id, windowId),
        ),
      )
      .returning();
    if (!row) throw new Error("Failover window update returned no row");
    await queueState(tx, context, node.id, row, caller.userId, now);
    await queueClosed(
      tx,
      context,
      node.id,
      row,
      {
        windowId,
        status: "closed",
        businessDates: datesBetween(
          row.businessDateFrom,
          row.businessDateTo ?? row.businessDateFrom,
        ),
        shifts: counts.map((count) => ({
          deviceId: count.deviceId,
          cashierId: userIdSchema.parse(count.cashierId),
          countedAt: toIsoDateTime(count.countedAt),
          counts: count.counts,
          totalIdr: Number(count.totalIdr),
        })),
      },
      closingEventId,
      caller.userId,
      now,
    );
    await auditAndNotify(tx, context, {
      transition: "return_started",
      row,
      actorId: caller.userId,
      before: { status: current.status },
      reason: null,
      at: now,
    });
    return toFailoverWindow(row);
  });
}

// ---- Reads ------------------------------------------------------------------

/** One window (finishing the return when the edge has acked it). */
export async function getFailoverWindow(
  context: ScopedTenantContext,
  caller: FailoverCaller,
  windowId: string,
  now: Date = new Date(),
): Promise<FailoverWindow> {
  return withTenant(db, context, async (tx) => {
    const row = await outletOfWindow(tx, context, caller, windowId);
    return toFailoverWindow(await finishIfAcked(tx, context, row, now));
  });
}

/** The outlet's latest window, or null (finishing a return when acked). */
export async function latestFailoverWindow(
  context: ScopedTenantContext,
  caller: FailoverCaller,
  outletId: OutletId,
  now: Date = new Date(),
): Promise<FailoverWindow | null> {
  const outlet = outletIdSchema.parse(outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outlet,
      "pos.failover.manage",
    );
    const [latest] = await tx
      .select({ id: outletFailoverWindows.id })
      .from(outletFailoverWindows)
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.outletId, outlet),
        ),
      )
      .orderBy(desc(outletFailoverWindows.activatedAt))
      .limit(1);
    if (!latest) return null;
    const row = await lockWindow(tx, tenantId, latest.id);
    return toFailoverWindow(await finishIfAcked(tx, context, row, now));
  });
}

/** The outlet of a window, for the route's permission check (null = none). */
export async function failoverWindowOutletId(
  tenantId: TenantId,
  windowId: string,
): Promise<string | null> {
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: outletFailoverWindows.outletId })
      .from(outletFailoverWindows)
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.id, windowId),
        ),
      );
    return row?.outletId ?? null;
  });
}
