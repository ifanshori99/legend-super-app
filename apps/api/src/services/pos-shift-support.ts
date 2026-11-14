// Shared plumbing of the cashier shift service (bead legend-6c0; POS-03):
// request fingerprints for idempotency, the outlet permission check, the live
// cash aggregates of a shift, the §5 outbox events, audit and the contract
// DTO mappers.

import { createHash } from "node:crypto";
import { and, asc, eq, isNull, not, or, sql } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  CoreError,
  createUlid,
  toIsoDateTime,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
  z,
} from "@starter/shared/core";
import {
  closePosShiftInputSchema,
  forceClosePosShiftInputSchema,
  openPosShiftInputSchema,
  posCashMovementSchema,
  posEvents,
  posShiftCountReceiptSchema,
  posShiftCountSchema,
  posShiftSchema,
  POS_SHIFT_BLIND_FIELDS,
  recordCashMovementInputSchema,
  submitPosShiftCountInputSchema,
  type PosCashMovement,
  type PosShiftCount,
  type PosShiftCountReceipt,
  type PosEventName,
  type PosShift,
  type PosShiftWithFigures,
} from "@starter/shared/pos";
import { domainEventOutbox } from "../db/schema/index.ts";
import {
  posOrderRefunds,
  posOrderTenders,
  posOrderVoids,
  posOrders,
} from "../db/schema/pos-order.ts";
import {
  cashMovementOutcomes,
  cashMovements,
  posShiftCounts,
  posShifts,
} from "../db/schema/pos-shift.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { outletTarget } from "./device-pin-support.ts";
import { accessSnapshotInTransaction, type Tx } from "./permission-resolver.ts";

export type ShiftRow = typeof posShifts.$inferSelect;
export type CashMovementRow = typeof cashMovements.$inferSelect;
export type OpenPosShiftInput = z.output<typeof openPosShiftInputSchema>;
export type ClosePosShiftInput = z.output<typeof closePosShiftInputSchema>;
export type ForceClosePosShiftInput = z.output<
  typeof forceClosePosShiftInputSchema
>;
export type SubmitPosShiftCountInput = z.output<
  typeof submitPosShiftCountInputSchema
>;
export type ShiftCountRow = typeof posShiftCounts.$inferSelect;

/**
 * `pos_overrides.object_type` of a shift-close approval: it names one blind
 * count submission (round 2, legend-6c0), never the shift itself.
 */
export const SHIFT_COUNT_OBJECT_TYPE = "pos_shift_count";
export type RecordCashMovementInput = z.output<
  typeof recordCashMovementInputSchema
>;

/** Who is acting: the verified session user and, when proven, the device. */
export type ShiftCaller = { userId: UserId; deviceId: string | null };

const EVENT_DESTINATION = "cloud-sync";
const AUDIT_SAFE_FIELDS = [
  "id",
  "status",
  "deviceId",
  "cashierId",
  "businessDate",
  "openingFloatIdr",
  "cashSalesIdr",
  "cashRefundsIdr",
  "cashInIdr",
  "cashOutIdr",
  "cashDropIdr",
  "expectedIdr",
  "countedIdr",
  "varianceIdr",
  "heldCashOutIdr",
  "differenceIdr",
  "expiredCashOutIdr",
  "type",
  "amountIdr",
  "shiftId",
  "approvedBy",
  "approvalRequestId",
  "version",
] as const;

export function shiftNotFound(): CoreError {
  return new CoreError("NOT_FOUND", "Shift tidak ditemukan.");
}

// ---- Idempotency ------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/**
 * sha256 of the canonical JSON `{op, outletId, shiftId?, userId, body}`; the
 * body never carries the idempotency key itself.
 */
export function shiftFingerprint(input: {
  op: string;
  outletId: string;
  shiftId?: string;
  userId: string;
  body: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)), "utf8")
    .digest("hex");
}

/** Postgres unique violation: the constraint name, or null for any other error. */
export function uniqueViolationOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolationOf(candidate.cause, depth + 1);
}

export function parseShiftId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw shiftNotFound();
  return parsed.data;
}

// ---- Permissions (service-layer, fail closed) --------------------------------

export type OutletAccess = { has: (code: PermissionCode) => boolean };

/** The user's permissions on the outlet, from one access snapshot of the tx. */
export async function loadOutletAccess(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  outletId: string,
  now = new Date(),
): Promise<OutletAccess> {
  const snapshot = await accessSnapshotInTransaction(tx, context, userId, now);
  const target = outletTarget(outletId);
  return { has: (code) => snapshot.allows(code, target) };
}

export function permissionDenied(): CoreError {
  return new CoreError(
    "FORBIDDEN",
    "Anda tidak memiliki izin untuk tindakan shift ini.",
  );
}

export async function assertOutletPermission(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  outletId: string,
  code: PermissionCode,
): Promise<void> {
  const access = await loadOutletAccess(tx, context, userId, outletId);
  if (!access.has(code)) throw permissionDenied();
}

// ---- Rows -------------------------------------------------------------------

export async function findShift(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  shiftId: string,
  lock = false,
): Promise<ShiftRow> {
  const query = tx
    .select()
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, context.tenant.tenantId),
        eq(posShifts.outletId, outletId),
        eq(posShifts.id, parseShiftId(shiftId)),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw shiftNotFound();
  return row;
}

// ---- Live cash aggregates ---------------------------------------------------

export type ShiftAggregates = {
  cashSalesIdr: number;
  cashRefundsIdr: number;
  cashInIdr: number;
  cashOutIdr: number;
  cashDropIdr: number;
};

export const emptyAggregates: ShiftAggregates = {
  cashSalesIdr: 0,
  cashRefundsIdr: 0,
  cashInIdr: 0,
  cashOutIdr: 0,
  cashDropIdr: 0,
};

/**
 * legend-0v3b3: not a training order. A row with no `pos_orders` partner (QR
 * pay-first sale) is real. Training cash never reached the drawer, so it must
 * not count into the expected cash (a false shortage on close).
 */
const notTrainingOrder = or(
  isNull(posOrders.orderId),
  eq(posOrders.isTraining, false),
);

/**
 * The shift's cash figures. Cash rows carry the id of the drawer they went
 * into (`shift_id`, set under the shift row lock by pos-cash-guard), so the
 * figures are exactly the rows of this shift: no cashier or time window.
 * - Sales: captured cash tenders of the shift.
 * - Refunds: cash lines of the shift's linked refunds, plus the captured
 *   cash tenders of the shift's paid-sale voids (a correction void pays the
 *   whole sale back; pos-order-corrections writes no per-method lines).
 * - Refunds and voids held for supervisor review (`needs_approval`) are left
 *   out (legend-utqr).
 * - In / out / drop: the shift's cash movements, without the rows held for
 *   supervisor review (`needs_approval`): they never reach the drawer figures,
 *   so the expected cash cannot go negative or leak through a refusal
 *   (legend-67dt).
 */
export async function computeShiftAggregates(
  tx: Tx,
  shift: ShiftRow,
): Promise<ShiftAggregates> {
  const tenantId = shift.tenantId;
  const outletId = shift.outletId;

  const [sales] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderTenders)
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderTenders.tenantId),
        eq(posOrders.orderId, posOrderTenders.orderId),
      ),
    )
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.outletId, outletId),
        eq(posOrderTenders.shiftId, shift.id),
        eq(posOrderTenders.method, "cash"),
        eq(posOrderTenders.status, "captured"),
        notTrainingOrder,
      ),
    );

  const refunds = await tx
    .select({ lines: posOrderRefunds.lines })
    .from(posOrderRefunds)
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderRefunds.tenantId),
        eq(posOrders.orderId, posOrderRefunds.orderId),
      ),
    )
    .where(
      and(
        notTrainingOrder,
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.outletId, outletId),
        eq(posOrderRefunds.shiftId, shift.id),
        eq(posOrderRefunds.needsApproval, false),
      ),
    );
  let refundCash = 0;
  for (const refund of refunds)
    for (const line of refund.lines)
      if (line.method === "cash") refundCash += Number(line.amountIdr);

  const [voided] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderVoids)
    .innerJoin(
      posOrderTenders,
      and(
        eq(posOrderTenders.tenantId, posOrderVoids.tenantId),
        eq(posOrderTenders.orderId, posOrderVoids.orderId),
      ),
    )
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderVoids.tenantId),
        eq(posOrders.orderId, posOrderVoids.orderId),
      ),
    )
    .where(
      and(
        notTrainingOrder,
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.outletId, outletId),
        eq(posOrderVoids.shiftId, shift.id),
        eq(posOrderVoids.needsApproval, false),
        eq(posOrderTenders.method, "cash"),
        eq(posOrderTenders.status, "captured"),
      ),
    );

  const movements = await tx
    .select({
      type: cashMovements.type,
      total: sql<string>`coalesce(sum(${cashMovements.amountIdr}), 0)`,
    })
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, tenantId),
        eq(cashMovements.outletId, outletId),
        eq(cashMovements.shiftId, shift.id),
        // A held movement books into the drawer only once it has an 'approved'
        // outcome (EXISTS, so a movement counts once).
        or(
          eq(cashMovements.needsApproval, false),
          decidedMovementExists("approved"),
        ),
      ),
    )
    .groupBy(cashMovements.type);
  const byType = new Map(movements.map((row) => [row.type, Number(row.total)]));

  return {
    cashSalesIdr: Number(sales?.total ?? 0),
    cashRefundsIdr: refundCash + Number(voided?.total ?? 0),
    cashInIdr: byType.get("cash_in") ?? 0,
    cashOutIdr: byType.get("cash_out") ?? 0,
    cashDropIdr: byType.get("drop") ?? 0,
  };
}

/** Correlated EXISTS: the movement row has an outcome of this kind. */
function decidedMovementExists(outcome: "approved" | "rejected") {
  return sql`EXISTS (SELECT 1 FROM ${cashMovementOutcomes} WHERE ${cashMovementOutcomes.tenantId} = ${cashMovements.tenantId} AND ${cashMovementOutcomes.movementId} = ${cashMovements.id} AND ${cashMovementOutcomes.outcome} = ${outcome})`;
}

/**
 * Sum of the shift's cash held for supervisor review: cash outs and drops
 * (legend-67dt) plus the cash of held refunds and voids (legend-utqr). The
 * count stores it and the close refuses the count as stale when it moved.
 */
export async function heldCashOutIdrOf(
  tx: Tx,
  shift: ShiftRow,
): Promise<number> {
  const [movements] = await tx
    .select({
      total: sql<string>`coalesce(sum(${cashMovements.amountIdr}), 0)`,
    })
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, shift.tenantId),
        eq(cashMovements.outletId, shift.outletId),
        eq(cashMovements.shiftId, shift.id),
        eq(cashMovements.needsApproval, true),
        // Decided movements leave the held sum: 'approved' is in the drawer
        // figures, 'rejected' is not booked. 'expired' stays counted (a closed
        // shift's figures do not change).
        not(decidedMovementExists("approved")),
        not(decidedMovementExists("rejected")),
      ),
    );
  return safeHeldTotal(
    BigInt(movements?.total ?? 0) + (await heldCorrectionCashOf(tx, shift)),
  );
}

/**
 * legend-y9bf: the cash of the shift's held refunds and voids. The cashier
 * paid it and its own events (order.refunded, order.voided) book it, so the
 * shift close books counted − (expected − this): differenceIdr. Held cash
 * outs and drops are not in it: they expire at the close, their cash still
 * in the drawer.
 */
export async function heldCorrectionCashIdrOf(
  tx: Tx,
  shift: ShiftRow,
): Promise<number> {
  return safeHeldTotal(await heldCorrectionCashOf(tx, shift));
}

async function heldCorrectionCashOf(tx: Tx, shift: ShiftRow): Promise<bigint> {
  const heldRefunds = await tx
    .select({ lines: posOrderRefunds.lines })
    .from(posOrderRefunds)
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderRefunds.tenantId),
        eq(posOrders.orderId, posOrderRefunds.orderId),
      ),
    )
    .where(
      and(
        notTrainingOrder,
        eq(posOrderRefunds.tenantId, shift.tenantId),
        eq(posOrderRefunds.outletId, shift.outletId),
        eq(posOrderRefunds.shiftId, shift.id),
        eq(posOrderRefunds.needsApproval, true),
      ),
    );
  let refundCash = 0n;
  for (const refund of heldRefunds)
    for (const line of refund.lines)
      if (line.method === "cash") refundCash += BigInt(line.amountIdr);
  const [voided] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderVoids)
    .innerJoin(
      posOrderTenders,
      and(
        eq(posOrderTenders.tenantId, posOrderVoids.tenantId),
        eq(posOrderTenders.orderId, posOrderVoids.orderId),
      ),
    )
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderVoids.tenantId),
        eq(posOrders.orderId, posOrderVoids.orderId),
      ),
    )
    .where(
      and(
        notTrainingOrder,
        eq(posOrderVoids.tenantId, shift.tenantId),
        eq(posOrderVoids.outletId, shift.outletId),
        eq(posOrderVoids.shiftId, shift.id),
        eq(posOrderVoids.needsApproval, true),
        eq(posOrderTenders.method, "cash"),
        eq(posOrderTenders.status, "captured"),
      ),
    );
  return refundCash + BigInt(voided?.total ?? 0);
}

function safeHeldTotal(total: bigint): number {
  // Parsed in bigint so a huge sum cannot silently lose precision. The
  // writers bound every outflow (assertShiftOutflowBound), so only legacy
  // data gets here: a conflict, never a 500 (legend-q7jj F3). The cashier
  // can read it, so it never names held cash (legend-utqr).
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CoreError(
      "CONFLICT",
      "Data kas shift ini tidak dapat dihitung; hubungi admin.",
    );
  return Number(total);
}

/**
 * legend-y9bf: the shift close (normal and force) expires every held cash out
 * / drop of the shift that has no decision yet: an 'expired' outcome row and
 * a `pos_shift.cash_movement_expired` audit row each. Nothing is booked: the
 * cash never left the drawer, and the cashier asks again on the next shift.
 * Call under the shift row lock, before the closing UPDATE (the outcome guard
 * trigger reads the shift). Returns the expired sum; never in a cashier DTO.
 */
export async function expireHeldCashMovements(
  tx: Tx,
  context: ScopedTenantContext,
  shift: ShiftRow,
  caller: ShiftCaller,
  now: Date,
): Promise<number> {
  const held = await tx
    .select({
      id: cashMovements.id,
      type: cashMovements.type,
      amountIdr: cashMovements.amountIdr,
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
        eq(cashMovements.tenantId, shift.tenantId),
        eq(cashMovements.outletId, shift.outletId),
        eq(cashMovements.shiftId, shift.id),
        eq(cashMovements.needsApproval, true),
        isNull(cashMovementOutcomes.id),
      ),
    )
    .orderBy(asc(cashMovements.recordedAt), asc(cashMovements.id));
  let total = 0n;
  for (const movement of held) {
    await tx.insert(cashMovementOutcomes).values({
      tenantId: shift.tenantId,
      outletId: shift.outletId,
      shiftId: shift.id,
      movementId: movement.id,
      outcome: "expired",
      decidedBy: null,
      decidedAt: now,
    });
    await auditShift(
      tx,
      context,
      {
        action: "pos_shift.cash_movement_expired",
        outletId: shift.outletId as OutletId,
        objectType: "cash_movement",
        objectId: movement.id,
        caller,
        before: null,
        after: {
          shiftId: shift.id,
          type: movement.type,
          amountIdr: Number(movement.amountIdr),
          status: "expired",
        },
      },
      now,
    );
    total += BigInt(movement.amountIdr);
  }
  return safeHeldTotal(total);
}

/**
 * legend-q7jj F1: how many cash rows the shift has, held or not: its cash
 * movements, refunds, voids and held-movement outcomes (all insert-only). A count stores it; the
 * close refuses the count as stale when it moved, before any approval is
 * judged, so the stale answer never depends on the held status (no balance
 * oracle). Call under the shift row lock. Never in any DTO.
 */
export async function cashWatermarkOf(
  tx: Tx,
  shift: ShiftRow,
): Promise<number> {
  const [movements] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, shift.tenantId),
        eq(cashMovements.outletId, shift.outletId),
        eq(cashMovements.shiftId, shift.id),
      ),
    );
  const [refunds] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, shift.tenantId),
        eq(posOrderRefunds.outletId, shift.outletId),
        eq(posOrderRefunds.shiftId, shift.id),
      ),
    );
  const [voids] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(posOrderVoids)
    .where(
      and(
        eq(posOrderVoids.tenantId, shift.tenantId),
        eq(posOrderVoids.outletId, shift.outletId),
        eq(posOrderVoids.shiftId, shift.id),
      ),
    );
  // A decision on a held movement changes the drawer figures, so it moves the
  // watermark too (backstop: a count goes stale after a decision). 'expired'
  // outcomes only exist after the close, so counting every outcome is fine.
  const [outcomes] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(cashMovementOutcomes)
    .where(
      and(
        eq(cashMovementOutcomes.tenantId, shift.tenantId),
        eq(cashMovementOutcomes.outletId, shift.outletId),
        eq(cashMovementOutcomes.shiftId, shift.id),
      ),
    );
  return (
    Number(movements?.n ?? 0) +
    Number(refunds?.n ?? 0) +
    Number(voids?.n ?? 0) +
    Number(outcomes?.n ?? 0)
  );
}

/**
 * legend-q7jj F3: every cash outflow of the shift stays a safe integer, held
 * or not and whichever writer recorded it: cash outs and drops, the cash
 * lines of its refunds and the captured cash of its voids, plus `addIdr`
 * about to be written. The held flag is never read, so the answer says
 * nothing about the drawer (legend-utqr). Call under the shift row lock,
 * before the insert.
 */
export async function assertShiftOutflowBound(
  tx: Tx,
  shift: ShiftRow,
  addIdr: number,
): Promise<void> {
  const [movements] = await tx
    .select({
      total: sql<string>`coalesce(sum(${cashMovements.amountIdr}), 0)`,
    })
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, shift.tenantId),
        eq(cashMovements.outletId, shift.outletId),
        eq(cashMovements.shiftId, shift.id),
        sql`${cashMovements.type} <> 'cash_in'`,
      ),
    );
  const refunds = await tx
    .select({ lines: posOrderRefunds.lines })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, shift.tenantId),
        eq(posOrderRefunds.outletId, shift.outletId),
        eq(posOrderRefunds.shiftId, shift.id),
      ),
    );
  let refundCash = 0n;
  for (const refund of refunds)
    for (const line of refund.lines)
      if (line.method === "cash") refundCash += BigInt(line.amountIdr);
  const [voided] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderVoids)
    .innerJoin(
      posOrderTenders,
      and(
        eq(posOrderTenders.tenantId, posOrderVoids.tenantId),
        eq(posOrderTenders.orderId, posOrderVoids.orderId),
      ),
    )
    .where(
      and(
        eq(posOrderVoids.tenantId, shift.tenantId),
        eq(posOrderVoids.outletId, shift.outletId),
        eq(posOrderVoids.shiftId, shift.id),
        eq(posOrderTenders.method, "cash"),
        eq(posOrderTenders.status, "captured"),
      ),
    );
  const outflow =
    BigInt(movements?.total ?? 0) +
    refundCash +
    BigInt(voided?.total ?? 0) +
    BigInt(addIdr);
  if (outflow > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Jumlah kas keluar terlalu besar untuk shift ini.",
    );
}

export async function movementsOf(
  tx: Tx,
  shift: ShiftRow,
): Promise<CashMovementRow[]> {
  return tx
    .select()
    .from(cashMovements)
    .where(
      and(
        eq(cashMovements.tenantId, shift.tenantId),
        eq(cashMovements.outletId, shift.outletId),
        eq(cashMovements.shiftId, shift.id),
      ),
    )
    .orderBy(asc(cashMovements.recordedAt), asc(cashMovements.id));
}

// ---- Events and audit -------------------------------------------------------

export type ShiftEventName = Extract<
  PosEventName,
  | "cashier_shift.opened"
  | "cashier_shift.closed"
  | "cash_movement.recorded"
  | "cash_movement.approved"
>;

/**
 * One shift contract event on the transactional outbox, in the caller's
 * transaction (same envelope and destination as the order events).
 */
export async function appendShiftEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: ShiftEventName,
  input: {
    aggregateId: string;
    outletId: OutletId;
    payload: Record<string, unknown>;
    caller: ShiftCaller;
    now: Date;
  },
): Promise<void> {
  const definition = posEvents[name];
  const aggregateType = definition.entry.aggregateType;
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, input.aggregateId),
      ),
    );
  const sequence = Number(row?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor: { type: "user", id: input.caller.userId },
    deviceId: input.caller.deviceId,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

export async function auditShift(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    action: string;
    outletId: OutletId;
    objectType: "pos_shift" | "cash_movement" | "pos_shift_count";
    objectId: string;
    caller: ShiftCaller;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.caller.userId,
      deviceId: input.caller.deviceId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason ?? null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, AUDIT_SAFE_FIELDS),
        after:
          input.after === null
            ? null
            : maskAuditChanges(input.after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Contract mappers -------------------------------------------------------

/**
 * The contract shift for a caller. `blind` (a caller without the variance
 * permission, or the shift's own cashier: POS-03, legend-4wrfd) nulls the
 * drawer breakdown, expected and variance, open or closed. Otherwise the
 * full view (shiftFiguresDto).
 */
export function shiftDto(
  row: ShiftRow,
  live: ShiftAggregates = emptyAggregates,
  options: { blind?: boolean } = {},
): PosShift {
  const dto = shiftFiguresDto(row, live);
  return options.blind ? blindShiftDto(dto) : dto;
}

/** The blind view of a full shift (legend-4wrfd). */
export function blindShiftDto(dto: PosShift): PosShift {
  const blind: Record<string, unknown> = { ...dto };
  for (const key of POS_SHIFT_BLIND_FIELDS) blind[key] = null;
  return posShiftSchema.parse(blind);
}

/**
 * The full shift (supervisor reads, internal maths, events, audit). An open
 * shift shows the live aggregates (`live`); a closed one shows the figures
 * frozen at close.
 */
export function shiftFiguresDto(
  row: ShiftRow,
  live: ShiftAggregates = emptyAggregates,
): PosShiftWithFigures {
  const closed = row.status === "closed";
  const figures = closed
    ? {
        cashSalesIdr: Number(row.cashSalesIdr),
        cashRefundsIdr: Number(row.cashRefundsIdr),
        cashInIdr: Number(row.cashInIdr),
        cashOutIdr: Number(row.cashOutIdr),
        cashDropIdr: Number(row.cashDropIdr),
      }
    : live;
  return posShiftSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    deviceId: row.deviceId,
    cashierId: row.cashierId,
    businessDate: row.businessDate,
    status: row.status,
    openedAt: toIsoDateTime(row.openedAt),
    openingFloatIdr: Number(row.openingFloatIdr),
    cashSalesIdr: figures.cashSalesIdr,
    cashRefundsIdr: figures.cashRefundsIdr,
    cashInIdr: figures.cashInIdr,
    cashOutIdr: figures.cashOutIdr,
    cashDropIdr: figures.cashDropIdr,
    expectedIdr: row.expectedIdr === null ? null : Number(row.expectedIdr),
    countedIdr: row.countedIdr === null ? null : Number(row.countedIdr),
    varianceIdr: row.varianceIdr === null ? null : Number(row.varianceIdr),
    varianceNote: row.varianceNote,
    approvedBy: row.approvedBy,
    approvalRequestId: row.approvalRequestId,
    approvedAt: row.approvedAt ? toIsoDateTime(row.approvedAt) : null,
    closedAt: row.closedAt ? toIsoDateTime(row.closedAt) : null,
    countId: row.countId ?? null,
  }) as PosShiftWithFigures;
}

/** Supervisor view of one blind count submission (expected and variance). */
export function countDto(row: ShiftCountRow): PosShiftCount {
  return posShiftCountSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    shiftId: row.shiftId,
    sequence: row.sequence,
    counts: row.counts,
    countedIdr: Number(row.countedIdr),
    expectedIdr: Number(row.expectedIdr),
    varianceIdr: Number(row.varianceIdr),
    heldCashOutIdr: Number(row.heldCashOutIdr),
    submittedBy: row.submittedBy,
    submittedAt: toIsoDateTime(row.submittedAt),
  });
}

/**
 * Cashier view of the same submission: blind, so no expected or variance;
 * only whether the close will need a written note (POS-03).
 */
export function countReceiptDto(row: ShiftCountRow): PosShiftCountReceipt {
  return posShiftCountReceiptSchema.parse({
    id: row.id,
    shiftId: row.shiftId,
    sequence: row.sequence,
    countedIdr: Number(row.countedIdr),
    // Exactly when the close books a difference (legend-y9bf): variance +
    // held refund and void cash. A held cash out expires with its cash still
    // in the drawer, so an honest count after it needs no note either and
    // the note never reveals the held status (legend-utqr). Counts made
    // before held_correction_idr keep their old answer.
    noteRequired:
      Number(row.varianceIdr) +
        Number(row.heldCorrectionIdr ?? row.heldCashOutIdr) !==
      0,
    submittedAt: toIsoDateTime(row.submittedAt),
  });
}

/**
 * `withApproval` adds the held flag for callers that see live figures
 * (supervisor reads); never for the record response or the shift's cashier.
 */
export function movementDto(
  row: CashMovementRow,
  options: { withApproval?: boolean } = {},
): PosCashMovement {
  return posCashMovementSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    shiftId: row.shiftId,
    type: row.type,
    amountIdr: Number(row.amountIdr),
    reasonNote: row.reasonNote,
    recordedBy: row.recordedBy,
    recordedAt: toIsoDateTime(row.recordedAt),
    approvedBy: row.approvedBy,
    ...(options.withApproval ? { needsApproval: row.needsApproval } : {}),
  });
}

/** Audit-safe snapshot of a shift row (no counts sheet, no note text). */
export function shiftAuditView(
  row: ShiftRow,
  live: ShiftAggregates = emptyAggregates,
): Record<string, unknown> {
  const dto = shiftFiguresDto(row, live);
  return {
    id: dto.id,
    status: dto.status,
    deviceId: dto.deviceId,
    cashierId: dto.cashierId,
    businessDate: dto.businessDate,
    openingFloatIdr: dto.openingFloatIdr,
    cashSalesIdr: dto.cashSalesIdr,
    cashRefundsIdr: dto.cashRefundsIdr,
    cashInIdr: dto.cashInIdr,
    cashOutIdr: dto.cashOutIdr,
    cashDropIdr: dto.cashDropIdr,
    expectedIdr: dto.expectedIdr,
    countedIdr: dto.countedIdr,
    varianceIdr: dto.varianceIdr,
    approvedBy: dto.approvedBy,
    approvalRequestId: dto.approvalRequestId,
    version: row.version,
  };
}

/**
 * The cash the drawer should hold right now: opening float + cash sales -
 * cash refunds + cash in - cash out - drops (same formula as the cash
 * movement guard). Call with the shift row locked.
 */
export async function liveExpectedCashIdr(
  tx: Tx,
  shift: ShiftRow,
): Promise<number> {
  const live = await computeShiftAggregates(tx, shift);
  return (
    Number(shift.openingFloatIdr) +
    live.cashSalesIdr -
    live.cashRefundsIdr +
    live.cashInIdr -
    live.cashOutIdr -
    live.cashDropIdr
  );
}
