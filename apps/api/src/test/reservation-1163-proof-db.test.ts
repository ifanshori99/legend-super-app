// legend-pdi5u (dup legend-ytwlo): the local clock is not proof that a DP can
// no longer be paid. Against PostgreSQL, with the real booking, deposit port,
// reconcile sweep, resend route and payment confirmation; only the payment
// gateway is a test double.
//
// Rules under test (CTO decision, the direction that limits payment):
//  A. A DP booking is only cancelled (zero DP), and a DP link only replaced,
//     when no DP intent can still take money: an intent with a provider
//     reference, no provider final answer (`provider_final_at` null) and a
//     status that is not paid / partially_refunded / refunded may still pay,
//     whatever the local clock says.
//  B. A DP PROVEN late (the confirmation time, from the provider, is after
//     max(reservation link limit, the intent's own expiry)) on a booking that
//     is still pending_deposit is not credited to the booking and does not
//     reduce the link's bill; the money is parked in unallocated funds.
//
// Assumptions (spec silent): "outstanding" of the DP link is
// payment_links.total_idr - paid_idr; "parked" means exactly one
// payment_unallocated_funds row for the intent with the DP amount; the
// reconcile entry point is the deposit sweep (it reconciles pending_deposit
// rows at a given `now`).
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
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { sweepStaleDepositHolds } from "../services/reservation-sweeps.ts";
import { originHeader } from "./helpers";
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
       VALUES ($1, $2, 'proof-1163', 'required', $3, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA, DP_IDR],
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
const key = () => `rsv-1163-${randomUUID()}`;

/** A DP booking (window 60 min) created at `createdAt` (default: real now). */
async function book(date: string, createdAt?: Date) {
  await setPolicy();
  const zoneId = await floor();
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Bukti 1163",
      contactPhone: "081234567890",
    }),
    key(),
    createdAt,
  );
}
type Booked = Awaited<ReturnType<typeof book>>;

/** The guest opens the hosted page and a QRIS code is created on the DP link. */
async function openIntent(created: Booked): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-1163-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/**
 * Put the code into a known state. The code carries a provider reference
 * (it reached the provider); `finalAnswer` is the provider's final answer.
 */
async function shapeIntent(
  intentId: string,
  input: {
    status: "pending" | "expired";
    expiresAt: Date;
    providerFinal?: boolean;
    providerRef?: string | null;
  },
) {
  await asOwner((client) =>
    client.query(
      `UPDATE payment_intents
          SET status = $2, expires_at = $3,
              provider_ref = $4,
              provider_final_at = $5
        WHERE id = $1`,
      [
        intentId,
        input.status,
        input.expiresAt,
        input.providerRef === undefined
          ? `PROV-${intentId}`
          : input.providerRef,
        input.providerFinal ? new Date() : null,
      ],
    ),
  );
}

/** Reconcile at `now` (the deposit sweep reconciles pending_deposit rows). */
async function sweepAt(now: Date) {
  return withTenant(db, tenantScope(), (tx) =>
    sweepStaleDepositHolds(tx, tenantScope(), now, { outletId: outletA }),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      close_reason: string | null;
      deposit_payment_id: string | null;
      deposit_payment_link_id: string | null;
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

async function unallocatedOf(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ amount_idr: string }>(
      "SELECT amount_idr::text FROM payment_unallocated_funds WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  return rows.map((row) => Number(row.amount_idr));
}

async function intentState(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; final: boolean }>(
      "SELECT status, provider_final_at IS NOT NULL AS final FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return { status: rows[0]!.status, final: rows[0]!.final };
}

/**
 * The provider confirms the payment at `at` (verified webhook). The service
 * clock (`now`) and the signed receipt time (`receivedAt`) are both `at`, so
 * the confirmation time is exactly `at` and does not depend on the real clock.
 */
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

/** A DP confirmed in time: the call settles the code. */
async function settleAt(intentId: string, at: Date) {
  await confirmAt(intentId, at);
}

/**
 * A DP confirmed too late: the confirmation is refused with BILL_CLOSED (the
 * money is parked, the bill stays open). Returns once the refusal is proven.
 */
async function settleLateAt(intentId: string, at: Date) {
  await expect(confirmAt(intentId, at)).rejects.toMatchObject({
    decisionCode: "BILL_CLOSED",
  });
}

/** How many payment.paid events exist for the intent. */
async function paidEventCount(intentId: string): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intentId],
    ),
  );
  return rows.length;
}

/** Deliver every payment.paid event of the intent to the reservation consumer. */
async function deliverPaidEvents(intentId: string): Promise<string[]> {
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intentId],
    ),
  );
  const outcomes: string[] = [];
  for (const row of rows)
    outcomes.push(
      await handlePaymentPaid(
        tenantScope(),
        eventEnvelopeSchema.parse(row.event),
      ),
    );
  return outcomes;
}

function resend(reservationId: string) {
  return staff.client
    .post(
      `/api/outlets/${seededOutletA}/reservations/${reservationId}/deposit-link`,
    )
    .set(originHeader)
    .set("Idempotency-Key", key())
    .send({});
}

/** The stored link lapsed by its own expiry (the booking window is still open). */
async function expireLink(reservationId: string) {
  await asOwner((client) =>
    client.query(
      "UPDATE reservations SET deposit_link_expires_at = now() - interval '1 minute' WHERE id = $1",
      [reservationId],
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv 1163" });
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

describe("legend-pdi5u 1 past the local limit, the provider has not answered final", () => {
  for (const status of ["pending", "expired"] as const) {
    it(`legend-pdi5u reconcile keeps a pending_deposit booking whose ${status} code has a provider reference and no final answer`, async () => {
      const t0 = dayAt("2027-07-01", "10:00");
      const created = await book("2027-07-10", t0);
      const id = created.reservation.id;
      const intentId = await openIntent(created);
      await shapeIntent(intentId, {
        status,
        expiresAt: new Date(t0.getTime() + 30 * MINUTE),
      });

      // 61 minutes after booking: link limit and the code's own expiry passed.
      const swept = await sweepAt(new Date(t0.getTime() + 61 * MINUTE));
      expect(swept.released).not.toContain(id);
      let row = await reservationRow(id);
      expect(row.status).toBe("pending_deposit");
      expect(row.close_reason).toBeNull();
      expect(await liveHolds(id)).toBe(1);

      // Twenty hours later: still inside the 24h poll-window cap (legend-m0kqn).
      await sweepAt(new Date(t0.getTime() + 20 * 60 * MINUTE));
      row = await reservationRow(id);
      expect(row.status).toBe("pending_deposit");
      expect(await liveHolds(id)).toBe(1);
    });
  }

  it("legend-pdi5u resend does not replace the DP link while a provider-backed code has no final answer", async () => {
    const created = await book("2027-07-11");
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await expireLink(id);
    await shapeIntent(intentId, {
      status: "expired",
      expiresAt: new Date(Date.now() - 60 * MINUTE),
    });

    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESERVATION_DEPOSIT_PAYMENT_PENDING");
    const row = await reservationRow(id);
    expect(row.status).toBe("pending_deposit");
    expect(row.deposit_payment_link_id).toBe(created.deposit!.paymentLinkId);
  });
});

describe("legend-pdi5u 2 the provider answered final, no money", () => {
  it("legend-pdi5u reconcile cancels with zero DP and releases the hold once the provider is final", async () => {
    const t0 = dayAt("2027-07-02", "10:00");
    const created = await book("2027-07-12", t0);
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await shapeIntent(intentId, {
      status: "expired",
      expiresAt: new Date(t0.getTime() + 30 * MINUTE),
      providerFinal: true,
    });

    const swept = await sweepAt(new Date(t0.getTime() + 61 * MINUTE));
    expect(swept.released).toContain(id);
    const row = await reservationRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.close_reason).toBe("deposit_not_paid");
    expect(await liveHolds(id)).toBe(0);
  });

  // Contrast on one clock: both codes are lapsed on the local clock (pending,
  // own expiry before the sweep), neither has a provider final answer; only the
  // one with a provider reference can still take money. The other cannot, so
  // its booking closes.
  it("legend-pdi5u a code that never reached the provider does not keep the booking open", async () => {
    const t0 = dayAt("2027-07-03", "10:00");
    const withRef = await book("2027-07-13", t0);
    const withoutRef = await book("2027-07-13", t0);
    const refIntent = await openIntent(withRef);
    const noRefIntent = await openIntent(withoutRef);
    for (const [intentId, providerRef] of [
      [refIntent, undefined],
      [noRefIntent, null],
    ] as const)
      await shapeIntent(intentId, {
        status: "pending",
        expiresAt: new Date(t0.getTime() + 30 * MINUTE),
        providerRef,
      });

    const swept = await sweepAt(new Date(t0.getTime() + 61 * MINUTE));
    expect(swept.released).toContain(withoutRef.reservation.id);
    expect(swept.released).not.toContain(withRef.reservation.id);
    expect((await reservationRow(withoutRef.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(withoutRef.reservation.id)).toBe(0);
    expect((await reservationRow(withRef.reservation.id)).status).toBe(
      "pending_deposit",
    );
    expect(await liveHolds(withRef.reservation.id)).toBe(1);
  });

  // Same lapsed link as the "does not replace" test, but the provider is final
  // with no money: resend reconciles first (reservation-deposit-resend.ts:186),
  // nothing can pay, so the booking closes. Reconcile runs before the mint, so
  // a lapsed link with no payable DP cancels the booking; the mint path is
  // unreachable.
  it("legend-pdi5u resend closes the booking once the provider is final and nothing was paid", async () => {
    const created = await book("2027-07-14");
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await expireLink(id);
    await shapeIntent(intentId, {
      status: "expired",
      expiresAt: new Date(Date.now() - 60 * MINUTE),
      providerFinal: true,
    });

    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESERVATION_DEPOSIT_NOT_PENDING");
    const row = await reservationRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.close_reason).toBe("deposit_not_paid");
    expect(await liveHolds(id)).toBe(0);
  });
});

describe("legend-pdi5u 3 a DP proven late is parked, not credited", () => {
  it("legend-pdi5u DP confirmed after the limit leaves the bill and the booking untouched and parks the money once", async () => {
    const t0 = dayAt("2027-07-04", "10:00");
    const created = await book("2027-07-15", t0);
    const id = created.reservation.id;
    const linkId = created.deposit!.paymentLinkId;
    const intentId = await openIntent(created);
    // Link limit t0+60 min, the code's own expiry t0+30 min.
    await shapeIntent(intentId, {
      status: "pending",
      expiresAt: new Date(t0.getTime() + 30 * MINUTE),
    });
    const owedBefore = await linkOutstanding(linkId);
    expect(owedBefore).toBe(DP_IDR);

    // The provider confirms 90 minutes after booking: after both limits.
    const at = new Date(t0.getTime() + 90 * MINUTE);
    await settleLateAt(intentId, at);
    expect(await deliverPaidEvents(intentId)).toEqual([]);

    const row = await reservationRow(id);
    expect(row.status).not.toBe("confirmed");
    expect(row.deposit_payment_id).toBeNull();
    expect(await linkOutstanding(linkId)).toBe(owedBefore);
    // The money is not lost: parked once, for the full DP.
    expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
    // The parked code is closed for good: final, and no longer `pending` (a
    // pending code would be polled forever).
    expect(await intentState(intentId)).toEqual({
      status: "expired",
      final: true,
    });

    // Replays (same provider message, consumer again) add and credit nothing:
    // the same refusal, and still no payment.paid event for this code.
    await settleLateAt(intentId, at);
    expect(await deliverPaidEvents(intentId)).toEqual([]);
    expect(await paidEventCount(intentId)).toBe(0);
    expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
    expect(await linkOutstanding(linkId)).toBe(owedBefore);
    expect((await reservationRow(id)).status).not.toBe("confirmed");
  });

  it("legend-pdi5u after the money is parked the booking cancels normally with zero DP and its hold is released", async () => {
    const t0 = dayAt("2027-07-05", "10:00");
    const created = await book("2027-07-16", t0);
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await shapeIntent(intentId, {
      status: "pending",
      expiresAt: new Date(t0.getTime() + 30 * MINUTE),
    });
    await settleLateAt(intentId, new Date(t0.getTime() + 90 * MINUTE));
    expect(await deliverPaidEvents(intentId)).toEqual([]);
    expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);

    // The parked code must not keep the booking payable forever.
    const swept = await sweepAt(new Date(t0.getTime() + 95 * MINUTE));
    expect(swept.released).toContain(id);
    const row = await reservationRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.close_reason).toBe("deposit_not_paid");
    expect(row.deposit_payment_id).toBeNull();
    expect(await liveHolds(id)).toBe(0);
    // Still parked exactly once (nothing refunded or credited twice).
    expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
  });
});

describe("legend-pdi5u 4 a DP on time still confirms", () => {
  it("legend-pdi5u DP confirmed before the limit confirms the booking, reduces the bill and parks nothing", async () => {
    const t0 = dayAt("2027-07-06", "10:00");
    const created = await book("2027-07-17", t0);
    const id = created.reservation.id;
    const linkId = created.deposit!.paymentLinkId;
    const intentId = await openIntent(created);
    await shapeIntent(intentId, {
      status: "pending",
      expiresAt: new Date(t0.getTime() + 30 * MINUTE),
    });

    await settleAt(intentId, new Date(t0.getTime() + 20 * MINUTE));
    expect(await deliverPaidEvents(intentId)).toContain("confirmed");
    const row = await reservationRow(id);
    expect(row.status).toBe("confirmed");
    expect(row.deposit_payment_id).toBe(intentId);
    expect(await linkOutstanding(linkId)).toBe(0);
    expect(await unallocatedOf(intentId)).toEqual([]);
  });

  it("legend-pdi5u DP confirmed after the link limit but before the code's own expiry is on time", async () => {
    const t0 = dayAt("2027-07-07", "10:00");
    const created = await book("2027-07-18", t0);
    const id = created.reservation.id;
    const linkId = created.deposit!.paymentLinkId;
    const intentId = await openIntent(created);
    // The code was shown just before the window closed and lives to t0+120.
    await shapeIntent(intentId, {
      status: "pending",
      expiresAt: new Date(t0.getTime() + 120 * MINUTE),
    });

    await settleAt(intentId, new Date(t0.getTime() + 90 * MINUTE));
    expect(await deliverPaidEvents(intentId)).toContain("confirmed");
    const row = await reservationRow(id);
    expect(row.status).toBe("confirmed");
    expect(row.deposit_payment_id).toBe(intentId);
    expect(await linkOutstanding(linkId)).toBe(0);
    expect(await unallocatedOf(intentId)).toEqual([]);
  });
});
