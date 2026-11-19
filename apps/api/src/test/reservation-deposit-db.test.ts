// Reservation DP through WS-05 as built, against PostgreSQL (PRD v1.7 §3.22
// "DP & Kebijakan", §3.13; RSV-01 holds never outlive an unpaid DP, RSV-02 the
// DP is a bill link confirmed by `payment.paid`, RSV-03 refunds are WS-05
// refund requests; bead legend-t8bz). Real services and the real WS-05 adapter
// (bill link → hosted-page intent → verified confirmation); only the gateway is
// a test double, and like the provider it returns one code per idempotency key.
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
import { listRefunds as listRefundsContract } from "@starter/shared/payment/admin";
import {
  cancelReservationInputSchema,
  createReservationInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { listRefunds } from "../services/payment-admin.service.ts";
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import {
  RESERVATION_SYSTEM_ACTOR,
  createPaymentReservationDepositPort,
} from "../services/reservation-deposit-payment.ts";
import {
  cancelReservation,
  listReservations,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import {
  REFUND_MAX_ATTEMPTS,
  requestDepositRefund,
  retryPendingRefunds,
} from "../services/reservation-refunds.ts";
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

/** Provider double: one code per idempotency key; health is switchable. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  healthValue: "available" | "degraded" | "down" = "available";
  readonly calls: string[] = [];
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: this.healthValue };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    this.calls.push(input.idempotencyKey);
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
let gateway: FakeGateway;
const zoneIds: string[] = [];
const tableIds: string[] = [];

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
        `dp-test-${requirement}`,
        requirement,
        amount,
      ],
    );
  });
}

async function floor(count: number) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    ids.push(table.id);
  }
  return { zoneId: zone.id as string, tableIds: ids };
}

const dayAt = (date: string, time: string) => zonedInstant(date, time, WIB);
const key = () => `rsv-dp-${randomUUID()}`;

function booking(zoneId: string, date: string, guestName = "Tamu DP") {
  return createReservationInputSchema.parse({
    reservedFor: dayAt(date, "19:00").toISOString(),
    pax: 2,
    zoneId,
    guestName,
    contactPhone: "081234567890",
  });
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      close_reason: string | null;
      deposit_payment_id: string | null;
      deposit_payment_link_id: string | null;
      refund_status: string;
      refund_payment_refund_id: string | null;
      refund_attempts: number;
      refund_next_attempt_at: Date | null;
    }>("SELECT * FROM reservations WHERE id = $1", [id]),
  );
  return rows[0]!;
}

async function liveHolds(reservationId: string): Promise<string[]> {
  const { rows } = await asOwner((client) =>
    client.query<{ table_id: string }>(
      "SELECT table_id FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows.map((row) => row.table_id);
}

async function eventCount(reservationId: string, name: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM domain_event_outbox WHERE aggregate_id = $1 AND event->>'name' = $2",
      [reservationId, name],
    ),
  );
  return rows.length;
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

/** The guest opens the hosted page and creates a QRIS code (no payment yet). */
async function openIntent(created: ReservationCreated): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-dp-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** legend-pdi5u: the provider answered final for the code (expired, no money),
 * so only then may the booking drop the DP; local time alone is not proof. */
async function providerFinal(intentId: string) {
  await asOwner((client) =>
    client.query(
      "UPDATE payment_intents SET provider_final_at = now() WHERE id = $1",
      [intentId],
    ),
  );
}

/** Verified webhook settles the code (WS-05 appends `payment.paid`). */
async function settle(intentId: string, amountIdr: number) {
  await confirmPayment(tenantScope(), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `PAID-${intentId}`,
    at: new Date().toISOString(),
  });
}

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

/** A booking left half-done (crash before the DP link was attached). */
async function insertUnattachedHold(input: {
  zoneId: string;
  tableId: string;
  reservedFor: Date;
  createdAt: Date;
}): Promise<string> {
  const snapshot = {
    version: "dp-test-required",
    depositRequirement: "required",
    depositAmountIdr: 100_000,
    paymentWindowMinutes: 60,
    freeCancellationHours: 24,
    lateCancellationRefundBp: 5000,
    noShowRefundBp: 0,
    minimumSpendIdr: 0,
    capturedAt: input.createdAt.toISOString(),
  };
  return asOwner(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reservations
         (tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax, zone_id, deposit_idr,
          policy_snapshot, status, source, created_at, updated_at)
       VALUES ($1, $2, 'Setengah Jadi', $3, 90, 2, $4, 100000, $5, 'pending_deposit', 'website', $6, $6)
       RETURNING id`,
      [
        seededTenantId,
        seededOutletA,
        input.reservedFor,
        input.zoneId,
        JSON.stringify(snapshot),
        input.createdAt,
      ],
    );
    const id = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO reservation_tables (tenant_id, outlet_id, reservation_id, table_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        seededTenantId,
        seededOutletA,
        id,
        input.tableId,
        input.reservedFor,
        new Date(input.reservedFor.getTime() + 90 * MINUTE),
      ],
    );
    return id;
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv DP" });
  gateway = new FakeGateway();
  setPaymentGateway(gateway);
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

describe("RSV-02 the DP is a WS-05 bill link confirmed by payment.paid", () => {
  it("RSV-02 book with DP opens a link (no intent yet); payment.paid confirms once, a replay changes nothing", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-03"),
      key(),
    );
    expect(created.reservation.status).toBe("pending_deposit");
    expect(created.reservation.depositPaymentId).toBeNull();
    expect(created.reservation.depositStatus).toBe("pending");
    const deposit = created.deposit!;
    expect(deposit.amountIdr).toBe(100_000);
    expect(deposit.paymentPath).toMatch(/^\/bayar\/pl_/);
    const link = await asOwner((client) =>
      client.query<{ total_idr: string; created_by: string; tax_idr: string }>(
        "SELECT total_idr::text, tax_idr::text, created_by FROM payment_links WHERE id = $1",
        [deposit.paymentLinkId],
      ),
    );
    expect(link.rows[0]).toEqual({
      total_idr: "100000",
      tax_idr: "0",
      created_by: RESERVATION_SYSTEM_ACTOR,
    });
    const before = await asOwner((client) =>
      client.query("SELECT 1 FROM payment_intents WHERE payment_link_id = $1", [
        deposit.paymentLinkId,
      ]),
    );
    expect(before.rows).toHaveLength(0);

    const intentId = await openIntent(created);
    await settle(intentId, 100_000);
    const event = await paymentPaidEvent(intentId);
    expect(await handlePaymentPaid(tenantScope(), event)).toBe("confirmed");
    const row = await reservationRow(created.reservation.id);
    expect(row.status).toBe("confirmed");
    expect(row.deposit_payment_id).toBe(intentId);

    // Replayed delivery: still one confirmation, no second event.
    expect(await handlePaymentPaid(tenantScope(), event)).toBe("unchanged");
    expect(await handlePaymentPaid(tenantScope(), event)).toBe("unchanged");
    expect(
      await eventCount(created.reservation.id, "reservation.confirmed"),
    ).toBe(1);

    // Payment of another bill: not a reservation, ignored.
    expect(
      await handlePaymentPaid(tenantScope(), {
        ...event,
        payload: {
          ...event.payload,
          intentId: randomUUID(),
          paymentLinkId: randomUUID(),
        },
      }),
    ).toBe("ignored");
  });

  it("RSV-02 with no payment gateway a DP booking is a clear 503 and leaves no reservation or hold", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    setPaymentGateway(null);
    try {
      await expect(
        createReservation(
          tenantScope(),
          outletA,
          booking(f.zoneId, "2027-05-04"),
          key(),
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: expect.stringContaining("hubungi outlet"),
      });
      gateway.healthValue = "down";
      setPaymentGateway(gateway);
      await expect(
        createReservation(
          tenantScope(),
          outletA,
          booking(f.zoneId, "2027-05-04"),
          key(),
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      gateway.healthValue = "available";
      setPaymentGateway(gateway);
    }
    const left = await asOwner((client) =>
      client.query(
        `SELECT 1 FROM reservations WHERE zone_id = $1
         UNION ALL SELECT 1 FROM reservation_tables WHERE table_id = ANY($2)`,
        [f.zoneId, f.tableIds],
      ),
    );
    expect(left.rows).toHaveLength(0);

    // A configured gateway never 503s a DP booking; no DP needs no gateway.
    const ok = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-04"),
      key(),
    );
    expect(ok.reservation.status).toBe("pending_deposit");
    await setPolicy("none");
    setPaymentGateway(null);
    try {
      const free = await createReservation(
        tenantScope(),
        outletA,
        booking(f.zoneId, "2027-05-05"),
        key(),
      );
      expect(free.reservation.status).toBe("confirmed");
    } finally {
      setPaymentGateway(gateway);
    }
  });
});

describe("RSV-01 an unpaid DP never holds a table forever", () => {
  it("RSV-01 an unattached DP hold is released after the payment window and the table is bookable again", async () => {
    await setPolicy("none");
    const f = await floor(1);
    const t0 = dayAt("2027-05-10", "10:00");
    const reservedFor = dayAt("2027-05-11", "19:00");
    const stale = await insertUnattachedHold({
      zoneId: f.zoneId,
      tableId: f.tableIds[0]!,
      reservedFor,
      createdAt: t0,
    });
    // Inside the window the hold still blocks the table.
    await expect(
      createReservation(
        tenantScope(),
        outletA,
        booking(f.zoneId, "2027-05-11", "Tamu Lain"),
        key(),
        new Date(t0.getTime() + 30 * MINUTE),
      ),
    ).rejects.toMatchObject({ code: "RESERVATION_SLOT_UNAVAILABLE" });
    expect(await liveHolds(stale)).toEqual([f.tableIds[0]]);

    // After it, the next booking releases it lazily and gets the table.
    const next = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-11", "Tamu Lain"),
      key(),
      new Date(t0.getTime() + 61 * MINUTE),
    );
    expect(next.reservation.tableIds).toEqual([f.tableIds[0]]);
    const row = await reservationRow(stale);
    expect(row.status).toBe("cancelled");
    expect(row.close_reason).toBe("deposit_not_paid");
    expect(await liveHolds(stale)).toEqual([]);
    expect(await eventCount(stale, "reservation.cancelled")).toBe(1);
  });

  it("RSV-01 the worker sweep releases an unattached hold per tenant", async () => {
    const f = await floor(1);
    const t0 = dayAt("2027-05-12", "10:00");
    const stale = await insertUnattachedHold({
      zoneId: f.zoneId,
      tableId: f.tableIds[0]!,
      reservedFor: dayAt("2027-05-13", "19:00"),
      createdAt: t0,
    });
    const early = await withTenant(db, tenantScope(), (tx) =>
      sweepStaleDepositHolds(
        tx,
        tenantScope(),
        new Date(t0.getTime() + MINUTE),
      ),
    );
    expect(early.released).not.toContain(stale);
    const swept = await withTenant(db, tenantScope(), (tx) =>
      sweepStaleDepositHolds(
        tx,
        tenantScope(),
        new Date(t0.getTime() + 61 * MINUTE),
      ),
    );
    expect(swept.released).toContain(stale);
    expect(await liveHolds(stale)).toEqual([]);
  });

  it("RSV-02 an expired unpaid link is released, a paid one is confirmed instead, an open code keeps it payable", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(3);
    const t0 = dayAt("2027-05-14", "10:00");
    const unpaid = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-20", "Belum Bayar"),
      key(),
      t0,
    );
    const paid = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-20", "Sudah Bayar"),
      key(),
      t0,
    );
    const paying = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-20", "Sedang Bayar"),
      key(),
      t0,
    );
    // Paid, but the consumer has not run yet (worker behind).
    await settle(await openIntent(paid), 100_000);
    // A QR shown just before the window closed stays payable for its life.
    const open = await openIntent(paying);
    await asOwner((client) =>
      client.query("UPDATE payment_intents SET expires_at = $2 WHERE id = $1", [
        open,
        new Date(t0.getTime() + 90 * MINUTE),
      ]),
    );

    const swept = await withTenant(db, tenantScope(), (tx) =>
      sweepStaleDepositHolds(
        tx,
        tenantScope(),
        new Date(t0.getTime() + 61 * MINUTE),
        { outletId: outletA },
      ),
    );
    expect(swept.released).toContain(unpaid.reservation.id);
    expect(swept.released).not.toContain(paid.reservation.id);
    expect(swept.released).not.toContain(paying.reservation.id);
    expect(swept.confirmed).toContain(paid.reservation.id);
    expect((await reservationRow(unpaid.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(unpaid.reservation.id)).toEqual([]);
    expect((await reservationRow(paid.reservation.id)).status).toBe(
      "confirmed",
    );
    expect(await liveHolds(paid.reservation.id)).toHaveLength(1);
    expect((await reservationRow(paying.reservation.id)).status).toBe(
      "pending_deposit",
    );

    await providerFinal(open);
    const later = await withTenant(db, tenantScope(), (tx) =>
      sweepStaleDepositHolds(
        tx,
        tenantScope(),
        new Date(t0.getTime() + 91 * MINUTE),
        { outletId: outletA },
      ),
    );
    expect(later.released).toContain(paying.reservation.id);
  });
});

describe("RSV-02 a late DP is refunded in full", () => {
  it("RSV-02 a DP paid after its hold was released is refunded in full, once", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    const t0 = dayAt("2027-05-21", "10:00");
    const created = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-27", "Telat Bayar"),
      key(),
      t0,
    );
    const intentId = await openIntent(created);
    // The window passes with the code unpaid and the provider answers final:
    // the sweep releases the hold.
    await providerFinal(intentId);
    await withTenant(db, tenantScope(), (tx) =>
      sweepStaleDepositHolds(
        tx,
        tenantScope(),
        new Date(t0.getTime() + 61 * MINUTE),
        { outletId: outletA },
      ),
    );
    expect((await reservationRow(created.reservation.id)).status).toBe(
      "cancelled",
    );

    // The guest still pays the code (late payment, PRD §3.13 "Siklus
    // Pembayaran"): the reservation keeps nothing.
    await settle(intentId, 100_000);
    const event = await paymentPaidEvent(intentId);
    expect(await handlePaymentPaid(tenantScope(), event)).toBe(
      "late_refund_requested",
    );
    const row = await reservationRow(created.reservation.id);
    expect(row).toMatchObject({
      status: "cancelled",
      deposit_payment_id: intentId,
      refund_status: "requested",
    });
    const refunds = await depositRefundRows(intentId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: "100000",
      requested_by: RESERVATION_SYSTEM_ACTOR,
    });
    expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);

    // A redelivered payment asks for no second refund.
    expect(await handlePaymentPaid(tenantScope(), event)).toBe("unchanged");
    expect(await depositRefundRows(intentId)).toHaveLength(1);
  });

  // legend-2dnh (PAY-04): the reservation system refund opens its approval
  // chain when it is created, requested by the reserved system user.
  it("PAY-04 the late-DP refund opens its approval chain at creation", async () => {
    await setPolicy("required", 100_000);
    // The tenant needs a refund approval matrix whose lowest floor is at or
    // below the deposit. Other suites share this tenant and may leave a custom
    // matrix, so save it, use the supervisor-from-Rp0 default, restore after.
    const saved = await asOwner((client) =>
      client.query<{
        id: string;
        threshold_idr: string | null;
        approver_role_id: string;
        levels: number;
        requires_distinct_actor: boolean;
      }>(
        "SELECT id, threshold_idr, approver_role_id, levels, requires_distinct_actor FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
        [seededTenantId],
      ),
    );
    await asOwner(async (client) => {
      await client.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
        [seededTenantId],
      );
      await client.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         SELECT $1, 'refund', 0, id, 1, true FROM roles
         WHERE tenant_id = $1 AND template_key = 'supervisor'`,
        [seededTenantId],
      );
    });
    let refundId: string | null = null;
    try {
      const f = await floor(1);
      const t0 = dayAt("2027-05-21", "11:00");
      const created = await createReservation(
        tenantScope(),
        outletA,
        booking(f.zoneId, "2027-05-29", "Rantai Persetujuan"),
        key(),
        t0,
      );
      const intentId = await openIntent(created);
      await providerFinal(intentId);
      await withTenant(db, tenantScope(), (tx) =>
        sweepStaleDepositHolds(
          tx,
          tenantScope(),
          new Date(t0.getTime() + 61 * MINUTE),
          { outletId: outletA },
        ),
      );
      await settle(intentId, 100_000);
      const event = await paymentPaidEvent(intentId);
      expect(await handlePaymentPaid(tenantScope(), event)).toBe(
        "late_refund_requested",
      );

      const refunds = await depositRefundRows(intentId);
      expect(refunds).toHaveLength(1);
      refundId = refunds[0]!.id;
      const row = await asOwner((client) =>
        client.query<{ approval_chain_id: string | null }>(
          "SELECT approval_chain_id FROM payment_refunds WHERE id = $1",
          [refundId],
        ),
      );
      expect(row.rows[0]!.approval_chain_id).not.toBeNull();
      const chain = await asOwner((client) =>
        client.query<{ status: string; requested_by: string }>(
          `SELECT status, requested_by FROM approval_requests
           WHERE object_type = 'payment_refund' AND object_id = $1`,
          [refundId],
        ),
      );
      expect(chain.rows).toEqual([
        {
          status: "pending",
          requested_by: "00000000-0000-4000-8000-000000000002",
        },
      ]);

      // A redelivered payment opens no second chain.
      await handlePaymentPaid(tenantScope(), event);
      const again = await asOwner((client) =>
        client.query(
          "SELECT 1 FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = $1",
          [refundId],
        ),
      );
      expect(again.rowCount).toBe(1);
    } finally {
      if (refundId)
        await asOwner((client) =>
          client.query(
            "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = $1",
            [refundId],
          ),
        );
      await asOwner(async (client) => {
        await client.query(
          "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
          [seededTenantId],
        );
        for (const row of saved.rows)
          await client.query(
            `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
             VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
            [
              row.id,
              seededTenantId,
              row.threshold_idr,
              row.approver_role_id,
              row.levels,
              row.requires_distinct_actor,
            ],
          );
      });
    }
  });

  it("RSV-02 a DP that settles while the sweep closes the hold is refunded, not lost", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, "2027-05-28", "Balapan Sapu"),
      key(),
    );
    const intentId = await openIntent(created);
    await settle(intentId, 100_000);
    const event = await paymentPaidEvent(intentId);

    // The sweep locks its whole batch before it closes each row. Hold the row,
    // let the consumer read `pending_deposit` and block on the lock, then close
    // the row the way the sweep does; the payment must not be kept silently.
    const blocker = await owner.connect();
    const probe = await owner.connect();
    let handled: ReturnType<typeof handlePaymentPaid> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
      );
      await blocker.query(
        "SELECT 1 FROM reservations WHERE id = $1 FOR UPDATE",
        [created.reservation.id],
      );
      handled = handlePaymentPaid(tenantScope(), event);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const { rows } = await probe.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND state = 'active' AND pid <> pg_backend_pid()`,
        );
        waiting = (rows[0]?.waiting ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await blocker.query(
        `UPDATE reservations SET status = 'cancelled', closed_at = now(),
           close_reason = 'deposit_not_paid', refund_status = 'not_required'
         WHERE id = $1`,
        [created.reservation.id],
      );
      await blocker.query("COMMIT");
      expect(await handled).toBe("late_refund_requested");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      probe.release();
      if (handled) await handled.catch(() => undefined);
    }
    const row = await reservationRow(created.reservation.id);
    expect(row.status).toBe("cancelled");
    expect(row.deposit_payment_id).toBe(intentId);
    expect(row.refund_status).toBe("requested");
    expect(await depositRefundRows(intentId)).toHaveLength(1);
  });
});

describe("RSV-03 a DP refund is a WS-05 refund request", () => {
  async function paidConfirmed(date: string) {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    const created = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, date),
      key(),
    );
    const intentId = await openIntent(created);
    await settle(intentId, 100_000);
    await handlePaymentPaid(tenantScope(), await paymentPaidEvent(intentId));
    return { created, intentId };
  }

  async function refundRows(intentId: string) {
    const { rows } = await asOwner((client) =>
      client.query<{ id: string; amount_idr: string; requested_by: string }>(
        "SELECT id, amount_idr::text, requested_by FROM payment_refunds WHERE payment_intent_id = $1",
        [intentId],
      ),
    );
    return rows;
  }

  it("RSV-03 cancelling a paid booking creates one refund request; replays never add another", async () => {
    const { created, intentId } = await paidConfirmed("2027-06-20");
    const closed = await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Ganti jadwal" }),
      key(),
    );
    expect(closed.depositOutcome.refundIdr).toBe(100_000);
    const rows = await refundRows(intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount_idr: "100000",
      requested_by: RESERVATION_SYSTEM_ACTOR,
    });
    const row = await reservationRow(created.reservation.id);
    expect(row.refund_status).toBe("requested");
    expect(row.refund_payment_refund_id).toBe(rows[0]!.id);

    // The WS-05 refund screen lists a system-requested refund (no user row
    // for `system:reservation`) instead of failing the whole tenant's list.
    const listed = await listRefunds(
      tenantScope(),
      staff.userId,
      listRefundsContract.query.parse({}),
    );
    const view = listed.data.find((refund) => refund.id === rows[0]!.id);
    expect(view).toMatchObject({
      requestedBy: RESERVATION_SYSTEM_ACTOR,
      requestedByName: "Sistem (reservasi)",
      amountIdr: 100_000,
      status: "pending",
    });

    await requestDepositRefund(
      tenantScope(),
      outletA,
      created.reservation.id,
      { intentId, refundIdr: 100_000 },
      "cancelled",
      staff.userId,
    );
    await retryPendingRefunds(
      tenantScope(),
      new Date(Date.now() + 60 * MINUTE),
    );
    expect(await refundRows(intentId)).toHaveLength(1);
  });

  it("RSV-03 a failed refund request stays pending, backs off, and the retry sweep requests it once", async () => {
    const { created, intentId } = await paidConfirmed("2027-06-21");
    // The close decision as the lifecycle records it (refund still pending).
    await asOwner((client) =>
      client.query(
        `UPDATE reservations SET status = 'cancelled', closed_at = now(), close_reason = 'x',
           deposit_refund_idr = 100000, deposit_forfeited_idr = 0, refund_status = 'pending'
         WHERE id = $1`,
        [created.reservation.id],
      ),
    );
    // Numbers that disagree with the decision fail closed (and count).
    const now = new Date();
    await requestDepositRefund(
      tenantScope(),
      outletA,
      created.reservation.id,
      { intentId, refundIdr: 1 },
      "cancelled",
      null,
    );
    let row = await reservationRow(created.reservation.id);
    expect(row.refund_status).toBe("pending");
    expect(row.refund_attempts).toBe(1);
    expect(row.refund_next_attempt_at!.getTime()).toBeGreaterThan(
      now.getTime(),
    );
    expect(await refundRows(intentId)).toHaveLength(0);

    // Not due yet: the sweep leaves it alone.
    await retryPendingRefunds(tenantScope(), now);
    expect(await refundRows(intentId)).toHaveLength(0);

    // Due: requested once, then idempotent.
    const later = new Date(now.getTime() + 5 * MINUTE);
    await retryPendingRefunds(tenantScope(), later);
    await retryPendingRefunds(tenantScope(), later);
    expect(await refundRows(intentId)).toHaveLength(1);
    row = await reservationRow(created.reservation.id);
    expect(row.refund_status).toBe("requested");
    expect(row.refund_payment_refund_id).not.toBeNull();

    // The retry budget is REFUND_MAX_ATTEMPTS: the last failure gives up with
    // an audit row for a human and the sweep never picks the row up again.
    const stuck = await paidConfirmed("2027-06-22");
    await asOwner((client) =>
      client.query(
        `UPDATE reservations SET status = 'cancelled', closed_at = now(), close_reason = 'x',
           deposit_refund_idr = 100000, deposit_forfeited_idr = 0, refund_status = 'pending',
           refund_attempts = $2
         WHERE id = $1`,
        [stuck.created.reservation.id, REFUND_MAX_ATTEMPTS - 1],
      ),
    );
    await requestDepositRefund(
      tenantScope(),
      outletA,
      stuck.created.reservation.id,
      { intentId: stuck.intentId, refundIdr: 1 },
      "cancelled",
      null,
    );
    const capped = await reservationRow(stuck.created.reservation.id);
    expect(capped.refund_attempts).toBe(REFUND_MAX_ATTEMPTS);
    expect(capped.refund_next_attempt_at).toBeNull();
    const audit = await asOwner((client) =>
      client.query(
        `SELECT 1 FROM audit_logs
         WHERE tenant_id = $1 AND event->>'objectId' = $2
           AND event->>'action' = 'reservation.refund_retry_exhausted'`,
        [seededTenantId, stuck.created.reservation.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    await retryPendingRefunds(
      tenantScope(),
      new Date(Date.now() + 48 * 60 * MINUTE),
    );
    expect(await refundRows(stuck.intentId)).toHaveLength(0);
    expect(
      (await reservationRow(stuck.created.reservation.id)).refund_status,
    ).toBe("pending");
  });
});

describe("staff list is total over valid rows", () => {
  it("RSV-02 the list maps a mid-booking DP row, an expired link and refunded DPs without failing", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(4);
    const date = "2027-07-01";
    // Mid-booking: DP row whose link is not attached yet.
    const midBooking = await insertUnattachedHold({
      zoneId: f.zoneId,
      tableId: f.tableIds[0]!,
      reservedFor: dayAt(date, "12:00"),
      createdAt: new Date(),
    });
    // A paid DP later refunded in full by WS-05, and one partially.
    const refunded = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, date, "Refund Penuh"),
      key(),
    );
    const refundedIntent = await openIntent(refunded);
    await settle(refundedIntent, 100_000);
    await handlePaymentPaid(
      tenantScope(),
      await paymentPaidEvent(refundedIntent),
    );
    const partial = await createReservation(
      tenantScope(),
      outletA,
      booking(f.zoneId, date, "Refund Sebagian"),
      key(),
    );
    const partialIntent = await openIntent(partial);
    await settle(partialIntent, 100_000);
    await handlePaymentPaid(
      tenantScope(),
      await paymentPaidEvent(partialIntent),
    );
    await asOwner(async (client) => {
      await client.query(
        "UPDATE payment_intents SET status = 'refunded' WHERE id = $1",
        [refundedIntent],
      );
      await client.query(
        "UPDATE payment_intents SET status = 'partially_refunded' WHERE id = $1",
        [partialIntent],
      );
    });

    const query = { limit: 50, date } as never;
    const listed = await listReservations(
      tenantScope(),
      staff.userId,
      outletA,
      query,
    );
    const byId = new Map(listed.data.map((r) => [r.id, r]));
    expect(byId.get(midBooking as never)).toMatchObject({
      status: "pending_deposit",
      depositPaymentId: null,
      depositStatus: "pending",
    });
    expect(byId.get(refunded.reservation.id)).toMatchObject({
      status: "confirmed",
      depositPaymentId: refundedIntent,
      depositStatus: "refunded",
    });
    expect(byId.get(partial.reservation.id)?.depositStatus).toBe(
      "partially_refunded",
    );

    const http = await staff.client.get(
      `/api/outlets/${seededOutletA}/reservations?date=${date}&limit=50`,
    );
    expect(http.status).toBe(200);
    expect((http.body.data as { id: string }[]).map((r) => r.id)).toEqual(
      expect.arrayContaining([midBooking, refunded.reservation.id]),
    );
  });
});
