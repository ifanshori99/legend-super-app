// Duitku callback intake (sub-brief 302 Slice D; design D18, D20-D22).
//
// The callback signature does not cover `resultCode`, so a signed callback is
// never proof of payment: every delivery is checked against Duitku's
// `transactionStatus` before money moves. Contract under test:
// - bad signature / wrong merchant / unknown or foreign order -> 401, nothing
//   changes; amount differs -> never paid on the callback amount;
// - resultCode 00 while the status answer says pending -> not paid, row kept
//   `failed` (PENDING_AT_PROVIDER) for the worker;
// - a duplicate callback settles once; a repeated form key is refused;
// - the previous key verifies inside its grace window and not after;
// - late payment (expired or failed intent) settles once, flagged
//   `late_payment`, one evidence row, also through the poller.
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
  vi,
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
import { runPaymentGatewayPollJob } from "../worker/payment-gateway-poll.job";
import {
  registerPaymentGateway,
  resetPaymentGateways,
} from "../services/payment-gateway";
import { createDuitkuGateway } from "../services/payment-duitku";
import { reprocessDuitkuWebhookEvents } from "../services/payment-duitku-webhook.service";
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const BILL_TOTAL = 144_375;
const MERCHANT = "DS1234";
const apiKey = `duitku-key-${randomBytes(12).toString("hex")}`;
const newApiKey = `duitku-key-new-${randomBytes(12).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
let integrationId = "";
let originalProviders: unknown;

const unique = () => randomBytes(4).toString("hex");

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
    { kind: "tenant" },
  );
}

// ---------------------------------------------------------------------------
// Fake Duitku transactionStatus (the only outbound call of the webhook path)
// ---------------------------------------------------------------------------

type StatusAnswer =
  | {
      statusCode: "00" | "01" | "02";
      reference: string | null;
      amount: string;
    }
  | "error";
/** Answer per merchantOrderId and merchantCode that asks. */
const statusAnswers = new Map<string, StatusAnswer>();
const statusAsks: { merchantCode: string; merchantOrderId: string }[] = [];
const realFetch = globalThis.fetch;

function answerFor(orderId: string, code = MERCHANT): StatusAnswer | undefined {
  return statusAnswers.get(`${code}|${orderId}`);
}

function setAnswer(
  orderId: string,
  answer: StatusAnswer,
  merchantCode = MERCHANT,
) {
  statusAnswers.set(`${merchantCode}|${orderId}`, answer);
}

function stubDuitku() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/transactionStatus"))
        return realFetch(input as string, init);
      const body = JSON.parse(String(init?.body)) as {
        merchantCode: string;
        merchantOrderId: string;
        signature: string;
      };
      statusAsks.push({
        merchantCode: body.merchantCode,
        merchantOrderId: body.merchantOrderId,
      });
      const answer = answerFor(body.merchantOrderId, body.merchantCode);
      if (!answer || answer === "error")
        return new Response("nope", { status: answer ? 500 : 404 });
      return new Response(
        JSON.stringify({ merchantOrderId: body.merchantOrderId, ...answer }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedIntegration(
  merchantCode: string,
  key: string,
): Promise<string> {
  const created = await upsertIntegration(
    contextFor("session"),
    {
      outletId: null,
      provider: "duitku",
      config: {
        environment: "sandbox",
        notificationEmail: "owner@example.test",
      },
      credentials: { merchantCode, apiKey: key },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor("session"),
    created.id,
    { status: "active" },
    actor,
  );
  integrationIds.push(created.id);
  return created.id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // A second, active tenant: its URL must never reach tenant A's orders.
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Duitku Webhook', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["duitku"]}', $3, $4)`,
    [
      tenantB,
      `uji-duitku-webhook-${unique()}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 3,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 10_000,
        emailCostCapIdr: 1_000,
      }),
      actor,
    ],
  );
  // Tenant A must be allowed to hold a Duitku integration (restored below).
  const flags = await owner.query<{ providers: unknown }>(
    "SELECT feature_flags->'integrationProviders' AS providers FROM tenants WHERE id = $1",
    [tenantA],
  );
  originalProviders = flags.rows[0]?.providers;
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
              (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
      WHERE id = $1
        AND NOT (feature_flags->'integrationProviders') ? 'duitku'`,
    [tenantA],
  );
  integrationId = await seedIntegration(MERCHANT, apiKey);
});

afterAll(async () => {
  resetPaymentGateways();
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = ANY($1::uuid[]) AND provider = 'duitku'",
    [[tenantA, tenantB]],
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
    // Seeded orders are final (voided): the POS-04 immutability trigger
    // refuses their delete, so it is skipped for this test cleanup only.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM orders WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await client.query(
        "DELETE FROM reservations WHERE tenant_id = $1 AND deposit_payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await client.query(
        "DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
  await owner.query(
    "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1",
    [tenantA, JSON.stringify(originalProviders)],
  );
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  statusAnswers.clear();
  statusAsks.length = 0;
  stubDuitku();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPaymentGateways();
});

type Bill = {
  linkId: string;
  intentId: string;
  reference: string;
};

/** A Duitku QRIS intent minted on `integrationId`, as the adapter would leave
 * it (rows are written directly: the adapter's own tests cover minting). */
async function openIntent(
  options: {
    status?: "pending" | "expired" | "failed";
    expiresAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
  } = {},
): Promise<Bill> {
  const opened = await createPaymentLink(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletA as OutletId] },
    ),
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
  const intentId = randomUUID();
  const reference = `DSREF${unique()}`;
  const created = options.createdAt ?? new Date(Date.now() - 10 * 60_000);
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, provider_ref, gateway_integration_id, status,
        instructions, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'qris', 'duitku', $5, $6, $7, $8, $9,
             $10::jsonb, $11, $12, $13)`,
    [
      intentId,
      tenantA,
      outletA,
      opened.linkId,
      BILL_TOTAL,
      `k-${unique()}`,
      reference,
      integrationId,
      options.status ?? "pending",
      JSON.stringify({
        method: "qris",
        qrString: "00020101021226DUITKU",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      options.expiresAt ?? new Date(Date.now() + 3_600_000),
      created,
      options.updatedAt ?? created,
    ],
  );
  return { linkId: opened.linkId, intentId, reference };
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

type CallbackOptions = {
  merchantCode?: string;
  key?: string;
  amount?: string;
  resultCode?: string;
  reference?: string | null;
  signature?: string;
  tenantId?: string;
  extra?: string;
};

function callback(orderId: string, reference: string, o: CallbackOptions = {}) {
  const amount = o.amount ?? String(BILL_TOTAL);
  const merchantCode = o.merchantCode ?? MERCHANT;
  const signature =
    o.signature ?? hmac(`${merchantCode}${amount}${orderId}`, o.key ?? apiKey);
  const form = new URLSearchParams({
    merchantCode,
    amount,
    merchantOrderId: orderId,
    resultCode: o.resultCode ?? "00",
    signature,
  });
  if (o.reference !== null) form.set("reference", o.reference ?? reference);
  return request(app)
    .post(`/api/webhooks/payments/duitku/${o.tenantId ?? tenantA}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(form.toString() + (o.extra ?? ""));
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{ status: string; flags: string[] }>(
    "SELECT status, flags FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!;
}

async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

async function rowsFor(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
    event_id: string;
    signature_valid: boolean;
    attempts: number;
  }>(
    `SELECT status, last_error_code, event_id, signature_valid, attempts
     FROM gateway_webhook_events
     WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2
     ORDER BY created_at`,
    [tenantA, intentId],
  );
  return rows;
}

async function evidenceCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

async function unallocatedCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

async function expectUnchangedBill(bill: Bill) {
  const { rows } = await owner.query<{
    total_idr: string;
    amount_idr: string;
  }>(
    `SELECT links.total_idr::text, intents.amount_idr::text
     FROM payment_links links
     JOIN payment_intents intents ON intents.payment_link_id = links.id
     WHERE links.id = $1 AND intents.id = $2 AND links.tenant_id = $3`,
    [bill.linkId, bill.intentId, tenantA],
  );
  expect(rows).toEqual([
    { total_idr: String(BILL_TOTAL), amount_idr: String(BILL_TOTAL) },
  ]);
}

async function settlementEventCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

async function expectUntouched(bill: Bill) {
  await expectUnchangedBill(bill);
  expect(await settlementEventCount(bill.intentId)).toBe(0);
  expect((await intentRow(bill.intentId)).status).toMatch(
    /^(pending|expired|failed)$/,
  );
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
}

async function expectPaidOnce(bill: Bill) {
  await expectUnchangedBill(bill);
  expect(await settlementEventCount(bill.intentId)).toBe(1);
  expect((await intentRow(bill.intentId)).status).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  expect(await evidenceCount(bill.intentId)).toBe(1);
}

const paid = (reference: string, amount = String(BILL_TOTAL)) =>
  ({ statusCode: "00", reference, amount }) as const;

// ---------------------------------------------------------------------------

describe("D21-D22 a Duitku callback is verified, then confirmed with transactionStatus", () => {
  it("a correctly signed callback with a paid status answer settles the bill once and answers 200 OK", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    const response = await callback(bill.intentId, bill.reference);

    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
    await expectPaidOnce(bill);
    const rows = await rowsFor(bill.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processed",
      // Only signed fields key the event (resultCode and reference are not
      // signed, Codex P1 legend-rgddb).
      event_id: `${bill.intentId}:${BILL_TOTAL}`,
      signature_valid: true,
    });
    // Asked with the minting merchant code.
    expect(statusAsks).toEqual([
      { merchantCode: MERCHANT, merchantOrderId: bill.intentId },
    ]);
  });

  it("PAY-03 a bad signature answers 401 and moves nothing, with no status call", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    const response = await callback(bill.intentId, bill.reference, {
      key: "not-the-key",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    await expectUntouched(bill);
    expect(statusAsks).toHaveLength(0);
    // Rejected attempts leave a counter row, never a payload.
    expect(await rowsFor(bill.intentId)).toHaveLength(0);
    expect(await evidenceCount(bill.intentId)).toBe(0);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
  });

  it("PAY-03 a wrong merchant code answers 401 and moves nothing", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      merchantCode: "DS9999",
      key: apiKey,
    });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
    expect(statusAsks).toHaveLength(0);
  });

  it("an unknown order and a non-uuid order both answer 401", async () => {
    const unknown = await callback(randomUUID(), "REF");
    expect(unknown.status).toBe(401);
    const junk = await callback("not-a-uuid", "REF");
    expect(junk.status).toBe(401);
    expect(statusAsks).toHaveLength(0);
  });

  it("a callback amount that differs from the bill never settles it, even when the status answer matches the bill", async () => {
    const bill = await openIntent();
    // Signed for 1000, but the bill is 144375 and transactionStatus reports
    // 144375. Callback, status and bill disagree: parked for reconciliation
    // (Codex P2 legend-rgddb), never paid.
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      amount: "1000",
    });
    expect(response.status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedCount(bill.intentId)).toBe(1);
    expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
      "REJECTED_AMOUNT_MISMATCH",
    );
  });

  it("an underpaid status answer is parked as unallocated funds, the bill stays unpaid", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference, "1000"));

    const response = await callback(bill.intentId, bill.reference, {
      amount: "1000",
    });

    expect(response.status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedCount(bill.intentId)).toBe(1);
    expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
      "REJECTED_AMOUNT_MISMATCH",
    );
  });

  it("resultCode 00 while transactionStatus says pending is not paid and the row stays failed for the worker", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "01",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });

    const response = await callback(bill.intentId, bill.reference);

    expect(response.status).toBe(200);
    await expectUntouched(bill);
    expect(await rowsFor(bill.intentId)).toMatchObject([
      { status: "failed", last_error_code: "PENDING_AT_PROVIDER" },
    ]);

    // Duitku later settles it: the worker retry (after the back-off) pays.
    setAnswer(bill.intentId, paid(bill.reference));
    const result = await reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 10 * 60_000),
    );
    expect(result.checked).toBeGreaterThanOrEqual(1);
    await expectPaidOnce(bill);
    expect((await rowsFor(bill.intentId))[0]?.status).toBe("processed");
  });

  it("a status call that fails keeps the row for the worker and pays nothing", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, "error");

    const response = await callback(bill.intentId, bill.reference);

    expect(response.status).toBe(200);
    await expectUntouched(bill);
    expect((await rowsFor(bill.intentId))[0]).toMatchObject({
      status: "failed",
      last_error_code: "SERVICE_UNAVAILABLE",
    });
  });

  it("a status answer for another reference never settles the bill", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid("SOMEONE-ELSES-REF"));
    const response = await callback(bill.intentId, bill.reference);
    expect(response.status).toBe(200);
    await expectUntouched(bill);
    expect((await rowsFor(bill.intentId))[0]).toMatchObject({
      status: "failed",
      last_error_code: "REFERENCE_MISMATCH",
    });
  });

  it("a callback's reference is unsigned and decides nothing: the status answer does", async () => {
    const bill = await openIntent();
    // Duitku still says pending: a forged reference neither pays nor closes
    // the row, which stays `failed` for the worker (Codex legend-rgddb).
    setAnswer(bill.intentId, {
      statusCode: "01",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    const response = await callback(bill.intentId, bill.reference, {
      reference: "FORGED-REF",
    });
    expect(response.status).toBe(200);
    await expectUntouched(bill);
    expect(statusAsks).toHaveLength(1);
    expect((await rowsFor(bill.intentId))[0]).toMatchObject({
      status: "failed",
      last_error_code: "PENDING_AT_PROVIDER",
    });
  });

  it("PAY-03 a duplicate callback settles once and the replay answers 200 without a second status call", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    const first = await callback(bill.intentId, bill.reference);
    const second = await callback(bill.intentId, bill.reference);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expectPaidOnce(bill);
    expect(await rowsFor(bill.intentId)).toHaveLength(1);
    expect(statusAsks).toHaveLength(1);
  });

  it("PAY-03 a paid callback followed by a stale failure callback keeps exactly one settlement and the original bill", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    await expectPaidOnce(bill);

    // A delayed failure notification must not undo or duplicate the payment.
    setAnswer(bill.intentId, {
      statusCode: "02",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect(
      (await callback(bill.intentId, bill.reference, { resultCode: "02" }))
        .status,
    ).toBe(200);
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    await expectPaidOnce(bill);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
    expect(await rowsFor(bill.intentId)).toHaveLength(1);
    expect(statusAsks).toHaveLength(1);
  });

  it("a repeated form key is refused (the signed value would be ambiguous)", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      extra: `&amount=1`,
    });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
  });

  it("a result code Duitku does not send is refused", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      resultCode: "99",
    });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
  });

  it("another content type answers 415", async () => {
    const response = await request(app)
      .post(`/api/webhooks/payments/duitku/${tenantA}`)
      .set("Content-Type", "application/json")
      .send("{}");
    expect(response.status).toBe(415);
  });

  it("TEN-01 tenant B's URL naming tenant A's order answers 401 and moves nothing", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      tenantId: tenantB,
    });
    expect(response.status).toBe(401);
    await expectUntouched(bill);
    expect(statusAsks).toHaveLength(0);
  });

  it("a status 02 closes a pending intent as failed, or expired once its time passed", async () => {
    const live = await openIntent();
    setAnswer(live.intentId, {
      statusCode: "02",
      reference: live.reference,
      amount: String(BILL_TOTAL),
    });
    expect((await callback(live.intentId, live.reference)).status).toBe(200);
    expect((await intentRow(live.intentId)).status).toBe("failed");

    const lapsed = await openIntent({
      expiresAt: new Date(Date.now() - 60_000),
    });
    setAnswer(lapsed.intentId, {
      statusCode: "02",
      reference: lapsed.reference,
      amount: String(BILL_TOTAL),
    });
    expect((await callback(lapsed.intentId, lapsed.reference)).status).toBe(
      200,
    );
    expect((await intentRow(lapsed.intentId)).status).toBe("expired");
  });
});

describe("D20 late payment goes through the provider-agnostic lifecycle", () => {
  it("PAY-03 an expired intent then a verified paid callback settles the bill once, flagged late_payment", async () => {
    const bill = await openIntent({
      status: "expired",
      expiresAt: new Date(Date.now() - 5 * 60_000),
    });
    setAnswer(bill.intentId, paid(bill.reference));

    const response = await callback(bill.intentId, bill.reference);

    expect(response.status).toBe(200);
    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).toContain("late_payment");
    // A replay adds nothing.
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    await expectPaidOnce(bill);
  });

  it("PAY-03 a failed intent (status 02 first) then a paid callback settles once, flagged late_payment", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "02",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect(
      (await callback(bill.intentId, bill.reference, { resultCode: "02" }))
        .status,
    ).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    await expectUntouched(bill);
    expect(await evidenceCount(bill.intentId)).toBe(0);

    // Same signed fields: the paid callback is a repeat of the stored event,
    // re-checked with Duitku once the repeat window passed.
    await ageRows(bill.intentId);
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      resultCode: "00",
    });

    expect(response.status).toBe(200);
    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).toContain("late_payment");
  });

  it("an underpayment on an expired intent is parked as one unallocated row", async () => {
    const bill = await openIntent({
      status: "expired",
      expiresAt: new Date(Date.now() - 5 * 60_000),
    });
    setAnswer(bill.intentId, paid(bill.reference, "1000"));
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedCount(bill.intentId)).toBe(1);
    expect(await evidenceCount(bill.intentId)).toBe(1);
  });

  it("the poller (syncExpiredIntentPayment) with a Duitku double settles an expired intent through the same single evidence row", async () => {
    // Closed before its code lapsed: updated_at < expires_at.
    const expiresAt = new Date(Date.now() - 5 * 60_000);
    const bill = await openIntent({
      status: "expired",
      expiresAt,
      createdAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(expiresAt.getTime() - 60_000),
    });
    setAnswer(bill.intentId, paid(bill.reference));
    registerPaymentGateway(
      createDuitkuGateway({
        fetch: globalThis.fetch,
        callbackBaseUrl: "https://api.example.test",
        returnUrl: "https://app.example.test/paid",
      }),
    );

    const ran = await runPaymentGatewayPollJob(
      contextFor("webhook"),
      new Date(),
      { force: true },
    );

    expect(ran?.polled.settled).toBeGreaterThanOrEqual(1);
    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).toContain("late_payment");
    // The webhook for the same payment afterwards is a no-op on money.
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    await expectPaidOnce(bill);
  });
});

// ---------------------------------------------------------------------------
// Codex second opinion (legend-rgddb). Before D18: the blocks below rotate
// the integration's key and merchant code.
// ---------------------------------------------------------------------------

async function setDuitkuInPlan(enabled: boolean) {
  await owner.query(
    enabled
      ? `UPDATE tenants
            SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                  (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
          WHERE id = $1
            AND NOT (feature_flags->'integrationProviders') ? 'duitku'`
      : `UPDATE tenants
            SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                  (feature_flags->'integrationProviders') - 'duitku')
          WHERE id = $1`,
    [tenantA],
  );
}

async function unallocatedIdr(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

/** Moves the intent's stored events past the repeat re-check window. */
async function ageRows(intentId: string, ms = 2 * 60_000) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET updated_at = updated_at - make_interval(secs => $3::double precision / 1000)
      WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2`,
    [tenantA, intentId, ms],
  );
}

/** Inserts a row whose parents this suite does not build (reservation,
 * POS order): foreign keys and triggers are skipped for that one statement,
 * CHECK and NOT NULL constraints still hold. */
async function insertWithoutParents(sqlText: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(sqlText, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A reservation whose deposit is the bill's link, closed as `status`. */
async function seedClosedReservation(
  linkId: string,
  status: "cancelled" | "no_show",
): Promise<void> {
  await insertWithoutParents(
    `INSERT INTO reservations
       (tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax,
        deposit_idr, policy_snapshot, status, source, closed_at,
        deposit_payment_link_id)
     VALUES ($1, $2, 'Tamu Uji', now() - interval '1 hour', 90, 2, $3,
             '{}'::jsonb, $4, 'staff', now(), $5)`,
    [tenantA, outletA, BILL_TOTAL, status, linkId],
  );
}

/** A POS gateway tender on the bill's link, closed as `failed`. */
async function seedFailedPosTender(
  linkId: string,
  intentId: string,
): Promise<void> {
  await insertWithoutParents(
    `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
        payment_link_token_sealed, payment_intent_id, amount_idr, status,
        requested_at, resolved_at)
     VALUES ($1, $2, $3, 'qris', 'duitku', $4, 'sealed-test', $5, $6,
             'failed', now(), now())`,
    [tenantA, outletA, randomUUID(), linkId, intentId, BILL_TOTAL],
  );
}

/** Distinct domain events of `name` raised for one intent (the outbox keeps
 * one row per destination). */
async function eventCount(name: string, intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(DISTINCT event_id)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND (aggregate_id = $3 OR event->'payload'->>'intentId' = $3::text)`,
    [tenantA, name, intentId],
  );
  return Number(rows[0]?.n);
}

/** A QR order on the bill's link, as the order flow would leave it. */
async function seedOrderOnLink(
  linkId: string,
  status: "voided" | "completed",
): Promise<void> {
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, status, business_date, payment_link_id,
        payment_link_token_sealed, placed_at, voided_at, void_reason)
     VALUES ($1, $2, $3, $4, 'qr', 'dine_in', 'pay_first',
             125000, 0, 6250, 13125, 0, $5, $6, current_date, $7,
             'sealed-test', now(), $8, $9)`,
    [
      randomUUID(),
      tenantA,
      outletA,
      `Q-${unique()}`,
      BILL_TOTAL,
      status,
      linkId,
      status === "voided" ? new Date() : null,
      status === "voided" ? "test" : null,
    ],
  );
}

describe("Codex P1 a stored intent still reconciles after Duitku leaves the tenant's plan", () => {
  it("a callback for an intent minted before the revoke still settles the bill", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    await setDuitkuInPlan(false);
    try {
      const response = await callback(bill.intentId, bill.reference);
      expect(response.status).toBe(200);
      await expectPaidOnce(bill);
    } finally {
      await setDuitkuInPlan(true);
    }
  });

  it("the poller still settles an expired intent minted before the revoke, while a new intent cannot be minted", async () => {
    const expiresAt = new Date(Date.now() - 5 * 60_000);
    const bill = await openIntent({
      status: "expired",
      expiresAt,
      createdAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(expiresAt.getTime() - 60_000),
    });
    setAnswer(bill.intentId, paid(bill.reference));
    const gateway = createDuitkuGateway({
      fetch: globalThis.fetch,
      callbackBaseUrl: "https://api.example.test",
      returnUrl: "https://app.example.test/paid",
    });
    registerPaymentGateway(gateway);
    await setDuitkuInPlan(false);
    try {
      const ran = await runPaymentGatewayPollJob(
        contextFor("webhook"),
        new Date(),
        { force: true },
      );
      expect(ran?.polled.settled).toBeGreaterThanOrEqual(1);
      await expectPaidOnce(bill);
      // Minting a new intent still needs the plan.
      expect(await gateway.health(contextFor("session"), outletA)).toEqual({
        status: "down",
        reason: "unconfigured",
      });
    } finally {
      await setDuitkuInPlan(true);
    }
  });
});

describe("Codex P1 duplicates are keyed by signed fields only", () => {
  it("PAY-03 a replayed failure callback with resultCode changed 02->00 does not swallow the real paid callback", async () => {
    const bill = await openIntent();
    // The real failure callback, replayed with resultCode forged to 00
    // (resultCode is not signed). Duitku says failed at that moment.
    setAnswer(bill.intentId, {
      statusCode: "02",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect(
      (await callback(bill.intentId, bill.reference, { resultCode: "00" }))
        .status,
    ).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");

    // The customer then pays; Duitku's genuine paid callback arrives at once.
    // Same signed fields: inside the repeat window the event is handed back
    // to the worker instead of being dropped as a duplicate.
    setAnswer(bill.intentId, paid(bill.reference));
    const response = await callback(bill.intentId, bill.reference, {
      resultCode: "00",
    });
    expect(response.status).toBe(200);
    expect(await rowsFor(bill.intentId)).toMatchObject([
      { status: "failed", last_error_code: "RECHECK_QUEUED" },
    ]);

    // The worker asks Duitku and settles it, late.
    await reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 10 * 60_000),
    );
    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).toContain("late_payment");
    expect(await rowsFor(bill.intentId)).toHaveLength(1);
  });

  it("the same replay after the repeat window is checked with Duitku directly", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "02",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    await callback(bill.intentId, bill.reference, { resultCode: "00" });
    await ageRows(bill.intentId);
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    await expectPaidOnce(bill);
    expect(statusAsks).toHaveLength(2);
  });

  it("a forged-reference replay does not take a pending event away from the worker", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "01",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    await callback(bill.intentId, bill.reference);
    expect(
      (
        await callback(bill.intentId, bill.reference, {
          reference: "FORGED-REF",
        })
      ).status,
    ).toBe(200);
    expect((await rowsFor(bill.intentId))[0]?.status).toBe("failed");

    setAnswer(bill.intentId, paid(bill.reference));
    await reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 10 * 60_000),
    );
    await expectPaidOnce(bill);
  });

  it("rapid signed replays on an unpaid intent ask Duitku once and never postpone the worker", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "01",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    for (let i = 0; i < 5; i += 1)
      expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    expect(statusAsks).toHaveLength(1);
    // Only the first delivery touched the row.
    expect((await rowsFor(bill.intentId))[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });
});

describe("Codex P2 only callback == status == bill settles", () => {
  it("an overpaid status answer (bill + 1) is parked for reconciliation, the bill stays unpaid", async () => {
    const bill = await openIntent();
    const over = String(BILL_TOTAL + 1);
    setAnswer(bill.intentId, paid(bill.reference, over));

    const response = await callback(bill.intentId, bill.reference, {
      amount: over,
    });

    expect(response.status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL + 1);
    expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
      "REJECTED_AMOUNT_MISMATCH",
    );
  });

  it("a callback for bill - 1 is not settled by a status answer for the full bill", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    const response = await callback(bill.intentId, bill.reference, {
      amount: String(BILL_TOTAL - 1),
    });

    expect(response.status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
  });
});

describe("Codex P2 a late payment settles only an open bill", () => {
  it("an expired intent whose bill another payment already settled stays expired; the money is parked once", async () => {
    const bill = await openIntent({
      status: "expired",
      expiresAt: new Date(Date.now() - 5 * 60_000),
    });
    // Paid meanwhile by another code / at the cashier.
    await owner.query("UPDATE payment_links SET paid_idr = $2 WHERE id = $1", [
      bill.linkId,
      BILL_TOTAL,
    ]);
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
      "REJECTED_BILL_CLOSED",
    );
    // A later repeat (and the worker) parks nothing twice.
    await ageRows(bill.intentId);
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    expect((await intentRow(bill.intentId)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(bill.intentId)).toBe(1);
  });

  it("the poller applies the same rules: a closed bill or an amount off the bill parks the money", async () => {
    const expiresAt = new Date(Date.now() - 5 * 60_000);
    const closedBill = await openIntent({
      status: "expired",
      expiresAt,
      createdAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(expiresAt.getTime() - 60_000),
    });
    await owner.query("UPDATE payment_links SET paid_idr = $2 WHERE id = $1", [
      closedBill.linkId,
      BILL_TOTAL,
    ]);
    setAnswer(closedBill.intentId, paid(closedBill.reference));
    const overpaid = await openIntent({
      status: "expired",
      expiresAt,
      createdAt: new Date(Date.now() - 20 * 60_000),
      updatedAt: new Date(expiresAt.getTime() - 60_000),
    });
    setAnswer(
      overpaid.intentId,
      paid(overpaid.reference, String(BILL_TOTAL + 1)),
    );
    registerPaymentGateway(
      createDuitkuGateway({
        fetch: globalThis.fetch,
        callbackBaseUrl: "https://api.example.test",
        returnUrl: "https://app.example.test/paid",
      }),
    );

    await runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
      force: true,
    });

    expect((await intentRow(closedBill.intentId)).status).toBe("expired");
    expect(await unallocatedIdr(closedBill.intentId)).toBe(BILL_TOTAL);
    expect((await intentRow(overpaid.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(overpaid.linkId)).toBe(0);
    expect(await unallocatedIdr(overpaid.intentId)).toBe(BILL_TOTAL + 1);
  });

  it("a failed intent whose order was voided stays failed; the money is parked for refund", async () => {
    const bill = await openIntent({ status: "failed" });
    await seedOrderOnLink(bill.linkId, "voided");
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
  });

  it.each(["cancelled", "no_show"] as const)(
    "an expired reservation deposit intent whose reservation is %s stays expired; the money is parked",
    async (status) => {
      const bill = await openIntent({
        status: "expired",
        expiresAt: new Date(Date.now() - 5 * 60_000),
      });
      await seedClosedReservation(bill.linkId, status);
      setAnswer(bill.intentId, paid(bill.reference));

      expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

      expect((await intentRow(bill.intentId)).status).toBe("expired");
      expect(await linkPaidIdr(bill.linkId)).toBe(0);
      expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
      expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
        "REJECTED_BILL_CLOSED",
      );
    },
  );

  it("a failed intent whose POS tender failed stays failed; the money is parked", async () => {
    const bill = await openIntent({ status: "failed" });
    await seedFailedPosTender(bill.linkId, bill.intentId);
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    expect((await intentRow(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
    expect((await rowsFor(bill.intentId))[0]?.last_error_code).toBe(
      "REJECTED_BILL_CLOSED",
    );
  });

  it("the poller and the webhook racing on the same transaction settle it once, with one payment.paid", async () => {
    registerPaymentGateway(
      createDuitkuGateway({
        fetch: globalThis.fetch,
        callbackBaseUrl: "https://api.example.test",
        returnUrl: "https://app.example.test/paid",
      }),
    );
    const expiresAt = new Date(Date.now() - 5 * 60_000);
    // Several rounds: the interleaving differs from one to the next.
    for (let round = 0; round < 3; round += 1) {
      const bill = await openIntent({
        status: "expired",
        expiresAt,
        createdAt: new Date(Date.now() - 20 * 60_000),
        updatedAt: new Date(expiresAt.getTime() - 60_000),
      });
      setAnswer(bill.intentId, paid(bill.reference));

      const [response] = await Promise.all([
        callback(bill.intentId, bill.reference),
        runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
          force: true,
        }),
      ]);

      expect(response.status).toBe(200);
      await expectPaidOnce(bill);
      expect(await unallocatedCount(bill.intentId)).toBe(0);
      // One receipt event: the gateway receipt journal posts once.
      expect(await eventCount("payment.paid", bill.intentId)).toBe(1);
      expect(await eventCount("payment.funds_unallocated", bill.intentId)).toBe(
        0,
      );
    }
  });

  it("a pending intent on a voided order does not settle it either; the money is parked (legend-s0u8c F2)", async () => {
    const bill = await openIntent();
    await seedOrderOnLink(bill.linkId, "voided");
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    // A closed bill is never settled, whatever the intent status.
    expect((await intentRow(bill.intentId)).status).not.toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
  });
});

describe("legend-s5jup D1 a worker retry keeps the first receipt time as paidAt", () => {
  it("a callback received before expiry and settled by a retry after expiry is not flagged late_payment", async () => {
    // Open for another 30 minutes when the callback arrives; Duitku is still
    // pending, so the worker settles it two hours later.
    const bill = await openIntent({
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    setAnswer(bill.intentId, {
      statusCode: "01",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    expect(await rowsFor(bill.intentId)).toMatchObject([
      { status: "failed", last_error_code: "PENDING_AT_PROVIDER" },
    ]);

    setAnswer(bill.intentId, paid(bill.reference));
    await reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 2 * 3_600_000),
    );

    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).not.toContain(
      "late_payment",
    );
    const { rows } = await owner.query<{ paid_at: Date; received_at: Date }>(
      `SELECT i.paid_at, e.received_at
       FROM payment_intents i
       JOIN gateway_webhook_events e ON e.payment_intent_id = i.id
       WHERE i.id = $1`,
      [bill.intentId],
    );
    expect(rows[0]!.paid_at.getTime()).toBe(rows[0]!.received_at.getTime());
  });
});

describe("legend-s5jup D1 a payment after a failure callback is not back-dated to it", () => {
  it("a failure callback, then a paid replay on the same event key hours later, keeps paidAt at the payment time", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "02",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    expect((await intentRow(bill.intentId)).status).toBe("failed");
    // The failure callback arrived three hours ago.
    await owner.query(
      `UPDATE gateway_webhook_events
         SET received_at = now() - interval '3 hours',
             updated_at = now() - interval '3 hours'
       WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2`,
      [tenantA, bill.intentId],
    );

    setAnswer(bill.intentId, paid(bill.reference));
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    await expectPaidOnce(bill);
    expect((await intentRow(bill.intentId)).flags).toContain("late_payment");
    const { rows } = await owner.query<{ age_seconds: string }>(
      "SELECT extract(epoch FROM now() - paid_at)::text AS age_seconds FROM payment_intents WHERE id = $1",
      [bill.intentId],
    );
    expect(Number(rows[0]!.age_seconds)).toBeLessThan(120);
  });
});

describe("legend-s5jup D2 a missing or different status reference is not closed for good", () => {
  it("a status answer without a reference keeps the row failed for the worker, which settles it once the reference arrives", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, {
      statusCode: "00",
      reference: null,
      amount: String(BILL_TOTAL),
    });

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);
    await expectUntouched(bill);
    expect(await rowsFor(bill.intentId)).toMatchObject([
      { status: "failed", last_error_code: "REFERENCE_PENDING" },
    ]);

    setAnswer(bill.intentId, paid(bill.reference));
    await reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + 10 * 60_000),
    );
    await expectPaidOnce(bill);
    expect((await rowsFor(bill.intentId))[0]?.status).toBe("processed");
  });

  it("a really different reference is held for review: no money moves and the row is not closed", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid("SOMEONE-ELSES-REF"));

    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    await expectUntouched(bill);
    expect(await evidenceCount(bill.intentId)).toBe(0);
    expect(await unallocatedCount(bill.intentId)).toBe(0);
    const [row] = await rowsFor(bill.intentId);
    expect(row).toMatchObject({
      status: "failed",
      last_error_code: "REFERENCE_MISMATCH",
    });
  });
});

describe("D18 the previous key verifies inside its grace window only", () => {
  let rotatedIntegrationId = "";

  beforeAll(async () => {
    // Rotate the apiKey: the old one rides along as previousApiKey for 72 h.
    const rotated = await upsertIntegration(
      contextFor("session"),
      {
        outletId: null,
        provider: "duitku",
        config: {
          environment: "sandbox",
          notificationEmail: "owner@example.test",
        },
        credentials: { merchantCode: MERCHANT, apiKey: newApiKey },
      },
      actor,
    );
    rotatedIntegrationId = rotated.id;
  });

  it("accepts a callback signed with the previous key while in grace, and refuses it after", async () => {
    expect(rotatedIntegrationId).toBe(integrationId);
    const bill = await openIntent();
    // The current key now answers transactionStatus for this merchant code.
    setAnswer(bill.intentId, paid(bill.reference));

    const withNew = await callback(bill.intentId, bill.reference, {
      key: newApiKey,
    });
    expect(withNew.status).toBe(200);
    await expectPaidOnce(bill);

    const second = await openIntent();
    setAnswer(second.intentId, paid(second.reference));
    const withOld = await callback(second.intentId, second.reference, {
      key: apiKey,
    });
    expect(withOld.status).toBe(200);
    await expectPaidOnce(second);

    // After previousValidUntil the old key is refused (service called with an
    // injected clock past the 72 h default grace).
    const third = await openIntent();
    setAnswer(third.intentId, paid(third.reference));
    const { receiveDuitkuCallback } =
      await import("../services/payment-duitku-webhook.service");
    const after = new Date(Date.now() + 73 * 3_600_000);
    const form = new URLSearchParams({
      merchantCode: MERCHANT,
      amount: String(BILL_TOTAL),
      merchantOrderId: third.intentId,
      resultCode: "00",
      reference: third.reference,
      signature: hmac(`${MERCHANT}${BILL_TOTAL}${third.intentId}`, apiKey),
    });
    await expect(
      receiveDuitkuCallback({
        tenantId: tenantA,
        rawBody: Buffer.from(form.toString()),
        now: after,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expectUntouched(third);
    // The current key still verifies after the grace.
    form.set(
      "signature",
      hmac(`${MERCHANT}${BILL_TOTAL}${third.intentId}`, newApiKey),
    );
    await expect(
      receiveDuitkuCallback({
        tenantId: tenantA,
        rawBody: Buffer.from(form.toString()),
        now: after,
      }),
    ).resolves.toMatchObject({ status: "processed" });
    await expectPaidOnce(third);
  });
});

describe("a transient status error is not hidden by a later reference mismatch", () => {
  it("current merchant code errors, previous one (in grace) answers another reference: the row stays failed for the worker", async () => {
    const bill = await openIntent();
    const rotated = await upsertIntegration(
      contextFor("session"),
      {
        outletId: null,
        provider: "duitku",
        config: {
          environment: "sandbox",
          notificationEmail: "owner@example.test",
        },
        credentials: {
          merchantCode: "DS5678",
          apiKey: `duitku-key-rotated-${unique()}`,
        },
      },
      actor,
    );
    expect(rotated.id).toBe(integrationId);
    // Current generation (DS5678) fails; the previous one (DS1234) answers
    // about another payment.
    setAnswer(bill.intentId, "error", "DS5678");
    setAnswer(bill.intentId, paid("SOMEONE-ELSES-REF"), MERCHANT);

    const response = await callback(bill.intentId, bill.reference, {
      key: newApiKey,
    });

    expect(response.status).toBe(200);
    await expectUntouched(bill);
    expect((await rowsFor(bill.intentId))[0]).toMatchObject({
      status: "failed",
      last_error_code: "SERVICE_UNAVAILABLE",
    });
  });
});
