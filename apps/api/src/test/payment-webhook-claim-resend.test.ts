// Sub-brief 1167 P3, card tipkj: stored DOIT webhook events are processed under
// an atomic claim, so two parties never process the same row twice.
//
// Contract under test:
// 1. A resend (a genuine retry delivery of an event id whose row is still
//    received/failed) claims the row atomically before processing. When another
//    party claimed the row in the meantime, the resend does not process it: the
//    bill is not paid by the resend, the row is left to its claimer.
//    Concurrent resends of one event record the payment exactly once.
// 2. `markRow` never overwrites a `processed` row with `failed`; a received row
//    still moves to failed normally.
// 3. The parked recurring-invoice sweep claims a row before processing it: two
//    sweeps (or a sweep that lost the claim) never process the same event twice.
//
// ASSUMPTIONS
// - "Another party claimed the row" is simulated like in
//   payment-webhook-retry-integration.test.ts: a competing transaction holds the
//   row lock, the contender blocks on it, the competitor then touches
//   `updated_at` (what a claim does) and commits. The contender must then skip.
// - Claim semantics (coordinator, after the architect): a claim sets status
//   `received` and `updated_at = now`; a row is claimable when it is `failed`,
//   or `received` and idle for more than WEBHOOK_STUCK_RECEIVED_MS (5 min). So
//   a `received` row that must be processable is stored 10 minutes idle (wide
//   margin), a freshly claimed one is stored idle 0.
// - A resend that lost the claim answers body status "duplicate" (coordinator);
//   in the competing-transaction test only "not processed" is pinned, because
//   the answer there may also be a plain in-progress result.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  markRow,
  reprocessParkedRecurringEvents,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent } from "./helpers";
import { BILL_TOTAL, FakeDoit } from "./payment-webhook-fake-doit";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();

const apiKey = `doit-key-claim-${randomBytes(12).toString("hex")}`;
const secret = `whsec-claim-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
const eventIds: string[] = [];
const planIds: string[] = [];
const subIds: string[] = [];
let integrationId = "";

const doit = new FakeDoit(apiKey);
const unique = () => randomBytes(4).toString("hex");
const newEventId = () => `evt_${randomBytes(8).toString("hex")}`;

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
    { kind: "tenant" },
  );
}

function outletContext(outletIds: readonly OutletId[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  const created = await upsertIntegration(
    contextFor("session"),
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor("session"),
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  integrationIds.push(created.id);
  setPaymentGateway(
    createDoitGateway({
      loadCredentials: async () => ({
        integration: {
          id: integrationId,
          outletId: null,
          config: { baseUrl: doit.baseUrl },
        },
        credentials: { apiKey, webhookSecret: secret },
      }),
    }),
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  await owner.query(
    "DELETE FROM subscription_invoices WHERE subscription_id = ANY($1::uuid[])",
    [subIds],
  );
  await owner.query(
    "DELETE FROM payment_recurring_subscriptions WHERE id = ANY($1::uuid[])",
    [subIds],
  );
  await owner.query(
    "DELETE FROM payment_recurring_plans WHERE id = ANY($1::uuid[])",
    [planIds],
  );
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
    [tenantA, eventIds],
  );
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
  }
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

afterEach(() => {
  clearDoitWebhookSecretCache();
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

type Bill = { linkId: string; intentId: string; providerRef: string };

async function openIntent(): Promise<Bill> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `R-${unique()}`,
      tableLabel: "A03",
      pax: 3,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: BILL_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  expect(created.status).toBe(201);
  const intentId = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [intentId],
  );
  const providerRef = rows[0]?.provider_ref;
  if (!providerRef) throw new Error("Intent has no DOIT payment id");
  return { linkId: opened.linkId, intentId, providerRef };
}

type StoredStatus = "received" | "failed" | "processed" | "ignored";

async function storeRow(
  eventId: string,
  status: StoredStatus,
  payload: object,
  idleSeconds = 0,
): Promise<string> {
  eventIds.push(eventId);
  const updatedAt = new Date(Date.now() - idleSeconds * 1000);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, received_at, updated_at,
        integration_id)
     VALUES ($1, 'doit', $2, 'payment.paid', true, $3, $4::jsonb, $5, $6, 1, $8, $8, $7)
     RETURNING id`,
    [
      tenantA,
      eventId,
      randomBytes(32).toString("hex"),
      JSON.stringify(payload),
      (payload as { data: { id: string } }).data.id,
      status,
      integrationId,
      updatedAt,
    ],
  );
  return rows[0]!.id;
}

function deliver(body: object) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantA}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", `t=${t},v1=${mac}`)
    .send(raw);
}

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.status;
}

async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

async function evidenceCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]!.n);
}

async function eventRow(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
    attempts: number;
  }>(
    `SELECT status, last_error_code, attempts FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2 AND signature_valid`,
    [tenantA, eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function expectPending(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("pending");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  expect(await evidenceCount(bill.intentId)).toBe(0);
}

async function expectPaidOnce(bill: Bill) {
  expect(await intentStatus(bill.intentId)).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  expect(await evidenceCount(bill.intentId)).toBe(1);
}

/**
 * Starts `run` while a competing transaction holds the row lock of `eventId`,
 * waits until `run` is queued behind that lock (or already finished, when it
 * skips locked rows), then lets the competitor touch `updated_at` (a claim)
 * and commit. Returns what `run` returned. No timing decides the outcome.
 */
async function runAgainstConcurrentClaim<T>(
  eventId: string,
  run: () => Promise<T>,
): Promise<T> {
  const holder = await owner.connect();
  let outcome: Promise<T> | undefined;
  try {
    await holder.query("BEGIN");
    const { rows: pid } = await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await holder.query(
      `SELECT id FROM gateway_webhook_events
        WHERE tenant_id = $1 AND event_id = $2 AND signature_valid FOR UPDATE`,
      [tenantA, eventId],
    );

    let settled = false;
    outcome = run();
    outcome.then(
      () => (settled = true),
      () => (settled = true),
    );

    const deadline = Date.now() + 15_000;
    let waiting = 0;
    while (Date.now() < deadline && !settled) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM pg_locks w
           JOIN pg_locks h
             ON h.locktype = 'transactionid'
            AND h.granted
            AND h.pid = $1
            AND w.transactionid = h.transactionid
          WHERE w.locktype = 'transactionid' AND NOT w.granted`,
        [pid[0]!.pid],
      );
      waiting = Number(rows[0]!.n);
      if (waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting > 0 || settled).toBe(true);

    // The competitor's claim (status received, updated_at now), then release.
    await holder.query(
      `UPDATE gateway_webhook_events SET status = 'received', updated_at = now()
        WHERE tenant_id = $1 AND event_id = $2 AND signature_valid`,
      [tenantA, eventId],
    );
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    outcome?.catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  return outcome!;
}

// ---------------------------------------------------------------------------
// tipkj (1): the resend path claims the row
// ---------------------------------------------------------------------------

describe("tipkj a resend claims the stored row atomically before processing", () => {
  for (const status of ["received", "failed"] as const) {
    it(`tipkj a resend of a ${status} row that another party claimed meanwhile does not process it`, async () => {
      const bill = await openIntent();
      const eventId = newEventId();
      const body = doit.eventFor(bill.providerRef, "paid", eventId);
      await storeRow(eventId, status, body, status === "received" ? 600 : 0);
      const before = await eventRow(eventId);

      const response = await runAgainstConcurrentClaim(eventId, () =>
        deliver(body),
      );

      // Lost the claim: not processed here, the bill is not paid by the
      // resend, and the row stays with whoever claimed it.
      expect(response.body.status).not.toBe("processed");
      await expectPending(bill);
      const after = await eventRow(eventId);
      expect(after.status).toBe("received");
      expect(after.attempts).toBe(before.attempts);
    });
  }

  it("tipkj concurrent resends of one received event record the payment once and exactly one of them reports processed", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "received", body, 600);

    const responses = await Promise.all([
      deliver(body),
      deliver(body),
      deliver(body),
    ]);

    for (const response of responses) expect(response.status).toBeLessThan(500);
    await expectPaidOnce(bill);
    expect(
      responses.filter((response) => response.body.status === "processed"),
    ).toHaveLength(1);
    expect((await eventRow(eventId)).status).toBe("processed");
  });

  it("tipkj a resend of a failed row still settles the bill once when nobody else holds it", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "failed", body);

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectPaidOnce(bill);
    expect((await eventRow(eventId)).status).toBe("processed");
  });
});

describe("tipkj a worker that claimed or finished a row makes a redelivery a duplicate", () => {
  it("tipkj a row freshly claimed by a worker (received, just touched) is not processed by a redelivery: duplicate, no payment", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "received", body, 0);
    const before = await eventRow(eventId);

    const response = await deliver(body);

    expect(response.status).toBeLessThan(500);
    expect(response.body.status).toBe("duplicate");
    await expectPending(bill);
    const after = await eventRow(eventId);
    expect(after.status).toBe("received");
    expect(after.attempts).toBe(before.attempts);
  });

  it("tipkj after the worker processed a row, a redelivery is a duplicate and nothing is processed again", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    // Failed and idle for 10 minutes: past any back-off, claimable by the worker
    // at the real clock (no clock shift, so leftover rows stay out of the sweep).
    await storeRow(eventId, "failed", body, 600);

    const sweep = await reprocessStoredWebhookEvents(
      contextFor("webhook"),
      new Date(),
      100,
    );
    expect(sweep.processed).toBe(1);
    await expectPaidOnce(bill);
    const processed = await eventRow(eventId);
    expect(processed.status).toBe("processed");

    const response = await deliver(body);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("duplicate");
    await expectPaidOnce(bill);
    const after = await eventRow(eventId);
    expect(after.status).toBe("processed");
    expect(after.attempts).toBe(processed.attempts);
  });

  it("tipkj a worker sweep right after a resend that already processed the row finds nothing to do", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "failed", body, 0);

    const response = await deliver(body);
    expect(response.body.status).toBe("processed");
    const processed = await eventRow(eventId);

    const sweep = await reprocessStoredWebhookEvents(
      contextFor("webhook"),
      new Date(),
      100,
    );

    expect(sweep.processed).toBe(0);
    await expectPaidOnce(bill);
    expect((await eventRow(eventId)).attempts).toBe(processed.attempts);
  });
});

// ---------------------------------------------------------------------------
// tipkj (2): markRow does not overwrite processed
// ---------------------------------------------------------------------------

describe("tipkj markRow never overwrites a processed row with failed", () => {
  const failedPatch = {
    status: "failed",
    lastErrorCode: "INTERNAL_ERROR",
  } as Parameters<typeof markRow>[2];

  it("tipkj a processed row stays processed when a late failure is recorded", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const rowId = await storeRow(
      eventId,
      "processed",
      doit.eventFor(bill.providerRef, "paid", eventId),
    );

    await markRow(contextFor("webhook"), rowId, failedPatch, new Date());

    const row = await eventRow(eventId);
    expect(row.status).toBe("processed");
    expect(row.last_error_code).toBeNull();
  });

  it("tipkj an ignored row stays ignored when a late failure is recorded", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const rowId = await storeRow(
      eventId,
      "ignored",
      doit.eventFor(bill.providerRef, "pending", eventId),
    );

    await markRow(contextFor("webhook"), rowId, failedPatch, new Date());

    const row = await eventRow(eventId);
    expect(row.status).toBe("ignored");
    expect(row.last_error_code).toBeNull();
  });

  it("tipkj a received row still moves to failed", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const rowId = await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
    );

    await markRow(contextFor("webhook"), rowId, failedPatch, new Date());

    const row = await eventRow(eventId);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe("INTERNAL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// tipkj (3): the parked recurring sweep claims before processing
// ---------------------------------------------------------------------------

const PRICE = 150_000;

function jakartaMonthStart(monthOffset: number): string {
  const now = new Date(Date.now() + 7 * 3_600_000);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1),
  )
    .toISOString()
    .slice(0, 10);
}

type Ids = { providerPlanId: string; providerSubId: string };
const newIds = (): Ids => ({
  providerPlanId: `plan_${unique()}`,
  providerSubId: `sub_${unique()}`,
});

function invoiceCreated(ids: Ids) {
  const invoiceId = `inv_${unique()}`;
  return {
    id: newEventId(),
    type: "invoice.created",
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: invoiceId,
        subscription_id: ids.providerSubId,
        plan_id: ids.providerPlanId,
        amount: PRICE,
        currency: "IDR",
        period_start: jakartaMonthStart(0),
        period_end: jakartaMonthStart(1),
        hosted_url: `https://pay.doit.example/invoices/${invoiceId}`,
        status: "open",
      },
    },
  };
}

async function seedSub(ids: Ids): Promise<void> {
  const planId = randomUUID();
  const subId = randomUUID();
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, 'month', 'active', $6)`,
    [planId, tenantA, outletA, ids.providerPlanId, PRICE, integrationId],
  );
  planIds.push(planId);
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_first_payment', $7)`,
    [
      subId,
      tenantA,
      outletA,
      planId,
      randomUUID(),
      ids.providerSubId,
      integrationId,
    ],
  );
  subIds.push(subId);
}

async function invoiceCount(providerInvoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM subscription_invoices WHERE provider_invoice_id = $1",
    [providerInvoiceId],
  );
  return Number(rows[0]!.n);
}

/** An invoice.created event parked for an unknown subscription, whose
 * subscription then appears: the sweep may process it. */
async function parkedEventWithSubscription() {
  const ids = newIds();
  const body = invoiceCreated(ids);
  eventIds.push(body.id);
  const response = await deliver(body);
  expect(response.status).toBe(200);
  expect(await eventRow(body.id)).toMatchObject({
    status: "failed",
    last_error_code: "UNKNOWN_SUBSCRIPTION",
  });
  await seedSub(ids);
  return body;
}

describe("tipkj the parked recurring sweep claims a row before processing it", () => {
  it("tipkj two sweeps over the same parked event process it once", async () => {
    const body = await parkedEventWithSubscription();

    const results = await Promise.all([
      reprocessParkedRecurringEvents(contextFor("session"), new Date()),
      reprocessParkedRecurringEvents(contextFor("session"), new Date()),
    ]);

    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
    expect(await invoiceCount(body.data.invoice.id)).toBe(1);
    expect((await eventRow(body.id)).status).toBe("processed");
  });

  it("tipkj a sweep that loses the claim to a concurrent worker does not process the event", async () => {
    const body = await parkedEventWithSubscription();

    const result = await runAgainstConcurrentClaim(body.id, () =>
      reprocessParkedRecurringEvents(contextFor("session"), new Date()),
    );

    expect(result.processed).toBe(0);
    expect(await invoiceCount(body.data.invoice.id)).toBe(0);
    // The row stays with the competitor that claimed it.
    expect((await eventRow(body.id)).status).toBe("received");
  });

  it("tipkj the parked sweep followed by the regular catch-up sweep processes the event once", async () => {
    const body = await parkedEventWithSubscription();

    const parked = await reprocessParkedRecurringEvents(
      contextFor("session"),
      new Date(),
    );
    expect(parked.processed).toBeGreaterThanOrEqual(1);
    expect(await invoiceCount(body.data.invoice.id)).toBe(1);
    const processed = await eventRow(body.id);
    expect(processed.status).toBe("processed");

    const catchUp = await reprocessStoredWebhookEvents(
      contextFor("webhook"),
      new Date(),
      100,
    );

    expect(catchUp.processed).toBe(0);
    expect(await invoiceCount(body.data.invoice.id)).toBe(1);
    const after = await eventRow(body.id);
    expect(after.status).toBe("processed");
    expect(after.attempts).toBe(processed.attempts);
  });

  it("tipkj a sweep still processes a parked event once its subscription exists and nobody holds it", async () => {
    const body = await parkedEventWithSubscription();

    const result = await reprocessParkedRecurringEvents(
      contextFor("session"),
      new Date(),
    );

    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(await invoiceCount(body.data.invoice.id)).toBe(1);
    expect((await eventRow(body.id)).status).toBe("processed");
  });
});
