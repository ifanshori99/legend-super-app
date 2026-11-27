// legend-3dfri follow-up (batch 1178, Kartu 1): TWO codes (A and B) on the SAME
// DP link, both PROVEN paid after the poll-window cap. The guest paid twice, so
// the provider took Rp100.000 per transaction (Rp200.000 in all). The first code
// settled holds the DP money and is refunded once by the RSV-02 consumer (the
// booking stays cancelled, never confirmed). The second is a double payment: its
// money sits in payment_unallocated_funds and is returned through that fund by
// the staff flow, so the consumer must NOT refund it as well. Whatever order the
// two payment.paid events are consumed in, the money returned never exceeds the
// money received per provider transaction, and replays add nothing.
// Against PostgreSQL with the real booking, deposit port, sweep and payment
// confirmation; only the gateway is a double.
//
// Assumptions (spec silent):
// - A is confirmed first (it takes the allocated money), B second (double
//   payment). Only the CONSUMPTION order of their events is varied (A then B,
//   B then A); the test consumes the payment.paid events that exist for each.
// - Code B is seeded by copying A's payment_intents row via SQL (new id, new
//   provider ref, pending, lapsed): the shape of a second code opened while the
//   link was still open.
// - "Money returned" for a code = its non-failed payment_refunds plus the amount
//   parked for it in payment_unallocated_funds (what the staff flow refunds);
//   it must stay <= Rp100.000 per code and <= Rp200.000 in all.
// - Duitku is the strict provider: its callback passes
//   closedIntentNeedsOpenBill: true (as the Duitku webhook does); the intent row
//   gets provider = 'duitku'.
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

/** Provider double: one code (with a provider reference) per idempotency key. */
class FakeGateway implements PaymentGatewayPort {
  private readonly byKey = new Map<string, GatewayIntent>();
  constructor(readonly provider: Provider) {}
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
       VALUES ($1, $2, 'rsv1178-two', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
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
const key = () => `rsv-1178-two-${randomUUID()}`;

/** A DP booking (window 60 min) created at `createdAt`, on its own table. */
async function book(date: string, createdAt: Date) {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId: await floor(),
      guestName: "Tamu Dua Kode 1178",
      contactPhone: "081234567890",
    }),
    key(),
    createdAt,
  );
}
type Booked = Awaited<ReturnType<typeof book>>;

/** The guest opens the hosted page and a QRIS code (A) is created on the DP link. */
async function openIntent(created: Booked): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-1178-two-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** Code B on the same link: A's row copied (new id and idempotency key, pending). */
async function seedSecondIntent(firstIntentId: string): Promise<string> {
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
      [firstIntentId, `rsv-1178-two-pay-b-${randomUUID()}`],
    );
  });
  return rows[0]!.id;
}

const providerRefOf = (intentId: string) => `PROV-${intentId}`;

/** The code reached the provider (has a reference), has no answer and lapsed at `expiresAt`. */
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

/** Refund requests (any status) written for one intent. */
async function refundRows(intentId: string) {
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

/** Refund money still owed back or already returned: failed requests do not count. */
async function refundedSum(intentId: string): Promise<number> {
  return (await refundRows(intentId))
    .filter((refund) => refund.status !== "failed")
    .reduce((sum, refund) => sum + Number(refund.amount_idr), 0);
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

/** The cap after which an unanswered provider code no longer holds a booking. */
const capOf = (t0: Date) =>
  new Date(t0.getTime() + WINDOW_MIN * MINUTE + GATEWAY_POLL_WINDOW_MS);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv 1178 two",
  });
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

type Timing = "before sweep" | "after sweep";
type Order = "A then B" | "B then A";

const providers: Provider[] = ["doit", "duitku"];
const timings: Timing[] = ["before sweep", "after sweep"];
const orders: Order[] = ["A then B", "B then A"];
let cellDay = 0;
const nextDays = () => {
  cellDay += 1;
  const day = String(cellDay).padStart(2, "0");
  return { created: `2027-05-${day}`, reserved: `2027-11-${day}` };
};

for (const provider of providers) {
  describe(`legend-3dfri ${provider}: two codes on one DP link, both paid after the cap`, () => {
    beforeAll(() => {
      setPaymentGateway(new FakeGateway(provider));
    });

    for (const timing of timings) {
      for (const order of orders) {
        it(`legend-3dfri ${provider} ${timing}, events consumed ${order}: one DP refund for the code holding the money, none for the double payment`, async () => {
          const days = nextDays();
          const t0 = dayAt(days.created, "10:00");
          const created = await book(days.reserved, t0);
          const id = created.reservation.id;
          const intentA = await openIntent(created);
          const intentB = await seedSecondIntent(intentA);
          expect(intentB).not.toBe(intentA);
          const lapsedAt = new Date(t0.getTime() + 30 * MINUTE);
          await shapeUnanswered(intentA, lapsedAt, provider);
          await shapeUnanswered(intentB, lapsedAt, provider);
          const cap = capOf(t0);

          let paidA = new Date(cap.getTime() + MINUTE);
          if (timing === "after sweep") {
            const swept = await sweepAt(new Date(cap.getTime() + MINUTE));
            expect(swept.released).toContain(id);
            expect((await reservationRow(id)).status).toBe("cancelled");
            expect(await liveHolds(id)).toBe(0);
            paidA = new Date(cap.getTime() + 2 * MINUTE);
          } else {
            expect((await reservationRow(id)).status).toBe("pending_deposit");
          }
          const paidB = new Date(paidA.getTime() + MINUTE);

          // The guest paid the provider twice, both proven after the cap.
          await confirmAt(intentA, paidA, provider);
          await confirmAt(intentB, paidB, provider).catch(() => undefined);

          // A took the DP money and settled; B is a double payment parked as
          // unallocated funds. The booking is neither confirmed nor credited.
          const eventsA = await paidEvents(intentA);
          const eventsB = await paidEvents(intentB);
          expect(eventsA).toHaveLength(1);
          expect(eventsB.length).toBeLessThanOrEqual(1);
          expect(await unallocatedOf(intentA)).toEqual([]);
          // DOIT: B is parked as a double payment. Duitku-strict: the callback
          // for B on the already settled link is refused (BILL_CLOSED) and B
          // stays pending, so nothing is parked for it (observed behavior, see
          // the report); either way B has no paid event of its own to refund.
          const parkedB = await unallocatedOf(intentB);
          if (provider === "doit") expect(parkedB).toEqual([DP_IDR]);
          else expect([[], [DP_IDR]]).toContainEqual(parkedB);
          let row = await reservationRow(id);
          expect(row.status).not.toBe("confirmed");
          expect(row.deposit_payment_id).toBeNull();

          // The RSV-02 consumer handles the announced events in the given order.
          const events =
            order === "A then B"
              ? [...eventsA, ...eventsB]
              : [...eventsB, ...eventsA];
          for (const event of events)
            await handlePaymentPaid(tenantScope(), event);

          // Exactly one DP refund request, for the code holding the money, in
          // full; none for the double payment (its money returns via the fund).
          const refundsA = await refundRows(intentA);
          expect(refundsA).toHaveLength(1);
          expect(refundsA[0]).toMatchObject({
            amount_idr: String(DP_IDR),
            requested_by: RESERVATION_SYSTEM_ACTOR,
          });
          expect(await refundRows(intentB)).toHaveLength(0);
          row = await reservationRow(id);
          expect(row).toMatchObject({
            status: "cancelled",
            refund_status: "requested",
            // RSV-02 records the refunded DP on the booking when it asks for the refund.
            deposit_payment_id: intentA,
          });
          expect(row.refund_payment_refund_id).toBe(refundsA[0]!.id);
          expect(await liveHolds(id)).toBe(0);

          // Never return more than the provider received, per code and in all.
          const returnedA = await refundedSum(intentA);
          const returnedB =
            (await refundedSum(intentB)) +
            (await unallocatedOf(intentB)).reduce((s, n) => s + n, 0);
          expect(returnedA).toBeLessThanOrEqual(DP_IDR);
          expect(returnedB).toBeLessThanOrEqual(DP_IDR);
          expect(returnedA + returnedB).toBeLessThanOrEqual(2 * DP_IDR);

          // Replays (consumer again in both orders, provider message again) add
          // no event and no refund.
          for (const event of [...events].reverse())
            await handlePaymentPaid(tenantScope(), event);
          for (const event of events)
            await handlePaymentPaid(tenantScope(), event);
          await confirmAt(intentA, paidA, provider).catch(() => undefined);
          await confirmAt(intentB, paidB, provider).catch(() => undefined);
          expect(await paidEvents(intentA)).toHaveLength(1);
          expect(await paidEvents(intentB)).toHaveLength(eventsB.length);
          expect(await refundRows(intentA)).toHaveLength(1);
          expect(await refundRows(intentB)).toHaveLength(0);
          expect(await unallocatedOf(intentB)).toEqual(parkedB);
          expect(await unallocatedOf(intentA)).toEqual([]);
          row = await reservationRow(id);
          expect(row.status).toBe("cancelled");
          expect(row.refund_payment_refund_id).toBe(refundsA[0]!.id);
          expect(await liveHolds(id)).toBe(0);
        });
      }
    }
  });
}

// legend-3dfri follow-up (batch 1178), ONE code paid twice after the cap: the
// guest pays the same code a second time under a new provider transaction. The
// first transaction settles code A (it holds the DP money and is refunded once
// by the RSV-02 consumer); the second is parked as an unallocated fund on A and
// returned by the staff flow. The consumer must refund A once and not skip it
// because some other transaction is parked on A. Money returned stays within
// money received per transaction (Rp100.000 each, Rp200.000 in all).
//
// Assumptions (spec silent):
// - Two ways the second transaction reaches us: the provider poll reports it
//   as `extraPayments` of the answer about A, or a second verified callback for
//   A under a different provider reference. Paths are unchanged otherwise.
// - The first callback carries the code's own provider reference; the second
//   one a different reference. A rejected second callback (settled link) is
//   tolerated, the parked fund is what is asserted.
// - Both transactions are proven after the cap (cap + 1 minute and later).

type Path = "poll" | "callback";

/** Provider double: a status answer per provider reference, set by the test. */
class PaidTwiceGateway implements PaymentGatewayPort {
  private readonly byKey = new Map<string, GatewayIntent>();
  private readonly answers = new Map<
    string,
    { paidAt: string; extras: { providerRef: string; paidAt: string }[] }
  >();
  constructor(readonly provider: Provider) {}
  answer(
    providerRef: string,
    paidAt: Date,
    extras: { providerRef: string; paidAt: Date }[],
  ) {
    this.answers.set(providerRef, {
      paidAt: paidAt.toISOString(),
      extras: extras.map((extra) => ({
        providerRef: extra.providerRef,
        paidAt: extra.paidAt.toISOString(),
      })),
    });
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
    const answer = this.answers.get(input.providerRef);
    if (answer)
      return {
        status: "paid" as const,
        providerRef: input.providerRef,
        amountIdr: DP_IDR,
        paidAt: answer.paidAt,
        ...(this.provider === "duitku" ? { rawStatus: "00" } : {}),
        extraPayments: answer.extras.map((extra) => ({
          providerRef: extra.providerRef,
          amountIdr: DP_IDR,
          paidAt: extra.paidAt,
        })),
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

async function statusOf(intentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return rows[0]!.status;
}

/** A verified callback for `intentId` about one provider transaction. */
function confirmRef(
  intentId: string,
  at: Date,
  provider: Provider,
  providerRef: string,
) {
  return confirmPayment(
    tenantScope(),
    intentId,
    {
      source: "verified_webhook",
      method: "qris",
      amountIdr: DP_IDR,
      providerRef,
      at: at.toISOString(),
      receivedAt: at,
    },
    { type: "system" },
    at,
    provider === "duitku" ? { closedIntentNeedsOpenBill: true } : {},
  );
}

for (const provider of providers) {
  describe(`legend-3dfri ${provider}: one code paid twice after the cap`, () => {
    let gateway: PaidTwiceGateway;
    beforeAll(() => {
      gateway = new PaidTwiceGateway(provider);
      setPaymentGateway(gateway);
    });

    for (const path of ["poll", "callback"] as Path[]) {
      for (const timing of timings) {
        it(`legend-3dfri ${provider} ${path} ${timing}: one DP refund for the settled code, the second transaction stays a parked fund`, async () => {
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
          const codeRef = providerRefOf(intentId);
          const secondRef = `SECOND-${intentId}`;

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
          const secondAt = new Date(paidAt.getTime() + 10_000);

          const deliver = async () => {
            if (path === "poll") {
              gateway.answer(codeRef, paidAt, [
                { providerRef: secondRef, paidAt: secondAt },
              ]);
              await pollPendingGatewayIntents(
                tenantScope(),
                new Date(paidAt.getTime() + MINUTE),
                1000,
              );
            } else {
              await confirmRef(intentId, paidAt, provider, codeRef).catch(
                () => undefined,
              );
              await confirmRef(intentId, secondAt, provider, secondRef).catch(
                () => undefined,
              );
            }
          };
          await deliver();

          // The first transaction settled the code (one payment.paid event); the
          // second is parked once as a fund of Rp100.000 on the same code. The
          // booking is neither confirmed nor credited.
          expect(await statusOf(intentId)).toBe("paid");
          const events = await paidEvents(intentId);
          expect(events).toHaveLength(1);
          expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
          let row = await reservationRow(id);
          expect(row.status).not.toBe("confirmed");
          expect(row.deposit_payment_id).toBeNull();

          // The consumer refunds the DP of the settled code in full, once.
          const event = events[0]!;
          expect(await handlePaymentPaid(tenantScope(), event)).toBe(
            "late_refund_requested",
          );
          const refunds = await refundRows(intentId);
          expect(refunds).toHaveLength(1);
          expect(refunds[0]).toMatchObject({
            amount_idr: String(DP_IDR),
            requested_by: RESERVATION_SYSTEM_ACTOR,
          });
          row = await reservationRow(id);
          expect(row).toMatchObject({
            status: "cancelled",
            refund_status: "requested",
            deposit_payment_id: intentId,
          });
          expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
          expect(await liveHolds(id)).toBe(0);

          // Returned money: the settled transaction once through the refund, the
          // second through its fund; together at most the two payments received.
          const refunded = await refundedSum(intentId);
          const parked = (await unallocatedOf(intentId)).reduce(
            (sum, amount) => sum + amount,
            0,
          );
          expect(refunded).toBeLessThanOrEqual(DP_IDR);
          expect(parked).toBeLessThanOrEqual(DP_IDR);
          expect(refunded + parked).toBeLessThanOrEqual(2 * DP_IDR);

          // Replays (both provider messages again, consumer again) add nothing.
          await deliver();
          expect(await handlePaymentPaid(tenantScope(), event)).toBe(
            "unchanged",
          );
          await handlePaymentPaid(tenantScope(), event);
          expect(await paidEvents(intentId)).toHaveLength(1);
          expect(await refundRows(intentId)).toHaveLength(1);
          expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
          row = await reservationRow(id);
          expect(row.status).toBe("cancelled");
          expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
          expect(await liveHolds(id)).toBe(0);
        });
      }
    }
  });
}
