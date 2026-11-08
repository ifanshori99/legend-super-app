// Shared plumbing of the cashier shift service (bead legend-6c0; POS-03):
// request fingerprints for idempotency, the outlet permission check, the live
// cash aggregates of a shift, the §5 outbox events, audit and the contract
// DTO mappers.

import { createHash } from "node:crypto";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
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
  openPosShiftInputSchema,
  posCashMovementSchema,
  posEvents,
  posShiftCountReceiptSchema,
  posShiftCountSchema,
  posShiftSchema,
  recordCashMovementInputSchema,
  submitPosShiftCountInputSchema,
  type PosCashMovement,
  type PosShiftCount,
  type PosShiftCountReceipt,
  type PosEventName,
  type PosShift,
} from "@starter/shared/pos";
import { domainEventOutbox } from "../db/schema/index.ts";
import {
  posOrderRefunds,
  posOrderTenders,
  posOrderVoids,
} from "../db/schema/pos-order.ts";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
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
 * The shift's cash figures up to `until` (the close instant, or now for an
 * open shift's screen).
 * - Sales: captured cash tenders of the orders attributed to the shift.
 * - Refunds: cash lines of the cashier's linked refunds, plus the captured
 *   cash tenders of the cashier's paid-sale voids (a correction void pays the
 *   whole sale back; pos-order-corrections writes no per-method lines), both
 *   inside [opened_at, until].
 * - In / out / drop: the shift's cash movements.
 */
export async function computeShiftAggregates(
  tx: Tx,
  shift: ShiftRow,
  until: Date,
): Promise<ShiftAggregates> {
  const tenantId = shift.tenantId;
  const outletId = shift.outletId;
  const cashier = shift.cashierId.toLowerCase();
  // An open shift (live figures, or the close itself under the shift's row
  // lock) owns everything its cashier took since it opened; only a closed
  // shift is bounded by its close time. No upper bound on an open shift also
  // keeps a database clock slightly ahead of the API clock from dropping a
  // capture that committed a moment before the close read.
  const bounded = (column: AnyPgColumn) =>
    shift.status === "open" ? undefined : lte(column, until);

  // Cash goes into the drawer of whoever took it, when they took it: the
  // capturing cashier and the capture time (pos-order-payment sets both on a
  // cash tender), the same rule as refunds and voids below. Not the order's
  // submit-time shift: a tab submitted in shift A and paid in shift B is B's
  // cash, and an order submitted without a shift still lands in a drawer.
  const [sales] = await tx
    .select({
      total: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
    })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.outletId, outletId),
        eq(posOrderTenders.method, "cash"),
        eq(posOrderTenders.status, "captured"),
        sql`lower(${posOrderTenders.capturedBy}) = ${cashier}`,
        gte(posOrderTenders.resolvedAt, shift.openedAt),
        bounded(posOrderTenders.resolvedAt),
      ),
    );

  const refunds = await tx
    .select({ lines: posOrderRefunds.lines })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.outletId, outletId),
        sql`lower(${posOrderRefunds.requestedBy}) = ${cashier}`,
        gte(posOrderRefunds.refundedAt, shift.openedAt),
        bounded(posOrderRefunds.refundedAt),
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
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.outletId, outletId),
        sql`lower(${posOrderVoids.requestedBy}) = ${cashier}`,
        gte(posOrderVoids.voidedAt, shift.openedAt),
        bounded(posOrderVoids.voidedAt),
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
  "cashier_shift.opened" | "cashier_shift.closed" | "cash_movement.recorded"
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
 * The contract shift. An open shift shows the live aggregates (`live`); a
 * closed one shows the figures frozen at close.
 */
export function shiftDto(
  row: ShiftRow,
  live: ShiftAggregates = emptyAggregates,
): PosShift {
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
  });
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
    noteRequired: Number(row.varianceIdr) !== 0,
    submittedAt: toIsoDateTime(row.submittedAt),
  });
}

export function movementDto(row: CashMovementRow): PosCashMovement {
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
  });
}

/** Audit-safe snapshot of a shift row (no counts sheet, no note text). */
export function shiftAuditView(
  row: ShiftRow,
  live: ShiftAggregates = emptyAggregates,
): Record<string, unknown> {
  const dto = shiftDto(row, live);
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
