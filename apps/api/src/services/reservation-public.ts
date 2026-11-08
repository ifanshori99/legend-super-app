// Guest self-service for a reservation through a signed link (PRD v1.7 §3.22
// "DP & Kebijakan", RSV-03; bead legend-o5gr). Routes:
// routes/reservation-public.routes.ts.
// - The link token is 32 random bytes (base64url). Only its sha256 hex is
//   stored; the token and its hash are never logged or audited.
// - Every way a token can be unusable (bad format, unknown, other tenant,
//   expired, revoked) throws the same RESERVATION_LINK_INVALID so the answer
//   gives no hint which one it was.
// - The guest cancel mirrors the staff cancel (`closeReservation` in
//   reservation-lifecycle.ts) step for step: the DP split comes from the
//   snapshot taken at booking (RSV-03) and the refund is only REQUESTED
//   (`requestDepositRefund`, WS-05), never paid here.
// - A reschedule is only recorded as a request; staff decide later.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import {
  assertOutletInScope,
  decodeCursor,
  encodeCursor,
  idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  GUEST_LINK_GRACE_HOURS,
  ReservationError,
  assertReservationTransition,
  cancellationDepositOutcome,
  guestCancelResultSchema,
  guestReservationViewSchema,
  guestRescheduleResultSchema,
  reservationLinkTokenSchema,
  reservationPolicySnapshotSchema,
  reservationRescheduleRequestSchema,
  type GuestCancelInput,
  type GuestCancelResult,
  type GuestReservationView,
  type GuestRescheduleInput,
  type GuestRescheduleResult,
  type ListRescheduleRequestsQuery,
  type ReservationDepositOutcome,
  type ReservationRescheduleRequest,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import {
  reservationGuestLinks,
  reservationRescheduleRequests,
} from "../db/schema/reservation-public.ts";
import { withTenant } from "../db/tenant.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  MANAGE_PERMISSION,
  VIEW_PERMISSION,
  appendReservationEvent,
  assertPermission,
  auditReservation,
  claimIdempotencyKey,
  loadHeldDeposit,
  lockReservation,
  pgErrorCode,
  reconcileDeposit,
  releaseHolds,
  storeIdempotencyResult,
  type ReservationRow,
  type Tx,
} from "./reservation-core.ts";
import { requestFingerprint } from "./reservation-plan.ts";
import { requestDepositRefund } from "./reservation-refunds.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A reschedule may be requested at most this far ahead of now (F3). */
const RESCHEDULE_MAX_AHEAD_DAYS = 180;

/** Guest writes allowed per link per minute, charged after the link resolves. */
const LINK_WRITES_PER_MINUTE = 10;

// Per-link write cap. The route's per-IP limit runs before the token is known;
// this one is charged only for a valid link, so junk tokens cannot spend any
// guest's budget (F1). Process-local, like the other public limits.
const newLinkWriteCounter = () =>
  createFixedWindowCounter({
    limit: LINK_WRITES_PER_MINUTE,
    windowMs: 60_000,
    capacity: 10_000,
  });
let linkWrites = newLinkWriteCounter();

/** Test seam: forgets every per-link write count. */
export function resetGuestLinkWriteLimit(): void {
  linkWrites = newLinkWriteCounter();
}

/** 429 that carries the seconds the route puts in `Retry-After`. */
export class GuestLinkRateLimitedError extends HttpError {
  constructor(public retryAfter: number) {
    super(
      429,
      "RATE_LIMITED",
      "Terlalu banyak permintaan. Coba lagi sebentar.",
    );
    this.name = "GuestLinkRateLimitedError";
  }
}

function chargeLinkWrite(link: GuestLinkRow): void {
  const retryAfter = linkWrites.take(`link:${link.id}`, Date.now());
  if (retryAfter !== null) throw new GuestLinkRateLimitedError(retryAfter);
}

/**
 * Drizzle query errors embed the bound parameters (the token hash) in their
 * message. Rethrow anything unexpected as a plain Error carrying only the
 * Postgres code, with no `cause`, so the hash never reaches a log (F2).
 */
function scrubLinkQueryError(error: unknown): never {
  if (error instanceof ReservationError || error instanceof HttpError)
    throw error;
  const code = pgErrorCode(error);
  throw Object.assign(new Error("guest link query failed"), {
    ...(code ? { code } : {}),
  });
}

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

type GuestLinkRow = typeof reservationGuestLinks.$inferSelect;
type RescheduleRow = typeof reservationRescheduleRequests.$inferSelect;

const outletTarget = (outletId: OutletId) =>
  ({ type: "outlet", id: outletId }) as const;

/** The only response for any unusable token. */
const invalidLink = () => new ReservationError("RESERVATION_LINK_INVALID");

/** sha256 hex of the token: the only form that is stored or compared. */
export function hashReservationLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ------------------------------------------------------------------ links

/**
 * Revokes the active link of the reservation and inserts a new one, in the
 * caller's transaction (also used by the reminder workstream). Returns the
 * plain token once; it cannot be recovered afterwards.
 */
export async function issueReservationGuestLink(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    reservationId: string;
    actorUserId: string | null;
    now: Date;
  },
): Promise<{ token: string; expiresAt: string }> {
  // The row lock serializes concurrent issues for one reservation, so the
  // revoke + insert below cannot race into the one-active-link unique index.
  const reservation = await lockReservation(
    tx,
    context,
    input.outletId,
    input.reservationId,
  );
  const expiresAt = new Date(
    reservation.reservedFor.getTime() + GUEST_LINK_GRACE_HOURS * HOUR_MS,
  );
  // A link that is already past its expiry would be a dead token.
  if (expiresAt <= input.now)
    throw new ReservationError(
      "RESERVATION_TRANSITION_INVALID",
      "Reservasi sudah lewat; tautan tidak dapat dibuat.",
    );
  await revokeActiveLinks(tx, context, input.reservationId, input.now);
  const token = randomBytes(32).toString("base64url");
  try {
    await tx.insert(reservationGuestLinks).values({
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      reservationId: input.reservationId,
      tokenHash: hashReservationLinkToken(token),
      expiresAt,
      createdBy: input.actorUserId,
      createdAt: input.now,
    });
  } catch (error) {
    scrubLinkQueryError(error);
  }
  return { token, expiresAt: expiresAt.toISOString() };
}

async function revokeActiveLinks(
  tx: Tx,
  context: ScopedTenantContext,
  reservationId: string,
  now: Date,
): Promise<number> {
  const revoked = await tx
    .update(reservationGuestLinks)
    .set({ revokedAt: now })
    .where(
      and(
        eq(reservationGuestLinks.tenantId, context.tenant.tenantId),
        eq(reservationGuestLinks.reservationId, reservationId),
        isNull(reservationGuestLinks.revokedAt),
      ),
    )
    .returning({ id: reservationGuestLinks.id });
  return revoked.length;
}

export async function issueGuestLinkForStaff(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MANAGE_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const row = await lockReservation(tx, context, outletId, reservationId);
    if (
      row.status === "completed" ||
      row.status === "cancelled" ||
      row.status === "no_show"
    )
      throw new ReservationError(
        "RESERVATION_TRANSITION_INVALID",
        "Reservasi sudah selesai atau dibatalkan; tautan tidak dapat dibuat.",
      );
    const issued = await issueReservationGuestLink(tx, context, {
      outletId,
      reservationId,
      actorUserId,
      now,
    });
    // The audit row never carries the token.
    await auditReservation(tx, context, {
      actorUserId,
      outletId,
      action: "reservation.guest_link_issued",
      reservationId,
      reason: null,
      before: { status: row.status },
      after: { status: row.status },
      now,
    });
    return issued;
  });
}

/** Idempotent: revoking when no link is active changes and audits nothing. */
export async function revokeGuestLinkForStaff(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MANAGE_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const row = await lockReservation(tx, context, outletId, reservationId);
    const revoked = await revokeActiveLinks(tx, context, reservationId, now);
    if (revoked === 0) return;
    await auditReservation(tx, context, {
      actorUserId,
      outletId,
      action: "reservation.guest_link_revoked",
      reservationId,
      reason: null,
      before: { status: row.status },
      after: { status: row.status },
      now,
    });
  });
}

/**
 * Token to active link. Tenant comes from the RLS context; the lookup is by
 * token hash and the hashes are compared in constant time. Throws the same
 * 404 for every failure.
 */
async function resolveGuestLink(
  tx: Tx,
  context: ScopedTenantContext,
  token: string,
  now: Date,
): Promise<GuestLinkRow> {
  if (!reservationLinkTokenSchema.safeParse(token).success) throw invalidLink();
  const tokenHash = hashReservationLinkToken(token);
  let link: GuestLinkRow | undefined;
  try {
    [link] = await tx
      .select()
      .from(reservationGuestLinks)
      .where(
        and(
          eq(reservationGuestLinks.tenantId, context.tenant.tenantId),
          eq(reservationGuestLinks.tokenHash, tokenHash),
        ),
      )
      .limit(1);
  } catch (error) {
    scrubLinkQueryError(error);
  }
  if (!link) throw invalidLink();
  const stored = Buffer.from(link.tokenHash, "hex");
  const given = Buffer.from(tokenHash, "hex");
  if (stored.length !== given.length || !timingSafeEqual(stored, given))
    throw invalidLink();
  if (link.revokedAt !== null || link.expiresAt <= now) throw invalidLink();
  return link;
}

// ------------------------------------------------------------------ view

function toRescheduleRequest(row: RescheduleRow): ReservationRescheduleRequest {
  return reservationRescheduleRequestSchema.parse({
    id: row.id,
    reservationId: row.reservationId,
    outletId: row.outletId,
    requestedFor: row.requestedFor.toISOString(),
    partySize: row.partySize,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  });
}

/** Outcome of an already decided cancellation, rebuilt from the stored split. */
function storedDepositOutcome(row: ReservationRow): ReservationDepositOutcome {
  const policy = reservationPolicySnapshotSchema.parse(row.policySnapshot);
  const refundIdr = row.depositRefundIdr ?? idr(0);
  const forfeitedIdr = row.depositForfeitedIdr ?? idr(0);
  const paid = refundIdr + forfeitedIdr;
  return {
    resolution:
      paid === 0
        ? "nothing_paid"
        : forfeitedIdr === 0
          ? "refund_full"
          : refundIdr === 0
            ? "no_refund"
            : "refund_partial",
    refundIdr,
    forfeitedIdr,
    policyVersion: policy.version,
  };
}

function canCancelNow(row: ReservationRow, now: Date): boolean {
  return (
    (row.status === "pending_deposit" || row.status === "confirmed") &&
    now < row.reservedFor
  );
}

async function buildGuestView(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReservationRow,
  link: GuestLinkRow,
  now: Date,
  pending?: RescheduleRow | null,
): Promise<GuestReservationView> {
  const policy = reservationPolicySnapshotSchema.parse(row.policySnapshot);
  // Money the DP intent still holds; once a split is decided, that split.
  let paid = idr(0);
  if (row.depositRefundIdr !== null || row.depositForfeitedIdr !== null)
    paid = idr((row.depositRefundIdr ?? 0) + (row.depositForfeitedIdr ?? 0));
  else if (row.depositIdr > 0 && row.depositPaymentId !== null)
    paid = (
      await loadHeldDeposit(tx, context, row.depositPaymentId, row.depositIdr)
    ).heldIdr;
  const [outlet] = await tx
    .select({ name: outlets.name })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, row.outletId),
      ),
    );
  if (!outlet) throw new ReservationError("RESERVATION_NOT_FOUND");
  const allowed = canCancelNow(row, now);
  const preview = allowed
    ? cancellationDepositOutcome(policy, {
        depositPaidIdr: paid,
        reservedFor: row.reservedFor.toISOString(),
        cancelledAt: now.toISOString(),
      })
    : null;
  if (pending === undefined) {
    const [latest] = await tx
      .select()
      .from(reservationRescheduleRequests)
      .where(
        and(
          eq(reservationRescheduleRequests.tenantId, context.tenant.tenantId),
          eq(reservationRescheduleRequests.reservationId, row.id),
          eq(reservationRescheduleRequests.status, "pending"),
        ),
      )
      .limit(1);
    pending = latest ?? null;
  }
  return guestReservationViewSchema.parse({
    reservationId: row.id,
    outletId: row.outletId,
    outletName: outlet.name,
    guestName: row.guestName,
    partySize: row.pax,
    reservedFor: row.reservedFor.toISOString(),
    status: row.status,
    note: row.note,
    policy,
    deposit: {
      amountIdr: row.depositIdr,
      paidIdr: paid,
      refundIdr: row.depositRefundIdr,
      forfeitedIdr: row.depositForfeitedIdr,
      refundStatus: row.refundStatus,
    },
    cancellation: {
      allowed,
      freeUntil: new Date(
        row.reservedFor.getTime() - policy.freeCancellationHours * HOUR_MS,
      ).toISOString(),
      preview,
    },
    rescheduleRequest: pending ? toRescheduleRequest(pending) : null,
    linkExpiresAt: link.expiresAt.toISOString(),
  });
}

async function readReservationRow(
  tx: Tx,
  context: ScopedTenantContext,
  link: GuestLinkRow,
): Promise<ReservationRow> {
  const [row] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, context.tenant.tenantId),
        eq(reservations.outletId, link.outletId),
        eq(reservations.id, link.reservationId),
      ),
    )
    .limit(1);
  // A link whose reservation is gone is as good as unknown.
  if (!row) throw invalidLink();
  return row;
}

export async function getGuestReservation(
  context: ScopedTenantContext,
  token: string,
  now = new Date(),
): Promise<GuestReservationView> {
  return withTenant(db, context, async (tx) => {
    const link = await resolveGuestLink(tx, context, token, now);
    const row = await readReservationRow(tx, context, link);
    return buildGuestView(tx, context, row, link, now);
  });
}

// ---------------------------------------------------------------- cancel

export async function cancelGuestReservation(
  context: ScopedTenantContext,
  token: string,
  input: GuestCancelInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<GuestCancelResult> {
  const done = await withTenant(db, context, async (tx) => {
    const link = await resolveGuestLink(tx, context, token, now);
    chargeLinkWrite(link);
    const outletId = link.outletId as OutletId;
    const reason = input.reason ?? null;
    const claim = await claimIdempotencyKey(tx, context, {
      outletId,
      key: idempotencyKey,
      operation: "reservation.guest_cancel",
      fingerprint: requestFingerprint("reservation.guest_cancel", {
        reservationId: link.reservationId,
        reason,
      }),
    });
    if (claim.kind === "replay")
      return {
        result: guestCancelResultSchema.parse(claim.response),
        refund: null,
      };
    let row = await lockReservation(tx, context, outletId, link.reservationId);
    row = await reconcileDeposit(tx, context, row, now);
    if (row.status === "cancelled") {
      // Already cancelled (by the guest, staff, or an unpaid-DP expiry): report
      // the stored decision and never request a second refund.
      const result = guestCancelResultSchema.parse({
        view: await buildGuestView(tx, context, row, link, now),
        depositOutcome: storedDepositOutcome(row),
        alreadyCancelled: true,
      });
      await storeIdempotencyResult(
        tx,
        context,
        idempotencyKey,
        row.id,
        result as unknown as Record<string, unknown>,
      );
      return { result, refund: null };
    }
    assertReservationTransition(row.status, "cancelled");
    // RSV-03: always the snapshot taken at booking, never the live policy.
    const policy = reservationPolicySnapshotSchema.parse(row.policySnapshot);
    let paid = idr(0);
    if (row.depositIdr > 0 && row.depositPaymentId !== null) {
      // Only money the intent still holds can be refunded/forfeited.
      paid = (
        await loadHeldDeposit(tx, context, row.depositPaymentId, row.depositIdr)
      ).heldIdr;
    }
    const outcome: ReservationDepositOutcome = cancellationDepositOutcome(
      policy,
      {
        depositPaidIdr: paid,
        reservedFor: row.reservedFor.toISOString(),
        cancelledAt: now.toISOString(),
      },
    );
    const closeReason = reason ?? "Dibatalkan tamu melalui tautan reservasi.";
    const [updated] = await tx
      .update(reservations)
      .set({
        status: "cancelled",
        closedAt: now,
        closeReason,
        closedBy: null,
        depositRefundIdr: idr(outcome.refundIdr),
        depositForfeitedIdr: idr(outcome.forfeitedIdr),
        refundStatus: outcome.refundIdr > 0 ? "pending" : "not_required",
        updatedAt: now,
      })
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, row.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Reservation update returned no row");
    await releaseHolds(tx, context, row.id, now);
    await appendReservationEvent(tx, context, "reservation.cancelled", {
      reservationId: row.id,
      outletId,
      actorUserId: null,
      now,
      payload: {
        reservationId: row.id,
        closedBy: "guest",
        reason: closeReason,
        depositPaidIdr: paid,
        depositRefundIdr: outcome.refundIdr,
        depositForfeitedIdr: outcome.forfeitedIdr,
        policyVersion: outcome.policyVersion,
      },
    });
    await auditReservation(tx, context, {
      actorUserId: null,
      outletId,
      action: "reservation.guest_cancelled",
      reservationId: row.id,
      reason: closeReason,
      before: { status: row.status, depositPaidIdr: paid },
      after: {
        status: "cancelled",
        depositRefundIdr: outcome.refundIdr,
        depositForfeitedIdr: outcome.forfeitedIdr,
        policyVersion: outcome.policyVersion,
        resolution: outcome.resolution,
      },
      now,
    });
    // The link stays valid so the guest can still see the outcome.
    const result = guestCancelResultSchema.parse({
      view: await buildGuestView(tx, context, updated, link, now),
      depositOutcome: outcome,
      alreadyCancelled: false,
    });
    await storeIdempotencyResult(
      tx,
      context,
      idempotencyKey,
      row.id,
      result as unknown as Record<string, unknown>,
    );
    return {
      result,
      refund:
        outcome.refundIdr > 0 && row.depositPaymentId !== null
          ? {
              outletId,
              reservationId: row.id,
              intentId: row.depositPaymentId,
              refundIdr: outcome.refundIdr,
            }
          : null,
    };
  });
  if (done.refund)
    await requestDepositRefund(
      context,
      done.refund.outletId,
      done.refund.reservationId,
      { intentId: done.refund.intentId, refundIdr: done.refund.refundIdr },
      "cancelled",
      null,
    );
  return done.result;
}

// ------------------------------------------------------------ reschedule

const rescheduleInvalid = () =>
  new ReservationError("RESERVATION_RESCHEDULE_INVALID");
const reschedulePending = () =>
  new ReservationError("RESERVATION_RESCHEDULE_PENDING");

/**
 * Records the guest's wish for another time. The reservation, its holds and
 * the DP stay untouched: staff approve or decline later.
 */
export async function requestGuestReschedule(
  context: ScopedTenantContext,
  token: string,
  input: GuestRescheduleInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<GuestRescheduleResult> {
  return withTenant(db, context, async (tx) => {
    const link = await resolveGuestLink(tx, context, token, now);
    chargeLinkWrite(link);
    const outletId = link.outletId as OutletId;
    const requestedFor = new Date(input.requestedFor);
    const claim = await claimIdempotencyKey(tx, context, {
      outletId,
      key: idempotencyKey,
      operation: "reservation.guest_reschedule",
      fingerprint: requestFingerprint("reservation.guest_reschedule", {
        reservationId: link.reservationId,
        requestedFor: requestedFor.toISOString(),
        partySize: input.partySize ?? null,
        note: input.note ?? null,
      }),
    });
    if (claim.kind === "replay")
      return guestRescheduleResultSchema.parse(claim.response);
    let row = await lockReservation(tx, context, outletId, link.reservationId);
    row = await reconcileDeposit(tx, context, row, now);
    if (
      (row.status !== "pending_deposit" && row.status !== "confirmed") ||
      now >= row.reservedFor ||
      requestedFor <= now ||
      requestedFor.getTime() >
        now.getTime() + RESCHEDULE_MAX_AHEAD_DAYS * DAY_MS
    )
      throw rescheduleInvalid();
    const [existing] = await tx
      .select({ id: reservationRescheduleRequests.id })
      .from(reservationRescheduleRequests)
      .where(
        and(
          eq(reservationRescheduleRequests.tenantId, context.tenant.tenantId),
          eq(reservationRescheduleRequests.reservationId, row.id),
          eq(reservationRescheduleRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) throw reschedulePending();
    let inserted: RescheduleRow | undefined;
    try {
      [inserted] = await tx
        .insert(reservationRescheduleRequests)
        .values({
          tenantId: context.tenant.tenantId,
          outletId,
          reservationId: row.id,
          guestLinkId: link.id,
          requestedFor,
          partySize: input.partySize ?? null,
          note: input.note ?? null,
          status: "pending",
          createdAt: now,
        })
        .returning();
    } catch (error) {
      // The partial unique index (one pending request) backs the check above.
      if (pgErrorCode(error) === "23505") throw reschedulePending();
      throw error;
    }
    if (!inserted) throw new Error("Reschedule insert returned no row");
    await auditReservation(tx, context, {
      actorUserId: null,
      outletId,
      action: "reservation.reschedule_requested",
      reservationId: row.id,
      reason: input.note ?? null,
      before: { status: row.status },
      after: { status: row.status },
      now,
    });
    const result = guestRescheduleResultSchema.parse({
      view: await buildGuestView(tx, context, row, link, now, inserted),
      request: toRescheduleRequest(inserted),
    });
    await storeIdempotencyResult(
      tx,
      context,
      idempotencyKey,
      row.id,
      result as unknown as Record<string, unknown>,
    );
    return result;
  });
}

// ------------------------------------------------------------ staff list

export async function listRescheduleRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  query: ListRescheduleRequestsQuery,
): Promise<Page<ReservationRescheduleRequest>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      VIEW_PERMISSION,
      outletTarget(outletId),
    );
    assertOutletInScope(context.outletScope, outletId);
    const filters = [
      eq(reservationRescheduleRequests.tenantId, context.tenant.tenantId),
      eq(reservationRescheduleRequests.outletId, outletId),
    ];
    if (query.status)
      filters.push(eq(reservationRescheduleRequests.status, query.status));
    if (query.cursor) {
      let keys;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const [at, id] = keys;
      if (typeof at !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const atDate = new Date(at);
      if (Number.isNaN(atDate.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          gt(reservationRescheduleRequests.createdAt, atDate),
          and(
            eq(reservationRescheduleRequests.createdAt, atDate),
            gt(reservationRescheduleRequests.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(reservationRescheduleRequests)
      .where(and(...filters))
      .orderBy(
        asc(reservationRescheduleRequests.createdAt),
        asc(reservationRescheduleRequests.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toRescheduleRequest),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
