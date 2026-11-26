// Cloud mirror of the cashier shifts, cash movements and business days an
// outlet runs on its edge (1269 E3, legend-8yqik, legend-k0i8). The events are
// parked first by edge/deferred-event-applier.ts; the parked hooks here write
// the cloud rows.
//
// Rules (money: in doubt refuse or wait, never count cash twice):
//  S1 Parking is never undone: after parking, an ingest NEVER throws. All
//     writes run in one savepoint; a failure is recorded in `edge_pos_ingests`
//     as `pending` (waits for other events, or a lock) or `refused`, with a
//     reason code. Event ids and codes only in logs.
//  S2 A drawer is written ONCE, whole and already closed: only when the close,
//     the opening and every cash movement the close lists are parked and all
//     figures agree. An open edge shift never exists in the cloud, so no cloud
//     cash can land in it, and the arrival order does not matter.
//  S3 Every figure comes from the payload; nothing is computed or rounded here,
//     only compared. The ledger row (one per shift) is the replay guard; a
//     second close of the same shift is refused, whatever it says.
//  S4 `day.closed` is mirrored into `pos_daily_closes` only when the cloud's own
//     figures of that day equal the edge's frozen recap. Until then the day
//     stays open in the cloud (metrics stay estimates). An existing close is
//     never changed. 1271 F5 (D5): failover rows are cloud-only, so they are
//     left out of the comparison; a date with failover rows stores the cloud's
//     recap of edge + failover rows, and waits while a window is still open
//     on it (more failover sales may come).
//  S5 Nothing is appended to the outbox (apply-scope.ts); journals are posted
//     here, keyed per shift and per movement, so a replay posts once.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import {
  businessDateOf,
  createUlid,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  blindCountTotalIdr,
  cashMovementApprovedPayloadSchema,
  cashMovementRecordedPayloadSchema,
  cashierShiftClosedPayloadSchema,
  cashierShiftOpenedPayloadSchema,
  dayClosedPayloadSchema,
  type CashMovementApprovedPayload,
  type CashMovementRecordedPayload,
  type CashierShiftClosedPayload,
  endOfDayRecapSchema,
  type DayClosedPayload,
  type EndOfDayRecap,
} from "@starter/shared/pos";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import {
  edgePosIngests,
  type EdgePosIngestKind,
  type EdgePosIngestState,
} from "../db/schema/edge-pos-ingest.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  cashMovementOutcomes,
  cashMovements,
  posDailyCloses,
  posShiftCounts,
  posShifts,
} from "../db/schema/pos-shift.ts";
import { logger } from "../lib/logger.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { recordAudit } from "../services/core-audit.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { outletBusinessDayClock } from "../services/outlet-clock.ts";
import { windowTouchesDate } from "../services/edge-failover-window.ts";
import {
  computeEdgeComparableRecap,
  computeEdgeMirrorRecap,
} from "../services/pos-day.service.ts";
import { uniqueViolationOf } from "../services/pos-shift-support.ts";
import {
  registerEdgeParkedEventHook,
  type EdgeParkedEventHook,
} from "./deferred-event-applier.ts";
import {
  alertSupervisors,
  edgeAlertId,
  openBusinessDateFrom,
  recordLateAdjustment,
} from "./late-adjustment.ts";
import { isTransientReason, sqlStateOf } from "./order-ingest.ts";
import type { EdgeApplyMeta } from "./ports.ts";

export const SHIFT_OPENED_EVENT = "cashier_shift.opened";
export const SHIFT_CLOSED_EVENT = "cashier_shift.closed";
export const CASH_RECORDED_EVENT = "cash_movement.recorded";
export const CASH_APPROVED_EVENT = "cash_movement.approved";
export const DAY_CLOSED_EVENT = "day.closed";

/** A row that still waits after this long alerts the supervisors once. */
const PENDING_ALERT_MS = 60 * 60_000;

/** Final: recorded as `refused`. */
class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Not yet: recorded as `pending` and tried again. */
class Waiting extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Outcome = { state: EdgePosIngestState; reason: string };

function outcomeOf(error: unknown): Outcome {
  if (error instanceof Waiting) return { state: "pending", reason: error.code };
  if (error instanceof Refusal) return { state: "refused", reason: error.code };
  const constraint = uniqueViolationOf(error);
  if (
    constraint === "pos_shifts_open_device_key" ||
    constraint === "pos_shifts_open_cashier_key"
  )
    // A cloud shift of this device or cashier from before the edge took over.
    return { state: "pending", reason: "cloud_shift_open" };
  // Ids the applier cannot see (another outlet's rows): somebody else's cash.
  if (constraint === "pos_shifts_pkey")
    return { state: "refused", reason: "shift_exists" };
  if (constraint === "cash_movements_pkey")
    return { state: "refused", reason: "movement_exists" };
  if (constraint === "pos_shift_counts_pkey")
    return { state: "refused", reason: "count_exists" };
  if (constraint === "pos_daily_closes_pkey")
    return { state: "refused", reason: "day_exists" };
  const state = sqlStateOf(error);
  const reason = state ? `db_error:${state}` : "error";
  return { state: isTransientReason(reason) ? "pending" : "refused", reason };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type Target = {
  kind: EdgePosIngestKind;
  aggregateId: string;
  businessDate: string;
};

/** One lock per mirrored aggregate, so two batches never write it together. */
async function lockAggregate(
  tx: EdgeTx,
  context: ScopedTenantContext,
  target: Target,
): Promise<void> {
  const key =
    `edge-pos-ingest:${context.tenant.tenantId}:${target.kind}:${target.aggregateId}`.toLowerCase();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function ledgerOf(
  tx: EdgeTx,
  context: ScopedTenantContext,
  kind: EdgePosIngestKind,
  aggregateId: string,
) {
  const [row] = await tx
    .select()
    .from(edgePosIngests)
    .where(
      and(
        eq(edgePosIngests.tenantId, context.tenant.tenantId),
        eq(edgePosIngests.kind, kind),
        eq(edgePosIngests.aggregateId, aggregateId),
      ),
    );
  return row;
}

/** Writes the ledger row; an ingested row and another event's row stay. */
async function writeLedger(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  target: Target,
  row: {
    state: EdgePosIngestState;
    reason: string | null;
    lateBusinessDate?: string | null;
  },
): Promise<void> {
  const lateBusinessDate = row.lateBusinessDate ?? null;
  await tx
    .insert(edgePosIngests)
    .values({
      tenantId: meta.context.tenant.tenantId,
      kind: target.kind,
      aggregateId: target.aggregateId,
      outletId: event.outletId as OutletId,
      edgeNodeId: meta.edgeNodeId,
      eventId: event.id,
      businessDate: target.businessDate,
      state: row.state,
      reason: row.reason,
      lateBusinessDate,
    })
    .onConflictDoUpdate({
      target: [
        edgePosIngests.tenantId,
        edgePosIngests.kind,
        edgePosIngests.aggregateId,
      ],
      set: {
        state: row.state,
        reason: row.reason,
        lateBusinessDate,
        updatedAt: new Date(),
      },
      setWhere: and(
        sql`${edgePosIngests.state} <> 'ingested'`,
        eq(edgePosIngests.eventId, event.id),
      ),
    });
}

async function alertRefused(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  target: Target,
  reason: string,
): Promise<void> {
  await alertSupervisors(tx, meta.context, {
    outletId: event.outletId as OutletId,
    id: edgeAlertId(
      "edge_pos_ingest",
      meta.context.tenant.tenantId,
      target.kind,
      target.aggregateId,
      reason,
    ),
    eventName: "edge_pos_ingest.refused",
    aggregateType: target.kind,
    aggregateId: target.aggregateId,
    payload: { kind: target.kind, reason },
    title: "Data kasir server lokal perlu ditinjau",
    body: "Data shift, kas, atau Tutup Hari dari server lokal tidak cocok dan belum dicatat di pusat. Hubungi finance.",
  });
}

/**
 * Runs one ingest: savepoint, ledger claim, writes. Never throws (S1). Returns
 * true when this call mirrored the aggregate.
 */
async function ingest(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  target: Target,
  work: (sp: EdgeTx) => Promise<{ lateBusinessDate: string | null }>,
): Promise<boolean> {
  try {
    return await tx.transaction(async (sp) => {
      await lockAggregate(sp, meta.context, target);
      const prior = await ledgerOf(
        sp,
        meta.context,
        target.kind,
        target.aggregateId,
      );
      if (prior) {
        // S3: another event for an aggregate that has one is never applied.
        if (!same(prior.eventId, event.id))
          throw new Refusal("duplicate_event");
        if (prior.state !== "pending") return false; // replay
      }
      const { lateBusinessDate } = await work(sp);
      await writeLedger(sp, event, meta, target, {
        state: "ingested",
        reason: null,
        lateBusinessDate,
      });
      return true;
    });
  } catch (error) {
    const outcome = outcomeOf(error);
    logger.warn(
      { eventId: event.id, kind: target.kind, ...outcome },
      "Edge POS event not mirrored",
    );
    try {
      await tx.transaction(async (sp) => {
        await writeLedger(sp, event, meta, target, outcome);
        if (outcome.state === "refused")
          await alertRefused(sp, event, meta, target, outcome.reason);
      });
    } catch {
      // The parked row stays the durable evidence.
      logger.warn({ eventId: event.id }, "Edge POS ledger row not recorded");
    }
    return false;
  }
}

type Parked = { event: EventEnvelope; edgeNodeId: string };

/** Parked events of these aggregates at the event's own outlet. */
async function parkedOf(
  tx: EdgeTx,
  context: ScopedTenantContext,
  outletId: string,
  eventName: string,
  aggregateIds: readonly string[],
): Promise<Parked[]> {
  if (aggregateIds.length === 0) return [];
  const rows = await tx
    .select({
      envelope: edgeDeferredEvents.envelope,
      edgeNodeId: edgeDeferredEvents.edgeNodeId,
    })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, context.tenant.tenantId),
        eq(edgeDeferredEvents.outletId, outletId as OutletId),
        eq(edgeDeferredEvents.eventName, eventName),
        inArray(edgeDeferredEvents.aggregateId, [...aggregateIds]),
      ),
    )
    .orderBy(asc(edgeDeferredEvents.aggregateSequence));
  return rows.map((row) => ({
    event: row.envelope as unknown as EventEnvelope,
    edgeNodeId: row.edgeNodeId,
  }));
}

/**
 * Every parked `cash_movement.recorded` naming this shift at the outlet.
 * Review R3: the payload filter has no index; fine for one outlet's parked
 * rows, add an expression index if edge_deferred_events grows large.
 */
async function parkedOfShift(
  tx: EdgeTx,
  context: ScopedTenantContext,
  outletId: string,
  shiftId: string,
): Promise<Parked[]> {
  const rows = await tx
    .select({
      envelope: edgeDeferredEvents.envelope,
      edgeNodeId: edgeDeferredEvents.edgeNodeId,
    })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, context.tenant.tenantId),
        eq(edgeDeferredEvents.outletId, outletId as OutletId),
        eq(edgeDeferredEvents.eventName, CASH_RECORDED_EVENT),
        sql`lower(${edgeDeferredEvents.envelope} -> 'payload' ->> 'shiftId') = ${shiftId.toLowerCase()}`,
      ),
    );
  return rows.map((row) => ({
    event: row.envelope as unknown as EventEnvelope,
    edgeNodeId: row.edgeNodeId,
  }));
}

// ---- cashier_shift.closed -------------------------------------------------

type Movement = {
  recorded: CashMovementRecordedPayload;
  events: EventEnvelope[];
  needsApproval: boolean;
  outcome: "expired" | "approved" | "rejected" | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

/** Every movement the close lists, complete and consistent, or a throw. */
async function movementsOfClose(
  tx: EdgeTx,
  context: ScopedTenantContext,
  payload: CashierShiftClosedPayload,
): Promise<Movement[]> {
  const listed = payload.close?.movements ?? [];
  const ids = listed.map((row) => row.movementId);
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length)
    throw new Refusal("movement_listed_twice");
  // Cash the edge recorded on this drawer but the close does not list would
  // be lost from the count: never mirror a drawer without it.
  const listedIds = new Set(ids.map((id) => id.toLowerCase()));
  const unlisted = (
    await parkedOfShift(tx, context, payload.outletId, payload.shiftId)
  ).some((p) => !listedIds.has(p.event.aggregateId.toLowerCase()));
  if (unlisted) throw new Refusal("movement_unlisted");
  const recorded = await parkedOf(
    tx,
    context,
    payload.outletId,
    CASH_RECORDED_EVENT,
    ids,
  );
  const approved = await parkedOf(
    tx,
    context,
    payload.outletId,
    CASH_APPROVED_EVENT,
    ids,
  );
  const result: Movement[] = [];
  for (const row of listed) {
    const events = recorded.filter((p) =>
      same(p.event.aggregateId, row.movementId),
    );
    if (events.length === 0) throw new Waiting("movement_missing");
    if (events.length > 1) throw new Refusal("movement_duplicate");
    const parsed = cashMovementRecordedPayloadSchema.safeParse(
      events[0]!.event.payload,
    );
    if (
      !parsed.success ||
      !same(parsed.data.movementId, row.movementId) ||
      !same(parsed.data.shiftId, payload.shiftId) ||
      !same(parsed.data.outletId, payload.outletId) ||
      !same(parsed.data.deviceId, payload.deviceId)
    )
      throw new Refusal("movement_mismatch");
    const movement: Movement = {
      recorded: parsed.data,
      events: [events[0]!.event],
      needsApproval: row.needsApproval,
      outcome: row.outcome,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
    };
    // A held movement is always decided by the close; a plain one never is.
    if (row.needsApproval !== (row.outcome !== null))
      throw new Refusal("movement_mismatch");
    if (row.needsApproval && parsed.data.type === "cash_in")
      throw new Refusal("movement_mismatch");
    if (row.outcome !== null && row.decidedAt === null)
      throw new Refusal("movement_mismatch");
    const decisions = approved.filter((p) =>
      same(p.event.aggregateId, row.movementId),
    );
    if (row.outcome === "approved") {
      if (decisions.length === 0) throw new Waiting("approval_missing");
      const approval = cashMovementApprovedPayloadSchema.safeParse(
        decisions[0]!.event.payload,
      );
      if (
        decisions.length > 1 ||
        !approval.success ||
        !approvalMatches(movement, approval.data)
      )
        throw new Refusal("approval_mismatch");
      movement.events.push(decisions[0]!.event);
    } else if (decisions.length > 0) throw new Refusal("approval_mismatch");
    result.push(movement);
  }
  return result;
}

function approvalMatches(
  movement: Movement,
  approval: CashMovementApprovedPayload,
): boolean {
  const { recorded } = movement;
  return (
    same(approval.movementId, recorded.movementId) &&
    same(approval.shiftId, recorded.shiftId) &&
    same(approval.outletId, recorded.outletId) &&
    approval.type === recorded.type &&
    Number(approval.amountIdr) === Number(recorded.amountIdr) &&
    movement.decidedBy !== null &&
    same(approval.approvedBy, movement.decidedBy)
  );
}

function assertDrawerAgrees(
  payload: CashierShiftClosedPayload,
  movements: readonly Movement[],
): void {
  const detail = payload.close!;
  const inDrawer = (type: string) =>
    movements
      .filter(
        (m) =>
          m.recorded.type === type &&
          (!m.needsApproval || m.outcome === "approved"),
      )
      .reduce((sum, m) => sum + Number(m.recorded.amountIdr), 0);
  if (
    inDrawer("cash_in") !== Number(payload.cashInIdr) ||
    inDrawer("cash_out") !== Number(payload.cashOutIdr) ||
    inDrawer("drop") !== Number(payload.cashDropIdr)
  )
    throw new Refusal("movements_mismatch");
  const expected =
    Number(payload.openingFloatIdr) +
    Number(payload.cashSalesIdr) -
    Number(payload.cashRefundsIdr) +
    Number(payload.cashInIdr) -
    Number(payload.cashOutIdr) -
    Number(payload.cashDropIdr);
  if (expected !== Number(payload.expectedIdr))
    throw new Refusal("expected_mismatch");
  if (
    Number(blindCountTotalIdr(detail.count.counts)) !==
    Number(payload.countedIdr)
  )
    throw new Refusal("count_mismatch");
  if (Number(payload.heldCashOutIdr ?? 0) > Number(detail.heldTotalIdr))
    throw new Refusal("held_mismatch");
}

async function writeShift(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  payload: CashierShiftClosedPayload,
): Promise<{ lateBusinessDate: string | null }> {
  const context = meta.context;
  const tenantId = context.tenant.tenantId;
  const outletId = payload.outletId;
  const detail = payload.close;
  if (!detail) throw new Refusal("legacy_payload");
  const opened = await parkedOf(tx, context, outletId, SHIFT_OPENED_EVENT, [
    payload.shiftId,
  ]);
  if (opened.length === 0) throw new Waiting("opening_missing");
  const opening = cashierShiftOpenedPayloadSchema.safeParse(
    opened[0]!.event.payload,
  );
  if (
    opened.length > 1 ||
    !opening.success ||
    !same(opening.data.shiftId, payload.shiftId) ||
    !same(opening.data.outletId, outletId) ||
    !same(opening.data.deviceId, payload.deviceId) ||
    !same(opening.data.cashierId, payload.cashierId) ||
    opening.data.businessDate !== payload.businessDate ||
    Number(opening.data.openingFloatIdr) !== Number(payload.openingFloatIdr) ||
    !sameInstant(opening.data.openedAt, detail.openedAt)
  )
    throw new Refusal("opening_mismatch");
  const movements = await movementsOfClose(tx, context, payload);
  assertDrawerAgrees(payload, movements);

  // Any row of these ids, at any outlet of the tenant, is somebody else's cash.
  const [existing] = await tx
    .select({ id: posShifts.id })
    .from(posShifts)
    .where(
      and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, payload.shiftId)),
    );
  if (existing) throw new Refusal("shift_exists");

  const businessDate = await openBusinessDateFrom(
    tx,
    context,
    outletId,
    payload.businessDate,
  );
  if (businessDate === null) throw new Refusal("no_open_day");
  const late = businessDate !== payload.businessDate;

  const varianceIdr = (Number(payload.countedIdr) -
    Number(payload.expectedIdr)) as typeof payload.expectedIdr;
  const fingerprint = sha256(JSON.stringify(event.payload));
  await tx.insert(posShifts).values({
    id: payload.shiftId,
    tenantId,
    outletId,
    deviceId: payload.deviceId,
    cashierId: payload.cashierId,
    businessDate,
    status: "open",
    openedAt: new Date(detail.openedAt),
    openingFloatIdr: payload.openingFloatIdr,
    openKey: `edge:${opened[0]!.event.id}`,
    openFingerprint: sha256(JSON.stringify(opened[0]!.event.payload)),
  });
  for (const movement of movements) {
    const { recorded } = movement;
    const movementEvent = movement.events[0]!;
    await tx.insert(cashMovements).values({
      id: recorded.movementId,
      tenantId,
      outletId,
      shiftId: payload.shiftId,
      type: recorded.type,
      amountIdr: recorded.amountIdr,
      reasonNote: recorded.reasonNote,
      recordedBy: recorded.recordedBy,
      recordedAt: new Date(recorded.recordedAt),
      needsApproval: movement.needsApproval,
      idempotencyKey: `edge:${movementEvent.id}`,
      requestFingerprint: sha256(JSON.stringify(movementEvent.payload)),
    });
    if (movement.outcome !== null)
      await tx.insert(cashMovementOutcomes).values({
        tenantId,
        outletId,
        shiftId: payload.shiftId,
        movementId: recorded.movementId,
        outcome: movement.outcome,
        decidedBy: movement.decidedBy,
        decidedAt: new Date(movement.decidedAt!),
      });
  }
  await tx.insert(posShiftCounts).values({
    id: detail.count.id,
    tenantId,
    outletId,
    shiftId: payload.shiftId,
    sequence: detail.count.sequence,
    counts: detail.count.counts,
    countsFingerprint: sha256(JSON.stringify(detail.count.counts)),
    countedIdr: payload.countedIdr,
    expectedIdr: payload.expectedIdr,
    varianceIdr,
    heldCashOutIdr: detail.heldTotalIdr,
    heldCorrectionIdr: detail.count.heldCorrectionIdr,
    cashWatermark: detail.count.cashWatermark,
    submittedBy: detail.count.submittedBy,
    submittedAt: new Date(detail.count.submittedAt),
    forced: detail.count.forced,
    idempotencyKey: `edge:${event.id}`,
    requestFingerprint: fingerprint,
  });
  await tx
    .update(posShifts)
    .set({
      status: "closed",
      cashSalesIdr: payload.cashSalesIdr,
      cashRefundsIdr: payload.cashRefundsIdr,
      cashInIdr: payload.cashInIdr,
      cashOutIdr: payload.cashOutIdr,
      cashDropIdr: payload.cashDropIdr,
      expectedIdr: payload.expectedIdr,
      countedIdr: payload.countedIdr,
      varianceIdr,
      varianceNote: payload.varianceNote,
      heldCashOutIdr: detail.heldTotalIdr,
      differenceIdr: payload.differenceIdr,
      counts: detail.count.counts,
      countId: detail.count.id,
      approvedBy: payload.approvedBy,
      approvalRequestId: payload.approvalRequestId,
      approvalOverrideId: detail.approvalOverrideId,
      approvedAt: new Date(detail.approvedAt),
      closedAt: new Date(payload.closedAt),
      closedBy: detail.closedBy,
      closeKey: `edge:${event.id}`,
      closeFingerprint: fingerprint,
      version: 2,
      updatedAt: new Date(),
    })
    .where(
      and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, payload.shiftId)),
    );
  if (late) {
    // Before the journals: they read the late date from this row.
    await writeLedger(tx, event, meta, shiftTarget(payload), {
      state: "pending",
      reason: null,
      lateBusinessDate: businessDate,
    });
    await recordLateAdjustment(tx, context, {
      outletId,
      action: "pos_shift.late_adjusted",
      objectType: "pos_shift",
      objectId: payload.shiftId,
      originalBusinessDate: payload.businessDate,
      lateBusinessDate: businessDate,
    });
  }
  // S5: keyed `aj:cash-movement:` / `aj:shift:`. A parked journal is its own
  // retry record, as for a cloud shift.
  for (const source of [...movements.flatMap((m) => m.events), event]) {
    const journal = await deliverAutoJournalEvent(context, source, tx);
    if (journal.status === "parked")
      logger.warn(
        { eventId: source.id, code: journal.code },
        "Edge shift journal parked",
      );
  }
  return { lateBusinessDate: late ? businessDate : null };
}

const shiftTarget = (payload: CashierShiftClosedPayload): Target => ({
  kind: "shift",
  aggregateId: payload.shiftId,
  businessDate: payload.businessDate,
});

/** Mirrors a parked `cashier_shift.closed`. Never throws (S1). */
export async function ingestEdgeShiftClosed(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<boolean> {
  const parsed = cashierShiftClosedPayloadSchema.safeParse(event.payload);
  if (
    !parsed.success ||
    !event.outletId ||
    !same(parsed.data.outletId, event.outletId) ||
    !same(parsed.data.shiftId, event.aggregateId)
  ) {
    // No trustworthy shift id or outlet: the parked event is the only record.
    logger.warn({ eventId: event.id }, "Edge shift close not ingestable");
    return false;
  }
  return ingest(tx, event, meta, shiftTarget(parsed.data), (sp) =>
    writeShift(sp, event, meta, parsed.data),
  );
}

/** Tries a waiting shift again after an event it may have waited for. */
async function retryPendingShift(
  tx: EdgeTx,
  meta: EdgeApplyMeta,
  outletId: string,
  shiftId: string,
): Promise<void> {
  const prior = await ledgerOf(tx, meta.context, "shift", shiftId);
  if (prior?.state !== "pending") return;
  const closes = await parkedOf(
    tx,
    meta.context,
    outletId,
    SHIFT_CLOSED_EVENT,
    [shiftId],
  );
  const own = closes.find((p) => same(p.event.id, prior.eventId));
  if (own)
    await ingestEdgeShiftClosed(tx, own.event, {
      ...meta,
      edgeNodeId: own.edgeNodeId,
    });
}

const onShiftOpened: EdgeParkedEventHook = async (tx, event, meta) => {
  const parsed = cashierShiftOpenedPayloadSchema.safeParse(event.payload);
  if (parsed.success && event.outletId)
    await retryPendingShift(tx, meta, event.outletId, parsed.data.shiftId);
};

const onShiftClosed: EdgeParkedEventHook = async (tx, event, meta) => {
  await ingestEdgeShiftClosed(tx, event, meta);
};

// ---- cash_movement.recorded / cash_movement.approved -----------------------

/**
 * A movement is written with its shift. One that arrives after its shift was
 * mirrored and is not part of it is cash the closed drawer never counted: it is
 * refused (recorded and alerted), never booked.
 */
const onCashMovement: EdgeParkedEventHook = async (tx, event, meta) => {
  const schema =
    event.name === CASH_APPROVED_EVENT
      ? cashMovementApprovedPayloadSchema
      : cashMovementRecordedPayloadSchema;
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success || !event.outletId) {
    logger.warn({ eventId: event.id }, "Edge cash movement not ingestable");
    return;
  }
  const payload = parsed.data;
  await retryPendingShift(tx, meta, event.outletId, payload.shiftId);
  const shift = await ledgerOf(tx, meta.context, "shift", payload.shiftId);
  if (!shift || shift.state === "pending") return;
  const [known] = await tx
    .select({
      shiftId: cashMovements.shiftId,
      amountIdr: cashMovements.amountIdr,
      outcome: cashMovementOutcomes.outcome,
    })
    .from(cashMovements)
    .leftJoin(
      cashMovementOutcomes,
      and(
        eq(cashMovementOutcomes.tenantId, cashMovements.tenantId),
        eq(cashMovementOutcomes.movementId, cashMovements.id),
      ),
    )
    .where(
      and(
        eq(cashMovements.tenantId, meta.context.tenant.tenantId),
        eq(cashMovements.id, payload.movementId),
      ),
    );
  if (
    known &&
    same(known.shiftId, payload.shiftId) &&
    Number(known.amountIdr) === Number(payload.amountIdr) &&
    (event.name !== CASH_APPROVED_EVENT || known.outcome === "approved")
  )
    return; // replay
  await ingest(
    tx,
    event,
    meta,
    {
      kind: "movement",
      aggregateId: payload.movementId,
      businessDate: shift.businessDate,
    },
    async () => {
      throw new Refusal("shift_closed");
    },
  );
};

// ---- day.closed -------------------------------------------------------------

/** The totals, per-method money and shift count two recaps must share (S4). */
function recapFigures(recap: EndOfDayRecap): string {
  const total = (pick: (d: EndOfDayRecap["devices"][number]) => number) =>
    recap.devices.reduce((sum, device) => sum + pick(device), 0);
  return JSON.stringify([
    total((d) => d.orderCount),
    total((d) => d.voidedOrderCount),
    total((d) => d.refundCount),
    total((d) => d.shiftCount),
    recap.devices.every((d) => d.closed),
    Number(recap.totalSalesIdr),
    Number(recap.totalRefundsIdr),
    Number(recap.totalVoidsIdr),
    Number(recap.totalVarianceIdr),
    Number(recap.totalExpiredCashOutIdr),
    Number(recap.totalDepositAppliedIdr),
    Number(recap.totalDepositRefundedIdr),
    recap.tenders
      .filter((t) => Number(t.capturedIdr) !== 0 || Number(t.refundedIdr) !== 0)
      .map((t) => `${t.method}:${t.capturedIdr}:${t.refundedIdr}`)
      .sort(),
    recap.channels
      .filter((c) => c.orderCount !== 0)
      .map((c) => `${c.channel}:${c.orderCount}:${c.totalIdr}`)
      .sort(),
  ]);
}

/**
 * 1271 F5 (D5): the recap to store for an edge close the cloud matched. The
 * edge's own when the date holds no failover rows; else the cloud's recap of
 * edge + failover rows (each sale once: the edge never had the failover rows,
 * the comparison left them out). Waits while an open window touches the date
 * or a failover shift of it is still open.
 */
async function failoverRecap(
  tx: EdgeTx,
  meta: EdgeApplyMeta,
  outlet: typeof outlets.$inferSelect,
  recap: EndOfDayRecap,
  comparable: EndOfDayRecap,
): Promise<EndOfDayRecap> {
  const context = meta.context;
  const windows = await tx
    .select({
      status: outletFailoverWindows.status,
      businessDateFrom: outletFailoverWindows.businessDateFrom,
      businessDateTo: outletFailoverWindows.businessDateTo,
    })
    .from(outletFailoverWindows)
    .where(
      and(
        eq(outletFailoverWindows.tenantId, context.tenant.tenantId),
        eq(outletFailoverWindows.outletId, recap.outletId as OutletId),
        notInArray(outletFailoverWindows.status, ["cancelled"]),
      ),
    );
  const touching = windows.filter((w) =>
    windowTouchesDate(w, recap.businessDate),
  );
  if (touching.some((w) => w.status === "active" || w.status === "returning"))
    throw new Waiting("failover_open");
  let full: EndOfDayRecap;
  try {
    full = await computeEdgeMirrorRecap(
      tx,
      context,
      outlet,
      recap.outletId as OutletId,
      recap.businessDate,
      new Date(recap.closedAt ?? recap.generatedAt),
    );
  } catch (error) {
    if (sqlStateOf(error) !== null) throw error;
    throw new Waiting("recap_unbalanced");
  }
  // No failover row moved a figure (also a refund of a failover order dated
  // here, after its window): the edge's recap is the whole day.
  if (
    touching.length === 0 &&
    full.unsyncedReceiptCount === 0 &&
    recapFigures(full) === recapFigures(comparable)
  )
    return recap;
  if (!full.devices.every((d) => d.closed))
    throw new Waiting("failover_shift_open");
  return endOfDayRecapSchema.parse({
    ...full,
    id: recap.id,
    status: "closed",
    generatedAt: recap.generatedAt,
    closedAt: recap.closedAt,
    closedBy: recap.closedBy,
    inventoryDeductionApplied: recap.inventoryDeductionApplied,
    // The edge's gaps plus the F-run gaps: reported, never written off.
    unsyncedReceiptCount:
      recap.unsyncedReceiptCount + full.unsyncedReceiptCount,
    accountingSync: recap.accountingSync,
  });
}

async function writeDay(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  payload: DayClosedPayload,
): Promise<{ lateBusinessDate: null }> {
  const context = meta.context;
  const tenantId = context.tenant.tenantId;
  const outletId = payload.outletId;
  const recap = payload.recap;
  if (!recap) throw new Refusal("legacy_payload");
  const orderCount = recap.devices.reduce((sum, d) => sum + d.orderCount, 0);
  if (
    !same(recap.id, event.aggregateId) ||
    !same(recap.tenantId, tenantId) ||
    !same(recap.outletId, outletId) ||
    recap.businessDate !== payload.businessDate ||
    recap.status !== "closed" ||
    recap.closedAt === null ||
    !sameInstant(recap.closedAt, payload.closedAt) ||
    recap.closedBy === null ||
    !same(recap.closedBy, payload.closedBy) ||
    orderCount !== payload.orderCount ||
    Number(recap.totalSalesIdr) !== Number(payload.totalSalesIdr) ||
    Number(recap.totalRefundsIdr) !== Number(payload.totalRefundsIdr) ||
    Number(recap.totalVoidsIdr) !== Number(payload.totalVoidsIdr) ||
    Number(recap.totalVarianceIdr) !== Number(payload.totalVarianceIdr) ||
    recap.inventoryDeductionApplied !== payload.inventoryDeductionApplied
  )
    throw new Refusal("recap_mismatch");

  // Same locks and order as closePosDay.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-shift-open:${tenantId}:${outletId}`}, 0))`,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`pos-day:${tenantId}:${outletId}:${payload.businessDate}`}))`,
  );
  const [existing] = await tx
    .select({ id: posDailyCloses.id })
    .from(posDailyCloses)
    .where(
      and(
        eq(posDailyCloses.tenantId, tenantId),
        eq(posDailyCloses.outletId, outletId),
        eq(posDailyCloses.businessDate, payload.businessDate),
      ),
    );
  if (existing) throw new Refusal("day_already_closed");
  const [outlet] = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new Refusal("outlet_missing");
  const closedAt = new Date(payload.closedAt);
  if (
    payload.businessDate >
    businessDateOf(closedAt, outletBusinessDayClock(outlet))
  )
    throw new Refusal("day_not_started");

  let cloud: EndOfDayRecap;
  try {
    cloud = await computeEdgeComparableRecap(
      tx,
      context,
      outlet,
      outletId,
      payload.businessDate,
      closedAt,
    );
  } catch (error) {
    if (sqlStateOf(error) !== null) throw error;
    throw new Waiting("recap_unbalanced");
  }
  if (recapFigures(cloud) !== recapFigures(recap))
    throw new Waiting("recap_differs");
  const stored = await failoverRecap(tx, meta, outlet, recap, cloud);
  const storedOrderCount = stored.devices.reduce(
    (sum, d) => sum + d.orderCount,
    0,
  );

  await tx.insert(posDailyCloses).values({
    id: recap.id,
    tenantId,
    outletId,
    businessDate: payload.businessDate,
    orderCount: storedOrderCount,
    totalSalesIdr: stored.totalSalesIdr,
    totalRefundsIdr: stored.totalRefundsIdr,
    totalVoidsIdr: stored.totalVoidsIdr,
    totalVarianceIdr: stored.totalVarianceIdr,
    inventoryDeductionApplied: recap.inventoryDeductionApplied,
    recap: stored as unknown as Record<string, unknown>,
    closedBy: payload.closedBy,
    closedAt,
    idempotencyKey: `edge:${event.id}`,
    requestFingerprint: sha256(JSON.stringify(event.payload)),
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(),
      tenantId,
      outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "pos_day.mirrored_from_edge",
      objectType: "pos_daily_close",
      objectId: recap.id,
      reason: null,
      maskedChanges: {
        before: null,
        after: { businessDate: payload.businessDate },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(new Date()),
    },
    ["businessDate"],
  );
  return { lateBusinessDate: null };
}

/** Mirrors a parked `day.closed`. Never throws (S1). */
export async function ingestEdgeDayClosed(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<boolean> {
  const parsed = dayClosedPayloadSchema.safeParse(event.payload);
  if (
    !parsed.success ||
    !event.outletId ||
    !same(parsed.data.outletId, event.outletId)
  ) {
    logger.warn({ eventId: event.id }, "Edge day close not ingestable");
    return false;
  }
  return ingest(
    tx,
    event,
    meta,
    {
      kind: "day",
      aggregateId: event.aggregateId,
      businessDate: parsed.data.businessDate,
    },
    (sp) => writeDay(sp, event, meta, parsed.data),
  );
}

const onDayClosed: EdgeParkedEventHook = async (tx, event, meta) => {
  await ingestEdgeDayClosed(tx, event, meta);
};

// ---- Redrive ----------------------------------------------------------------

export type PendingEdgePosIngest = {
  kind: "shift" | "day";
  aggregateId: string;
  outletId: string;
  eventId: string;
  createdAt: Date;
};

/** Waiting shifts first (a day waits for its shifts), oldest first. */
export async function pendingEdgePosIngests(
  tx: EdgeTx,
  context: ScopedTenantContext,
  options: { before: Date; limit: number },
): Promise<PendingEdgePosIngest[]> {
  const rows = await tx
    .select({
      kind: edgePosIngests.kind,
      aggregateId: edgePosIngests.aggregateId,
      outletId: edgePosIngests.outletId,
      eventId: edgePosIngests.eventId,
      createdAt: edgePosIngests.createdAt,
    })
    .from(edgePosIngests)
    .where(
      and(
        eq(edgePosIngests.tenantId, context.tenant.tenantId),
        eq(edgePosIngests.state, "pending"),
        inArray(edgePosIngests.kind, ["shift", "day"]),
        lt(edgePosIngests.updatedAt, options.before),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${edgePosIngests.kind} = 'shift' THEN 0 ELSE 1 END`,
      asc(edgePosIngests.updatedAt),
    )
    .limit(options.limit);
  return rows as PendingEdgePosIngest[];
}

/** One more try of a waiting shift or day; alerts once when it waits long. */
export async function redriveEdgePosIngest(
  tx: EdgeTx,
  context: ScopedTenantContext,
  row: PendingEdgePosIngest,
  now: Date = new Date(),
): Promise<boolean> {
  const name = row.kind === "shift" ? SHIFT_CLOSED_EVENT : DAY_CLOSED_EVENT;
  const parked = await parkedOf(tx, context, row.outletId, name, [
    row.aggregateId,
  ]);
  const own = parked.find((p) => same(p.event.id, row.eventId));
  if (!own) return false;
  const meta: EdgeApplyMeta = {
    edgeNodeId: own.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context,
  };
  const done =
    row.kind === "shift"
      ? await ingestEdgeShiftClosed(tx, own.event, meta)
      : await ingestEdgeDayClosed(tx, own.event, meta);
  if (!done && now.getTime() - row.createdAt.getTime() > PENDING_ALERT_MS)
    await alertRefused(
      tx,
      own.event,
      meta,
      { kind: row.kind, aggregateId: row.aggregateId, businessDate: "" },
      "waiting",
    );
  return done;
}

/**
 * Cloud boot (registerEdgeLink), after registerPosDeferredEdgeApplier: the
 * shift, cash and day events are parked first, then mirrored.
 */
export function registerShiftDayEdgeApplier(): void {
  registerEdgeParkedEventHook(SHIFT_OPENED_EVENT, onShiftOpened);
  registerEdgeParkedEventHook(SHIFT_CLOSED_EVENT, onShiftClosed);
  registerEdgeParkedEventHook(CASH_RECORDED_EVENT, onCashMovement);
  registerEdgeParkedEventHook(CASH_APPROVED_EVENT, onCashMovement);
  registerEdgeParkedEventHook(DAY_CLOSED_EVENT, onDayClosed);
}
