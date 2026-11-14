// Guest reservation view contract additions and the late-reschedule guard
// (bead legend-z5ygw; PRD v1.7 §3.22 "Reservasi", RSV-03 self-service). Real
// app, real middleware, PostgreSQL. Only the payment gateway is a test double.
//
// Contract under test (docs/briefs/730-reservation-guest-contract-work.md):
// - the guest view carries `timeZone` (the outlet's IANA zone, default
//   Asia/Jakarta);
// - the guest view carries `rescheduleDecision`: the latest request that staff
//   already decided ({ outcome, decidedAt, requestedFor, partySize }) or null.
//   It is separate from `rescheduleRequest`, which stays pending-only;
// - a guest reschedule request made inside the free-cancellation window of a
//   booking with a paid DP is refused: 409 RESERVATION_RESCHEDULE_LATE, no
//   request row, booking untouched. A booking without DP is not guarded.
//
// Assumptions:
// - staff decide through POST .../reservation-reschedule-requests/:id/approve
//   and .../decline (as in reservation-reschedule-staff.test.ts), answer 200;
// - `decidedAt` equals the request's `resolved_at`; `partySize` is the guest's
//   requested party size, or null when the guest did not ask for one;
// - the outlet zone is changed only after the booking exists (the booking rules
//   use opening hours in the outlet zone) and is restored in afterAll;
// - the free window of the test policy is 24h; "inside" is reservedFor = now+3h,
//   "outside" is reservedFor = now+3 days. The reschedule time asked for is
//   19:00 WIB on a distinct April 2027 day (inside the 180 day window).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  RESERVATION_LINK_TOKEN_HEADER,
  createReservationInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
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
const HOUR = 3_600_000;
const outletA = outletIdSchema.parse(seededOutletA);
const LINK_PATH = "/api/public/reservation-link";

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

/** Provider double: one code per idempotency key. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const created: GatewayIntent = {
      providerRef: `FAKE-GC-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEGC",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
    this.byKey.set(input.idempotencyKey, created);
    return created;
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

let app: ReturnType<typeof createApp>;
let staff: Staff;
let originalTimeZone: string;
const zoneIds: string[] = [];
const tableIds: string[] = [];
let dayCounter = 0;
let targetDayCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv Guest Contract",
  });
  originalTimeZone = await asOwner(async (client) => {
    const { rows } = await client.query<{ timezone: string }>(
      "SELECT timezone FROM outlets WHERE id = $1",
      [seededOutletA],
    );
    return rows[0]!.timezone;
  });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
    await client.query("UPDATE outlets SET timezone = $2 WHERE id = $1", [
      seededOutletA,
      originalTimeZone,
    ]);
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    const links = (
      await client.query<{ id: string }>(
        "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
        [seededTenantId, zoneIds],
      )
    ).rows.map((row) => row.id);
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
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, links],
      );
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE 'reservation-refund:%'",
      [seededTenantId],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

async function setPolicy(requirement: "none" | "required", amount = 0) {
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
       VALUES ($1, $2, $3, $4, $5, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        `guest-contract-${requirement}`,
        requirement,
        amount,
      ],
    );
  });
}

async function floorZone() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  return zone.id as string;
}

const key = () => `rsv-gc-${randomUUID()}`;

/** A distinct future day (March 2027) per reservation. */
function nextDate() {
  const day = 1 + (dayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

/** A distinct 19:00 WIB instant in April 2027 for a requested time. */
function targetAt() {
  const day = 1 + (targetDayCounter++ % 28);
  return zonedInstant(
    `2027-04-${String(day).padStart(2, "0")}`,
    "19:00",
    WIB,
  ).toISOString();
}

async function book(): Promise<ReservationCreated> {
  const zoneId = await floorZone();
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(nextDate(), "19:00", WIB).toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Kontrak",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

/** Confirmed booking with the 100k DP paid through the real WS-05 path. */
async function paidBooking() {
  await setPolicy("required", 100_000);
  const created = await book();
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-gc-pay-${created.reservation.id}`,
    }),
  );
  await confirmPayment(tenantScope(), intent.id, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: 100_000,
    providerRef: `PAID-${intent.id}`,
    at: new Date().toISOString(),
  });
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intent.id],
    ),
  );
  await handlePaymentPaid(
    tenantScope(),
    eventEnvelopeSchema.parse(rows[0]!.event),
  );
  return { id: created.reservation.id };
}

/** Confirmed booking with no DP. */
async function freeBooking() {
  await setPolicy("none");
  const created = await book();
  return { id: created.reservation.id };
}

/** Moves the booking time (the HTTP surface uses the real clock). */
async function moveReservedFor(id: string, to: Date) {
  await asOwner((client) =>
    client.query("UPDATE reservations SET reserved_for = $2 WHERE id = $1", [
      id,
      to,
    ]),
  );
}

async function setOutletTimeZone(timeZone: string) {
  await asOwner((client) =>
    client.query("UPDATE outlets SET timezone = $2 WHERE id = $1", [
      seededOutletA,
      timeZone,
    ]),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; reserved_for: Date; pax: number }>(
      "SELECT status, reserved_for, pax FROM reservations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

async function requestRows(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ id: string; status: string; resolved_at: Date | null }>(
      "SELECT id, status, resolved_at FROM reservation_reschedule_requests WHERE reservation_id = $1 ORDER BY created_at",
      [reservationId],
    ),
  );
  return rows;
}

async function idempotencyClaims(idempotencyKey: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM reservation_idempotency WHERE tenant_id = $1 AND idempotency_key = $2",
      [seededTenantId, idempotencyKey],
    ),
  );
  return Number(rows[0]!.n);
}

// --- HTTP helpers -----------------------------------------------------------

async function issueLink(reservationId: string): Promise<string> {
  const response = await staff.client
    .post(
      `/api/outlets/${seededOutletA}/reservations/${reservationId}/guest-link`,
    )
    .set(originHeader)
    .send({});
  expect(response.status).toBe(201);
  return response.body.data.token as string;
}

function guestView(token: string) {
  return agent(app)
    .get(LINK_PATH)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token);
}

function guestReschedule(
  token: string,
  body: Record<string, unknown>,
  idempotencyKey = key(),
) {
  return agent(app)
    .post(`${LINK_PATH}/reschedule`)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token)
    .set("Idempotency-Key", idempotencyKey)
    .send(body);
}

/** The guest asks; returns the request id. */
async function guestRequests(
  token: string,
  requestedFor: string,
  partySize?: number,
): Promise<string> {
  const response = await guestReschedule(
    token,
    partySize === undefined ? { requestedFor } : { requestedFor, partySize },
  );
  expect([200, 201]).toContain(response.status);
  return response.body.data.request.id as string;
}

function decide(
  requestId: string,
  action: "approve" | "decline",
  body: Record<string, unknown> = {},
) {
  return staff.client
    .post(
      `/api/outlets/${seededOutletA}/reservation-reschedule-requests/${requestId}/${action}`,
    )
    .set(originHeader)
    .send(body);
}

// --- tests ------------------------------------------------------------------

describe("RSV-03 guest view carries the outlet time zone (legend-z5ygw)", () => {
  it("RSV-03 the view names Asia/Jakarta for an outlet on the default zone", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);

    const view = await guestView(token);
    expect(view.status).toBe(200);
    expect(view.body.data.timeZone).toBe("Asia/Jakarta");
  });

  it("RSV-03 the view follows the outlet zone: Asia/Makassar then Asia/Jayapura, same instant", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const before = await guestView(token);
    expect(before.status).toBe(200);
    const reservedFor = before.body.data.reservedFor as string;

    try {
      await setOutletTimeZone("Asia/Makassar");
      const makassar = await guestView(token);
      expect(makassar.status).toBe(200);
      expect(makassar.body.data.timeZone).toBe("Asia/Makassar");

      await setOutletTimeZone("Asia/Jayapura");
      const jayapura = await guestView(token);
      expect(jayapura.status).toBe(200);
      expect(jayapura.body.data.timeZone).toBe("Asia/Jayapura");

      // The zone is display context only: the instant does not move.
      expect(makassar.body.data.reservedFor).toBe(reservedFor);
      expect(jayapura.body.data.reservedFor).toBe(reservedFor);
    } finally {
      await setOutletTimeZone(originalTimeZone);
    }
  });

  it("RSV-03 the zone is also in the view returned by a reschedule request", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);

    const response = await guestReschedule(token, {
      requestedFor: targetAt(),
    });
    expect([200, 201]).toContain(response.status);
    expect(response.body.data.view.timeZone).toBe("Asia/Jakarta");
    expect(response.body.data.view.rescheduleDecision).toBeNull();
  });
});

describe("RSV-03 guest view shows the last decided reschedule request (legend-z5ygw)", () => {
  it("RSV-03 rescheduleDecision is null while no request exists and while one is pending", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);

    const none = await guestView(token);
    expect(none.status).toBe(200);
    expect(none.body.data.rescheduleDecision).toBeNull();
    expect(none.body.data.rescheduleRequest).toBeNull();

    await guestRequests(token, targetAt());
    const pending = await guestView(token);
    expect(pending.body.data.rescheduleRequest).toMatchObject({
      status: "pending",
    });
    // Pending is not a decision.
    expect(pending.body.data.rescheduleDecision).toBeNull();
  });

  it("RSV-03 after staff approve the view shows outcome approved with the asked time and party size", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const requestedFor = targetAt();
    const requestId = await guestRequests(token, requestedFor, 3);
    const oldSchedule = (await reservationRow(id)).reserved_for.toISOString();

    expect((await decide(requestId, "approve")).status).toBe(200);

    const [row] = await requestRows(id);
    expect(row!.status).toBe("approved");
    const view = await guestView(token);
    expect(view.status).toBe(200);
    // rescheduleRequest stays pending-only.
    expect(view.body.data.rescheduleRequest).toBeNull();
    expect(view.body.data.rescheduleDecision).toEqual({
      outcome: "approved",
      decidedAt: row!.resolved_at!.toISOString(),
      requestedFor,
      partySize: 3,
      // The replaced schedule, so the guest page can say it was swapped out.
      previousReservedFor: oldSchedule,
    });
    // The booking itself moved to the approved time.
    expect(view.body.data.reservedFor).toBe(requestedFor);
  });

  it("RSV-03 an approval from before previous_reserved_for existed (NULL) still parses and shows previousReservedFor null", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const requestId = await guestRequests(token, targetAt());
    expect((await decide(requestId, "approve")).status).toBe(200);
    await asOwner((client) =>
      client.query(
        "UPDATE reservation_reschedule_requests SET previous_reserved_for = NULL WHERE id = $1",
        [requestId],
      ),
    );

    const view = await guestView(token);
    expect(view.status).toBe(200);
    expect(view.body.data.rescheduleDecision).toMatchObject({
      outcome: "approved",
      previousReservedFor: null,
    });
  });

  it("RSV-03 after staff decline the view shows outcome declined, partySize null when none was asked, booking unchanged", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const before = await reservationRow(id);
    const requestedFor = targetAt();
    const requestId = await guestRequests(token, requestedFor);

    const declined = await decide(requestId, "decline", {
      reason: "Meja penuh malam itu",
    });
    expect(declined.status).toBe(200);

    const [row] = await requestRows(id);
    expect(row!.status).toBe("declined");
    const view = await guestView(token);
    expect(view.status).toBe(200);
    expect(view.body.data.rescheduleRequest).toBeNull();
    expect(view.body.data.rescheduleDecision).toEqual({
      outcome: "declined",
      decidedAt: row!.resolved_at!.toISOString(),
      requestedFor,
      partySize: null,
      previousReservedFor: null,
    });
    expect(view.body.data.reservedFor).toBe(before.reserved_for.toISOString());
    // The refusal reason is never sent to the guest (it may hold internal
    // notes; CTO decision 14 Nov), so it must not leak into the view under any key.
    expect(JSON.stringify(view.body.data)).not.toContain("Meja penuh");
  });

  it("RSV-03 with several requests the view shows the most recently decided one, and a new pending one does not hide it", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);

    const firstAt = targetAt();
    const first = await guestRequests(token, firstAt, 4);
    expect((await decide(first, "approve")).status).toBe(200);

    const secondAt = targetAt();
    const second = await guestRequests(token, secondAt);
    // A new pending ask shows as rescheduleRequest; the earlier decision stays.
    const pending = await guestView(token);
    expect(pending.body.data.rescheduleRequest).toMatchObject({
      id: second,
      status: "pending",
    });
    expect(pending.body.data.rescheduleDecision).toMatchObject({
      outcome: "approved",
      requestedFor: firstAt,
      partySize: 4,
      previousReservedFor: expect.any(String),
    });

    expect((await decide(second, "decline")).status).toBe(200);
    const view = await guestView(token);
    expect(view.body.data.rescheduleRequest).toBeNull();
    expect(view.body.data.rescheduleDecision).toMatchObject({
      outcome: "declined",
      requestedFor: secondAt,
      partySize: null,
      previousReservedFor: null,
    });
  });

  it("RSV-03 the decision is not visible through another booking's link", async () => {
    const decided = await freeBooking();
    const decidedToken = await issueLink(decided.id);
    const requestId = await guestRequests(decidedToken, targetAt());
    expect((await decide(requestId, "decline")).status).toBe(200);

    const other = await freeBooking();
    const otherToken = await issueLink(other.id);
    const view = await guestView(otherToken);
    expect(view.status).toBe(200);
    expect(view.body.data.rescheduleDecision).toBeNull();
  });
});

describe("RSV-03 a guest cannot request a reschedule inside the free window of a paid booking (legend-z5ygw)", () => {
  it("RSV-03 inside the free window the request is refused with RESERVATION_RESCHEDULE_LATE and nothing is stored", async () => {
    const { id } = await paidBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() + 3 * HOUR));
    const before = await reservationRow(id);

    const idempotencyKey = key();
    const response = await guestReschedule(
      token,
      { requestedFor: targetAt(), note: "Mohon geser" },
      idempotencyKey,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("RESERVATION_RESCHEDULE_LATE");

    // No request row, booking untouched, no pending ask in the view.
    expect(await requestRows(id)).toHaveLength(0);
    const after = await reservationRow(id);
    expect(after.status).toBe("confirmed");
    expect(after.reserved_for.getTime()).toBe(before.reserved_for.getTime());
    expect(after.pax).toBe(before.pax);
    const view = await guestView(token);
    expect(view.status).toBe(200);
    expect(view.body.data.rescheduleRequest).toBeNull();
    expect(view.body.data.rescheduleDecision).toBeNull();
    // The refusal must not leave a stored success behind.
    expect(await idempotencyClaims(idempotencyKey)).toBe(0);

    // Retrying with the same key is refused again, never replayed as success.
    const retry = await guestReschedule(
      token,
      { requestedFor: targetAt(), note: "Mohon geser" },
      idempotencyKey,
    );
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("RESERVATION_RESCHEDULE_LATE");
    expect(await requestRows(id)).toHaveLength(0);
  });

  it("RSV-03 outside the free window (more than 24h ahead) a paid booking can still request a reschedule", async () => {
    const { id } = await paidBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() + 72 * HOUR));
    const requestedFor = targetAt();

    const response = await guestReschedule(token, { requestedFor });
    expect([200, 201]).toContain(response.status);
    expect(response.body.data.request).toMatchObject({
      status: "pending",
      requestedFor,
    });
    expect(await requestRows(id)).toHaveLength(1);
    expect((await requestRows(id))[0]!.status).toBe("pending");
  });

  it("RSV-03 a booking without a DP is not guarded: it can request inside the 24h window", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() + 3 * HOUR));
    const requestedFor = targetAt();

    const response = await guestReschedule(token, { requestedFor });
    expect([200, 201]).toContain(response.status);
    expect(response.body.data.request.status).toBe("pending");
    expect(await requestRows(id)).toHaveLength(1);
  });

  it("RSV-03 an invalid time is still refused as RESERVATION_RESCHEDULE_INVALID before the window check", async () => {
    const { id } = await paidBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() + 3 * HOUR));

    const response = await guestReschedule(token, {
      requestedFor: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("RESERVATION_RESCHEDULE_INVALID");
    expect(await requestRows(id)).toHaveLength(0);
  });
});
