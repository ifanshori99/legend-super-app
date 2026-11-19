// legend-m0kqn: a provider-backed DP code that never becomes final must not
// hold a booking forever. Against PostgreSQL with the real booking, deposit
// port, deposit sweep and payment confirmation; only the gateway is a double.
//
// Rules under test (CTO decision, sub-brief legend-m0kqn):
//  1. A pending_deposit booking whose DP code has a provider reference and no
//     provider final answer is cancelled once the cap
//     `payableUntil + GATEWAY_POLL_WINDOW_MS` has passed (reason
//     deposit_not_paid, hold released, audit row marked providerUnanswered).
//     One minute before the cap the booking stays open (rule A of legend-pdi5u).
//  2. A payment confirmed after that cancellation settles the intent (late
//     payment, like RSV-02) but is not credited to the booking: it stays
//     cancelled and the DP is refunded in full, once (late_refund_requested;
//     a redelivery is unchanged).
//  3. The deposit sweep skips still-pending provider-backed rows in SQL, so a
//     batch of 150 of them (LIMIT 100) cannot starve a normally due booking.
//
// Assumptions (spec silent): payableUntil is the booking's DP link limit, i.e.
// creation time + the policy payment window (60 min here); the audit row is in
// audit_logs with event->>'action' = 'reservation.cancelled' and the flag
// providerUnanswered = true inside event.maskedChanges.before or .after.
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
import { createReservationInputSchema } from "@starter/shared/reservation";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  createIntent,
  GATEWAY_POLL_WINDOW_MS,
} from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import {
  RESERVATION_SYSTEM_ACTOR,
  createPaymentReservationDepositPort,
} from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { sweepStaleDepositHolds } from "../services/reservation-sweeps.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
const WIB = "Asia/Jakarta";
const MINUTE = 60_000;
const DP_IDR = 100_000;
const WINDOW_MIN = 60;
const outletA = outletIdSchema.parse(seededOutletA);
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
/** Provider double: one code (with a provider reference) per idempotency key. */
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
      providerRef: `FAKE-DP-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEDP",
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
const zoneIds: string[] = [];
const tableIds: string[] = [];

async function setPolicy() {
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
       VALUES ($1, $2, 'm0kqn-cap', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA, DP_IDR, WINDOW_MIN],
    );
  });
}

async function floor() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  return zone.id as string;
}

const dayAt = (date: string, time: string) => zonedInstant(date, time, WIB);
const key = () => `rsv-m0kqn-${randomUUID()}`;

/** A DP booking in `zoneId` (window 60 min) created at `createdAt`. */
async function bookIn(zoneId: string, date: string, createdAt: Date) {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Batas m0kqn",
      contactPhone: "081234567890",
    }),
    key(),
    createdAt,
  );
}
type Booked = Awaited<ReturnType<typeof bookIn>>;

async function book(date: string, createdAt: Date) {
  return bookIn(await floor(), date, createdAt);
}

/** The guest opens the hosted page and a QRIS code is created on the DP link. */
async function openIntent(created: Booked): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-m0kqn-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** The code reached the provider (has a reference) and has no final answer. */
async function shapeUnanswered(intentId: string, expiresAt: Date) {
  await asOwner((client) =>
    client.query(
      `UPDATE payment_intents
          SET status = 'pending', expires_at = $2,
              provider_ref = $3, provider_final_at = NULL
        WHERE id = $1`,
      [intentId, expiresAt, `PROV-${intentId}`],
    ),
  );
}

/** Reconcile at `now` (the deposit sweep reconciles pending_deposit rows). */
async function sweepAt(now: Date, limit?: number) {
  return withTenant(db, tenantScope(), (tx) =>
    sweepStaleDepositHolds(tx, tenantScope(), now, {
      outletId: outletA,
      ...(limit ? { limit } : {}),
    }),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      close_reason: string | null;
      deposit_payment_id: string | null;
      deposit_payment_link_id: string | null;
      refund_status: string | null;
      refund_payment_refund_id: string | null;
    }>("SELECT * FROM reservations WHERE id = $1", [id]),
  );
  return rows[0]!;
}

async function liveHolds(reservationId: string): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows.length;
}

/** What is still owed on the DP link, in rupiah. */
async function linkOutstanding(linkId: string): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query<{ outstanding: string }>(
      "SELECT (total_idr - paid_idr)::text AS outstanding FROM payment_links WHERE id = $1",
      [linkId],
    ),
  );
  return Number(rows[0]!.outstanding);
}

/** WS-05 refund requests written for one DP intent. */
async function depositRefundRows(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      id: string;
      amount_idr: string;
      requested_by: string;
      status: string;
    }>(
      "SELECT id, amount_idr::text, requested_by, status FROM payment_refunds WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  return rows;
}

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return rows[0]!.status;
}

/** The provider confirms the payment at `at`; service clock and receipt are `at`. */
function confirmAt(intentId: string, at: Date) {
  return confirmPayment(
    tenantScope(),
    intentId,
    {
      source: "verified_webhook",
      method: "qris",
      amountIdr: DP_IDR,
      providerRef: `PAID-${intentId}`,
      at: at.toISOString(),
      receivedAt: at,
    },
    { type: "system" },
    at,
  );
}

/** The single payment.paid event of the intent (the consumer's input). */
async function paymentPaidEvent(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intentId],
    ),
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** Audit rows of the cancellation that carry the providerUnanswered flag. */
async function unansweredCancelAudits(reservationId: string): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'reservation.cancelled'
          AND (event->'maskedChanges'->'before'->>'providerUnanswered' = 'true'
            OR event->'maskedChanges'->'after'->>'providerUnanswered' = 'true')`,
      [seededTenantId, reservationId],
    ),
  );
  return rows.length;
}

/** The cap after which an unanswered provider code no longer holds a booking. */
const capOf = (t0: Date) =>
  new Date(t0.getTime() + WINDOW_MIN * MINUTE + GATEWAY_POLL_WINDOW_MS);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv m0kqn" });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
  await setPolicy();
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

describe("legend-m0kqn 1 an unanswered provider code is capped", () => {
  it("legend-m0kqn booking stays open one minute before the cap and is cancelled one minute after", async () => {
    const t0 = dayAt("2027-01-05", "10:00");
    const created = await book("2027-08-01", t0);
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await shapeUnanswered(intentId, new Date(t0.getTime() + 30 * MINUTE));
    const cap = capOf(t0);

    // Just before the cap: the provider may still take money.
    const early = await sweepAt(new Date(cap.getTime() - MINUTE));
    expect(early.released).not.toContain(id);
    let row = await reservationRow(id);
    expect(row.status).toBe("pending_deposit");
    expect(row.close_reason).toBeNull();
    expect(await liveHolds(id)).toBe(1);
    expect(await unansweredCancelAudits(id)).toBe(0);

    // Just after the cap: closed, hold released, audit marks the cause.
    const late = await sweepAt(new Date(cap.getTime() + MINUTE));
    expect(late.released).toContain(id);
    row = await reservationRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.close_reason).toBe("deposit_not_paid");
    expect(await liveHolds(id)).toBe(0);
    expect(await unansweredCancelAudits(id)).toBe(1);
  });
});

describe("legend-m0kqn 2 a payment after the cap cancellation is refunded in full", () => {
  // Mirrors RSV-02 (reservation-deposit-db.test.ts): the booking is cancelled
  // at the cap first; a code paid after that settles (the guest did pay), the
  // booking is NOT confirmed, and the DP goes back in full, exactly once.
  it("legend-m0kqn paying the code after the cancellation settles it, keeps the booking cancelled and refunds the DP once", async () => {
    const t0 = dayAt("2027-01-06", "10:00");
    const created = await book("2027-08-02", t0);
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await shapeUnanswered(intentId, new Date(t0.getTime() + 30 * MINUTE));
    const cancelAt = new Date(capOf(t0).getTime() + MINUTE);

    await sweepAt(cancelAt);
    expect((await reservationRow(id)).status).toBe("cancelled");

    // The provider confirms the payment later: it resolves (no BILL_CLOSED).
    await expect(
      confirmAt(intentId, new Date(cancelAt.getTime() + MINUTE)),
    ).resolves.not.toThrow();
    expect(await intentStatus(intentId)).toBe("paid");

    const event = await paymentPaidEvent(intentId);
    expect(await handlePaymentPaid(tenantScope(), event)).toBe(
      "late_refund_requested",
    );
    const row = await reservationRow(id);
    expect(row).toMatchObject({
      status: "cancelled",
      refund_status: "requested",
    });
    expect(await liveHolds(id)).toBe(0);
    const refunds = await depositRefundRows(intentId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: String(DP_IDR),
      requested_by: RESERVATION_SYSTEM_ACTOR,
    });
    expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);

    // A redelivered payment asks for no second refund.
    expect(await handlePaymentPaid(tenantScope(), event)).toBe("unchanged");
    expect(await depositRefundRows(intentId)).toHaveLength(1);
  });
});

describe("legend-m0kqn 3 pending provider rows do not starve the sweep", () => {
  it("legend-m0kqn 150 still-pending provider-backed bookings do not block a normally due booking", async () => {
    const t0 = dayAt("2027-01-10", "10:00");
    const zoneId = await floor();
    const pendingIds: string[] = [];
    const linkIds: string[] = [];
    const intentIds: string[] = [];
    // One table, one reservation per day (150 distinct days).
    for (let i = 0; i < 150; i += 1) {
      const date = new Date(Date.UTC(2027, 2, 1 + i))
        .toISOString()
        .slice(0, 10);
      const created = await bookIn(zoneId, date, t0);
      pendingIds.push(created.reservation.id);
      linkIds.push(created.deposit!.paymentLinkId);
      intentIds.push(await openIntent(created));
    }
    await asOwner((client) =>
      client.query(
        `UPDATE payment_intents
            SET status = 'pending', expires_at = $2,
                provider_ref = 'PROV-' || id::text, provider_final_at = NULL
          WHERE id = ANY($1::uuid[])`,
        [intentIds, new Date(t0.getTime() + 30 * MINUTE)],
      ),
    );

    // Newer booking, no provider code: normally due 60 minutes after creation.
    const newer = await bookIn(
      zoneId,
      "2027-09-01",
      new Date(t0.getTime() + 10 * MINUTE),
    );
    const newerId = newer.reservation.id;

    // All 150 are past their link limit but far from the cap.
    const swept = await sweepAt(new Date(t0.getTime() + 75 * MINUTE));
    expect(swept.released).toContain(newerId);
    expect((await reservationRow(newerId)).status).toBe("cancelled");
    expect(await liveHolds(newerId)).toBe(0);

    const { rows } = await asOwner((client) =>
      client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM reservations WHERE id = ANY($1::uuid[]) AND status = 'pending_deposit'",
        [pendingIds],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(150);
    expect(linkIds).toHaveLength(150);
  }, 300_000);
});

describe("legend-m0kqn 4 a paid DP is confirmed even while another code is still pollable", () => {
  // P3: the sweep must not skip a row whose DP is already paid. The SQL filter
  // that leaves still-pending provider-backed rows alone (rule 3) must only
  // apply when nothing was paid: here code B settled the DP link, while code A
  // on the same link is still pending at the provider (reference set, no final
  // answer). The booking is past payableUntil but far before the cap, and the
  // consumer has not run yet (worker behind), so the sweep has to confirm it.
  // Assumption (spec silent): "paid" is reached through the real
  // confirmPayment path (not a raw status UPDATE) so link and reservation
  // stay consistent for reconcileDeposit.
  it("legend-m0kqn a booking with a paid code and a pollable code is confirmed by the sweep, not skipped or cancelled", async () => {
    const t0 = dayAt("2027-01-11", "10:00");
    const created = await book("2027-08-03", t0);
    const id = created.reservation.id;
    const token = created.deposit!.paymentPath.slice("/bayar/".length);

    // Code A (the pollable one) and a second code B on the same DP link.
    const pollableId = await openIntent(created);
    const paidIntent = await createIntent(
      tenantScope(),
      token,
      createPaymentIntentInputSchema.parse({
        method: "qris",
        channelCode: null,
        idempotencyKey: `rsv-m0kqn-pay-b-${id}`,
      }),
    );
    expect(paidIntent.id).not.toBe(pollableId);

    // Code B is paid inside the payment window; the link is now fully paid.
    // Intents are created on the real clock; without this the 2027
    // confirmation would count as past the code's own expiry (flag
    // late_payment) and not as settled.
    await asOwner((client) =>
      client.query("UPDATE payment_intents SET expires_at = $2 WHERE id = $1", [
        paidIntent.id,
        new Date(t0.getTime() + 30 * MINUTE),
      ]),
    );
    await confirmAt(paidIntent.id, new Date(t0.getTime() + 10 * MINUTE));
    expect(await linkOutstanding(created.deposit!.paymentLinkId)).toBe(0);

    // Code A is still unanswered by the provider (reference set, not final).
    await shapeUnanswered(pollableId, new Date(t0.getTime() + 30 * MINUTE));
    expect((await reservationRow(id)).status).toBe("pending_deposit");

    // Past payableUntil (60 min), far before the cap. Earlier tests in this
    // file leave 150+ bookings that are legitimately past their cap at this
    // clock; they fill the default LIMIT 100 batch (oldest first), so this
    // test lifts the limit to prove the paid row is not skipped by the SQL
    // prefilter.
    const swept = await sweepAt(new Date(t0.getTime() + 75 * MINUTE), 1000);
    expect(swept.confirmed).toContain(id);
    expect(swept.released).not.toContain(id);
    const row = await reservationRow(id);
    expect(row.status).toBe("confirmed");
    expect(row.close_reason).toBeNull();
    expect(await liveHolds(id)).toBe(1);
    expect(await unansweredCancelAudits(id)).toBe(0);
  });
});
