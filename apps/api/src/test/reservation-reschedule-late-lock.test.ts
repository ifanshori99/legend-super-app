// Approve takes its decision time AFTER the locks (bead legend-hlud3; PRD v1.7
// §3.22 "Reservasi", RSV-03). The money guard of an approve ("the free-cancel
// window must still be open, otherwise a guest could move the booking out and
// cancel for a full refund") is measured against "now". If "now" is read before
// the approve has waited for the reservation row lock, an approve that queued
// behind another transaction can slip past the penalty boundary: the clock said
// "free" when the request arrived, but by the time the move is written the
// window is shut. Real app, real middleware, PostgreSQL.
//
// Assumptions (same endpoints and fixtures as reservation-reschedule-staff.test.ts):
// - approve: POST /api/outlets/:outletId/reservation-reschedule-requests/:requestId/approve
//   with an empty JSON body, called WITHOUT an injected clock (the route uses
//   the real clock).
// - the policy has a 24h free-cancellation window and a 50% late refund.
// - the booking is a paid-DP booking (`pending_deposit`, DP 100.000) 30h from
//   now: the window is open when the approve arrives. While the approve waits
//   for the reservation row lock the system clock moves 8h forward (22h to go),
//   so the window is shut by the time the lock is granted.
// - expected: 409 RESERVATION_RESCHEDULE_LATE, nothing moved, request still
//   pending, DP untouched, no `reservation.rescheduled` event.
// - how the test knows the approve is queued: it polls pg_stat_activity until
//   some backend is blocked by the lock holder's pid (no sleeps, no guessing).
//   Only `Date` is faked, and only after the approve is queued, so timers and
//   sockets keep working.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  RESERVATION_LINK_TOKEN_HEADER,
  createReservationInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import { createReservation } from "../services/reservation-booking.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import { agent, originHeader } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const outletA = outletIdSchema.parse(seededOutletA);
const LINK_PATH = "/api/public/reservation-link";
const HOUR_MS = 3_600_000;
const DP_IDR = 100_000;

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

const linkIds: string[] = [];

/** Opens the DP bill link like WS-05 (the intent only comes when the guest pays). */
const depositPort: ReservationDepositPort = {
  async assertReady() {},
  async openDeposit(input) {
    const linkId = randomUUID();
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'reservation-test')`,
        [
          linkId,
          seededTenantId,
          input.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `RSV-${linkId.slice(0, 8)}`,
          input.amountIdr,
        ],
      );
    });
    linkIds.push(linkId);
    return {
      paymentLinkId: linkId,
      paymentPath: `/bayar/${linkId}`,
      expiresAt: new Date(
        input.now.getTime() + input.expiresInMinutes * 60_000,
      ).toISOString(),
    };
  },
};

let app: ReturnType<typeof createApp>;
let manager: Staff;
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
    label: "Rsv Late Lock Owner",
  });
  setReservationDepositPort(depositPort);
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
       VALUES ($1, $2, 'resc-late-lock-1', 'required', 100000, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.useRealTimers();
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
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
  });
  setReservationDepositPort(null);
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

const key = () => `rsv-late-lock-${randomUUID()}`;

function originalDate() {
  const day = 1 + (originalDayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

function targetDate() {
  const day = 1 + (targetDayCounter++ % 28);
  return `2027-04-${String(day).padStart(2, "0")}`;
}

const at = (date: string, time = "19:00") =>
  zonedInstant(date, time, WIB).toISOString();

async function bookIn(
  zoneId: string,
  date: string,
): Promise<ReservationCreated> {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: at(date, "19:00"),
      pax: 2,
      zoneId,
      guestName: "Tamu Geser",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

type Booking = { id: string; token: string; requestId: string };

/**
 * A booking with a DP still to be paid, `hoursAhead` hours from now, plus a
 * pending reschedule request from the guest for a distinct April 2027 day.
 */
async function bookingWithPendingRequest(hoursAhead: number): Promise<Booking> {
  const zone = await createZone(manager.client);
  zoneIds.push(zone.id);
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const created = await bookIn(zone.id as string, originalDate());
  const id = created.reservation.id;
  const issued = await manager.client
    .post(`/api/outlets/${seededOutletA}/reservations/${id}/guest-link`)
    .set(originHeader)
    .send({});
  expect(issued.status).toBe(201);
  const token = issued.body.data.token as string;
  await asOwner(async (client) => {
    await client.query(
      // The DP link must outlive the 8h clock shift, or the unpaid booking would
      // lapse (a different refusal) before the money guard is reached.
      "UPDATE reservations SET reserved_for = now() + make_interval(hours => $2), deposit_link_expires_at = now() + interval '30 days' WHERE id = $1",
      [id, hoursAhead],
    );
  });
  const asked = await agent(app)
    .post(`${LINK_PATH}/reschedule`)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token)
    .set("Idempotency-Key", key())
    .send({ requestedFor: at(targetDate()) });
  expect([200, 201]).toContain(asked.status);
  return { id, token, requestId: asked.body.data.request.id as string };
}

/** Another transaction holds the reservation row lock until `release()`. */
async function holdReservationLock(reservationId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [seededTenantId],
  );
  await client.query("SELECT id FROM reservations WHERE id = $1 FOR UPDATE", [
    reservationId,
  ]);
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  let released = false;
  return {
    pid: rows[0]!.pid,
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}

/** Resolves once some backend is waiting on a lock held by `holderPid`. */
async function waitUntilBlockedBy(holderPid: number) {
  await vi.waitFor(
    async () => {
      const { rows } = await owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))",
        [holderPid],
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    },
    { timeout: 15_000, interval: 25 },
  );
}

function startApprove(requestId: string) {
  return manager.client
    .post(
      `/api/outlets/${seededOutletA}/reservation-reschedule-requests/${requestId}/approve`,
    )
    .set(originHeader)
    .send({})
    .then((response) => response);
}

async function reservationState(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      reserved_for: Date;
      deposit_idr: number;
    }>(
      "SELECT status, reserved_for, deposit_idr FROM reservations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

async function liveHolds(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ starts_at: Date }>(
      "SELECT starts_at FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [id],
    ),
  );
  return rows.map((row) => row.starts_at.toISOString());
}

async function requestStatus(requestId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM reservation_reschedule_requests WHERE id = $1",
      [requestId],
    ),
  );
  return rows[0]!.status;
}

async function allocationCount(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reservation_deposit_allocations WHERE reservation_id = $1",
      [id],
    ),
  );
  return rows[0]!.n;
}

async function rescheduleEventCount(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'reservation.rescheduled'",
      [seededTenantId, id],
    ),
  );
  return rows[0]!.n;
}

// --- tests ------------------------------------------------------------------

describe("RSV-03 approve decides on the clock read after the locks (legend-hlud3)", () => {
  it("RSV-03 an approve queued behind a lock while the free window closes is refused: 409 RESERVATION_RESCHEDULE_LATE, nothing moves, DP intact", async () => {
    const booking = await bookingWithPendingRequest(30);
    const before = await reservationState(booking.id);
    const holdsBefore = await liveHolds(booking.id);
    expect(holdsBefore).toHaveLength(1);

    const holder = await holdReservationLock(booking.id);
    let response: Awaited<ReturnType<typeof startApprove>>;
    try {
      const approve = startApprove(booking.requestId);
      await waitUntilBlockedBy(holder.pid);
      // Window was open when the approve arrived (30h left, 24h free window).
      // While it waits, the clock passes the boundary: 22h left.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 8 * HOUR_MS));
      await holder.release();
      response = await approve;
    } finally {
      await holder.release();
      vi.useRealTimers();
    }

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("RESERVATION_RESCHEDULE_LATE");

    // Nothing moved, the request waits for a decision, the DP is untouched.
    const after = await reservationState(booking.id);
    expect(after.reserved_for.toISOString()).toBe(
      before.reserved_for.toISOString(),
    );
    expect(after.status).toBe("pending_deposit");
    expect(Number(after.deposit_idr)).toBe(DP_IDR);
    expect(await liveHolds(booking.id)).toEqual(holdsBefore);
    expect(await requestStatus(booking.requestId)).toBe("pending");
    expect(await allocationCount(booking.id)).toBe(0);
    expect(await rescheduleEventCount(booking.id)).toBe(0);
  });

  it("RSV-03 control: the same queued approve with the clock still outside the window goes through (the wait alone is not what refuses it)", async () => {
    const booking = await bookingWithPendingRequest(30);
    const holder = await holdReservationLock(booking.id);
    let response: Awaited<ReturnType<typeof startApprove>>;
    try {
      const approve = startApprove(booking.requestId);
      await waitUntilBlockedBy(holder.pid);
      await holder.release();
      response = await approve;
    } finally {
      await holder.release();
    }

    expect(response.status).toBe(200);
    expect(await requestStatus(booking.requestId)).toBe("approved");
    expect(await rescheduleEventCount(booking.id)).toBe(1);
  });
});
