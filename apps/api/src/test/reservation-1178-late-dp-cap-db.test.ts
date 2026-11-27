// legend-3dfri (batch 1178, finding of the legend-1171 second opinion): a DP
// that is PROVEN to have arrived after the poll-window cap
// `payableUntil + GATEWAY_POLL_WINDOW_MS` must not be parked as unallocated
// money. The guest did pay, so the code settles, the booking stays cancelled
// (never confirmed, no booking credit) and the DP is refunded in full, once,
// through the RSV-02 late-payment consumer. Against PostgreSQL with the real
// booking, deposit port, sweep, payment confirmation and gateway poller; only
// the gateway is a double.
//
// Matrix: {DOIT, Duitku} x {callback, polling} x {before sweep, after sweep}
// at cap + 1 minute, plus a control one minute BEFORE the cap (rule pdi5u: a
// DP late for the link but before the cap is still parked, no payment.paid).
//
// Assumptions (spec silent):
// - "Proof of time" is the provider's payment time: for a callback the signed
//   evidence time / first receipt (both set to the same instant here), for
//   polling the `paidAt` the gateway reports. The service clock is that same
//   instant (callback) or one minute later (polling).
// - Duitku is the strict provider: its callback passes
//   `closedIntentNeedsOpenBill: true` (as the Duitku webhook does) and its poll
//   is strict by provider. To make an intent a Duitku one the test sets
//   payment_intents.provider = 'duitku' on the row (the double registers
//   itself under that provider).
// - The pre-consumer state of a still `pending_deposit` booking (before-sweep
//   cells) is only required to be "not confirmed, no booking credit"; after
//   the consumer ran it must be `cancelled` with no live holds in both cases.
// - A replayed confirmation may answer or be refused; either way it adds no
//   refund and no event.
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
  pollPendingGatewayIntents,
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

type Provider = "doit" | "duitku";

/**
 * Provider double: one code (with a provider reference) per idempotency key.
 * Status checks answer `pending` until `markPaid` says the provider took the
 * money (with the provider's own payment time).
 */
class FakeGateway implements PaymentGatewayPort {
  private readonly byKey = new Map<string, GatewayIntent>();
  private readonly paid = new Map<string, string>();
  constructor(readonly provider: Provider) {}
  markPaid(providerRef: string, paidAt: Date) {
    this.paid.set(providerRef, paidAt.toISOString());
  }
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
    const paidAt = this.paid.get(input.providerRef);
    if (paidAt)
      return {
        status: "paid" as const,
        providerRef: input.providerRef,
        amountIdr: DP_IDR,
        paidAt,
        ...(this.provider === "duitku" ? { rawStatus: "00" } : {}),
      };
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
       VALUES ($1, $2, 'rsv1178-cap', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
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
const key = () => `rsv-1178-${randomUUID()}`;

/** A DP booking (window 60 min) created at `createdAt`, on its own table. */
async function book(date: string, createdAt: Date) {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId: await floor(),
      guestName: "Tamu DP Lewat Batas 1178",
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
      idempotencyKey: `rsv-1178-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/**
 * The code reached the provider (has a reference), has no final answer and
 * lapsed at `expiresAt` (30 min after booking, before the 60 min link limit).
 */
async function shapeUnanswered(
  intentId: string,
  expiresAt: Date,
  provider: Provider,
) {
  await asOwner((client) =>
    client.query(
      `UPDATE payment_intents
          SET status = 'pending', expires_at = $2, provider = $4,
              provider_ref = $3, provider_final_at = NULL
        WHERE id = $1`,
      [intentId, expiresAt, providerRefOf(intentId), provider],
    ),
  );
}
const providerRefOf = (intentId: string) => `PROV-${intentId}`;

/** The deposit sweep at `now` (all due rows of the outlet, no batch limit). */
async function sweepAt(now: Date) {
  return withTenant(db, tenantScope(), (tx) =>
    sweepStaleDepositHolds(tx, tenantScope(), now, {
      outletId: outletA,
      limit: 1000,
    }),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      close_reason: string | null;
      deposit_payment_id: string | null;
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

async function unallocatedOf(intentId: string): Promise<number[]> {
  const { rows } = await asOwner((client) =>
    client.query<{ amount_idr: string }>(
      "SELECT amount_idr::text FROM payment_unallocated_funds WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  return rows.map((row) => Number(row.amount_idr));
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

async function paidEvents(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intentId],
    ),
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/** The provider confirms the payment at `at`; service clock and receipt are `at`. */
function confirmAt(intentId: string, at: Date, provider: Provider) {
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
    provider === "duitku" ? { closedIntentNeedsOpenBill: true } : {},
  );
}

/** The payment poller asks the provider one minute after the payment. */
async function pollAfter(paidAt: Date, intentId: string) {
  gateway.markPaid(providerRefOf(intentId), paidAt);
  await pollPendingGatewayIntents(
    tenantScope(),
    new Date(paidAt.getTime() + MINUTE),
    1000,
  );
}

/** The cap after which an unanswered provider code no longer holds a booking. */
const capOf = (t0: Date) =>
  new Date(t0.getTime() + WINDOW_MIN * MINUTE + GATEWAY_POLL_WINDOW_MS);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv 1178" });
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

type Path = "callback" | "polling";
type Timing = "before sweep" | "after sweep";

const providers: Provider[] = ["doit", "duitku"];
const paths: Path[] = ["callback", "polling"];
const timings: Timing[] = ["before sweep", "after sweep"];
let cellDay = 0;
const nextDays = () => {
  cellDay += 1;
  const day = String(cellDay).padStart(2, "0");
  return { created: `2027-03-${day}`, reserved: `2027-10-${day}` };
};

for (const provider of providers) {
  describe(`legend-3dfri ${provider}: a DP proven after the cap is refunded, not parked`, () => {
    beforeAll(() => {
      gateway = new FakeGateway(provider);
      setPaymentGateway(gateway);
    });

    for (const path of paths) {
      for (const timing of timings) {
        it(`legend-3dfri ${provider} ${path} ${timing}: settles the code, keeps the booking cancelled and refunds the DP once`, async () => {
          const days = nextDays();
          const t0 = dayAt(days.created, "10:00");
          const created = await book(days.reserved, t0);
          const id = created.reservation.id;
          const intentId = await openIntent(created);
          await shapeUnanswered(
            intentId,
            new Date(t0.getTime() + 30 * MINUTE),
            provider,
          );
          const cap = capOf(t0);

          // Proof of payment arrives one minute after the cap (two minutes
          // when the sweep cancelled the booking first, at cap + 1 minute).
          let paidAt = new Date(cap.getTime() + MINUTE);
          if (timing === "after sweep") {
            const swept = await sweepAt(new Date(cap.getTime() + MINUTE));
            expect(swept.released).toContain(id);
            expect((await reservationRow(id)).status).toBe("cancelled");
            expect(await liveHolds(id)).toBe(0);
            paidAt = new Date(cap.getTime() + 2 * MINUTE);
          } else {
            expect((await reservationRow(id)).status).toBe("pending_deposit");
          }

          if (path === "callback")
            await expect(
              confirmAt(intentId, paidAt, provider),
            ).resolves.not.toThrow();
          else await pollAfter(paidAt, intentId);

          // The guest paid: the code settles, exactly one payment.paid event,
          // nothing parked, and the booking is not credited nor confirmed.
          expect(await intentStatus(intentId)).toBe("paid");
          const events = await paidEvents(intentId);
          expect(events).toHaveLength(1);
          expect(await unallocatedOf(intentId)).toEqual([]);
          let row = await reservationRow(id);
          expect(row.status).not.toBe("confirmed");
          expect(row.deposit_payment_id).toBeNull();

          // The reservation consumer (RSV-02) refunds the late DP in full.
          const event = events[0]!;
          expect(await handlePaymentPaid(tenantScope(), event)).toBe(
            "late_refund_requested",
          );
          row = await reservationRow(id);
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
          expect(await unallocatedOf(intentId)).toEqual([]);

          // Replays (provider message or poll again, consumer again) add no
          // event and no refund; never refund more than was received.
          if (path === "callback")
            await confirmAt(intentId, paidAt, provider).catch(() => undefined);
          else await pollAfter(paidAt, intentId);
          expect(await handlePaymentPaid(tenantScope(), event)).toBe(
            "unchanged",
          );
          expect(await paidEvents(intentId)).toHaveLength(1);
          const after = await depositRefundRows(intentId);
          expect(after).toHaveLength(1);
          expect(
            after.reduce((sum, refund) => sum + Number(refund.amount_idr), 0),
          ).toBeLessThanOrEqual(DP_IDR);
          expect((await reservationRow(id)).status).toBe("cancelled");
          expect(await liveHolds(id)).toBe(0);
          expect(await unallocatedOf(intentId)).toEqual([]);
        });
      }
    }

    // Control (rule pdi5u, unchanged): after the link limit but one minute
    // BEFORE the cap the DP is still parked and nothing is announced.
    it(`legend-3dfri ${provider} callback one minute before the cap is still parked, no payment.paid`, async () => {
      const days = nextDays();
      const t0 = dayAt(days.created, "10:00");
      const created = await book(days.reserved, t0);
      const id = created.reservation.id;
      const intentId = await openIntent(created);
      await shapeUnanswered(
        intentId,
        new Date(t0.getTime() + 30 * MINUTE),
        provider,
      );

      const at = new Date(capOf(t0).getTime() - MINUTE);
      await expect(confirmAt(intentId, at, provider)).rejects.toMatchObject({
        decisionCode: "BILL_CLOSED",
      });
      expect(await paidEvents(intentId)).toHaveLength(0);
      expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
      expect(await intentStatus(intentId)).not.toBe("paid");
      const row = await reservationRow(id);
      expect(row.status).not.toBe("confirmed");
      expect(row.deposit_payment_id).toBeNull();
      expect(await depositRefundRows(intentId)).toHaveLength(0);
    });
  });
}

// legend-3dfri follow-up (second opinion): a link whose DP was already paid in
// time by code A must not be cancelled by a later code B on the SAME link that
// is proven paid after the cap. B is the old rule (parked money / double
// payment): it never becomes the booking DP and never refunds or cancels A.
//
// Assumptions (spec silent):
// - Code B is opened with createIntent on the same token after A settled; if
//   the product refuses a second code on a fully paid link, the test seeds B by
//   copying A's row (new id, new provider ref, pending, lapsed) which is the
//   shape a code created while the link was still open has.
// - "Old rule" for B is only required as: no cancel, no booking DP, no refund
//   of A, no refund request made for B by the reservation consumer, holds kept.
//   Whether B settles or is parked is left open.
async function openSecondIntent(
  created: Booked,
  firstIntentId: string,
): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  try {
    const intent = await createIntent(
      tenantScope(),
      token,
      createPaymentIntentInputSchema.parse({
        method: "qris",
        channelCode: null,
        idempotencyKey: `rsv-1178-pay-b-${created.reservation.id}`,
      }),
    );
    if (intent.id !== firstIntentId) return intent.id;
  } catch {
    // fall through to the seeded shape
  }
  const { rows } = await asOwner(async (client) => {
    // charged_idr is generated (0544): copy only the writable columns.
    const writable = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'payment_intents'
          AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    );
    const columns = writable.rows.map((row) => `"${row.column_name}"`);
    return client.query<{ id: string }>(
      `INSERT INTO payment_intents (${columns.join(", ")})
         SELECT ${columns.map((column) => `r.${column}`).join(", ")}
           FROM payment_intents p,
                jsonb_populate_record(null::payment_intents,
                  to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', $2::text, 'status', 'pending', 'paid_at', NULL)) r
          WHERE p.id = $1
       RETURNING id`,
      [firstIntentId, `rsv-1178-pay-b-seed-${randomUUID()}`],
    );
  });
  return rows[0]!.id;
}

for (const provider of providers) {
  describe(`legend-3dfri ${provider}: a second code paid after the cap leaves a DP already paid in time alone`, () => {
    beforeAll(() => {
      gateway = new FakeGateway(provider);
      setPaymentGateway(gateway);
    });

    for (const path of paths) {
      it(`legend-3dfri ${provider} ${path}: code B proven after the cap does not cancel, refund or replace code A`, async () => {
        const days = nextDays();
        const t0 = dayAt(days.created, "10:00");
        const created = await book(days.reserved, t0);
        const id = created.reservation.id;
        const intentA = await openIntent(created);

        // Code A is paid in time (10 minutes after booking, inside the link limit).
        await confirmAt(
          intentA,
          new Date(t0.getTime() + 10 * MINUTE),
          provider,
        );
        expect(await intentStatus(intentA)).toBe("paid");
        const eventsA = await paidEvents(intentA);
        expect(eventsA).toHaveLength(1);
        expect((await reservationRow(id)).status).toBe("pending_deposit");

        // Code B on the same link, unanswered and lapsed, then proven paid after the cap.
        const intentB = await openSecondIntent(created, intentA);
        expect(intentB).not.toBe(intentA);
        await shapeUnanswered(
          intentB,
          new Date(t0.getTime() + 30 * MINUTE),
          provider,
        );
        const paidAt = new Date(capOf(t0).getTime() + MINUTE);
        if (path === "callback")
          await confirmAt(intentB, paidAt, provider).catch(() => undefined);
        else await pollAfter(paidAt, intentB);

        // B did not cancel the booking nor release its tables.
        let row = await reservationRow(id);
        expect(row.status).toBe("pending_deposit");
        expect(await liveHolds(id)).toBeGreaterThan(0);
        expect(await depositRefundRows(intentA)).toHaveLength(0);

        // The consumer applies A: booking confirmed with A as its DP, A not refunded.
        expect(await handlePaymentPaid(tenantScope(), eventsA[0]!)).not.toBe(
          "late_refund_requested",
        );
        row = await reservationRow(id);
        expect(row.status).toBe("confirmed");
        expect(row.deposit_payment_id).toBe(intentA);
        expect(row.refund_status).not.toBe("requested");
        expect(row.refund_payment_refund_id).toBeNull();
        expect(await liveHolds(id)).toBeGreaterThan(0);
        expect(await depositRefundRows(intentA)).toHaveLength(0);

        // B never becomes the booking DP and the consumer makes no refund for it,
        // even if B settled and announced itself.
        for (const event of await paidEvents(intentB))
          expect(await handlePaymentPaid(tenantScope(), event)).not.toBe(
            "late_refund_requested",
          );
        row = await reservationRow(id);
        expect(row.status).toBe("confirmed");
        expect(row.deposit_payment_id).toBe(intentA);
        expect(await liveHolds(id)).toBeGreaterThan(0);
        expect(await depositRefundRows(intentA)).toHaveLength(0);
        expect(await depositRefundRows(intentB)).toHaveLength(0);
      });
    }
  });
}
