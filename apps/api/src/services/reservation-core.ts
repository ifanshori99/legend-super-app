// Shared building blocks of the reservation services (PRD v1.7 §3.22; RSV-01..03;
// bead legend-t8bz): permission check, idempotency binding, event/audit writers,
// row mapping to the contract, table holds and DP reconciliation.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  RESERVATION_RANGE_BOUNDS,
  ReservationError,
  depositIsSettled,
  reservationEvents,
  reservationPolicySnapshotSchema,
  reservationSchema,
  reservationTableSlotSchema,
  type Reservation,
  type ReservationEventName,
  type ReservationTableSlot,
} from "@starter/shared/reservation";
import { domainEventOutbox, paymentIntents } from "../db/schema/index.ts";
import {
  reservationIdempotency,
  reservationTables,
  reservations,
} from "../db/schema/reservation.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

export type { Tx };
export type ReservationRow = typeof reservations.$inferSelect;
export type HoldRow = typeof reservationTables.$inferSelect;

export const RESERVATION_EVENT_DESTINATION = "cloud-sync";
export const VIEW_PERMISSION: PermissionCode = "reservation.view";
export const MANAGE_PERMISSION: PermissionCode = "reservation.manage";

/** Service-layer authorization (TEN-03) inside the tenant transaction. */
export async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  target: AccessTarget,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!snapshot.allows(permission, target))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this tenant.",
    );
}

/** PostgreSQL error code, directly or wrapped by drizzle's cause chain. */
export function pgErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code)
  )
    return candidate.code;
  return pgErrorCode(candidate.cause, depth + 1);
}

/** RSV-01: the exclusion constraint (23P01) is the contract's SLOT_TAKEN. */
export function mapHoldViolation(error: unknown): unknown {
  return pgErrorCode(error) === "23P01"
    ? new ReservationError("RESERVATION_SLOT_TAKEN")
    : error;
}

/** Serializes every table-hold writer of one outlet (before any row lock). */
export async function lockOutletHolds(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reservation-holds:${context.tenant.tenantId}:${outletId}`}, 0))`,
  );
}

// ------------------------------------------------------------ idempotency

export type KeyClaim =
  | { kind: "new" }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "resume"; reservationId: string | null };

/**
 * Binds `key` to the request fingerprint. Same key + same request replays the
 * stored result; same key + another request fails IDEMPOTENCY_KEY_REUSED. The
 * unique (tenant, key) index serializes racing first requests.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    key: string;
    operation: string;
    fingerprint: string;
  },
): Promise<KeyClaim> {
  const inserted = await tx
    .insert(reservationIdempotency)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      idempotencyKey: input.key,
      operation: input.operation,
      requestFingerprint: input.fingerprint,
    })
    .onConflictDoNothing()
    .returning({ key: reservationIdempotency.idempotencyKey });
  if (inserted.length > 0) return { kind: "new" };
  const [existing] = await tx
    .select()
    .from(reservationIdempotency)
    .where(
      and(
        eq(reservationIdempotency.tenantId, context.tenant.tenantId),
        eq(reservationIdempotency.idempotencyKey, input.key),
      ),
    );
  if (!existing)
    throw new HttpError(409, "CONFLICT", "Coba kirim permintaan sekali lagi.");
  if (
    existing.requestFingerprint !== input.fingerprint ||
    existing.outletId !== input.outletId
  )
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi ini sudah dipakai untuk permintaan lain.",
    );
  if (existing.response !== null)
    return { kind: "replay", response: existing.response };
  return { kind: "resume", reservationId: existing.reservationId };
}

export async function storeIdempotencyResult(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  reservationId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(reservationIdempotency)
    .set({ reservationId, response })
    .where(
      and(
        eq(reservationIdempotency.tenantId, context.tenant.tenantId),
        eq(reservationIdempotency.idempotencyKey, key),
      ),
    );
}

export async function attachIdempotencyReservation(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  reservationId: string,
): Promise<void> {
  await tx
    .update(reservationIdempotency)
    .set({ reservationId })
    .where(
      and(
        eq(reservationIdempotency.tenantId, context.tenant.tenantId),
        eq(reservationIdempotency.idempotencyKey, key),
      ),
    );
}

// ------------------------------------------------------------ events/audit

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, RESERVATION_EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Appends one catalogued reservation event in the caller's transaction. */
export async function appendReservationEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: ReservationEventName,
  input: {
    reservationId: string;
    outletId: OutletId;
    actorUserId: string | null;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const definition = reservationEvents[name];
  await appendEnvelope(tx, context, definition, {
    aggregateId: input.reservationId,
    outletId: input.outletId,
    actorUserId: input.actorUserId,
    payload: input.payload,
    now: input.now,
    idempotencyKey: `${name}:${input.reservationId}`,
  });
}

/** Shared envelope writer; also used for the QR-order `table_session.opened`. */
export async function appendEnvelope(
  tx: Tx,
  context: ScopedTenantContext,
  definition: (typeof reservationEvents)[ReservationEventName],
  input: {
    aggregateId: string;
    outletId: OutletId;
    actorUserId: string | null;
    payload: Record<string, unknown>;
    now: Date;
    idempotencyKey: string;
  },
): Promise<void> {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor:
      input.actorUserId === null
        ? { type: "system" }
        : { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: input.idempotencyKey.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: RESERVATION_EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

export const RESERVATION_AUDIT_SAFE_FIELDS = [
  "status",
  "reason",
  "depositPaidIdr",
  "depositRefundIdr",
  "depositForfeitedIdr",
  "policyVersion",
  "resolution",
] as const;

/** Sensitive writes (cancel, no-show, refund/forfeit decisions) are audited. */
export async function auditReservation(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string | null;
    outletId: OutletId;
    action: string;
    reservationId: string;
    reason: string | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: input.actorUserId === null ? "system" : "user",
      actorId: input.actorUserId ?? "system",
      deviceId: null,
      action: input.action,
      objectType: "reservation",
      objectId: input.reservationId,
      reason: input.reason,
      maskedChanges: { before: input.before, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    },
    RESERVATION_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ loading/mapping

export async function lockReservation(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  reservationId: string,
): Promise<ReservationRow> {
  const [row] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, context.tenant.tenantId),
        eq(reservations.outletId, outletId),
        eq(reservations.id, reservationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new ReservationError("RESERVATION_NOT_FOUND");
  return row;
}

export async function loadHolds(
  tx: Tx,
  context: ScopedTenantContext,
  reservationIds: string[],
): Promise<HoldRow[]> {
  if (reservationIds.length === 0) return [];
  return tx
    .select()
    .from(reservationTables)
    .where(
      and(
        eq(reservationTables.tenantId, context.tenant.tenantId),
        inArray(reservationTables.reservationId, reservationIds),
      ),
    );
}

/** `payment_intents.status` of each DP, keyed by intent id. */
export async function loadDepositStatuses(
  tx: Tx,
  context: ScopedTenantContext,
  intentIds: string[],
): Promise<Map<string, (typeof paymentIntents.$inferSelect)["status"]>> {
  const map = new Map<string, (typeof paymentIntents.$inferSelect)["status"]>();
  if (intentIds.length === 0) return map;
  const rows = await tx
    .select({ id: paymentIntents.id, status: paymentIntents.status })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        inArray(paymentIntents.id, intentIds),
      ),
    );
  for (const row of rows) map.set(row.id, row.status);
  return map;
}

export function toReservation(
  row: ReservationRow,
  holds: readonly HoldRow[],
  depositStatus: (typeof paymentIntents.$inferSelect)["status"] | null,
): Reservation {
  return reservationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    customerProfileId: row.customerProfileId,
    guestName: row.guestName,
    contactHash: row.contactHash,
    reservedFor: row.reservedFor.toISOString(),
    durationMinutes: row.durationMinutes,
    pax: row.pax,
    zoneId: row.zoneId,
    tableIds: [
      ...new Set(
        holds
          .filter((hold) => hold.reservationId === row.id)
          .map((hold) => hold.tableId),
      ),
    ],
    depositIdr: row.depositIdr,
    depositPaymentId: row.depositPaymentId,
    depositStatus: row.depositPaymentId === null ? null : depositStatus,
    policy: reservationPolicySnapshotSchema.parse(row.policySnapshot),
    status: row.status,
    note: row.note,
    source: row.source,
    seatedAt: row.seatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    closeReason: row.closeReason,
    tableSessionId: row.tableSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toSlot(hold: HoldRow): ReservationTableSlot {
  return reservationTableSlotSchema.parse({
    id: hold.id,
    tenantId: hold.tenantId,
    outletId: hold.outletId,
    reservationId: hold.reservationId,
    tableId: hold.tableId,
    startsAt: hold.startsAt.toISOString(),
    endsAt: hold.endsAt.toISOString(),
    releasedAt: hold.releasedAt?.toISOString() ?? null,
  });
}

/** Reads one reservation (no lock) as the contract object. */
export async function readReservation(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
): Promise<Reservation> {
  const holds = await loadHolds(tx, context, [row.id]);
  const statuses = await loadDepositStatuses(
    tx,
    context,
    row.depositPaymentId ? [row.depositPaymentId] : [],
  );
  return toReservation(
    row,
    holds,
    row.depositPaymentId ? (statuses.get(row.depositPaymentId) ?? null) : null,
  );
}

// ------------------------------------------------------------ holds (RSV-01)

/**
 * Replaces the reservation's table holds with `tableIds` (caller holds the
 * outlet lock and the reservation row lock). Another live hold on any table at
 * an overlapping time is RESERVATION_SLOT_TAKEN; the exclusion constraint
 * `reservation_tables_no_overlap` is the concurrency-safe backstop.
 */
export async function replaceHolds(
  tx: Tx,
  context: ScopedTenantContext,
  reservation: ReservationRow,
  tableIds: readonly string[],
): Promise<void> {
  const endsAt = new Date(
    reservation.reservedFor.getTime() + reservation.durationMinutes * 60_000,
  );
  const clash = await tx.execute(sql`
    SELECT rt.table_id
    FROM reservation_tables rt
    WHERE rt.tenant_id = ${context.tenant.tenantId}
      AND rt.released_at IS NULL
      AND rt.reservation_id <> ${reservation.id}
      AND rt.table_id IN (${sql.join(
        tableIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND rt.hold_range && tstzrange(${reservation.reservedFor.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, ${RESERVATION_RANGE_BOUNDS})
    LIMIT 1
  `);
  if (clash.rows.length > 0)
    throw new ReservationError("RESERVATION_SLOT_TAKEN");
  await tx
    .delete(reservationTables)
    .where(
      and(
        eq(reservationTables.tenantId, context.tenant.tenantId),
        eq(reservationTables.reservationId, reservation.id),
        isNull(reservationTables.releasedAt),
      ),
    );
  await insertHolds(tx, context, reservation, tableIds, endsAt);
}

export async function insertHolds(
  tx: Tx,
  context: ScopedTenantContext,
  reservation: ReservationRow,
  tableIds: readonly string[],
  endsAt: Date,
): Promise<void> {
  await tx.insert(reservationTables).values(
    tableIds.map((tableId) => ({
      tenantId: context.tenant.tenantId,
      outletId: reservation.outletId,
      reservationId: reservation.id,
      tableId,
      startsAt: reservation.reservedFor,
      endsAt,
    })),
  );
}

export async function releaseHolds(
  tx: Tx,
  context: ScopedTenantContext,
  reservationId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(reservationTables)
    .set({ releasedAt: now })
    .where(
      and(
        eq(reservationTables.tenantId, context.tenant.tenantId),
        eq(reservationTables.reservationId, reservationId),
        isNull(reservationTables.releasedAt),
      ),
    );
}

// ------------------------------------------------------------ DP reconciliation

/**
 * RSV-02: a reservation waiting for its DP becomes `confirmed` once the payment
 * intent is settled, and is closed as `cancelled` (nothing paid) when the
 * payment window passed unpaid. Idempotent; call it with the row locked.
 * Returns the (possibly updated) row.
 */
export async function reconcileDeposit(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  now: Date,
): Promise<ReservationRow> {
  if (row.status !== "pending_deposit" || row.depositPaymentId === null)
    return row;
  const statuses = await loadDepositStatuses(tx, context, [
    row.depositPaymentId,
  ]);
  const status = statuses.get(row.depositPaymentId) ?? null;
  if (depositIsSettled(status)) {
    const [updated] = await tx
      .update(reservations)
      .set({ status: "confirmed", updatedAt: now })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, row.id),
          eq(reservations.status, "pending_deposit"),
        ),
      )
      .returning();
    if (!updated) return row;
    await appendReservationEvent(tx, context, "reservation.confirmed", {
      reservationId: row.id,
      outletId: row.outletId,
      actorUserId: null,
      now,
      payload: {
        reservationId: row.id,
        depositPaymentId: row.depositPaymentId,
        depositIdr: row.depositIdr,
      },
    });
    return updated;
  }
  const expired =
    row.depositLinkExpiresAt !== null && row.depositLinkExpiresAt <= now;
  if (
    expired &&
    (status === "pending" || status === "expired" || status === "failed")
  ) {
    const [updated] = await tx
      .update(reservations)
      .set({
        status: "cancelled",
        closedAt: now,
        closeReason: "DP tidak dibayar sampai batas waktu.",
        depositRefundIdr: idr(0),
        depositForfeitedIdr: idr(0),
        updatedAt: now,
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, row.id),
          eq(reservations.status, "pending_deposit"),
        ),
      )
      .returning();
    if (!updated) return row;
    await releaseHolds(tx, context, row.id, now);
    const snapshot = reservationPolicySnapshotSchema.parse(row.policySnapshot);
    await appendReservationEvent(tx, context, "reservation.cancelled", {
      reservationId: row.id,
      outletId: row.outletId,
      actorUserId: null,
      now,
      payload: {
        reservationId: row.id,
        closedBy: "system",
        reason: "DP tidak dibayar sampai batas waktu.",
        depositPaidIdr: 0,
        depositRefundIdr: 0,
        depositForfeitedIdr: 0,
        policyVersion: snapshot.version,
      },
    });
    return updated;
  }
  return row;
}
