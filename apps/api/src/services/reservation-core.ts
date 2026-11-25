// Shared building blocks of the reservation services (PRD v1.7 §3.22; RSV-01..03;
// bead legend-t8bz): permission check, idempotency binding, event/audit writers,
// row mapping to the contract, table holds and DP reconciliation.
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  idr,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  RESERVATION_RANGE_BOUNDS,
  ReservationError,
  depositHoldsFunds,
  reservationEvents,
  reservationPolicySnapshotSchema,
  reservationSchema,
  reservationTableSlotSchema,
  type Reservation,
  type ReservationEventName,
  type ReservationTableSlot,
} from "@starter/shared/reservation";
import {
  domainEventOutbox,
  paymentIntents,
  paymentLinks,
  paymentRefunds,
} from "../db/schema/index.ts";
import {
  reservationIdempotency,
  reservationTables,
  reservations,
} from "../db/schema/reservation.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { GATEWAY_POLL_WINDOW_MS } from "./payment-poll-window.ts";
import { depositIntentMayStillPay } from "./reservation-deposit-proof.ts";
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
  reservationId: string | null,
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
  "refundStatus",
  "refundAttempts",
  "paymentRefundId",
  // legend-m0kqn: the cancel was forced by the poll-window cap, not by the guest.
  "providerUnanswered",
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
      actorId: input.actorUserId,
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

type IntentStatus = (typeof paymentIntents.$inferSelect)["status"];

/**
 * RSV-02/RSV-03 money guard: how much of a reservation's DP its WS-05 intent
 * still holds. Zero unless the intent is `paid` or `partially_refunded`
 * (`depositHoldsFunds`); otherwise the DP (capped at the intent amount) minus
 * every refund WS-05 has reserved against the intent (any status but `failed`,
 * the same sum WS-05's refund cap uses), never below zero. Seating credits
 * exactly this, and a close or late-DP refund splits exactly this, so a DP
 * that was partly returned is never credited or refunded in full again.
 */
export async function loadHeldDeposit(
  tx: Tx,
  context: ScopedTenantContext,
  intentId: string,
  depositIdr: number,
): Promise<{ status: IntentStatus | null; heldIdr: Idr }> {
  const [intent] = await tx
    .select({
      status: paymentIntents.status,
      amountIdr: paymentIntents.amountIdr,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intentId),
      ),
    );
  if (!intent) return { status: null, heldIdr: idr(0) };
  if (!depositHoldsFunds(intent.status))
    return { status: intent.status, heldIdr: idr(0) };
  const [reserved] = await tx
    .select({
      total: sql<string>`coalesce(sum(${paymentRefunds.amountIdr}), 0)::text`,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, context.tenant.tenantId),
        eq(paymentRefunds.paymentIntentId, intentId),
        sql`${paymentRefunds.status} <> 'failed'`,
        isNull(paymentRefunds.unallocatedFundId),
      ),
    );
  const base = BigInt(Math.min(depositIdr, Number(intent.amountIdr)));
  const held = base - BigInt(reserved?.total ?? "0");
  return { status: intent.status, heldIdr: idr(Number(held > 0n ? held : 0n)) };
}

/**
 * The contract's `depositStatus` for a row (RSV-02), total over valid rows:
 * - no DP: null;
 * - a recorded intent: its WS-05 status (`intentStatus`). If that lookup came
 *   back empty, the row still says what it was: a `deposit_payment_id` is
 *   only recorded for a settled intent, so `paid` (and `pending` for a legacy
 *   row still waiting);
 * - awaited (pending_deposit, no settled intent yet, link attached or still
 *   being attached): `pending`, or `expired` once the link's window passed;
 * - closed without anything paid: null.
 */
export function deriveDepositStatus(
  row: ReservationRow,
  intentStatus: IntentStatus | null,
  now: Date = new Date(),
): IntentStatus | null {
  if (row.depositIdr === 0) return null;
  if (row.depositPaymentId !== null)
    return (
      intentStatus ?? (row.status === "pending_deposit" ? "pending" : "paid")
    );
  if (row.status !== "pending_deposit") return null;
  return row.depositLinkExpiresAt !== null && row.depositLinkExpiresAt <= now
    ? "expired"
    : "pending";
}

/**
 * Maps a row to the contract. Total over every row the database accepts: a
 * booking still waiting for its DP link, an awaited DP without an intent, and
 * a settled DP later refunded (`refunded` / `partially_refunded`) all map, so
 * one row can never fail a whole staff list.
 */
export function toReservation(
  row: ReservationRow,
  holds: readonly HoldRow[],
  depositStatus: IntentStatus | null,
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
    depositPaymentId: row.depositIdr === 0 ? null : row.depositPaymentId,
    depositStatus: deriveDepositStatus(row, depositStatus),
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
 * Grace for a DP booking whose bill link was never attached (a crash or a
 * payment-side failure between the booking commit and the link). PRD §3 F22 /
 * §3.22 "DP & Kebijakan" set no value; the safest default is the snapshot's own
 * payment window (the guest could not have paid any longer than that), and this
 * constant only applies when the snapshot cannot be read.
 */
export const DEPOSIT_ATTACH_GRACE_MINUTES = 30;
/** `close_reason` of a reservation closed because its DP was never paid. */
export const DEPOSIT_NOT_PAID_REASON = "deposit_not_paid";

function paymentWindowMinutes(row: ReservationRow): number {
  const parsed = reservationPolicySnapshotSchema.safeParse(row.policySnapshot);
  return parsed.success
    ? parsed.data.paymentWindowMinutes
    : DEPOSIT_ATTACH_GRACE_MINUTES;
}

export type DepositState = {
  /** First settled (`paid` / `partially_refunded`) intent of the DP, if any. */
  readonly settledIntentId: string | null;
  /**
   * Until when the DP can still be paid: the link's expiry, extended by any
   * pending intent the guest already opened on it (a QR shown just before the
   * link expired stays payable for its own lifetime); without a link, the
   * creation time plus the payment window (the attach grace).
   */
  readonly payableUntil: Date;
  /**
   * legend-pdi5u: an intent of the DP is still open at the provider (see
   * `depositIntentMayStillPay`), so the local `payableUntil` is not proof.
   */
  readonly providerPending: boolean;
};

/**
 * RSV-02: the DP's state derived from WS-05. A reservation's DP is the bill
 * link it opened; any settled intent on that link pays it. Rows written before
 * the link model carry the intent directly in `deposit_payment_id`.
 */
export async function loadDepositState(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
): Promise<DepositState> {
  const match: SQL[] = [];
  if (row.depositPaymentLinkId !== null)
    match.push(eq(paymentIntents.paymentLinkId, row.depositPaymentLinkId));
  if (row.depositPaymentId !== null)
    match.push(eq(paymentIntents.id, row.depositPaymentId));
  const intents =
    match.length === 0
      ? []
      : await tx
          .select({
            id: paymentIntents.id,
            status: paymentIntents.status,
            expiresAt: paymentIntents.expiresAt,
            paidAt: paymentIntents.paidAt,
            providerRef: paymentIntents.providerRef,
            providerFinalAt: paymentIntents.providerFinalAt,
          })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, context.tenant.tenantId),
              or(...match),
            ),
          )
          .orderBy(asc(paymentIntents.paidAt), asc(paymentIntents.id));
  // Only an intent that still holds the money confirms the DP: one already
  // refunded in full by WS-05 is not a deposit, whatever it once was (RSV-02).
  const settled = intents.find((intent) => depositHoldsFunds(intent.status));
  let payableUntil =
    row.depositLinkExpiresAt ??
    new Date(row.createdAt.getTime() + paymentWindowMinutes(row) * 60_000);
  for (const intent of intents)
    if (
      (intent.status === "pending" || depositIntentMayStillPay(intent)) &&
      intent.expiresAt > payableUntil
    )
      payableUntil = intent.expiresAt;
  return {
    settledIntentId: settled?.id ?? null,
    payableUntil,
    providerPending: intents.some(depositIntentMayStillPay),
  };
}

/**
 * Payment lock protocol (see `payment-late-settlement.ts`, "Urutan kunci
 * pembayaran"): the reservation row is the bill owner, so it is locked first
 * (`lockReservation`), then the DP link, then the link's intents in ascending
 * id. Call it right after `lockReservation`, before reading the DP state, so a
 * settlement that committed first is visible and one that has not yet locked
 * the reservation waits behind this transaction. Returns the first intent of
 * the link that still holds money (`paid` / `partially_refunded`), if any.
 * Also locks the recorded intent, including legacy rows without a DP link, in
 * the same ascending order as the link's intents.
 */
export async function lockDepositLink(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
): Promise<{ heldIntentId: string | null }> {
  if (row.depositPaymentLinkId === null && row.depositPaymentId === null)
    return { heldIntentId: null };
  const tenantId = context.tenant.tenantId;
  if (row.depositPaymentLinkId !== null)
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, tenantId),
          eq(paymentLinks.id, row.depositPaymentLinkId),
        ),
      )
      .for("update");
  const intents = await tx
    .select({
      id: paymentIntents.id,
      status: paymentIntents.status,
      paymentLinkId: paymentIntents.paymentLinkId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        or(
          row.depositPaymentLinkId === null
            ? undefined
            : eq(paymentIntents.paymentLinkId, row.depositPaymentLinkId),
          row.depositPaymentId === null
            ? undefined
            : eq(paymentIntents.id, row.depositPaymentId),
        ),
      ),
    )
    .orderBy(asc(paymentIntents.id))
    .for("update");
  const held = intents.find(
    (intent) =>
      intent.paymentLinkId === row.depositPaymentLinkId &&
      row.depositPaymentLinkId !== null &&
      depositHoldsFunds(intent.status),
  );
  return { heldIntentId: held?.id ?? null };
}

/**
 * Closes a `pending_deposit` reservation whose DP was never paid: status
 * `cancelled`, nothing paid / refunded / forfeited, holds released, one
 * `reservation.cancelled` event (closedBy system) and an audit row. No-op when
 * the row already left `pending_deposit`. Caller holds the row lock.
 */
export async function cancelUnpaidDeposit(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  now: Date,
  cause: { providerUnanswered?: boolean } = {},
): Promise<ReservationRow> {
  const [updated] = await tx
    .update(reservations)
    .set({
      status: "cancelled",
      closedAt: now,
      closeReason: DEPOSIT_NOT_PAID_REASON,
      closedBy: null,
      depositRefundIdr: idr(0),
      depositForfeitedIdr: idr(0),
      refundStatus: "not_required",
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
  const snapshot = reservationPolicySnapshotSchema.safeParse(
    row.policySnapshot,
  );
  const version = snapshot.success ? snapshot.data.version : "unknown";
  await appendReservationEvent(tx, context, "reservation.cancelled", {
    reservationId: row.id,
    outletId: row.outletId,
    actorUserId: null,
    now,
    payload: {
      reservationId: row.id,
      closedBy: "system",
      reason: DEPOSIT_NOT_PAID_REASON,
      depositPaidIdr: 0,
      depositRefundIdr: 0,
      depositForfeitedIdr: 0,
      policyVersion: version,
    },
  });
  await auditReservation(tx, context, {
    actorUserId: null,
    outletId: row.outletId,
    action: "reservation.cancelled",
    reservationId: row.id,
    reason: DEPOSIT_NOT_PAID_REASON,
    before: {
      status: row.status,
      depositPaidIdr: 0,
      ...(cause.providerUnanswered ? { providerUnanswered: true } : {}),
    },
    after: {
      status: "cancelled",
      depositRefundIdr: 0,
      depositForfeitedIdr: 0,
      policyVersion: version,
      ...(cause.providerUnanswered ? { providerUnanswered: true } : {}),
    },
    now,
  });
  return updated;
}

/**
 * RSV-02: a reservation waiting for its DP becomes `confirmed` once an intent
 * on its DP link is settled (that intent is recorded as `deposit_payment_id`),
 * and is closed as `cancelled` (nothing paid) once the DP can no longer be
 * paid. Idempotent and replay safe (conditional on `pending_deposit`; the
 * events are keyed per reservation); call it with the row locked. Returns the
 * (possibly updated) row.
 */
export async function reconcileDeposit(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  now: Date,
): Promise<ReservationRow> {
  if (row.status !== "pending_deposit") return row;
  const state = await loadDepositState(tx, context, row);
  if (state.settledIntentId !== null) {
    const [updated] = await tx
      .update(reservations)
      .set({
        status: "confirmed",
        depositPaymentId: state.settledIntentId,
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
    await appendReservationEvent(tx, context, "reservation.confirmed", {
      reservationId: row.id,
      outletId: row.outletId,
      actorUserId: null,
      now,
      payload: {
        reservationId: row.id,
        depositPaymentId: state.settledIntentId,
        depositIdr: row.depositIdr,
      },
    });
    return updated;
  }
  if (state.payableUntil <= now) {
    if (!state.providerPending)
      return cancelUnpaidDeposit(tx, context, row, now);
    // legend-m0kqn: a provider-backed code the provider never answers final
    // must not hold the tables forever. The payment poller gives up on a code
    // `GATEWAY_POLL_WINDOW_MS` after its expiry; the booking follows. Money
    // that still lands afterwards settles the code but never confirms the
    // cancelled booking: the RSV-02 late-DP flow refunds it in full, once
    // (`handlePaymentPaid` -> `late_refund_requested`). Legacy rows without a
    // deposit link (pre-0049, intent id only) are not capped: the late refund
    // cannot reach them (`refundLateDeposit`), so cancelling would lose the DP.
    if (
      row.depositPaymentLinkId !== null &&
      state.payableUntil.getTime() + GATEWAY_POLL_WINDOW_MS <= now.getTime()
    )
      return cancelUnpaidDeposit(tx, context, row, now, {
        providerUnanswered: true,
      });
  }
  return row;
}
