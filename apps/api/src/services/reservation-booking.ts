// Reservation availability, booking and table assignment (PRD v1.7 §3.22
// "Reservasi Online", "Penugasan Meja", "DP & Kebijakan"; Alur H; RSV-01, RSV-02,
// RSV-03; bead legend-t8bz). Routes: routes/reservation.routes.ts.
//
// - Availability and booking are public (tenant from the host, TEN-02); the
//   outlet in the path must belong to that tenant.
// - Booking holds tables at once (best fit, tentative) under the outlet hold
//   lock, so two simultaneous bookings for the last table cannot both win
//   (RSV-01); the gist exclusion constraint is the database backstop.
// - The policy in force is frozen into `policy_snapshot` (RSV-03).
// - A required DP is opened through the deposit port as a WS-05 bill link; a
//   reservation is `pending_deposit` until an intent on that link is settled
//   (RSV-02). With no usable payment gateway a DP booking is refused (503)
//   before any table is held.
// - Stale unpaid DP holds of the outlet are released first (reservation-sweeps).
// - Every mutation takes an idempotency key bound to a request fingerprint.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  ReservationError,
  hashGuestContact,
  reservationAvailabilitySchema,
  reservationCreatedSchema,
  reservationPolicySnapshotSchema,
  reservationSchema,
  type AssignReservationTablesInput,
  type CreateReservationInput,
  type Reservation,
  type ReservationAvailability,
  type ReservationAvailabilityQuery,
  type ReservationCreated,
  type ReservationPolicySnapshot,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { floorZones, outlets, tables } from "../db/schema/index.ts";
import { reservationPolicies, reservations } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { contactDigestSecret } from "../lib/identity-digest.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import {
  MANAGE_PERMISSION,
  appendReservationEvent,
  assertPermission,
  attachIdempotencyReservation,
  claimIdempotencyKey,
  insertHolds,
  lockOutletHolds,
  lockReservation,
  mapHoldViolation,
  pgErrorCode,
  readReservation,
  reconcileDeposit,
  releaseHolds,
  replaceHolds,
  storeIdempotencyResult,
  type ReservationRow,
  type Tx,
} from "./reservation-core.ts";
import { findLinkableProfileIdByWhatsAppHash } from "./member-profile.service.ts";
import { reservationDepositPort } from "./reservation-ports.ts";
import { sweepStaleDepositHolds } from "./reservation-sweeps.ts";
import {
  addDays,
  candidateStarts,
  pickTables,
  requestFingerprint,
  slotInsideHours,
  zonedInstant,
  type FreeTable,
} from "./reservation-plan.ts";

const MINUTE = 60_000;

type OutletRef = { id: string; timezone: string };

async function loadOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<OutletRef> {
  assertOutletInScope(context.outletScope, outletId);
  const [outlet] = await tx
    .select({ id: outlets.id, timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return outlet;
}

type PolicyRow = typeof reservationPolicies.$inferSelect;

/** No active policy = bookings are closed (fail closed). */
async function loadPolicy(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<PolicyRow> {
  const [policy] = await tx
    .select()
    .from(reservationPolicies)
    .where(
      and(
        eq(reservationPolicies.tenantId, context.tenant.tenantId),
        eq(reservationPolicies.outletId, outletId),
        eq(reservationPolicies.isActive, true),
      ),
    );
  if (!policy) throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
  return policy;
}

type ZoneRow = typeof floorZones.$inferSelect;
type TableRow = typeof tables.$inferSelect;

async function loadZonesAndTables(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  zoneId: string | null | undefined,
): Promise<{ zones: ZoneRow[]; tableRows: TableRow[] }> {
  const zoneFilter = [
    eq(floorZones.tenantId, context.tenant.tenantId),
    eq(floorZones.outletId, outletId),
    eq(floorZones.status, "active"),
  ];
  if (zoneId) zoneFilter.push(eq(floorZones.id, zoneId));
  const zones = await tx
    .select()
    .from(floorZones)
    .where(and(...zoneFilter))
    .orderBy(asc(floorZones.sortOrder), asc(floorZones.id));
  if (zoneId && zones.length === 0)
    throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
  if (zones.length === 0) return { zones, tableRows: [] };
  const tableRows = await tx
    .select()
    .from(tables)
    .where(
      and(
        eq(tables.tenantId, context.tenant.tenantId),
        eq(tables.outletId, outletId),
        inArray(
          tables.zoneId,
          zones.map((zone) => zone.id),
        ),
      ),
    );
  return {
    zones,
    tableRows: tableRows.filter((table) => table.status !== "inactive"),
  };
}

/** Live holds overlapping `[from, to)` per table id (rows, not the contract). */
async function busyTables(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  from: Date,
  to: Date,
): Promise<{ tableId: string; startsAt: Date; endsAt: Date }[]> {
  const result = await tx.execute(sql`
    SELECT table_id, starts_at, ends_at
    FROM reservation_tables
    WHERE tenant_id = ${context.tenant.tenantId}
      AND outlet_id = ${outletId}
      AND released_at IS NULL
      AND hold_range && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')
  `);
  return result.rows.map((row) => ({
    tableId: String(row.table_id),
    startsAt: new Date(row.starts_at as string | Date),
    endsAt: new Date(row.ends_at as string | Date),
  }));
}

const overlaps = (
  hold: { startsAt: Date; endsAt: Date },
  start: Date,
  end: Date,
) => hold.startsAt < end && start < hold.endsAt;

// ---------------------------------------------------------------- availability

/** RSV-01: free tables per candidate start time (public, read-only). */
export async function getAvailability(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: ReservationAvailabilityQuery,
  now = new Date(),
): Promise<ReservationAvailability> {
  return withTenant(db, context, async (tx) => {
    const outlet = await loadOutlet(tx, context, outletId);
    const policy = await loadPolicy(tx, context, outletId);
    const duration = query.durationMinutes ?? policy.defaultDurationMinutes;
    const { zones, tableRows } = await loadZonesAndTables(
      tx,
      context,
      outletId,
      query.zoneId,
    );
    const dayStart = zonedInstant(query.date, "00:00", outlet.timezone);
    const dayEnd = zonedInstant(
      addDays(query.date, 1),
      "00:00",
      outlet.timezone,
    );
    const busy = await busyTables(
      tx,
      context,
      outletId,
      dayStart,
      new Date(dayEnd.getTime() + duration * MINUTE),
    );
    const startsByZone = new Map<string, Date[]>();
    const allStarts = new Map<number, Date>();
    for (const zone of zones) {
      const starts = candidateStarts(
        query.date,
        zone.hours,
        duration,
        policy.slotIntervalMinutes,
        outlet.timezone,
      );
      startsByZone.set(zone.id, starts);
      for (const start of starts) allStarts.set(start.getTime(), start);
    }
    const slots = [];
    for (const start of [...allStarts.values()].sort(
      (a, b) => a.getTime() - b.getTime(),
    )) {
      if (start <= now) continue;
      const end = new Date(start.getTime() + duration * MINUTE);
      const openZones = new Set(
        zones
          .filter((zone) =>
            startsByZone
              .get(zone.id)
              ?.some((s) => s.getTime() === start.getTime()),
          )
          .map((zone) => zone.id),
      );
      const free: FreeTable[] = tableRows
        .filter(
          (table) =>
            openZones.has(table.zoneId) &&
            !busy.some(
              (hold) => hold.tableId === table.id && overlaps(hold, start, end),
            ),
        )
        .map((table) => ({
          id: table.id,
          zoneId: table.zoneId,
          capacity: table.capacity,
        }));
      if (pickTables(free, query.pax) === null) continue;
      slots.push({
        startsAt: start.toISOString(),
        tableIds: free.map((table) => table.id),
        seatsAvailable: free.reduce((sum, table) => sum + table.capacity, 0),
      });
    }
    return reservationAvailabilitySchema.parse({
      date: query.date,
      timeZone: outlet.timezone,
      durationMinutes: duration,
      pax: query.pax,
      zoneId: query.zoneId ?? null,
      slots,
    });
  });
}

// ---------------------------------------------------------------- create

function snapshotOf(
  policy: PolicyRow,
  minimumSpendIdr: number,
  now: Date,
): ReservationPolicySnapshot {
  return reservationPolicySnapshotSchema.parse({
    version: policy.version,
    depositRequirement: policy.depositRequirement,
    // §3.22: an optional DP is not charged by the website form (no way to opt
    // in on the contract), so only a required DP carries an amount here.
    depositAmountIdr:
      policy.depositRequirement === "none" ? 0 : policy.depositAmountIdr,
    paymentWindowMinutes: policy.paymentWindowMinutes,
    freeCancellationHours: policy.freeCancellationHours,
    lateCancellationRefundBp: policy.lateCancellationRefundBp,
    noShowRefundBp: policy.noShowRefundBp,
    minimumSpendIdr,
    capturedAt: now.toISOString(),
  });
}

/** Sealing context (AAD) of a stored DP link; shared with reservation-deposit-resend.ts. */
export const linkAad = (tenantId: string, reservationId: string) =>
  `reservation-deposit:${tenantId}:${reservationId}`;

function createdFrom(
  reservation: Reservation,
  row: ReservationRow,
  tenantId: string,
): ReservationCreated {
  const deposit =
    row.depositPaymentLinkId !== null &&
    row.depositLinkSealed !== null &&
    row.depositLinkExpiresAt !== null
      ? {
          paymentLinkId: row.depositPaymentLinkId,
          amountIdr: row.depositIdr,
          paymentPath: openSecret(
            row.depositLinkSealed,
            linkAad(tenantId, row.id),
          ),
          expiresAt: row.depositLinkExpiresAt.toISOString(),
        }
      : null;
  // Public response: never reveal whether the phone matched a member profile.
  // The link is kept in the DB only (legend-q4sv2).
  return reservationCreatedSchema.parse({
    reservation: { ...reservation, customerProfileId: null },
    deposit,
  });
}

async function buildCreated(
  context: ScopedTenantContext,
  outletId: OutletId,
  reservationId: string,
): Promise<ReservationCreated> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.outletId, outletId),
          eq(reservations.id, reservationId),
        ),
      );
    if (!row) throw new ReservationError("RESERVATION_NOT_FOUND");
    return createdFrom(
      await readReservation(tx, context, row),
      row,
      context.tenant.tenantId,
    );
  });
}

/**
 * Opens the DP bill link for a `pending_deposit` reservation (steps run outside
 * the booking transaction because the payment service has its own). If the
 * payment side fails the booking is closed again and its tables released; if
 * this process dies in between, the deposit sweep releases the hold after the
 * payment window (reservation-sweeps.ts). Two racing replays may each open a
 * link; only the first stored one is ever returned, the other token is
 * discarded unseen (and its link expires with the window).
 */
async function attachDeposit(
  context: ScopedTenantContext,
  outletId: OutletId,
  reservationId: string,
  idempotencyKey: string,
  now: Date,
): Promise<ReservationCreated> {
  const row = await withTenant(db, context, async (tx) =>
    lockReservation(tx, context, outletId, reservationId),
  );
  if (row.depositPaymentLinkId !== null || row.status !== "pending_deposit")
    return buildCreated(context, outletId, reservationId);
  const snapshot = reservationPolicySnapshotSchema.parse(row.policySnapshot);
  let opened;
  try {
    opened = await reservationDepositPort().openDeposit({
      context,
      outletId,
      reservationId,
      amountIdr: row.depositIdr,
      expiresInMinutes: snapshot.paymentWindowMinutes,
      now,
    });
  } catch (error) {
    const keepBooking = await withTenant(db, context, async (tx) => {
      const locked = await lockReservation(
        tx,
        context,
        outletId,
        reservationId,
      );
      if (locked.status !== "pending_deposit") return false;
      // A staff resend stored a payable link while this attempt was failing:
      // the booking is still collectable, so it is neither cancelled nor released.
      if (locked.depositPaymentLinkId !== null) return true;
      await tx
        .update(reservations)
        .set({
          status: "cancelled",
          closedAt: now,
          closeReason: "Pembayaran DP tidak dapat dibuka.",
          depositRefundIdr: idr(0),
          depositForfeitedIdr: idr(0),
          updatedAt: now,
        })
        .where(
          and(
            eq(reservations.tenantId, context.tenant.tenantId),
            eq(reservations.id, reservationId),
          ),
        );
      await releaseHolds(tx, context, reservationId, now);
      await appendReservationEvent(tx, context, "reservation.cancelled", {
        reservationId,
        outletId,
        actorUserId: null,
        now,
        payload: {
          reservationId,
          closedBy: "system",
          reason: "Pembayaran DP tidak dapat dibuka.",
          depositPaidIdr: 0,
          depositRefundIdr: 0,
          depositForfeitedIdr: 0,
          policyVersion: snapshot.version,
        },
      });
      return false;
    });
    if (keepBooking) return buildCreated(context, outletId, reservationId);
    throw error;
  }
  return withTenant(db, context, async (tx) => {
    const locked = await lockReservation(tx, context, outletId, reservationId);
    // Never attach a payable link to a booking the sweep already released.
    if (
      locked.depositPaymentLinkId === null &&
      locked.status === "pending_deposit"
    ) {
      await tx
        .update(reservations)
        .set({
          depositPaymentLinkId: opened.paymentLinkId,
          depositLinkSealed: sealSecret(
            opened.paymentPath,
            linkAad(context.tenant.tenantId, reservationId),
          ),
          depositLinkExpiresAt: new Date(opened.expiresAt),
          updatedAt: now,
        })
        .where(
          and(
            eq(reservations.tenantId, context.tenant.tenantId),
            eq(reservations.id, reservationId),
          ),
        );
    }
    const [row2] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, context.tenant.tenantId),
          eq(reservations.id, reservationId),
        ),
      );
    if (!row2) throw new ReservationError("RESERVATION_NOT_FOUND");
    const result = createdFrom(
      await readReservation(tx, context, row2),
      row2,
      context.tenant.tenantId,
    );
    await storeIdempotencyResult(tx, context, idempotencyKey, reservationId, {
      reservationId,
    });
    return result;
  });
}

type BookingOutcome =
  | { kind: "done"; created: ReservationCreated }
  | { kind: "needs_deposit"; reservationId: string };

/** Public booking (RSV-01..03). Tenant from the host; actor is the guest. */
export async function createReservation(
  context: ScopedTenantContext,
  outletId: OutletId,
  input: CreateReservationInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<ReservationCreated> {
  const contactHash = await hashGuestContact(
    input.contactPhone,
    contactDigestSecret(),
  );
  const fingerprint = requestFingerprint("reservation.create", {
    outletId,
    reservedFor: new Date(input.reservedFor).toISOString(),
    durationMinutes: input.durationMinutes ?? null,
    pax: input.pax,
    zoneId: input.zoneId ?? null,
    guestName: input.guestName,
    contactHash,
    note: input.note ?? null,
    preOrderPackageId: input.preOrderPackageId ?? null,
  });
  if (input.preOrderPackageId)
    // Event pre-orders belong to legend-y9o7; refuse rather than ignore.
    throw new ReservationError("RESERVATION_PACKAGE_UNAVAILABLE");

  let outcome: BookingOutcome;
  try {
    outcome = await withTenant(
      db,
      context,
      async (tx): Promise<BookingOutcome> => {
        const outlet = await loadOutlet(tx, context, outletId);
        const claim = await claimIdempotencyKey(tx, context, {
          outletId,
          key: idempotencyKey,
          operation: "reservation.create",
          fingerprint,
        });
        if (claim.kind === "replay" || claim.kind === "resume") {
          const id =
            claim.kind === "replay"
              ? String(claim.response.reservationId)
              : claim.reservationId;
          if (id === null) throw new HttpError(409, "CONFLICT", "Coba lagi.");
          return { kind: "needs_deposit", reservationId: id };
        }
        const policy = await loadPolicy(tx, context, outletId);
        // RSV-02: a DP booking needs a working online payment; refuse it
        // before anything is held (fail closed; the guest contacts the venue).
        if (
          policy.depositRequirement === "required" &&
          policy.depositAmountIdr > 0
        )
          await reservationDepositPort().assertReady(context, outletId);
        const reservedFor = new Date(input.reservedFor);
        const duration = input.durationMinutes ?? policy.defaultDurationMinutes;
        if (reservedFor <= now)
          throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
        const { zones, tableRows } = await loadZonesAndTables(
          tx,
          context,
          outletId,
          input.zoneId,
        );
        const openZoneIds = new Set(
          zones
            .filter((zone) =>
              slotInsideHours(
                reservedFor,
                duration,
                zone.hours,
                outlet.timezone,
              ),
            )
            .map((zone) => zone.id),
        );
        await lockOutletHolds(tx, context, outletId);
        // Release this outlet's lapsed unpaid DP holds first, so a stale hold
        // never blocks a new guest even when the worker is behind.
        await sweepStaleDepositHolds(tx, context, now, { outletId });
        const endsAt = new Date(reservedFor.getTime() + duration * MINUTE);
        const busy = await busyTables(
          tx,
          context,
          outletId,
          reservedFor,
          endsAt,
        );
        const free: FreeTable[] = tableRows
          .filter(
            (table) =>
              openZoneIds.has(table.zoneId) &&
              !busy.some((hold) => hold.tableId === table.id),
          )
          .map((table) => ({
            id: table.id,
            zoneId: table.zoneId,
            capacity: table.capacity,
          }));
        const picked = pickTables(free, input.pax);
        if (picked === null)
          throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
        const zoneMinimum = Math.max(
          0,
          ...picked.map(
            (table) =>
              zones.find((zone) => zone.id === table.zoneId)?.minimumSpendIdr ??
              0,
          ),
        );
        const snapshot = snapshotOf(
          policy,
          Math.max(policy.minimumSpendIdr, zoneMinimum),
          now,
        );
        const needsDeposit =
          snapshot.depositRequirement === "required" &&
          snapshot.depositAmountIdr > 0;
        const reservationId = randomUUID();
        // Lookup only (legend-q4sv2): no profile is created from a number
        // nobody verified.
        const customerProfileId = await findLinkableProfileIdByWhatsAppHash(
          tx,
          context.tenant.tenantId,
          contactHash,
        );
        const [row] = await tx
          .insert(reservations)
          .values({
            id: reservationId,
            tenantId: context.tenant.tenantId,
            outletId,
            customerProfileId,
            guestName: input.guestName,
            contactHash,
            reservedFor,
            durationMinutes: duration,
            pax: input.pax,
            zoneId: input.zoneId ?? picked[0]?.zoneId ?? null,
            depositIdr: idr(needsDeposit ? snapshot.depositAmountIdr : 0),
            policySnapshot: snapshot,
            status: needsDeposit ? "pending_deposit" : "confirmed",
            note: input.note ?? null,
            source: "website",
            refundStatus: "not_required",
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("Reservation insert returned no row");
        await insertHolds(
          tx,
          context,
          row,
          picked.map((table) => table.id),
          endsAt,
        );
        await attachIdempotencyReservation(tx, context, idempotencyKey, row.id);
        await appendReservationEvent(tx, context, "reservation.created", {
          reservationId: row.id,
          outletId,
          actorUserId: null,
          now,
          payload: {
            reservationId: row.id,
            customerProfileId: row.customerProfileId,
            reservedFor: reservedFor.toISOString(),
            durationMinutes: duration,
            pax: input.pax,
            zoneId: row.zoneId,
            tableIds: picked.map((table) => table.id),
            depositIdr: row.depositIdr,
            depositPaymentId: null,
            policyVersion: snapshot.version,
            status: row.status,
          },
        });
        if (needsDeposit)
          return { kind: "needs_deposit", reservationId: row.id };
        await appendReservationEvent(tx, context, "reservation.confirmed", {
          reservationId: row.id,
          outletId,
          actorUserId: null,
          now,
          payload: {
            reservationId: row.id,
            depositPaymentId: null,
            depositIdr: 0,
          },
        });
        await storeIdempotencyResult(tx, context, idempotencyKey, row.id, {
          reservationId: row.id,
        });
        return {
          kind: "done",
          created: createdFrom(
            await readReservation(tx, context, row),
            row,
            context.tenant.tenantId,
          ),
        };
      },
    );
  } catch (error) {
    // Race backstop: the exclusion constraint fired for a table picked as free.
    if (pgErrorCode(error) === "23P01")
      throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
    throw error;
  }
  if (outcome.kind === "done") return outcome.created;
  return attachDeposit(
    context,
    outletId,
    outcome.reservationId,
    idempotencyKey,
    now,
  );
}

// ---------------------------------------------------------------- assign

/**
 * RSV-01: staff assigns tables on the floor plan. Allowed before the DP is
 * paid (a tentative hold); the server rejects any overlap with
 * RESERVATION_SLOT_TAKEN, including under concurrency.
 */
export async function assignReservationTables(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  reservationId: string,
  input: AssignReservationTablesInput,
  idempotencyKey: string,
  now = new Date(),
): Promise<Reservation> {
  const tableIds = [...new Set(input.tableIds)].sort();
  const fingerprint = requestFingerprint("reservation.assign", {
    outletId,
    reservationId,
    tableIds,
  });
  try {
    return await withTenant(db, context, async (tx) => {
      await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
        type: "outlet",
        id: outletId,
      });
      await loadOutlet(tx, context, outletId);
      const claim = await claimIdempotencyKey(tx, context, {
        outletId,
        key: idempotencyKey,
        operation: "reservation.assign",
        fingerprint,
      });
      if (claim.kind === "replay")
        return reservationSchema.parse(claim.response);
      await lockOutletHolds(tx, context, outletId);
      let row = await lockReservation(tx, context, outletId, reservationId);
      row = await reconcileDeposit(tx, context, row, now);
      if (row.status !== "pending_deposit" && row.status !== "confirmed")
        throw new ReservationError("RESERVATION_TRANSITION_INVALID");
      await assertAssignableTables(tx, context, outletId, tableIds);
      await replaceHolds(tx, context, row, tableIds);
      await tx
        .update(reservations)
        .set({ updatedAt: now })
        .where(
          and(
            eq(reservations.tenantId, context.tenant.tenantId),
            eq(reservations.id, reservationId),
          ),
        );
      const result = await readReservation(tx, context, row);
      await storeIdempotencyResult(
        tx,
        context,
        idempotencyKey,
        reservationId,
        result as unknown as Record<string, unknown>,
      );
      return result;
    });
  } catch (error) {
    throw mapHoldViolation(error);
  }
}

/** Tables must exist in this outlet and be in service. */
export async function assertAssignableTables(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  tableIds: readonly string[],
): Promise<void> {
  const rows = await tx
    .select({ id: tables.id, status: tables.status })
    .from(tables)
    .where(
      and(
        eq(tables.tenantId, context.tenant.tenantId),
        eq(tables.outletId, outletId),
        inArray(tables.id, [...tableIds]),
      ),
    );
  if (rows.length !== tableIds.length)
    throw new HttpError(
      404,
      "NOT_FOUND",
      "Meja tidak ditemukan di outlet ini.",
    );
  if (rows.some((row) => row.status === "inactive"))
    throw new ReservationError("RESERVATION_SLOT_UNAVAILABLE");
}
