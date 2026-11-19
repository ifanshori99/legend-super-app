// legend-3dfri follow-up (batch 1178, round 3 item 2): the deposit sweep and a
// late DP proof (after the poll-window cap) run AT THE SAME TIME on two real
// pool connections / transactions. Whoever wins, the guest's single Rp100.000
// DP must end up as: booking cancelled (never confirmed), no live holds,
// exactly one payment.paid event, exactly one DP refund request of Rp100.000
// raised by RSV-02 (system actor), total refund <= money received, nothing
// parked as unallocated funds, and no deadlock. Replays (the consumer run twice
// at once, then again) add nothing.
// Against PostgreSQL with the real booking, deposit port, sweep, payment
// confirmation / polling and RSV-02 consumer; only the gateway is a double.
//
// Assumptions (spec silent):
// - Each iteration is a fresh booking; the sweep (all due rows of the outlet)
//   and the proof are started together behind one gate, with a small per
//   iteration start skew (0, 0, 2, 5 ms, either side first) so the transactions
//   overlap in different interleavings. Every iteration repeats the whole
//   scenario (10 per provider and path).
// - Both sides use the same instant (cap + 1 minute) as service clock, and the
//   provider's own pay time (callback `at` / poll `paidAt`) is also after the
//   cap, so the proof counts as late whichever side commits first.
// - "Callback" = verified webhook (`confirmPayment`; the Duitku strict option
//   `closedIntentNeedsOpenBill: true` as the Duitku webhook passes it).
//   "Poll" = `pollPendingGatewayIntents` answering `paid` with the provider
//   clock. Both end in the same state, so the same assertions apply.
// - A deadlock (Postgres 40P01) or a sweep / proof that fails is a finding and
//   fails the test with the error shown; a sweep or proof that hangs more
//   than 30 s is reported as a suspected deadlock.
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

/** Provider double: one code per idempotency key; paid answers are set per provider reference. */
class BarrierGateway implements PaymentGatewayPort {
  private readonly byKey = new Map<string, GatewayIntent>();
  private readonly paid = new Map<string, string>();
  constructor(readonly provider: Provider) {}
  answerPaid(providerRef: string, paidAt: Date) {
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
       VALUES ($1, $2, 'rsv1178-barrier', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
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
const key = () => `rsv-1178-barrier-${randomUUID()}`;

/** A DP booking (window 60 min) created at `createdAt`, on its own table. */
async function book(date: string, createdAt: Date) {
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId: await floor(),
      guestName: "Tamu Barrier 1178",
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
      idempotencyKey: `rsv-1178-barrier-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
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
    label: "Rsv 1178 barrier",
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

async function statusOf(intentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return rows[0]!.status;
}

const providers: Provider[] = ["doit", "duitku"];
type Path = "callback" | "poll";
const paths: Path[] = ["callback", "poll"];
const ITERATIONS = 10;
const HANG_MS = 30_000;
const SKEW_MS = [0, 0, 2, 5];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fails with a clear message when a side does not finish (suspected deadlock). */
function guarded<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} did not finish in ${HANG_MS} ms: suspected deadlock`,
          ),
        ),
      HANG_MS,
    );
  });
  return Promise.race([work, hang]).finally(() => clearTimeout(timer));
}

/** Each iteration gets its own calendar day so bookings never collide. */
let dayCounter = 0;
function nextDays() {
  dayCounter += 1;
  const created = new Date(Date.UTC(2027, 0, 1) + dayCounter * 86_400_000);
  const reserved = new Date(created.getTime() + 190 * 86_400_000);
  return {
    created: created.toISOString().slice(0, 10),
    reserved: reserved.toISOString().slice(0, 10),
  };
}

for (const provider of providers) {
  for (const path of paths) {
    describe(`legend-3dfri ${provider} ${path}: sweep and late DP proof on two connections at once`, () => {
      let gateway: BarrierGateway;
      beforeAll(() => {
        gateway = new BarrierGateway(provider);
        setPaymentGateway(gateway);
      });

      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        it(
          `legend-3dfri ${provider} ${path} iteration ${iteration + 1}: one DP refund of Rp100.000, cancelled, no holds, one payment.paid`,
          { timeout: 90_000 },
          async () => {
            const days = nextDays();
            const t0 = dayAt(days.created, "10:00");
            const created = await book(days.reserved, t0);
            const id = created.reservation.id;
            const intentId = await openIntent(created);
            // The code reached the provider, never got an answer and lapsed.
            await shapeUnanswered(
              intentId,
              new Date(t0.getTime() + 30 * MINUTE),
              provider,
            );
            const cap = capOf(t0);
            const proofAt = new Date(cap.getTime() + MINUTE);
            expect((await reservationRow(id)).status).toBe("pending_deposit");
            gateway.answerPaid(providerRefOf(intentId), proofAt);

            // Two real connections: both sides wait at one gate, then run.
            let open!: () => void;
            const gate = new Promise<void>((resolve) => {
              open = resolve;
            });
            const skew = SKEW_MS[iteration % SKEW_MS.length]!;
            const sweepFirst = iteration % 2 === 0;
            const sweep = guarded(
              "sweep",
              (async () => {
                await gate;
                if (!sweepFirst) await sleep(skew);
                return sweepAt(proofAt);
              })(),
            );
            const proof = guarded(
              "late DP proof",
              (async () => {
                await gate;
                if (sweepFirst) await sleep(skew);
                if (path === "callback")
                  return confirmAt(intentId, proofAt, provider);
                return pollPendingGatewayIntents(
                  tenantScope(),
                  new Date(proofAt.getTime() + MINUTE),
                  1000,
                );
              })(),
            );
            open();
            const [sweepResult, proofResult] = await Promise.allSettled([
              sweep,
              proof,
            ]);
            // A deadlock or any failure on either side is a finding.
            expect(
              sweepResult.status === "rejected"
                ? String(sweepResult.reason)
                : "sweep ok",
            ).toBe("sweep ok");
            expect(
              proofResult.status === "rejected"
                ? String(proofResult.reason)
                : "proof ok",
            ).toBe("proof ok");

            // The booking is cancelled, never confirmed, nothing held.
            let row = await reservationRow(id);
            expect(row.status).toBe("cancelled");
            expect(await liveHolds(id)).toBe(0);
            // The code settled exactly once; nothing parked for it.
            expect(await statusOf(intentId)).toBe("paid");
            const events = await paidEvents(intentId);
            expect(events).toHaveLength(1);
            expect(await unallocatedOf(intentId)).toEqual([]);

            // RSV-02: the consumer runs twice at once (two connections), then again.
            const event = events[0]!;
            await Promise.all([
              guarded("consumer 1", handlePaymentPaid(tenantScope(), event)),
              guarded("consumer 2", handlePaymentPaid(tenantScope(), event)),
            ]);
            await handlePaymentPaid(tenantScope(), event);

            const refunds = await refundRows(intentId);
            expect(refunds).toHaveLength(1);
            expect(refunds[0]).toMatchObject({
              amount_idr: String(DP_IDR),
              requested_by: RESERVATION_SYSTEM_ACTOR,
            });
            // Never return more than the provider received.
            expect(await refundedSum(intentId)).toBeLessThanOrEqual(DP_IDR);
            row = await reservationRow(id);
            expect(row).toMatchObject({
              status: "cancelled",
              refund_status: "requested",
              deposit_payment_id: intentId,
            });
            expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
            expect(await liveHolds(id)).toBe(0);

            // Replays (sweep, proof, consumer again) add nothing.
            await sweepAt(new Date(proofAt.getTime() + MINUTE));
            await (path === "callback"
              ? confirmAt(intentId, proofAt, provider).catch(() => undefined)
              : pollPendingGatewayIntents(
                  tenantScope(),
                  new Date(proofAt.getTime() + 2 * MINUTE),
                  1000,
                ));
            await handlePaymentPaid(tenantScope(), event);
            expect(await paidEvents(intentId)).toHaveLength(1);
            expect(await refundRows(intentId)).toHaveLength(1);
            expect(await unallocatedOf(intentId)).toEqual([]);
            row = await reservationRow(id);
            expect(row.status).toBe("cancelled");
            expect(row.refund_payment_refund_id).toBe(refunds[0]!.id);
            expect(await liveHolds(id)).toBe(0);
          },
        );
      }
    });
  }
}
