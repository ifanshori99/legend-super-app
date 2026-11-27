// legend-3dfri follow-up (batch 1178, round 3, item 1): Duitku STRICT, a second
// code on a DP link that is already settled. The guest paid twice after the
// poll-window cap: code A settles the DP link (and is refunded once by the RSV-02
// consumer); the callback for code B is refused (the bill is closed) and its
// money must be recorded as ONE unallocated fund of Rp100.000, so staff can
// return it. This goes through the REAL Duitku webhook route
// (POST /api/webhooks/payments/duitku/:tenantId, signed form, transactionStatus
// answered by a fetch stub), not through confirmPayment directly.
// Against PostgreSQL with the real booking, deposit port, sweep and webhook.
//
// Assumptions (spec silent):
// - Time is the REAL clock here (the webhook stamps its own receipt time): the
//   booking is made now, then the link and code expiries are moved back in SQL so
//   that the cap (latest expiry + 24 hours) passed 30 minutes ago.
// - Code B is a copy of code A's payment_intents row (new id, new provider
//   reference, pending, lapsed): a second code opened while the link was open.
// - The Duitku integration is seeded for the seeded tenant and removed again.
// - A rejected callback answers 200 (the provider must not retry forever); what
//   is asserted is the stored outcome, not the HTTP body.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import { createReservationInputSchema } from "@starter/shared/reservation";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { reprocessDuitkuWebhookEvents } from "../services/payment-duitku-webhook.service";
import {
  createIntent,
  GATEWAY_POLL_WINDOW_MS,
} from "../services/payment.service.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
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
const MERCHANT = "DS1178";
const apiKey = `duitku-key-${randomBytes(12).toString("hex")}`;
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
const webhookScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "webhook",
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

/** Provider double for creating the first code only (the webhook needs none). */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "duitku" as const;
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

// ---------------------------------------------------------------------------
// Duitku transactionStatus (the only outbound call of the webhook path)
// ---------------------------------------------------------------------------

type StatusAnswer = {
  statusCode: "00" | "01" | "02";
  reference: string | null;
  amount: string;
};
/** Answer per merchantOrderId (the intent id). */
const statusAnswers = new Map<string, StatusAnswer>();
const realFetch = globalThis.fetch;

function stubDuitku() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/transactionStatus"))
        return realFetch(input as string, init);
      const body = JSON.parse(String(init?.body)) as {
        merchantOrderId: string;
      };
      const answer = statusAnswers.get(body.merchantOrderId);
      if (!answer) return new Response("nope", { status: 404 });
      return new Response(
        JSON.stringify({ merchantOrderId: body.merchantOrderId, ...answer }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

let app: ReturnType<typeof createApp>;
let staff: Staff;
let integrationId = "";
let duitkuAddedToPlan = false;
const zoneIds: string[] = [];
const tableIds: string[] = [];

/** The signed Duitku callback form for one code (merchantOrderId = intent id). */
function callback(intentId: string, reference: string) {
  const amount = String(DP_IDR);
  const form = new URLSearchParams({
    merchantCode: MERCHANT,
    amount,
    merchantOrderId: intentId,
    resultCode: "00",
    signature: hmac(`${MERCHANT}${amount}${intentId}`, apiKey),
    reference,
  });
  return request(app)
    .post(`/api/webhooks/payments/duitku/${seededTenantId}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(form.toString());
}

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
       VALUES ($1, $2, 'rsv1178-duitku', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
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

const key = () => `rsv-1178-duitku-${randomUUID()}`;

/** A DP booking (window 60 min) made now, a week ahead, on its own table. */
async function book() {
  const day = new Date(Date.now() + 7 * 24 * 60 * MINUTE).toLocaleDateString(
    "en-CA",
    { timeZone: WIB },
  );
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(day, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: await floor(),
      guestName: "Tamu Duitku Kode Kedua 1178",
      contactPhone: "081234567890",
    }),
    key(),
    new Date(),
  );
}
type Booked = Awaited<ReturnType<typeof book>>;

async function openIntent(created: Booked): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-1178-duitku-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** Code B on the same link: A's row copied (new id and idempotency key). */
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
      [firstIntentId, `rsv-1178-duitku-pay-b-${randomUUID()}`],
    );
  });
  return rows[0]!.id;
}

const referenceOf = (intentId: string) => `DSREF-${intentId}`;

/**
 * Both codes reached Duitku (own reference, minting integration), got no answer
 * and lapsed; the reservation link and the codes expired so that the poll-window
 * cap passed 30 minutes ago.
 */
async function lapsePastCap(
  reservationId: string,
  linkId: string,
  intentIds: string[],
) {
  const lapsedAt = new Date(Date.now() - GATEWAY_POLL_WINDOW_MS - 30 * MINUTE);
  await asOwner(async (client) => {
    await client.query(
      "UPDATE reservations SET deposit_link_expires_at = $2 WHERE id = $1",
      [reservationId, lapsedAt],
    );
    await client.query(
      "UPDATE payment_links SET expires_at = $2 WHERE id = $1",
      [linkId, lapsedAt],
    );
    for (const id of intentIds)
      await client.query(
        `UPDATE payment_intents
            SET status = 'pending', expires_at = $2, provider = 'duitku',
                provider_ref = $3, provider_final_at = NULL,
                gateway_integration_id = $4
          WHERE id = $1`,
        [id, lapsedAt, referenceOf(id), integrationId],
      );
  });
}

async function linkIdOf(reservationId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ id: string }>(
      "SELECT deposit_payment_link_id AS id FROM reservations WHERE id = $1",
      [reservationId],
    ),
  );
  return rows[0]!.id;
}

async function sweepNow() {
  return withTenant(db, tenantScope(), (tx) =>
    sweepStaleDepositHolds(tx, tenantScope(), new Date(), {
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

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    ),
  );
  return rows[0]!.status;
}

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

async function webhookRows(intentId: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; last_error_code: string | null }>(
      `SELECT status, last_error_code FROM gateway_webhook_events
        WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2
        ORDER BY created_at`,
      [seededTenantId, intentId],
    ),
  );
  return rows;
}

/** Moves the stored deliveries past the repeat re-check window. */
async function ageRows(intentId: string) {
  await asOwner((client) =>
    client.query(
      `UPDATE gateway_webhook_events
          SET updated_at = updated_at - interval '2 minutes'
        WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2`,
      [seededTenantId, intentId],
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv 1178 duitku",
  });
  setReservationDepositPort(createPaymentReservationDepositPort());
  setPaymentGateway(new FakeGateway());
  await setPolicy();

  // The Duitku integration of the seeded tenant (strict provider).
  const { rowCount } = await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
              (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
      WHERE id = $1
        AND NOT (feature_flags->'integrationProviders') ? 'duitku'`,
    [seededTenantId],
  );
  duitkuAddedToPlan = (rowCount ?? 0) > 0;
  const created = await upsertIntegration(
    tenantScope(),
    {
      outletId: null,
      provider: "duitku",
      config: {
        environment: "sandbox",
        notificationEmail: "owner@example.test",
      },
      credentials: { merchantCode: MERCHANT, apiKey },
    },
    randomUUID(),
  );
  await setIntegrationStatus(
    tenantScope(),
    created.id,
    { status: "active" },
    randomUUID(),
  );
  integrationId = created.id;
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
      "gateway_webhook_events",
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
  if (integrationId)
    await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId,
    ]);
  if (duitkuAddedToPlan)
    await owner.query(
      `UPDATE tenants
          SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                (feature_flags->'integrationProviders') - 'duitku')
        WHERE id = $1`,
      [seededTenantId],
    );
  await owner.end();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  statusAnswers.clear();
  stubDuitku();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Timing = "before sweep" | "after sweep";
const timings: Timing[] = ["before sweep", "after sweep"];

describe("legend-3dfri duitku strict: a second code on a settled DP link, through the real webhook", () => {
  for (const timing of timings) {
    it(`legend-3dfri duitku ${timing}: code B's callback is refused as BILL_CLOSED and its money is parked exactly once`, async () => {
      const created = await book();
      const id = created.reservation.id;
      const intentA = await openIntent(created);
      const intentB = await seedSecondIntent(intentA);
      expect(intentB).not.toBe(intentA);
      await lapsePastCap(id, await linkIdOf(id), [intentA, intentB]);
      for (const code of [intentA, intentB])
        statusAnswers.set(code, {
          statusCode: "00",
          reference: referenceOf(code),
          amount: String(DP_IDR),
        });

      if (timing === "after sweep") {
        const swept = await sweepNow();
        expect(swept.released).toContain(id);
        expect((await reservationRow(id)).status).toBe("cancelled");
        expect(await liveHolds(id)).toBe(0);
      } else {
        expect((await reservationRow(id)).status).toBe("pending_deposit");
      }

      // Code A's callback arrives first, after the cap: it settles the link.
      expect((await callback(intentA, referenceOf(intentA))).status).toBe(200);
      expect(await intentStatus(intentA)).toBe("paid");
      const eventsA = await paidEvents(intentA);
      expect(eventsA).toHaveLength(1);
      expect(await unallocatedOf(intentA)).toEqual([]);

      // Code B's callback arrives on the now settled link: refused, never paid,
      // and the Rp100.000 the provider took is recorded as ONE unallocated fund.
      expect((await callback(intentB, referenceOf(intentB))).status).toBe(200);
      expect(await intentStatus(intentB)).not.toBe("paid");
      expect(await paidEvents(intentB)).toHaveLength(0);
      expect((await webhookRows(intentB))[0]?.last_error_code).toBe(
        "REJECTED_BILL_CLOSED",
      );
      expect(await unallocatedOf(intentB)).toEqual([DP_IDR]);

      // A replay of B's callback, a later repeat after the re-check window and
      // the reprocess worker add no second fund row.
      expect((await callback(intentB, referenceOf(intentB))).status).toBe(200);
      await ageRows(intentB);
      expect((await callback(intentB, referenceOf(intentB))).status).toBe(200);
      await ageRows(intentB);
      await reprocessDuitkuWebhookEvents(
        webhookScope(),
        new Date(Date.now() + 10 * MINUTE),
      );
      expect(await unallocatedOf(intentB)).toEqual([DP_IDR]);
      expect(await unallocatedOf(intentA)).toEqual([]);
      expect(await paidEvents(intentB)).toHaveLength(0);

      // The booking is neither confirmed nor credited by the double payment.
      let row = await reservationRow(id);
      expect(row.status).not.toBe("confirmed");
      expect(row.deposit_payment_id).toBeNull();

      // The consumer refunds the DP of code A once (the code that settled); the
      // double payment of B is returned through its fund, never a second refund.
      expect(await handlePaymentPaid(tenantScope(), eventsA[0]!)).toBe(
        "late_refund_requested",
      );
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
        deposit_payment_id: intentA,
      });
      expect(row.refund_payment_refund_id).toBe(refundsA[0]!.id);
      expect(await liveHolds(id)).toBe(0);

      // Money returned never exceeds money received: A refunded once, B parked
      // once, together at most the Rp200.000 the provider took.
      const returned =
        (await refundRows(intentA))
          .filter((refund) => refund.status !== "failed")
          .reduce((sum, refund) => sum + Number(refund.amount_idr), 0) +
        (await unallocatedOf(intentB)).reduce((sum, n) => sum + n, 0);
      expect(returned).toBeLessThanOrEqual(2 * DP_IDR);

      // Replaying A's callback and event changes nothing.
      expect((await callback(intentA, referenceOf(intentA))).status).toBe(200);
      await handlePaymentPaid(tenantScope(), eventsA[0]!);
      expect(await paidEvents(intentA)).toHaveLength(1);
      expect(await refundRows(intentA)).toHaveLength(1);
      expect(await unallocatedOf(intentA)).toEqual([]);
      expect(await unallocatedOf(intentB)).toEqual([DP_IDR]);
    });
  }
});
