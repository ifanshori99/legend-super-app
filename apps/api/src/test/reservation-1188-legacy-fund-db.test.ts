// legend-qs2r4 (batch 1188, second opinion 1186 P2): the late-DP refund
// (RSV-02 consumer) must skip ONLY on proof that the settling transaction of the
// code is parked in full as a `double_payment` fund: (a) the fund carries the
// settling transaction's evidence, or (b) a legacy fund (no evidence) of at
// least the code's amount whose link has ANOTHER paid code holding the money.
// Anything else (a legacy `overpayment` fund, a legacy second transaction on the
// same code, funds without evidence) must NOT hold back the refund of the
// allocated Rp100.000. Money returned (refund + parked) never exceeds money
// received. Against PostgreSQL with the real booking, deposit port, sweep and
// payment confirmation; only the gateway is a double. Legacy funds are made by
// setting evidence_id to NULL on the fund the current writer recorded (what the
// older writer left behind).
//
// Assumptions (spec silent):
// - Scenario 1 (overpayment, evidence NULL) and 2 (second transaction on the
//   same code, double_payment, evidence NULL, code A the only paid code on the
//   link) run for DOIT and Duitku-strict, before and after the sweep.
// - Scenario 2 reaches the second transaction through the provider poll
//   (`extraPayments`), which both providers accept after the cap.
// - Scenarios 3 and 4 (legacy / control for code B) run on DOIT only: under
//   Duitku-strict the callback for B on a settled link is refused (BILL_CLOSED),
//   so B has no paid event and no fund to be legacy about.
// - Scenario 4 is the control: the fund keeps its evidence and the consumer
//   still skips B (the 1178 two-late-codes behavior stays green).
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
       VALUES ($1, $2, 'rsv1188-legacy', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
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
const key = () => `rsv-1188-${randomUUID()}`;

/** A DP booking (window 60 min) created at `createdAt`, on its own table. */
async function book(date: string, createdAt: Date) {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId: await floor(),
      guestName: "Tamu Dana Lama 1188",
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
      idempotencyKey: `rsv-1188-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** Code B on the same link: A's row copied (new id and idempotency key, pending). */
async function seedSecondIntent(firstIntentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ id: string }>(
      `INSERT INTO payment_intents
         SELECT (jsonb_populate_record(null::payment_intents,
                 to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'idempotency_key', $2::text, 'status', 'pending', 'paid_at', NULL))).*
           FROM payment_intents p WHERE p.id = $1
       RETURNING id`,
      [firstIntentId, `rsv-1188-pay-b-${randomUUID()}`],
    ),
  );
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
    label: "Rsv 1188 legacy",
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
const providers: Provider[] = ["doit", "duitku"];
const timings: Timing[] = ["before sweep", "after sweep"];
let cellDay = 0;
const nextDays = () => {
  cellDay += 1;
  const day = String(cellDay).padStart(2, "0");
  return { created: `2027-08-${day}`, reserved: `2027-12-${day}` };
};

async function statusOf(intentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return rows[0]!.status;
}

const PAID_OVER_IDR = 150_000;
const EXCESS_IDR = PAID_OVER_IDR - DP_IDR;

async function fundsOf(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      amount_idr: string;
      reason: string;
      evidence_id: string | null;
    }>(
      "SELECT amount_idr::text, reason, evidence_id FROM payment_unallocated_funds WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  return rows;
}

/** Meet the older writer: the fund of the intent has no evidence reference. */
async function makeLegacy(intentId: string) {
  await asOwner((client) =>
    client.query(
      "UPDATE payment_unallocated_funds SET evidence_id = NULL WHERE payment_intent_id = $1",
      [intentId],
    ),
  );
  for (const fund of await fundsOf(intentId))
    expect(fund.evidence_id).toBeNull();
}

const sumOf = (amounts: number[]) => amounts.reduce((s, n) => s + n, 0);

// Scenario 1: overpayment fund without evidence.
for (const provider of providers) {
  describe(`legend-qs2r4 ${provider}: legacy overpayment fund`, () => {
    beforeAll(() => {
      setPaymentGateway(new FakeGateway(provider));
    });
    for (const timing of timings) {
      it(`legend-qs2r4 ${provider} ${timing}: an overpayment fund without evidence does not hold back the DP refund`, async () => {
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
        let paidAt = new Date(cap.getTime() + MINUTE);
        if (timing === "after sweep") {
          const swept = await sweepAt(new Date(cap.getTime() + MINUTE));
          expect(swept.released).toContain(id);
          expect((await reservationRow(id)).status).toBe("cancelled");
          paidAt = new Date(cap.getTime() + 2 * MINUTE);
        }
        const pay = (at: Date) =>
          confirmPayment(
            tenantScope(),
            intentId,
            {
              source: "verified_webhook",
              method: "qris",
              amountIdr: PAID_OVER_IDR,
              providerRef: providerRefOf(intentId),
              at: at.toISOString(),
              receivedAt: at,
            },
            { type: "system" },
            at,
            provider === "duitku" ? { closedIntentNeedsOpenBill: true } : {},
          );
        await pay(paidAt);
        const events = await paidEvents(intentId);
        expect(events).toHaveLength(1);
        const funds = await fundsOf(intentId);
        expect(funds).toHaveLength(1);
        expect(funds[0]).toMatchObject({
          amount_idr: String(EXCESS_IDR),
          reason: "overpayment",
        });
        await makeLegacy(intentId);
        expect((await reservationRow(id)).status).not.toBe("confirmed");

        expect(await handlePaymentPaid(tenantScope(), events[0]!)).toBe(
          "late_refund_requested",
        );
        const refunds = await refundRows(intentId);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({
          amount_idr: String(DP_IDR),
          requested_by: RESERVATION_SYSTEM_ACTOR,
        });
        let row = await reservationRow(id);
        expect(row).toMatchObject({
          status: "cancelled",
          refund_status: "requested",
          deposit_payment_id: intentId,
        });
        expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
        expect(await liveHolds(id)).toBe(0);
        expect(await unallocatedOf(intentId)).toEqual([EXCESS_IDR]);
        expect(
          (await refundedSum(intentId)) + sumOf(await unallocatedOf(intentId)),
        ).toBeLessThanOrEqual(PAID_OVER_IDR);

        // Replays add nothing.
        expect(await handlePaymentPaid(tenantScope(), events[0]!)).toBe(
          "unchanged",
        );
        await pay(paidAt).catch(() => undefined);
        expect(await paidEvents(intentId)).toHaveLength(1);
        expect(await refundRows(intentId)).toHaveLength(1);
        expect(await unallocatedOf(intentId)).toEqual([EXCESS_IDR]);
        row = await reservationRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
      });
    }
  });
}

// Scenario 2: legacy double_payment fund for a second transaction on the SAME
// code; that code is the only paid intent on the link.
type Answer = {
  paidAt: string;
  extras: { providerRef: string; paidAt: string }[];
};

class PaidTwiceGateway implements PaymentGatewayPort {
  private readonly byKey = new Map<string, GatewayIntent>();
  private readonly answers = new Map<string, Answer>();
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

for (const provider of providers) {
  describe(`legend-qs2r4 ${provider}: legacy second transaction on the same code`, () => {
    let gateway: PaidTwiceGateway;
    beforeAll(() => {
      gateway = new PaidTwiceGateway(provider);
      setPaymentGateway(gateway);
    });
    for (const timing of timings) {
      it(`legend-qs2r4 ${provider} ${timing}: a legacy double_payment fund on the settled code does not hold back its DP refund`, async () => {
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
        let paidAt = new Date(cap.getTime() + MINUTE);
        if (timing === "after sweep") {
          const swept = await sweepAt(new Date(cap.getTime() + MINUTE));
          expect(swept.released).toContain(id);
          expect((await reservationRow(id)).status).toBe("cancelled");
          paidAt = new Date(cap.getTime() + 2 * MINUTE);
        }
        const secondAt = new Date(paidAt.getTime() + 10_000);
        const deliver = async () => {
          gateway.answer(providerRefOf(intentId), paidAt, [
            { providerRef: `SECOND-${intentId}`, paidAt: secondAt },
          ]);
          await pollPendingGatewayIntents(
            tenantScope(),
            new Date(paidAt.getTime() + MINUTE),
            1000,
          );
        };
        await deliver();

        expect(await statusOf(intentId)).toBe("paid");
        const events = await paidEvents(intentId);
        expect(events).toHaveLength(1);
        const funds = await fundsOf(intentId);
        expect(funds).toHaveLength(1);
        expect(funds[0]).toMatchObject({
          amount_idr: String(DP_IDR),
          reason: "double_payment",
        });
        await makeLegacy(intentId);

        // The code is the only paid intent on its link: nothing proves its own
        // transaction is parked, so the DP is refunded once.
        expect(await handlePaymentPaid(tenantScope(), events[0]!)).toBe(
          "late_refund_requested",
        );
        const refunds = await refundRows(intentId);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({
          amount_idr: String(DP_IDR),
          requested_by: RESERVATION_SYSTEM_ACTOR,
        });
        let row = await reservationRow(id);
        expect(row).toMatchObject({
          status: "cancelled",
          refund_status: "requested",
          deposit_payment_id: intentId,
        });
        expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
        expect(await liveHolds(id)).toBe(0);
        expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
        expect(
          (await refundedSum(intentId)) + sumOf(await unallocatedOf(intentId)),
        ).toBeLessThanOrEqual(2 * DP_IDR);

        // Replays add nothing.
        expect(await handlePaymentPaid(tenantScope(), events[0]!)).toBe(
          "unchanged",
        );
        await deliver();
        expect(await paidEvents(intentId)).toHaveLength(1);
        expect(await refundRows(intentId)).toHaveLength(1);
        expect(await unallocatedOf(intentId)).toEqual([DP_IDR]);
        row = await reservationRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
      });
    }
  });
}

// Scenarios 3 and 4: two codes on one link, both paid after the cap (DOIT).
// Code B's fund is a legacy one (evidence NULL, scenario 3) or keeps its
// evidence (scenario 4, control). Either way only A is refunded by the consumer.
type Order = "A then B" | "B then A";
const orders: Order[] = ["A then B", "B then A"];

describe("legend-qs2r4 doit: second code on one link, fund of code B", () => {
  beforeAll(() => {
    setPaymentGateway(new FakeGateway("doit"));
  });
  for (const legacy of [true, false]) {
    for (const timing of timings) {
      for (const order of orders) {
        it(`legend-qs2r4 doit ${legacy ? "legacy fund (evidence NULL)" : "control (fund keeps evidence)"} ${timing}, events ${order}: one DP refund for A, none for B`, async () => {
          const days = nextDays();
          const t0 = dayAt(days.created, "10:00");
          const created = await book(days.reserved, t0);
          const id = created.reservation.id;
          const intentA = await openIntent(created);
          const intentB = await seedSecondIntent(intentA);
          const lapsedAt = new Date(t0.getTime() + 30 * MINUTE);
          await shapeUnanswered(intentA, lapsedAt, "doit");
          await shapeUnanswered(intentB, lapsedAt, "doit");
          const cap = capOf(t0);
          let paidA = new Date(cap.getTime() + MINUTE);
          if (timing === "after sweep") {
            const swept = await sweepAt(new Date(cap.getTime() + MINUTE));
            expect(swept.released).toContain(id);
            expect((await reservationRow(id)).status).toBe("cancelled");
            paidA = new Date(cap.getTime() + 2 * MINUTE);
          }
          const paidB = new Date(paidA.getTime() + MINUTE);
          await confirmAt(intentA, paidA, "doit");
          await confirmAt(intentB, paidB, "doit");

          const eventsA = await paidEvents(intentA);
          const eventsB = await paidEvents(intentB);
          expect(eventsA).toHaveLength(1);
          expect(eventsB).toHaveLength(1);
          const fundsB = await fundsOf(intentB);
          expect(fundsB).toHaveLength(1);
          expect(fundsB[0]).toMatchObject({
            amount_idr: String(DP_IDR),
            reason: "double_payment",
          });
          if (legacy) await makeLegacy(intentB);
          else expect(fundsB[0]!.evidence_id).not.toBeNull();
          expect(await unallocatedOf(intentA)).toEqual([]);

          const events =
            order === "A then B"
              ? [...eventsA, ...eventsB]
              : [...eventsB, ...eventsA];
          for (const event of events)
            await handlePaymentPaid(tenantScope(), event);

          const refundsA = await refundRows(intentA);
          expect(refundsA).toHaveLength(1);
          expect(refundsA[0]).toMatchObject({
            amount_idr: String(DP_IDR),
            requested_by: RESERVATION_SYSTEM_ACTOR,
          });
          expect(await refundRows(intentB)).toHaveLength(0);
          let row = await reservationRow(id);
          expect(row).toMatchObject({
            status: "cancelled",
            refund_status: "requested",
            deposit_payment_id: intentA,
          });
          expect(row.refund_payment_refund_id).toBe(refundsA[0]!.id);
          expect(await liveHolds(id)).toBe(0);

          const returned =
            (await refundedSum(intentA)) +
            (await refundedSum(intentB)) +
            sumOf(await unallocatedOf(intentA)) +
            sumOf(await unallocatedOf(intentB));
          expect(returned).toBeLessThanOrEqual(2 * DP_IDR);

          // Replays in both orders add nothing.
          for (const event of [...events].reverse())
            await handlePaymentPaid(tenantScope(), event);
          for (const event of events)
            await handlePaymentPaid(tenantScope(), event);
          expect(await refundRows(intentA)).toHaveLength(1);
          expect(await refundRows(intentB)).toHaveLength(0);
          expect(await unallocatedOf(intentB)).toEqual([DP_IDR]);
          row = await reservationRow(id);
          expect(row.refund_payment_refund_id).toBe(refundsA[0]!.id);
        });
      }
    }
  }
});
