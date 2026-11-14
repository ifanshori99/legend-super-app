// Guest self-service via a signed reservation link (PRD v1.7 §3.22 "DP &
// Kebijakan", "Pengingat"; RSV-03 cancel follows the policy snapshot taken at
// booking; bead legend-o5gr). Real app, real middleware, PostgreSQL. Only the
// payment gateway is a test double.
//
// Assumptions (the brief fixes names, not every status code):
// - public GET view answers 200; cancel answers 200; reschedule answers 200 or 201.
// - a missing Idempotency-Key on a public write is 422, like the public booking.
// - "cancel after reservedFor refused" and "issue for a closed reservation" are
//   asserted as a 4xx with the reservation untouched, not as one exact code.
// - the "token of another tenant" case uses a tenant-A token on tenant B's host
//   (the same isolation, without building a full reservation for tenant B).
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { createLogger } from "../lib/logger";
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
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  fixtures,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
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
      providerRef: `FAKE-GL-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEGL",
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
let cashier: Staff;
let otherTenant: IsolatedTenant;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
let dayCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Link" });
  // A cashier holds neither reservation.view nor reservation.manage.
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Rsv Link Cashier",
  });
  otherTenant = await createIsolatedTenant(`rsvlink${Date.now() % 100_000}`);
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
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
  await dropIsolatedTenant(otherTenant);
  await owner.end();
});

// --- fixtures ---------------------------------------------------------------

async function setPolicy(
  requirement: "none" | "required",
  amount = 0,
  lateCancellationRefundBp = 5000,
) {
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
       VALUES ($1, $2, $3, $4, $5, 60, 24, $6, 0, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        `link-test-${requirement}-${lateCancellationRefundBp}`,
        requirement,
        amount,
        lateCancellationRefundBp,
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

const key = () => `rsv-link-${randomUUID()}`;

/** A distinct future day (March 2027) per reservation. */
function nextDate() {
  const day = 1 + (dayCounter++ % 28);
  return `2027-03-${String(day).padStart(2, "0")}`;
}

async function book(guestName = "Tamu Tautan"): Promise<ReservationCreated> {
  const zoneId = await floorZone();
  const created = await createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(nextDate(), "19:00", WIB).toISOString(),
      pax: 2,
      zoneId,
      guestName,
      contactPhone: "081234567890",
    }),
    key(),
  );
  reservationIds.push(created.reservation.id);
  return created;
}

/** Confirmed booking with the 100k DP paid through the real WS-05 path. */
async function paidBooking(lateBp = 5000) {
  await setPolicy("required", 100_000, lateBp);
  const created = await book();
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-link-pay-${created.reservation.id}`,
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
  return { created, intentId: intent.id, id: created.reservation.id };
}

/** Confirmed booking with no DP. */
async function freeBooking() {
  await setPolicy("none");
  const created = await book();
  return { created, id: created.reservation.id };
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

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      reserved_for: Date;
      refund_status: string;
    }>("SELECT * FROM reservations WHERE id = $1", [id]),
  );
  return rows[0]!;
}

async function refundRows(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ id: string; amount_idr: string }>(
      "SELECT id, amount_idr::text FROM payment_refunds WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  return rows;
}

async function linkRows(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ token_hash: string; revoked_at: Date | null }>(
      "SELECT token_hash, revoked_at FROM reservation_guest_links WHERE reservation_id = $1",
      [reservationId],
    ),
  );
  return rows;
}

async function rescheduleRows(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM reservation_reschedule_requests WHERE reservation_id = $1",
      [reservationId],
    ),
  );
  return rows;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// --- HTTP helpers -----------------------------------------------------------

const staffPath = (reservationId: string) =>
  `/api/outlets/${seededOutletA}/reservations/${reservationId}/guest-link`;

async function issueLink(reservationId: string): Promise<string> {
  const response = await staff.client
    .post(staffPath(reservationId))
    .set(originHeader)
    .send({});
  expect(response.status).toBe(201);
  return response.body.data.token as string;
}

function publicGet(
  token: string | null,
  options: { host?: string; client?: ReturnType<typeof agent> } = {},
) {
  const request = (options.client ?? agent(app))
    .get(LINK_PATH)
    .set("Host", options.host ?? seededHostname);
  return token === null
    ? request
    : request.set(RESERVATION_LINK_TOKEN_HEADER, token);
}

function publicPost(
  action: "cancel" | "reschedule",
  token: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null = key(),
  client: ReturnType<typeof agent> = agent(app),
) {
  const request = client
    .post(`${LINK_PATH}/${action}`)
    .set("Host", seededHostname)
    .set(RESERVATION_LINK_TOKEN_HEADER, token);
  return (
    idempotencyKey === null
      ? request
      : request.set("Idempotency-Key", idempotencyKey)
  ).send(body);
}

/** What a guest can tell apart in a refused link: status, code, message. */
const refusal = (response: {
  status: number;
  body: { error?: { code?: string; message?: string } };
}) => ({
  status: response.status,
  code: response.body.error?.code,
  message: response.body.error?.message,
});

const validLinkRefusal = {
  status: 404,
  code: "RESERVATION_LINK_INVALID",
  message: "Tautan reservasi tidak berlaku.",
};

// --- tests ------------------------------------------------------------------

describe("RSV-03 guest link validity (legend-o5gr)", () => {
  it("RSV-03 a valid token shows the booking, with no-store caching", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await publicGet(token);
    expect(response.status).toBe(200);
    expect(response.body.data.reservationId).toBe(id);
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("RSV-03 bad format, unknown, expired, revoked, missing and cross-tenant tokens all get the same 404", async () => {
    const { id } = await freeBooking();
    const good = await issueLink(id);
    expect((await publicGet(good)).status).toBe(200);

    const expired = await freeBooking();
    const expiredToken = await issueLink(expired.id);
    await asOwner((client) =>
      client.query(
        "UPDATE reservation_guest_links SET expires_at = now() - interval '1 hour' WHERE reservation_id = $1",
        [expired.id],
      ),
    );

    const revoked = await freeBooking();
    const revokedToken = await issueLink(revoked.id);
    const revoke = await staff.client
      .delete(staffPath(revoked.id))
      .set(originHeader);
    expect(revoke.status).toBe(204);

    const responses = [
      await publicGet("too-short"),
      await publicGet(`${"a".repeat(42)}!`),
      await publicGet(randomBytes(32).toString("base64url")),
      await publicGet(expiredToken),
      await publicGet(revokedToken),
      await publicGet(null),
      // A real, active token on another tenant's host.
      await publicGet(good, { host: otherTenant.hostname }),
    ];
    for (const response of responses)
      expect(refusal(response)).toEqual(validLinkRefusal);
    // Identical down to the whole error body, ignoring the per-request id:
    // nothing hints at the reason.
    const bodies = new Set(
      responses.map((r) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(r.body.error as Record<string, unknown>).filter(
              ([name]) => name !== "requestId" && name !== "reqId",
            ),
          ),
        ),
      ),
    );
    expect(bodies.size).toBe(1);
  });

  it("RSV-03 the token is in the header only: it is not accepted in the URL", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const asQuery = await agent(app)
      .get(`${LINK_PATH}?token=${token}`)
      .set("Host", seededHostname);
    expect(refusal(asQuery)).toEqual(validLinkRefusal);
    const asPath = await agent(app)
      .get(`${LINK_PATH}/${token}`)
      .set("Host", seededHostname);
    expect(asPath.status).toBe(404);
    expect(asPath.body.data).toBeUndefined();
  });
});

describe("RSV-03 guest view", () => {
  it("RSV-03 shows the snapshot policy and the cancel preview, and no contact data", async () => {
    const { id, created } = await paidBooking();
    const token = await issueLink(id);
    const response = await publicGet(token);
    expect(response.status).toBe(200);
    const view = response.body.data;
    expect(view.status).toBe("confirmed");
    expect(view.outletName).toBe(fixtures.outlets[0].name);
    expect(view.partySize).toBe(2);
    expect(view.policy).toMatchObject({
      freeCancellationHours: 24,
      lateCancellationRefundBp: 5000,
      depositAmountIdr: 100_000,
    });
    expect(view.deposit).toMatchObject({
      amountIdr: 100_000,
      paidIdr: 100_000,
    });
    expect(view.cancellation.allowed).toBe(true);
    expect(view.cancellation.preview).toMatchObject({ refundIdr: 100_000 });
    expect(new Date(view.cancellation.freeUntil).getTime()).toBe(
      new Date(view.reservedFor).getTime() - 24 * HOUR,
    );
    expect(view.rescheduleRequest).toBeNull();
    expect(view.rescheduleDecision).toBeNull();
    expect(view.timeZone).toBe("Asia/Jakarta");
    expect(new Date(view.linkExpiresAt).getTime()).toBe(
      new Date(view.reservedFor).getTime() + 24 * HOUR,
    );

    // The guest holds the link, not the staff file: nothing personal or internal.
    const text = JSON.stringify(response.body);
    expect(text).not.toContain("081234567890");
    for (const field of ["contactPhone", "contactEmail", "tableIds", "tables"])
      expect(view).not.toHaveProperty(field);
    expect(text).not.toContain(created.reservation.tableIds[0]);
  });
});

describe("RSV-03 guest cancel follows the policy snapshot", () => {
  it("RSV-03 cancelling before the free window refunds in full with exactly one refund request, and replays add none", async () => {
    const { id, intentId } = await paidBooking();
    const token = await issueLink(id);

    // The public write needs an Idempotency-Key.
    const missingKey = await publicPost("cancel", token, {}, null);
    expect(missingKey.status).toBe(422);
    expect((await reservationRow(id)).status).toBe("confirmed");

    const firstKey = key();
    const first = await publicPost(
      "cancel",
      token,
      { reason: "Ganti rencana" },
      firstKey,
    );
    expect(first.status).toBe(200);
    expect(first.body.data.alreadyCancelled).toBe(false);
    expect(first.body.data.view.status).toBe("cancelled");
    expect(first.body.data.depositOutcome).toMatchObject({
      refundIdr: 100_000,
    });
    expect((await reservationRow(id)).status).toBe("cancelled");
    const rows = await refundRows(intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe("100000");

    // Same key replayed: the stored answer, no second refund.
    const replay = await publicPost(
      "cancel",
      token,
      { reason: "Ganti rencana" },
      firstKey,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await refundRows(intentId)).toHaveLength(1);

    // A new key: idempotent too, flagged as already cancelled.
    const second = await publicPost("cancel", token, {});
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyCancelled).toBe(true);
    expect(second.body.data.view.status).toBe("cancelled");
    expect(second.body.data.depositOutcome).toMatchObject({
      refundIdr: 100_000,
    });
    expect(await refundRows(intentId)).toHaveLength(1);

    // The link still opens for viewing, but nothing can be cancelled again.
    const view = await publicGet(token);
    expect(view.status).toBe(200);
    expect(view.body.data.status).toBe("cancelled");
    expect(view.body.data.cancellation.allowed).toBe(false);
    expect(view.body.data.cancellation.preview).toBeNull();
  });

  it("RSV-03 a late cancel uses the snapshot refund share even after the live outlet policy changed", async () => {
    const { id, intentId } = await paidBooking(5000);
    const token = await issueLink(id);
    // Inside the 24h free window (but still before the booking).
    await moveReservedFor(id, new Date(Date.now() + 3 * HOUR));
    // The outlet now refunds nothing on a late cancel; the booking must not care.
    await setPolicy("required", 100_000, 0);

    const view = await publicGet(token);
    expect(view.body.data.policy.lateCancellationRefundBp).toBe(5000);
    expect(view.body.data.cancellation.preview).toMatchObject({
      refundIdr: 50_000,
      forfeitedIdr: 50_000,
    });

    const cancelled = await publicPost("cancel", token, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.depositOutcome).toMatchObject({
      refundIdr: 50_000,
      forfeitedIdr: 50_000,
    });
    const rows = await refundRows(intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe("50000");
  });

  it("RSV-03 a booking without a DP cancels with nothing to refund", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const response = await publicPost("cancel", token, {});
    expect(response.status).toBe(200);
    expect(response.body.data.view.status).toBe("cancelled");
    expect(response.body.data.depositOutcome.refundIdr).toBe(0);
    expect((await reservationRow(id)).status).toBe("cancelled");
  });

  it("RSV-03 cancelling after the booking time is refused and changes nothing", async () => {
    const { id, intentId } = await paidBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() - HOUR));

    const view = await publicGet(token);
    expect(view.status).toBe(200);
    expect(view.body.data.cancellation.allowed).toBe(false);
    expect(view.body.data.cancellation.preview).toBeNull();

    const response = await publicPost("cancel", token, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect((await reservationRow(id)).status).toBe("confirmed");
    expect(await refundRows(intentId)).toHaveLength(0);
  });

  it("RSV-03 a booking without a DP past its time cannot be cancelled by the guest", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    await moveReservedFor(id, new Date(Date.now() - HOUR));

    const response = await publicPost("cancel", token, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.body.error.code).toBe("RESERVATION_TRANSITION_INVALID");
    expect((await reservationRow(id)).status).toBe("confirmed");
  });

  it("RSV-03 a body with unknown fields (tenant, refund amount) is refused", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const response = await publicPost("cancel", token, {
      refundIdr: 999_999,
      tenantId: randomUUID(),
    });
    expect(response.status).toBe(422);
    expect((await reservationRow(id)).status).toBe("confirmed");
  });
});

describe("RSV-03 guest reschedule request", () => {
  it("RSV-03 a request is recorded as pending and the booking is untouched; a second pending is a 409", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const before = await reservationRow(id);
    const requestedFor = new Date(Date.now() + 40 * 24 * HOUR).toISOString();

    // A time in the past cannot be requested.
    const past = await publicPost("reschedule", token, {
      requestedFor: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe("RESERVATION_RESCHEDULE_INVALID");
    expect(await rescheduleRows(id)).toHaveLength(0);

    const first = await publicPost("reschedule", token, {
      requestedFor,
      partySize: 3,
      note: "Mohon geser ke malam",
    });
    expect([200, 201]).toContain(first.status);
    expect(first.body.data.request).toMatchObject({
      status: "pending",
      partySize: 3,
      note: "Mohon geser ke malam",
    });
    expect(first.body.data.request.requestedFor).toBe(requestedFor);
    expect(await rescheduleRows(id)).toEqual([{ status: "pending" }]);

    // Staff approves later: until then the booking keeps its time and status.
    const after = await reservationRow(id);
    expect(after.status).toBe(before.status);
    expect(after.reserved_for.getTime()).toBe(before.reserved_for.getTime());
    const view = await publicGet(token);
    expect(view.body.data.reservedFor).toBe(before.reserved_for.toISOString());
    expect(view.body.data.rescheduleRequest).toMatchObject({
      status: "pending",
    });
    expect(view.body.data.rescheduleDecision).toBeNull();

    const second = await publicPost("reschedule", token, { requestedFor });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("RESERVATION_RESCHEDULE_PENDING");
    expect(await rescheduleRows(id)).toHaveLength(1);

    // Staff with reservation.view see it; staff without do not.
    const listed = await staff.client.get(
      `/api/outlets/${seededOutletA}/reservation-reschedule-requests`,
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.some(
        (item: { reservationId: string; status: string }) =>
          item.reservationId === id && item.status === "pending",
      ),
    ).toBe(true);
    const denied = await cashier.client.get(
      `/api/outlets/${seededOutletA}/reservation-reschedule-requests`,
    );
    expect(denied.status).toBe(403);
  });

  it("RSV-03 a cancelled booking cannot ask for a new time", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    expect((await publicPost("cancel", token, {})).status).toBe(200);
    const response = await publicPost("reschedule", token, {
      requestedFor: new Date(Date.now() + 40 * 24 * HOUR).toISOString(),
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("RESERVATION_RESCHEDULE_INVALID");
    expect(await rescheduleRows(id)).toHaveLength(0);
  });
});

describe("RSV-03 staff issue and revoke the guest link", () => {
  it("RSV-03 issuing needs reservation.manage and a session", async () => {
    const { id } = await freeBooking();
    const anonymous = await agent(app)
      .post(staffPath(id))
      .set(originHeader)
      .send({});
    expect(anonymous.status).toBe(401);
    const denied = await cashier.client
      .post(staffPath(id))
      .set(originHeader)
      .send({});
    expect(denied.status).toBe(403);
    const deniedRevoke = await cashier.client
      .delete(staffPath(id))
      .set(originHeader);
    expect(deniedRevoke.status).toBe(403);
    expect(await linkRows(id)).toHaveLength(0);
  });

  it("RSV-03 issuing again revokes the previous token; only the hash is stored", async () => {
    const { id } = await freeBooking();
    const first = await issueLink(id);
    const second = await issueLink(id);
    expect(second).not.toBe(first);
    expect(refusal(await publicGet(first))).toEqual(validLinkRefusal);
    expect((await publicGet(second)).status).toBe(200);

    const rows = await linkRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    const hashes = rows.map((row) => row.token_hash).sort();
    expect(hashes).toEqual([sha256(first), sha256(second)].sort());
    expect(hashes).not.toContain(first);
    expect(hashes).not.toContain(second);
  });

  it("RSV-03 the link expires 24 hours after the booking time", async () => {
    const { id } = await freeBooking();
    const response = await staff.client
      .post(staffPath(id))
      .set(originHeader)
      .send({});
    expect(response.status).toBe(201);
    const { reserved_for } = await reservationRow(id);
    expect(new Date(response.body.data.expiresAt).getTime()).toBe(
      reserved_for.getTime() + 24 * HOUR,
    );
  });

  it("RSV-03 revoking is idempotent and kills the link; a closed booking gets no new link", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    for (let i = 0; i < 2; i += 1) {
      const revoke = await staff.client.delete(staffPath(id)).set(originHeader);
      expect(revoke.status).toBe(204);
    }
    expect(refusal(await publicGet(token))).toEqual(validLinkRefusal);

    const closed = await freeBooking();
    const closedToken = await issueLink(closed.id);
    expect((await publicPost("cancel", closedToken, {})).status).toBe(200);
    const refused = await staff.client
      .post(staffPath(closed.id))
      .set(originHeader)
      .send({});
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });
});

describe("RSV-03 public link hardening", () => {
  it("RSV-03 the public link is rate limited with Retry-After", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const limited = createApp({
      publicRateLimit: { perIp: 1, internalIps: [] },
    });
    const read = () => publicGet(token, { client: agent(limited) });
    expect((await read()).status).toBe(200);
    const blocked = await read();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("RSV-03 neither the token nor its hash ever reaches the logs, on success or on error paths", async () => {
    const lines: string[] = [];
    const logged = createApp({
      logger: createLogger({
        level: "trace",
        destination: { write: (chunk: string) => void lines.push(chunk) },
      }),
    });
    const client = () => agent(logged);

    const { id } = await paidBooking();
    const token = await issueLink(id);
    const unknown = randomBytes(32).toString("base64url");
    const secrets = [token, sha256(token), unknown, sha256(unknown)];

    expect((await publicGet(token, { client: client() })).status).toBe(200);
    expect((await publicGet(unknown, { client: client() })).status).toBe(404);
    expect((await publicGet("short", { client: client() })).status).toBe(404);
    const cancelKey = key();
    expect(
      (await publicPost("cancel", token, {}, cancelKey, client())).status,
    ).toBe(200);
    expect(
      (await publicPost("cancel", token, {}, key(), client())).status,
    ).toBe(200);
    // Error paths: an invalid body, a refused reschedule, an unknown token write.
    expect(
      (await publicPost("cancel", token, { bogus: 1 }, key(), client())).status,
    ).toBe(422);
    expect(
      (
        await publicPost(
          "reschedule",
          token,
          { requestedFor: new Date(Date.now() + 40 * 24 * HOUR).toISOString() },
          key(),
          client(),
        )
      ).status,
    ).toBe(422);
    expect(
      (await publicPost("cancel", unknown, {}, key(), client())).status,
    ).toBe(404);

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

describe("RSV-03 review fixes: abuse limits and races", () => {
  it("RSV-03 a flood of junk tokens from many IPs does not lock out a valid guest", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const flooded = createApp();
    // Behind one proxy hop the client address is the first X-Forwarded-For.
    flooded.set("trust proxy", 1);
    const junk = Array.from({ length: 150 }, (_, index) =>
      agent(flooded)
        .post(`${LINK_PATH}/cancel`)
        .set("Host", seededHostname)
        .set("X-Forwarded-For", `198.51.100.${(index % 250) + 1}`)
        .set("Idempotency-Key", key())
        .set(
          RESERVATION_LINK_TOKEN_HEADER,
          randomBytes(32).toString("base64url"),
        )
        .send({}),
    );
    const results = await Promise.all(junk);
    // Junk stays a plain 404 (or a limit on the junk sender), never a 5xx.
    for (const result of results) expect([404, 429]).toContain(result.status);

    const guest = await agent(flooded)
      .post(`${LINK_PATH}/cancel`)
      .set("Host", seededHostname)
      .set("X-Forwarded-For", "203.0.113.77")
      .set("Idempotency-Key", key())
      .set(RESERVATION_LINK_TOKEN_HEADER, token)
      .send({});
    expect(guest.status).toBe(200);
    expect(guest.body.data.view.status).toBe("cancelled");
  });

  it("RSV-03 one link accepts 10 writes a minute; the 11th is a 429 with Retry-After", async () => {
    // Assumption: every public write on a valid link counts, repeats included.
    const { id } = await freeBooking();
    const token = await issueLink(id);
    for (let i = 0; i < 10; i += 1) {
      const response = await publicPost("cancel", token, {});
      expect(response.status).toBe(200);
    }
    const limited = await publicPost("cancel", token, {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another guest's link is not affected.
    const other = await freeBooking();
    const otherToken = await issueLink(other.id);
    expect((await publicPost("cancel", otherToken, {})).status).toBe(200);
  });

  it("RSV-03 two staff issuing at once leave exactly one active link, no 500, and no secret in the logs", async () => {
    const lines: string[] = [];
    const logged = createApp({
      logger: createLogger({
        level: "trace",
        destination: { write: (chunk: string) => void lines.push(chunk) },
      }),
    });
    const loggedStaff = await staffWithRole(logged, {
      template: "owner",
      label: "Rsv Link Race",
    });
    const { id } = await freeBooking();
    const issue = () =>
      loggedStaff.client.post(staffPath(id)).set(originHeader).send({});
    const responses = await Promise.all([issue(), issue()]);
    for (const response of responses) {
      expect(response.status).toBeLessThan(500);
      expect([201, 409]).toContain(response.status);
    }
    const issued = responses.filter((response) => response.status === 201);
    expect(issued.length).toBeGreaterThanOrEqual(1);

    const rows = await linkRows(id);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    // The surviving token opens the booking; every revoked one is refused.
    const tokens = issued.map((response) => response.body.data.token as string);
    const working = [];
    for (const token of tokens)
      if ((await publicGet(token)).status === 200) working.push(token);
    expect(working).toHaveLength(1);

    const output = lines.join("\n");
    for (const token of tokens) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(sha256(token));
    }
  });

  it("RSV-03 a reschedule more than 180 days ahead is refused", async () => {
    const { id } = await freeBooking();
    const token = await issueLink(id);
    const tooFar = await publicPost("reschedule", token, {
      requestedFor: new Date(Date.now() + 181 * 24 * HOUR).toISOString(),
    });
    expect(tooFar.status).toBe(422);
    expect(tooFar.body.error.code).toBe("RESERVATION_RESCHEDULE_INVALID");
    expect(await rescheduleRows(id)).toHaveLength(0);
    const near = await publicPost("reschedule", token, {
      requestedFor: new Date(Date.now() + 170 * 24 * HOUR).toISOString(),
    });
    expect([200, 201]).toContain(near.status);
    expect(await rescheduleRows(id)).toEqual([{ status: "pending" }]);
  });

  it("RSV-03 no link is issued for a booking more than 24 hours past its time", async () => {
    const stale = await freeBooking();
    await moveReservedFor(stale.id, new Date(Date.now() - 25 * HOUR));
    const refused = await staff.client
      .post(staffPath(stale.id))
      .set(originHeader)
      .send({});
    expect(refused.status).toBe(409);
    expect(await linkRows(stale.id)).toHaveLength(0);

    // Assumption: inside the 24h grace after the booking time a link is still fine.
    const recent = await freeBooking();
    await moveReservedFor(recent.id, new Date(Date.now() - 2 * HOUR));
    const ok = await staff.client
      .post(staffPath(recent.id))
      .set(originHeader)
      .send({});
    expect(ok.status).toBe(201);
  });
});
