// Mock mode for the guest booking flow (VITE_API_MOCK=true): serves the public
// reservation endpoints from @starter/shared/reservation fixtures with the same
// validation, policy snapshot and idempotency the API will apply, so the
// booking page, the DP card and the walk-in waitlist work with no API
// (docs/frontend.md "Mock mode").
//
// This file owns the four public endpoints (no staff mock registers them):
// getReservationAvailability, createReservation, listPublicReservationPackages
// and joinWaitlist.
//
// Mock-only limits, all documented in the bead report:
// - Availability is generated from the sample outlet's zones, tables and opening
//   hours (30-minute starts) instead of a real table-slot query (RSV-01).
// - The guest contact digest is the fixture digest: hashing needs the server
//   secret, so the mock stores sample data, never a real number.
// - A reservation made here does not appear on the staff desk: the staff mock
//   keeps its own store.
// - The pre-order package is validated but not expanded into a kitchen order.
import {
  cafeLegendReservationFixtures,
  createReservation,
  getReservationAvailability,
  joinWaitlist,
  listPublicReservationPackages,
  clampWaitEstimate,
  reservationCreatedSchema,
  joinWaitlistResultSchema,
  waitlistEntrySchema,
} from "@starter/shared/reservation";
import type {
  JoinWaitlistResult,
  ReservationCreated,
  ReservationPolicySnapshot,
} from "@starter/shared/reservation";
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendQrOrderFixtures } from "@starter/shared/qr-order/sample";
import type { FloorZone, Table } from "@starter/shared/qr-order";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { registerExternalPaymentLink } from "../../lib/mock/payment-link-bridge.ts";
import {
  DEFAULT_DURATION,
  depositToken,
  instantAt,
  minutesOfDay,
  readConfirmation,
  saveConfirmation,
} from "./lib.ts";

const fixtures = cafeLegendReservationFixtures;
const outlet = cafeLegendFixtures.outlets[0];
const outletId = outlet.id;
const timeZone = outlet.timeZone;
const zones = cafeLegendQrOrderFixtures.zones.filter(
  (zone) => zone.status === "active",
);
const tables = cafeLegendQrOrderFixtures.tables;
/** Sample digest: the API stores an HMAC-SHA-256 with its own secret. */
const contactHash = fixtures.reservations[0].contactHash ?? "";
const SLOT_STEP_MINUTES = 30;
const HOUR_MS = 3_600_000;

const privateRoomZone = zones.find(
  (zone) => zone.name === "Private Room Nusantara",
);
/** Policies come from the fixtures in the documented order (regular, private room). */
const regularPolicy = fixtures.policies[0];
const privateRoomPolicy = fixtures.policies[1] ?? fixtures.policies[0];

function requireOutlet(requested: string): void {
  if (requested !== outletId)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
}

function fail(code: string, status: number, message: string): never {
  throw new ApiError(status, code, message);
}

function policyFor(
  zoneId: string | null | undefined,
): ReservationPolicySnapshot {
  return zoneId === privateRoomZone?.id ? privateRoomPolicy : regularPolicy;
}

function requireZone(zoneId: string | null | undefined): void {
  if (zoneId === null || zoneId === undefined) return;
  if (!zones.some((zone) => zone.id === zoneId))
    fail("NOT_FOUND", 404, "Zona tidak ditemukan.");
}

// ---- Opening hours and tables (sample schedule) ---------------------------

/** Weekday of a business date (0 = Sunday), independent of the runtime zone. */
function weekdayOf(businessDate: string): number {
  return new Date(`${businessDate}T12:00:00.000Z`).getUTCDay();
}

/** The zone's opening window for that weekday, when it opens. */
function windowOf(
  zone: FloorZone,
  weekday: number,
): { opens: number; closes: number } | null {
  const hours = zone.hours.find((entry) => entry.daysOfWeek.includes(weekday));
  if (!hours) return null;
  return { opens: minutesOfDay(hours.start), closes: minutesOfDay(hours.end) };
}

function zoneIdsOf(zoneId: string | undefined): string[] {
  return zoneId === undefined ? zones.map((zone) => zone.id) : [zoneId];
}

function tablesOf(zoneIds: readonly string[]): Table[] {
  return tables.filter(
    (table) => table.status !== "inactive" && zoneIds.includes(table.zoneId),
  );
}

/**
 * Candidate start times for the date, inside every selected zone's opening
 * hours, with the seats of the free tables of that zone (RSV-01 read model).
 */
function slotsFor(input: {
  date: string;
  pax: number;
  zoneId: string | undefined;
  durationMinutes: number;
}) {
  const weekday = weekdayOf(input.date);
  const selected = zones.filter((zone) =>
    zoneIdsOf(input.zoneId).includes(zone.id),
  );
  const windows = selected
    .map((zone) => windowOf(zone, weekday))
    .filter(
      (window): window is { opens: number; closes: number } => window !== null,
    );
  if (windows.length === 0) return [];
  const opens = Math.min(...windows.map((window) => window.opens));
  const closes = Math.max(...windows.map((window) => window.closes));
  const zoneTables = tablesOf(selected.map((zone) => zone.id));
  const seats = zoneTables.reduce((total, table) => total + table.capacity, 0);
  if (seats < input.pax) return [];
  const tableIds = zoneTables.map((table) => table.id);
  const slots: {
    startsAt: string;
    tableIds: string[];
    seatsAvailable: number;
  }[] = [];
  for (
    let start = opens;
    start + input.durationMinutes <= closes;
    start += SLOT_STEP_MINUTES
  )
    slots.push({
      startsAt: instantAt(input.date, start, timeZone),
      tableIds,
      seatsAvailable: seats,
    });
  return slots;
}

function businessDateOfInstant(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime()))
    fail("VALIDATION_ERROR", 400, "Tanggal kedatangan tidak valid.");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// ---- Per-runtime stores ---------------------------------------------------

/** Idempotency-Key → the first answer, so a retry returns one reservation. */
const bookings = createMockStore(() => new Map<string, ReservationCreated>());
const waitlistReplays = createMockStore(
  () => new Map<string, JoinWaitlistResult>(),
);
const waitlistEntries = createMockStore(() =>
  structuredClone(fixtures.waitlist),
);

/** The saved confirmation outlives the in-memory bridge after a page reload. */
function registerDepositPayment(created: ReservationCreated): void {
  if (!created.deposit || created.reservation.status !== "pending_deposit")
    return;
  const token = depositToken(created.deposit.paymentPath);
  if (!token) return;
  registerExternalPaymentLink({
    token,
    reference: `Reservasi ${created.reservation.id.slice(-8)}`,
    subtotalIdr: created.deposit.amountIdr,
    taxIdr: 0,
    returnPath: "/reservasi",
    onPaid: () => {
      if (created.reservation.status !== "pending_deposit") return;
      created.reservation = reservationCreatedSchema.parse({
        ...created,
        reservation: {
          ...created.reservation,
          depositPaymentId: newIdempotencyKey(),
          depositStatus: "paid",
          status: "confirmed",
          updatedAt: new Date().toISOString(),
        },
      }).reservation;
      if (readConfirmation()?.reservation.id === created.reservation.id)
        saveConfirmation(created);
    },
  });
}

const restoredConfirmation = readConfirmation();
if (restoredConfirmation) registerDepositPayment(restoredConfirmation);

// ---- Public endpoints -----------------------------------------------------

registerMock(getReservationAvailability, ({ params, query, scenario }) => {
  requireOutlet(params.outletId);
  requireZone(query.zoneId);
  const durationMinutes = query.durationMinutes ?? DEFAULT_DURATION;
  return {
    data: {
      date: query.date,
      timeZone,
      durationMinutes,
      pax: query.pax,
      zoneId: query.zoneId ?? null,
      // `?mock=empty`: the honest "no table left" answer for the empty state.
      slots:
        scenario === "empty"
          ? []
          : slotsFor({
              date: query.date,
              pax: query.pax,
              zoneId: query.zoneId,
              durationMinutes,
            }),
    },
  };
});

registerMock(listPublicReservationPackages, ({ params, scenario }) => {
  requireOutlet(params.outletId);
  const active = fixtures.packages
    .filter((pack) => pack.status === "active")
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder);
  return { data: scenario === "empty" ? [] : active };
});

registerMock(
  createReservation,
  ({ params, body, scenario, headers }): { data: ReservationCreated } => {
    requireOutlet(params.outletId);
    requireZone(body.zoneId);
    const key = headers?.["Idempotency-Key"];
    const replay = key === undefined ? undefined : bookings.get().get(key);
    if (replay) return { data: replay };

    const durationMinutes = body.durationMinutes ?? DEFAULT_DURATION;
    const date = businessDateOfInstant(body.reservedFor);
    const slots = slotsFor({
      date,
      pax: body.pax,
      zoneId: body.zoneId ?? undefined,
      durationMinutes,
    });
    const requested = Date.parse(body.reservedFor);
    const slot = slots.find(
      (candidate) => Date.parse(candidate.startsAt) === requested,
    );
    // RSV-01: the requested start must still be a free slot for that party.
    if (!slot || requested <= Date.now() || scenario === "empty")
      fail(
        "RESERVATION_SLOT_UNAVAILABLE",
        409,
        "Tidak ada meja yang tersedia pada tanggal dan jam tersebut.",
      );

    if (body.preOrderPackageId) {
      const pack = fixtures.packages.find(
        (candidate) => candidate.id === body.preOrderPackageId,
      );
      const leadOk =
        pack !== undefined &&
        requested - Date.now() >= pack.leadTimeHours * HOUR_MS;
      if (
        !pack ||
        pack.status !== "active" ||
        body.pax < pack.minPax ||
        body.pax > pack.maxPax ||
        !leadOk
      )
        fail(
          "RESERVATION_PACKAGE_UNAVAILABLE",
          409,
          "Paket pre-order tidak tersedia atau sudah melewati batas pemesanan.",
        );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const policy = policyFor(body.zoneId);
    const snapshot: ReservationPolicySnapshot = {
      ...policy,
      // RSV-03: the snapshot freezes when the reservation is created.
      capturedAt: nowIso,
    };
    const depositRequired = policy.depositRequirement !== "none";
    const reservationId = newIdempotencyKey();
    const expiresAt = new Date(
      now.getTime() + policy.paymentWindowMinutes * 60_000,
    ).toISOString();

    const created = reservationCreatedSchema.parse({
      reservation: {
        id: reservationId,
        tenantId: outlet.tenantId,
        outletId,
        customerProfileId: null,
        guestName: body.guestName,
        contactHash,
        reservedFor: body.reservedFor,
        durationMinutes,
        pax: body.pax,
        zoneId: body.zoneId ?? null,
        // The host assigns tables on the floor plan (RSV-01).
        tableIds: [],
        depositIdr: depositRequired ? policy.depositAmountIdr : 0,
        depositPaymentId: null,
        depositStatus: depositRequired ? "pending" : null,
        policy: snapshot,
        status: depositRequired ? "pending_deposit" : "confirmed",
        note: body.note ?? null,
        source: "website",
        seatedAt: null,
        completedAt: null,
        closedAt: null,
        closeReason: null,
        tableSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      // The DP is a WS-05 bill link; the guest picks a method on that page.
      deposit: depositRequired
        ? {
            paymentLinkId: newIdempotencyKey(),
            amountIdr: policy.depositAmountIdr,
            paymentPath: `/bayar/rsv-${reservationId.replace(/-/g, "").slice(-16)}`,
            expiresAt,
          }
        : null,
    });

    registerDepositPayment(created);

    if (key !== undefined) bookings.set(bookings.get().set(key, created));
    return { data: created };
  },
);

registerMock(
  joinWaitlist,
  ({ params, body, headers }): { data: JoinWaitlistResult } => {
    requireOutlet(params.outletId);
    requireZone(body.zoneId);
    const key = headers?.["Idempotency-Key"];
    const replay =
      key === undefined ? undefined : waitlistReplays.get().get(key);
    if (replay) return { data: replay };

    const nowIso = new Date().toISOString();
    const queue = waitlistEntries
      .get()
      .filter(
        (entry) => entry.status === "waiting" || entry.status === "called",
      ).length;
    // One estimate for the queue and the party size; the service owns the real
    // turnover math (machines.ts `clampWaitEstimate` only bounds it).
    const estimatedWaitMinutes = clampWaitEstimate(
      10 + queue * 8 + (body.pax - 1) * 3,
    );
    const entry = waitlistEntrySchema.parse({
      id: newIdempotencyKey(),
      tenantId: outlet.tenantId,
      outletId,
      name: body.name,
      pax: body.pax,
      contactHash,
      zoneId: body.zoneId ?? null,
      status: "waiting",
      joinedAt: nowIso,
      calledAt: null,
      seatedAt: null,
      leftAt: null,
      estimatedWaitMinutes,
    });
    waitlistEntries.set([...waitlistEntries.get(), entry]);

    const result = joinWaitlistResultSchema.parse({
      entry,
      estimatedWaitMinutes,
    });
    if (key !== undefined)
      waitlistReplays.set(waitlistReplays.get().set(key, result));
    return { data: result };
  },
);
