// Staff decide a guest's reschedule request (bead legend-9txo; PRD v1.7 §3.22
// "Reservasi", RSV-01 table holds, RSV-03 self-service). The guest side already
// exists (reservation-public.test.ts): a request is recorded as `pending` and
// the booking is untouched. This file covers the missing staff side: approve
// moves the booking and its table hold through the booking rules, decline
// leaves everything as it was. Real app, real middleware, PostgreSQL.
//
// Assumptions (the shared contract has no staff reschedule endpoints yet, so the
// names follow the existing `reservation-reschedule-requests` list route and the
// `declined` status of `rescheduleRequestStatusSchema`):
// - approve:  POST /api/outlets/:outletId/reservation-reschedule-requests/:requestId/approve
// - decline:  POST /api/outlets/:outletId/reservation-reschedule-requests/:requestId/decline
//   both with an (optional) empty strict JSON body; success answers 200.
// - the permission is reservation.manage (a cashier has neither it nor view).
// - the new event is `reservation.rescheduled`, aggregate id = reservation id,
//   payload carries `reservationId` and the new time, and no guest PII.
// - a second approve of the same request is idempotent (200) or refused (409);
//   either way: exactly one event and one move. Approve after decline (or the
//   other way round) is a 409 and changes nothing.
// - a target slot that the booking rules refuse (table taken) answers 409, the
//   request stays pending and the old hold stays.
// - the reschedule time the guest asks for is 19:00 WIB on a distinct April 2027
//   day per test (inside the 180 day window, inside the zone's opening hours).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  RESERVATION_LINK_TOKEN_HEADER,
  createReservationInputSchema,
  reservationAvailabilityQuerySchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import {
  getAvailability,
  createReservation,
} from "../services/reservation-booking.ts";
import { assertFreeCancellationWindowOpen } from "../services/reservation-reschedule.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const outletA = outletIdSchema.parse(seededOutletA);
const LINK_PATH = "/api/public/reservation-link";
const REQUESTS_PATH = `/api/outlets/${seededOutletA}/reservation-reschedule-requests`;

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let app: ReturnType<typeof createApp>;
let manager: Staff;
let cashier: Staff;
let outletBManager: Staff;
let otherTenant: IsolatedTenant;
let otherTenantStaff: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
let originalDayCounter = 0;
let targetDayCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  manager = await staffWithRole(app, {
    template: "owner",
    label: "Rsv Reschedule Owner",
  });
  // A cashier holds neither reservation.view nor reservation.manage.
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Rsv Reschedule Cashier",
  });
  // Manager of the other outlet of the same tenant: no rights on outlet A.
  outletBManager = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletB,
    label: "Rsv Reschedule Outlet B",
  });
  otherTenant = await createIsolatedTenant(`rsvresc${Date.now() % 100_000}`);
  otherTenantStaff = await staffOfIsolatedTenant(app, otherTenant);
  // No deposit: bookings are confirmed at once (policy below), so the deposit
  // port is never reached.
  setReservationDepositPort(null);
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'resc-staff-1', 'none', 0, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
});

afterAll(async () => {
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    for (const table of [
      "reservation_reschedule_requests",
      "reservation_guest_links",
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await dropIsolatedTenant(otherTenant);
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

const key = () => `rsv-resc-${randomUUID()}`;

/** A distinct future day (March 2027) for the original booking. */
function originalDate() {
  const day = 1 + (originalDayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

/** A distinct future day (April 2027) for the requested time. */
function targetDate() {
  const day = 1 + (targetDayCounter++ % 28);
  return `2027-04-${String(day).padStart(2, "0")}`;
}

const at = (date: string, time = "19:00") =>
  zonedInstant(date, time, WIB).toISOString();

async function floorZone() {
  const zone = await createZone(manager.client);
  zoneIds.push(zone.id);
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  return { zoneId: zone.id as string, tableId: table.id as string };
}

async function bookIn(
  zoneId: string,
  date: string,
  time = "19:00",
  pax = 2,
): Promise<ReservationCreated> {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: at(date, time),
      pax,
      zoneId,
      guestName: "Tamu Geser",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

type Booking = {
  id: string;
  zoneId: string;
  tableId: string;
  fromDate: string;
  originalAt: string;
  token: string;
};

/** A confirmed booking on its own zone and table, with an active guest link. */
async function bookingWithLink(): Promise<Booking> {
  const { zoneId, tableId } = await floorZone();
  const fromDate = originalDate();
  const created = await bookIn(zoneId, fromDate);
  const id = created.reservation.id;
  const issued = await manager.client
    .post(`/api/outlets/${seededOutletA}/reservations/${id}/guest-link`)
    .set(originHeader)
    .send({});
  expect(issued.status).toBe(201);
  return {
    id,
    zoneId,
    tableId,
    fromDate,
    originalAt: at(fromDate),
    token: issued.body.data.token as string,
  };
}

/** The guest asks for a new time through the public link; returns the request id. */
async function guestRequests(
  booking: Booking,
  requestedFor: string,
  extra: { partySize?: number; note?: string } = {},
): Promise<string> {
  const response = await agent(app)
    .post(`${LINK_PATH}/reschedule`)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, booking.token)
    .set("Idempotency-Key", key())
    .send({ requestedFor, ...extra });
  expect([200, 201]).toContain(response.status);
  return response.body.data.request.id as string;
}

function decide(
  client: ReturnType<typeof agent>,
  requestId: string,
  action: "approve" | "decline",
  options: { outletId?: string; body?: Record<string, unknown> } = {},
) {
  return client
    .post(
      `/api/outlets/${options.outletId ?? seededOutletA}/reservation-reschedule-requests/${requestId}/${action}`,
    )
    .set(originHeader)
    .send(options.body ?? {});
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      reserved_for: Date;
      pax: number;
      duration_minutes: number;
    }>(
      "SELECT status, reserved_for, pax, duration_minutes FROM reservations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

async function liveHolds(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ table_id: string; starts_at: Date; ends_at: Date }>(
      "SELECT table_id, starts_at, ends_at FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows;
}

async function requestStatus(requestId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; resolved_at: Date | null }>(
      "SELECT status, resolved_at FROM reservation_reschedule_requests WHERE id = $1",
      [requestId],
    ),
  );
  return rows[0]!;
}

async function rescheduleEvents(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'reservation.rescheduled' ORDER BY sequence",
      [seededTenantId, reservationId],
    ),
  );
  return rows.map((row) => row.event);
}

async function guestView(token: string) {
  return agent(app)
    .get(LINK_PATH)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token);
}

async function slotsFree(zoneId: string, date: string, pax = 2) {
  const result = await getAvailability(
    tenantScope(),
    outletA,
    reservationAvailabilityQuerySchema.parse({ date, pax, zoneId }),
  );
  return result.slots.map((slot) => slot.startsAt);
}

// --- tests ------------------------------------------------------------------

describe("RSV-03 staff approve a reschedule request (legend-9txo)", () => {
  it("RSV-03 approve moves the booking and its table hold to the requested time and frees the old slot", async () => {
    const booking = await bookingWithLink();
    const toDate = targetDate();
    const requestedFor = at(toDate);
    const before = await reservationRow(booking.id);
    const requestId = await guestRequests(booking, requestedFor, {
      partySize: 3,
    });

    // Until staff decide, nothing moved.
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
    expect(await slotsFree(booking.zoneId, booking.fromDate)).not.toContain(
      booking.originalAt,
    );

    const response = await decide(manager.client, requestId, "approve");
    expect(response.status).toBe(200);

    const after = await reservationRow(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.reserved_for.toISOString()).toBe(requestedFor);
    expect(after.pax).toBe(3);
    expect(after.duration_minutes).toBe(before.duration_minutes);

    // The hold moved with the booking: one live hold, same table, new window.
    const holds = await liveHolds(booking.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.table_id).toBe(booking.tableId);
    expect(holds[0]!.starts_at.toISOString()).toBe(requestedFor);
    expect(holds[0]!.ends_at.getTime() - holds[0]!.starts_at.getTime()).toBe(
      before.duration_minutes * 60_000,
    );

    // The old slot is bookable again, the new one is taken.
    expect(await slotsFree(booking.zoneId, booking.fromDate)).toContain(
      booking.originalAt,
    );
    expect(await slotsFree(booking.zoneId, toDate, 3)).not.toContain(
      requestedFor,
    );

    // The request is resolved and the guest sees the new time, no pending ask.
    const resolved = await requestStatus(requestId);
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_at).not.toBeNull();
    const view = await guestView(booking.token);
    expect(view.status).toBe(200);
    expect(view.body.data.reservedFor).toBe(requestedFor);
    expect(view.body.data.partySize).toBe(3);
    expect(view.body.data.rescheduleRequest).toBeNull();
    // The same link keeps working and now outlives the new booking time.
    expect(
      new Date(view.body.data.linkExpiresAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(requestedFor).getTime());
  });

  it("RSV-03 approve writes exactly one reservation.rescheduled outbox event without guest data", async () => {
    const booking = await bookingWithLink();
    const requestedFor = at(targetDate());
    const requestId = await guestRequests(booking, requestedFor);
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);

    expect((await decide(manager.client, requestId, "approve")).status).toBe(
      200,
    );
    const events = await rescheduleEvents(booking.id);
    expect(events).toHaveLength(1);
    // The event is in the catalog: it parses as a registered envelope.
    const envelope = eventEnvelopeSchema.parse(events[0]);
    expect(envelope.name).toBe("reservation.rescheduled");
    expect(envelope.tenantId).toBe(seededTenantId);
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.reservationId).toBe(booking.id);
    expect(JSON.stringify(payload)).toContain(requestedFor);
    // Ids and times only: no guest name, phone, or link token.
    const text = JSON.stringify(envelope);
    expect(text).not.toContain("081234567890");
    expect(text).not.toContain("Tamu Geser");
    expect(text).not.toContain(booking.token);
  });

  it("RSV-03 approve is refused when the booking rules say the table is taken: nothing moves and the request stays pending", async () => {
    const booking = await bookingWithLink();
    const toDate = targetDate();
    const requestedFor = at(toDate);
    const requestId = await guestRequests(booking, requestedFor);
    // Someone else books the only table of the zone at the requested time.
    await bookIn(booking.zoneId, toDate);

    const response = await decide(manager.client, requestId, "approve");
    expect(response.status).toBe(409);
    expect(response.body.data).toBeUndefined();

    const after = await reservationRow(booking.id);
    expect(after.reserved_for.toISOString()).toBe(booking.originalAt);
    const holds = await liveHolds(booking.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.starts_at.toISOString()).toBe(booking.originalAt);
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);
  });

  it("RSV-03 a party larger than the held tables is refused: nothing moves and the request stays pending", async () => {
    const booking = await bookingWithLink();
    // One table of 4 seats is held; 5 guests do not fit.
    const requestId = await guestRequests(booking, at(targetDate()), {
      partySize: 5,
    });
    const response = await decide(manager.client, requestId, "approve");
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("RESERVATION_SLOT_UNAVAILABLE");
    const after = await reservationRow(booking.id);
    expect(after.pax).toBe(2);
    expect(after.reserved_for.toISOString()).toBe(booking.originalAt);
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);
    // A party that still fits (4) is approved.
    const fits = await bookingWithLink();
    const fitsId = await guestRequests(fits, at(targetDate()), {
      partySize: 4,
    });
    expect((await decide(manager.client, fitsId, "approve")).status).toBe(200);
    expect((await reservationRow(fits.id)).pax).toBe(4);
  });

  describe("money: the free-cancellation window is measured from the ORIGINAL time", () => {
    /**
     * Puts the booking `hours` from now with a DP of 100.000 still to be paid
     * (a confirmed booking needs a settled payment intent, so the booking
     * waits for its DP; the guard counts the full DP at stake either way).
     */
    async function withDeposit(booking: Booking, hours: number, dp = 100_000) {
      await asOwner(async (client) => {
        await client.query(
          "UPDATE reservations SET reserved_for = now() + make_interval(hours => $2), deposit_idr = $3::int WHERE id = $1",
          [booking.id, hours, dp],
        );
        if (dp > 0)
          await client.query(
            "UPDATE reservations SET status = 'pending_deposit', deposit_link_expires_at = now() + interval '30 days' WHERE id = $1",
            [booking.id],
          );
      });
      return (await reservationRow(booking.id)).reserved_for.toISOString();
    }

    it("RSV-03 inside the free window a paid-DP booking cannot be moved out: 409 RESERVATION_RESCHEDULE_LATE, nothing moves, staff can still decline", async () => {
      const booking = await bookingWithLink();
      // The guest asked while no DP was held; the DP lands afterwards (a
      // guest asking inside the window is refused up front, see
      // reservation-guest-contract.test.ts).
      const requestId = await guestRequests(booking, at(targetDate()));
      const original = await withDeposit(booking, 10);

      const response = await decide(manager.client, requestId, "approve");
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("RESERVATION_RESCHEDULE_LATE");
      // Nothing moved, so a later cancel is still measured on the original
      // time: the DP cannot come back larger than it would have before.
      expect(
        (await reservationRow(booking.id)).reserved_for.toISOString(),
      ).toBe(original);
      expect((await requestStatus(requestId)).status).toBe("pending");
      expect(await rescheduleEvents(booking.id)).toHaveLength(0);
    });

    it("RSV-03 the guard (same machine as a cancel): refuses inside the free window, allows outside it and when the late refund is full", async () => {
      const booking = await bookingWithLink();
      const { rows } = await asOwner((client) =>
        client.query<{ policy_snapshot: Record<string, unknown> }>(
          "SELECT policy_snapshot FROM reservations WHERE id = $1",
          [booking.id],
        ),
      );
      const snapshot = rows[0]!.policy_snapshot;
      const now = new Date("2026-12-01T10:00:00.000Z");
      const row = (hours: number, policy = snapshot) =>
        ({
          depositIdr: 100_000,
          depositPaymentId: null,
          reservedFor: new Date(now.getTime() + hours * 3_600_000),
          policySnapshot: policy,
        }) as unknown as Parameters<typeof assertFreeCancellationWindowOpen>[2];
      // Pending DP path: no database read is needed, the DP at stake is full.
      const tx = undefined as never;
      await expect(
        assertFreeCancellationWindowOpen(tx, tenantScope(), row(10), now),
      ).rejects.toMatchObject({ code: "RESERVATION_RESCHEDULE_LATE" });
      await expect(
        assertFreeCancellationWindowOpen(tx, tenantScope(), row(-1), now),
      ).rejects.toMatchObject({ code: "RESERVATION_RESCHEDULE_LATE" });
      await expect(
        assertFreeCancellationWindowOpen(tx, tenantScope(), row(72), now),
      ).resolves.toBeUndefined();
      // A late cancel that still refunds in full gives nothing to protect.
      await expect(
        assertFreeCancellationWindowOpen(
          tx,
          tenantScope(),
          row(10, { ...snapshot, lateCancellationRefundBp: 10_000 }),
          now,
        ),
      ).resolves.toBeUndefined();
    });

    it("RSV-03 with no DP at stake the late window does not block a move", async () => {
      const booking = await bookingWithLink();
      await withDeposit(booking, 10, 0);
      const requestedFor = at(targetDate());
      const requestId = await guestRequests(booking, requestedFor);
      expect((await decide(manager.client, requestId, "approve")).status).toBe(
        200,
      );
    });
  });

  it("RSV-03 approving twice is idempotent or refused, never a second move or event", async () => {
    const booking = await bookingWithLink();
    const requestedFor = at(targetDate());
    const requestId = await guestRequests(booking, requestedFor);

    const first = await decide(manager.client, requestId, "approve");
    expect(first.status).toBe(200);
    const second = await decide(manager.client, requestId, "approve");
    expect([200, 409]).toContain(second.status);

    expect(await rescheduleEvents(booking.id)).toHaveLength(1);
    const holds = await liveHolds(booking.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.starts_at.toISOString()).toBe(requestedFor);
    expect((await requestStatus(requestId)).status).toBe("approved");
  });

  it("RSV-03 two staff approving at once move the booking once, with no 5xx", async () => {
    const booking = await bookingWithLink();
    const requestedFor = at(targetDate());
    const requestId = await guestRequests(booking, requestedFor);

    const results = await Promise.all([
      decide(manager.client, requestId, "approve"),
      decide(manager.client, requestId, "approve"),
    ]);
    for (const result of results) expect([200, 409]).toContain(result.status);
    expect(results.some((result) => result.status === 200)).toBe(true);

    expect(await rescheduleEvents(booking.id)).toHaveLength(1);
    const holds = await liveHolds(booking.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.starts_at.toISOString()).toBe(requestedFor);
  });

  it("RSV-03 a request on a booking the guest already cancelled cannot be approved", async () => {
    const booking = await bookingWithLink();
    const requestedFor = at(targetDate());
    const requestId = await guestRequests(booking, requestedFor);
    const cancelled = await agent(app)
      .post(`${LINK_PATH}/cancel`)
      .set("Host", seededHostname)
      .set(RESERVATION_LINK_TOKEN_HEADER, booking.token)
      .set("Idempotency-Key", key())
      .send({});
    expect(cancelled.status).toBe(200);

    const response = await decide(manager.client, requestId, "approve");
    expect(response.status).toBe(409);
    const after = await reservationRow(booking.id);
    expect(after.status).toBe("cancelled");
    expect(after.reserved_for.toISOString()).toBe(booking.originalAt);
    expect(await liveHolds(booking.id)).toHaveLength(0);
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);
  });
});

describe("RSV-03 staff decline a reschedule request (legend-9txo)", () => {
  it("RSV-03 decline keeps the booking and hold as they were, resolves the request, and lets the guest ask again", async () => {
    const booking = await bookingWithLink();
    const requestedFor = at(targetDate());
    const requestId = await guestRequests(booking, requestedFor, {
      partySize: 3,
    });

    const response = await decide(manager.client, requestId, "decline");
    expect(response.status).toBe(200);

    const after = await reservationRow(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.reserved_for.toISOString()).toBe(booking.originalAt);
    expect(after.pax).toBe(2);
    const holds = await liveHolds(booking.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.starts_at.toISOString()).toBe(booking.originalAt);
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);

    const resolved = await requestStatus(requestId);
    expect(resolved.status).toBe("declined");
    expect(resolved.resolved_at).not.toBeNull();
    const view = await guestView(booking.token);
    expect(view.body.data.reservedFor).toBe(booking.originalAt);
    expect(view.body.data.rescheduleRequest).toBeNull();

    // No pending request is left, so the guest may ask for another time.
    const again = await agent(app)
      .post(`${LINK_PATH}/reschedule`)
      .set("Host", seededHostname)
      .set(RESERVATION_LINK_TOKEN_HEADER, booking.token)
      .set("Idempotency-Key", key())
      .send({ requestedFor: at(targetDate()) });
    expect([200, 201]).toContain(again.status);
  });

  it("RSV-03 a decided request cannot be decided the other way", async () => {
    const declined = await bookingWithLink();
    const declinedRequest = await guestRequests(declined, at(targetDate()));
    expect(
      (await decide(manager.client, declinedRequest, "decline")).status,
    ).toBe(200);
    const approveAfterDecline = await decide(
      manager.client,
      declinedRequest,
      "approve",
    );
    expect(approveAfterDecline.status).toBe(409);
    expect((await requestStatus(declinedRequest)).status).toBe("declined");
    expect((await reservationRow(declined.id)).reserved_for.toISOString()).toBe(
      declined.originalAt,
    );
    expect(await rescheduleEvents(declined.id)).toHaveLength(0);

    const approvedTo = at(targetDate());
    const approved = await bookingWithLink();
    const approvedRequest = await guestRequests(approved, approvedTo);
    expect(
      (await decide(manager.client, approvedRequest, "approve")).status,
    ).toBe(200);
    const declineAfterApprove = await decide(
      manager.client,
      approvedRequest,
      "decline",
    );
    expect(declineAfterApprove.status).toBe(409);
    expect((await requestStatus(approvedRequest)).status).toBe("approved");
    expect((await reservationRow(approved.id)).reserved_for.toISOString()).toBe(
      approvedTo,
    );
  });

  it("RSV-03 declining twice leaves one resolved request and no change", async () => {
    const booking = await bookingWithLink();
    const requestId = await guestRequests(booking, at(targetDate()));
    expect((await decide(manager.client, requestId, "decline")).status).toBe(
      200,
    );
    const second = await decide(manager.client, requestId, "decline");
    expect([200, 409]).toContain(second.status);
    expect((await requestStatus(requestId)).status).toBe("declined");
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
  });
});

describe("RSV-03 staff reschedule list reflects decisions", () => {
  it("RSV-03 the list filters by status: a decided request leaves pending and shows under its new status", async () => {
    const approved = await bookingWithLink();
    const approvedRequest = await guestRequests(approved, at(targetDate()));
    const declined = await bookingWithLink();
    const declinedRequest = await guestRequests(declined, at(targetDate()));
    const waiting = await bookingWithLink();
    const waitingRequest = await guestRequests(waiting, at(targetDate()));
    expect(
      (await decide(manager.client, approvedRequest, "approve")).status,
    ).toBe(200);
    expect(
      (await decide(manager.client, declinedRequest, "decline")).status,
    ).toBe(200);

    const ids = async (status: string) => {
      const response = await manager.client.get(
        `${REQUESTS_PATH}?status=${status}&limit=100`,
      );
      expect(response.status).toBe(200);
      return (response.body.data as { id: string }[]).map((item) => item.id);
    };
    const pending = await ids("pending");
    expect(pending).toContain(waitingRequest);
    expect(pending).not.toContain(approvedRequest);
    expect(pending).not.toContain(declinedRequest);
    expect(await ids("approved")).toContain(approvedRequest);
    expect(await ids("declined")).toContain(declinedRequest);
    expect(await ids("declined")).not.toContain(approvedRequest);
  });

  it("RSV-03 a status with no requests lists an empty page, not an error", async () => {
    // Nothing in these tests is ever withdrawn: that filter must be an empty
    // page (or hold only withdrawn rows), never an error.
    const response = await manager.client.get(
      `${REQUESTS_PATH}?status=withdrawn&limit=100`,
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    for (const item of response.body.data as { status: string }[])
      expect(item.status).toBe("withdrawn");
  });
});

describe("RSV-03 staff reschedule decision: permissions and isolation", () => {
  it("RSV-03 deciding needs a session and reservation.manage", async () => {
    const booking = await bookingWithLink();
    const requestId = await guestRequests(booking, at(targetDate()));

    const anonymous = await decide(agent(app), requestId, "approve");
    expect(anonymous.status).toBe(401);
    for (const action of ["approve", "decline"] as const) {
      const denied = await decide(cashier.client, requestId, action);
      expect(denied.status).toBe(403);
    }
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);
  });

  it("RSV-03 staff of another outlet cannot decide, and the request is not found under another outlet's path", async () => {
    const booking = await bookingWithLink();
    const requestId = await guestRequests(booking, at(targetDate()));

    // A manager scoped to outlet B only: no rights on outlet A.
    for (const action of ["approve", "decline"] as const) {
      const wrongScope = await decide(outletBManager.client, requestId, action);
      expect(wrongScope.status).toBe(403);
    }
    // An outlet-A request addressed through outlet B's path is not found, even
    // for a tenant owner who may act on both outlets.
    for (const action of ["approve", "decline"] as const) {
      const wrongPath = await decide(manager.client, requestId, action, {
        outletId: seededOutletB,
      });
      expect(wrongPath.status).toBe(404);
    }
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
    expect(await rescheduleEvents(booking.id)).toHaveLength(0);
  });

  it("RSV-03 staff of another tenant cannot decide, under either tenant's outlet path", async () => {
    const booking = await bookingWithLink();
    const requestId = await guestRequests(booking, at(targetDate()));

    const ownPath = await decide(
      otherTenantStaff.client,
      requestId,
      "approve",
      {
        outletId: otherTenant.outletId,
      },
    );
    expect([403, 404]).toContain(ownPath.status);
    const foreignPath = await decide(
      otherTenantStaff.client,
      requestId,
      "decline",
    );
    expect([403, 404]).toContain(foreignPath.status);
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
  });

  it("RSV-03 an unknown or malformed request id is refused", async () => {
    const unknown = await decide(manager.client, randomUUID(), "approve");
    expect(unknown.status).toBe(404);
    const malformed = await decide(manager.client, "not-a-uuid", "decline");
    expect(malformed.status).toBe(422);
  });

  it("RSV-03 the decision body is strict: it cannot override the time, party size or tenant", async () => {
    const booking = await bookingWithLink();
    const requestId = await guestRequests(booking, at(targetDate()));
    const response = await decide(manager.client, requestId, "approve", {
      body: {
        reservedFor: at("2027-05-01"),
        pax: 40,
        tenantId: randomUUID(),
      },
    });
    expect(response.status).toBe(422);
    expect((await requestStatus(requestId)).status).toBe("pending");
    expect((await reservationRow(booking.id)).reserved_for.toISOString()).toBe(
      booking.originalAt,
    );
  });
});
