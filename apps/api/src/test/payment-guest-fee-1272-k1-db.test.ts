// 1272 K1 (design duitku-fee-passthrough §3-§5) on the database: the CHECK
// keeps a guest fee off QRIS and off any other gateway; a Duitku callback is
// settled only at the charged amount (bill + fee), the bill is credited the
// bill and the fee is never overpayment; a callback at the bill alone is held
// as AMOUNT_MISMATCH; the refund cap stays the bill (the fee is never paid
// back); a second payment of the same code parks only the bill part; the
// payment.paid journal splits the fee off the deposit. Tenant B cannot reach
// tenant A's fee intent.
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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  buildJournalLinesFromRule,
  defaultPostingRules,
  resolvePostingRule,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import { sql } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { paymentIntents } from "../db/schema";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { resetPaymentGateways } from "../services/payment-gateway";
import { refundableBalance } from "../services/payment-admin.service";
import { netAllocatedIdrSql } from "../services/payment-net-allocated-sql";
import { confirmPayment, createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";
import { and, eq } from "drizzle-orm";

const app = createApp();
let isolatedTenant: SecondTenant;
let tenantA: TenantId;
const tenantB = randomUUID();
let outletA: OutletId;
const actor = randomUUID();
const BILL_TOTAL = 144_375;
const GUEST_FEE = 2_456;
const CHARGED = BILL_TOTAL + GUEST_FEE;
const MERCHANT = "DS1272";
const apiKey = `duitku-key-${randomBytes(12).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
let integrationId = "";

const unique = () => randomBytes(4).toString("hex");

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
    { kind: "tenant" },
  );
}

type StatusAnswer = { statusCode: "00"; reference: string; amount: string };
const statusAnswers = new Map<string, StatusAnswer>();
const realFetch = globalThis.fetch;

function stubDuitku() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/transactionStatus"))
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
  isolatedTenant = await createSecondTenant(owner, "payment-guest-fee-1272");
  tenantA = tenantIdSchema.parse(isolatedTenant.tenantId);
  outletA = outletIdSchema.parse(isolatedTenant.outletId);
  // A second, active tenant: its URL must never reach tenant A's orders.
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Guest Fee 1272', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["duitku"]}', $3, $4)`,
    [
      tenantB,
      `uji-guest-fee-1272-${unique()}`,
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
  // Only this file's tenant is allowed to hold its test Duitku integration.
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
      `DELETE FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
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
  // Owner-only teardown: audit_logs is append-only and references our
  // outlet. Bypass its delete trigger only while removing this file's tenant;
  // fixture creation and every payment operation keep integrity checks active.
  const cleanup = await owner.connect();
  try {
    await cleanup.query("BEGIN");
    await cleanup.query("SET LOCAL session_replication_role = replica");
    await cleanup.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
      tenantA,
    ]);
    await cleanup.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1",
      [tenantA],
    );
    await cleanup.query("COMMIT");
  } catch (error) {
    await cleanup.query("ROLLBACK");
    throw error;
  } finally {
    cleanup.release();
  }
  await removeSecondTenant(owner, isolatedTenant);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  statusAnswers.clear();
  stubDuitku();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPaymentGateways();
});

type Bill = { linkId: string; intentId: string; reference: string };

async function openLink(): Promise<string> {
  const opened = await createPaymentLink(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletA] },
    ),
    {
      outletId: outletA,
      reference: `R-${unique()}`,
      tableLabel: "A12",
      pax: 2,
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
  return opened.linkId;
}

const insertIntentSql = `INSERT INTO payment_intents
   (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
    guest_fee_idr, idempotency_key, provider_ref, gateway_integration_id,
    status, instructions, channel_code, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12::jsonb,
         $13, now() + interval '1 hour')`;

/** A Duitku e-wallet intent with a guest fee, as createIntent leaves it. */
async function openFeeIntent(): Promise<Bill> {
  const linkId = await openLink();
  const intentId = randomUUID();
  const reference = `DSREF${unique()}`;
  await owner.query(insertIntentSql, [
    intentId,
    tenantA,
    outletA,
    linkId,
    "ewallet",
    "duitku",
    BILL_TOTAL,
    GUEST_FEE,
    `k-${unique()}`,
    reference,
    integrationId,
    JSON.stringify({
      method: "ewallet",
      channelCode: "OV",
      channelName: "OVO",
      paymentUrl: "https://passport.duitku.com/pay/x",
    }),
    "OV",
  ]);
  return { linkId, intentId, reference };
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

function callback(
  orderId: string,
  reference: string,
  amount: number,
  tenantId: string = tenantA,
) {
  const form = new URLSearchParams({
    merchantCode: MERCHANT,
    amount: String(amount),
    merchantOrderId: orderId,
    resultCode: "00",
    signature: hmac(`${MERCHANT}${amount}${orderId}`, apiKey),
    reference,
  });
  return request(app)
    .post(`/api/webhooks/payments/duitku/${tenantId}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(form.toString());
}

async function intentState(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    charged_idr: string;
    guest_fee_idr: string;
  }>(
    "SELECT status, charged_idr::text, guest_fee_idr::text FROM payment_intents WHERE id = $1",
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

async function funds(intentId: string) {
  const { rows } = await owner.query<{ amount_idr: string; reason: string }>(
    "SELECT amount_idr::text, reason FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [tenantA, intentId],
  );
  return rows.map((row) => ({
    amountIdr: Number(row.amount_idr),
    reason: row.reason,
  }));
}

async function eventPayloads(name: string, intentId: string) {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND event->'payload'->>'intentId' = $3`,
    [tenantA, name, intentId],
  );
  return rows.map((row) => row.payload);
}

async function settleAtCharged(bill: Bill) {
  statusAnswers.set(bill.intentId, {
    statusCode: "00",
    reference: bill.reference,
    amount: String(CHARGED),
  });
  const response = await callback(bill.intentId, bill.reference, CHARGED);
  expect(response.status).toBe(200);
}

describe("0544 CHECK: a guest fee only on a Duitku va, ewallet or card intent", () => {
  it("charged_idr is the bill plus the fee", async () => {
    const bill = await openFeeIntent();
    expect(await intentState(bill.intentId)).toMatchObject({
      charged_idr: String(CHARGED),
      guest_fee_idr: String(GUEST_FEE),
    });
  });

  it.each([
    ["qris", "duitku", null],
    ["ewallet", "doit", "OV"],
    ["bank_transfer", "duitku", "BC"],
  ])("refuses a fee on %s via %s", async (method, provider, channel) => {
    const linkId = await openLink();
    await expect(
      owner.query(insertIntentSql, [
        randomUUID(),
        tenantA,
        outletA,
        linkId,
        method,
        provider,
        BILL_TOTAL,
        500,
        `k-${unique()}`,
        `REF${unique()}`,
        integrationId,
        JSON.stringify({ method }),
        channel,
      ]),
    ).rejects.toThrow(/payment_intents_guest_fee_check/);
  });

  it("refuses a negative fee and a written charged_idr", async () => {
    const linkId = await openLink();
    await expect(
      owner.query(insertIntentSql, [
        randomUUID(),
        tenantA,
        outletA,
        linkId,
        "ewallet",
        "duitku",
        BILL_TOTAL,
        -1,
        `k-${unique()}`,
        `REF${unique()}`,
        integrationId,
        JSON.stringify({ method: "ewallet" }),
        "OV",
      ]),
    ).rejects.toThrow(/payment_intents_guest_fee_check/);
    const bill = await openFeeIntent();
    await expect(
      owner.query("UPDATE payment_intents SET charged_idr = 1 WHERE id = $1", [
        bill.intentId,
      ]),
    ).rejects.toThrow(/charged_idr/);
  });
});

describe("settlement at the charged amount", () => {
  it("a callback at bill + fee settles: the bill gets the bill, nothing is unallocated", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    expect((await intentState(bill.intentId)).status).toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await funds(bill.intentId)).toEqual([]);
    const [paid] = await eventPayloads("payment.paid", bill.intentId);
    expect(paid).toMatchObject({
      amountIdr: BILL_TOTAL,
      receivedIdr: CHARGED,
      guestFeeIdr: GUEST_FEE,
      allocatedIdr: BILL_TOTAL,
      unallocatedIdr: 0,
    });
  });

  it("a callback at the bill alone (fee missing) is AMOUNT_MISMATCH: held and parked whole", async () => {
    const bill = await openFeeIntent();
    statusAnswers.set(bill.intentId, {
      statusCode: "00",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    const response = await callback(bill.intentId, bill.reference, BILL_TOTAL);
    expect(response.status).toBe(200);
    expect((await intentState(bill.intentId)).status).toBe("failed");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await funds(bill.intentId)).toEqual([
      { amountIdr: BILL_TOTAL, reason: "double_payment" },
    ]);
    expect(await eventPayloads("payment.paid", bill.intentId)).toEqual([]);
  });

  it("TEN-01 tenant B's URL naming tenant A's fee intent answers 401 and moves nothing", async () => {
    const bill = await openFeeIntent();
    statusAnswers.set(bill.intentId, {
      statusCode: "00",
      reference: bill.reference,
      amount: String(CHARGED),
    });
    const response = await callback(
      bill.intentId,
      bill.reference,
      CHARGED,
      tenantB,
    );
    expect(response.status).toBe(401);
    expect((await intentState(bill.intentId)).status).toBe("pending");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
  });
});

describe("§4 the guest fee is never refunded", () => {
  it("the refund cap of a paid fee intent is the bill, not the charged amount", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    const balance = await withTenant(db, contextFor("session"), async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantA),
            eq(paymentIntents.id, bill.intentId),
          ),
        );
      return refundableBalance(tx, intent!, { lockDeposit: false });
    });
    expect(balance.paid).toBe(BigInt(BILL_TOTAL));
    expect(balance.cap).toBeLessThanOrEqual(BigInt(BILL_TOTAL));
  });

  it("a second payment of the same code at the charged amount parks only the bill part", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    await confirmPayment(contextFor("webhook"), bill.intentId, {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: CHARGED,
      providerRef: `${bill.reference}-2`,
      at: new Date().toISOString(),
    });
    expect(await funds(bill.intentId)).toEqual([
      { amountIdr: BILL_TOTAL, reason: "double_payment" },
    ]);
    const [parked] = await eventPayloads(
      "payment.funds_unallocated",
      bill.intentId,
    );
    expect(parked).toMatchObject({
      receivedIdr: CHARGED,
      guestFeeIdr: GUEST_FEE,
    });
    // The bill is still credited once.
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });
});

describe("a second payment above the charged amount still keeps the fee (fee second opinion P3-1)", () => {
  it("parks what was paid less the fee, the fee is withheld", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    const extra = 5_000;
    await confirmPayment(contextFor("webhook"), bill.intentId, {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: CHARGED + extra,
      providerRef: `${bill.reference}-2`,
      at: new Date().toISOString(),
    });
    expect(await funds(bill.intentId)).toEqual([
      { amountIdr: BILL_TOTAL + extra, reason: "double_payment" },
    ]);
    const [parked] = await eventPayloads(
      "payment.funds_unallocated",
      bill.intentId,
    );
    expect(parked).toMatchObject({
      receivedIdr: CHARGED + extra,
      guestFeeIdr: GUEST_FEE,
    });
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it("a second payment below the charged amount is parked whole", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    await confirmPayment(contextFor("webhook"), bill.intentId, {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: CHARGED - 1,
      providerRef: `${bill.reference}-3`,
      at: new Date().toISOString(),
    });
    expect(await funds(bill.intentId)).toEqual([
      { amountIdr: CHARGED - 1, reason: "double_payment" },
    ]);
  });
});

async function netAllocated(intentId: string): Promise<bigint> {
  return withTenant(db, contextFor("session"), async (tx) => {
    const result = await tx.execute(
      sql`SELECT (${netAllocatedIdrSql(sql`${tenantA}::uuid`, sql`${intentId}::uuid`)})::text AS net`,
    );
    return BigInt((result.rows[0] as { net: string }).net);
  });
}

async function providerRefund(bill: Bill, amountIdr: number): Promise<void> {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'duitku', $4, $5, $6, 'payment_webhook')`,
    [
      tenantA,
      outletA,
      bill.intentId,
      `rf_${unique()}`,
      bill.reference,
      amountIdr,
    ],
  );
}

describe("net allocated of a fee intent is the bill, never bill + fee (K1 review P2-1)", () => {
  it("a paid fee intent put the bill toward its bill, not the charged amount", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    expect(await netAllocated(bill.intentId)).toBe(BigInt(BILL_TOTAL));
  });

  it("a provider refund within the fee is taken off the bill, not hidden in the fee", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    await providerRefund(bill, GUEST_FEE - 1_000);
    expect(await netAllocated(bill.intentId)).toBe(
      BigInt(BILL_TOTAL - (GUEST_FEE - 1_000)),
    );
  });

  it("a second payment at the charged amount does not raise it above the bill", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    await confirmPayment(contextFor("webhook"), bill.intentId, {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: CHARGED,
      providerRef: `${bill.reference}-2`,
      at: new Date().toISOString(),
    });
    expect(await netAllocated(bill.intentId)).toBe(BigInt(BILL_TOTAL));
  });

  it("an intent without a fee gives the old result: evidence less funds", async () => {
    const bill = await openFeeIntent();
    await owner.query(
      "UPDATE payment_intents SET guest_fee_idr = 0 WHERE id = $1",
      [bill.intentId],
    );
    statusAnswers.set(bill.intentId, {
      statusCode: "00",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    expect(
      (await callback(bill.intentId, bill.reference, BILL_TOTAL)).status,
    ).toBe(200);
    expect(await netAllocated(bill.intentId)).toBe(BigInt(BILL_TOTAL));
    await providerRefund(bill, 1_000);
    expect(await netAllocated(bill.intentId)).toBe(BigInt(BILL_TOTAL - 1_000));
  });
});

async function refundable(intentId: string) {
  return withTenant(db, contextFor("session"), async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantA),
          eq(paymentIntents.id, intentId),
        ),
      );
    return refundableBalance(tx, intent!, { lockDeposit: false });
  });
}

describe("the fee is taken off once, whatever else parked (fee second opinion P2-1)", () => {
  it("a fee code paid late after the bill was covered counts nothing and refunds nothing", async () => {
    const bill = await openFeeIntent();
    // Another code (QRIS) already paid the whole bill.
    await owner.query("UPDATE payment_links SET paid_idr = $2 WHERE id = $1", [
      bill.linkId,
      BILL_TOTAL,
    ]);
    await settleAtCharged(bill);
    // Parked is the bill (the fee is not parked), so nothing is left.
    expect(await funds(bill.intentId)).toEqual([
      { amountIdr: BILL_TOTAL, reason: "double_payment" },
    ]);
    expect(await netAllocated(bill.intentId)).toBe(0n);
    const balance = await refundable(bill.intentId);
    expect(balance.paid).toBe(0n);
    expect(balance.cap).toBe(0n);
  });

  it("a code held for a wrong amount (parked whole, never paid) counts nothing", async () => {
    const bill = await openFeeIntent();
    statusAnswers.set(bill.intentId, {
      statusCode: "00",
      reference: bill.reference,
      amount: String(BILL_TOTAL),
    });
    await callback(bill.intentId, bill.reference, BILL_TOTAL);
    expect(await netAllocated(bill.intentId)).toBe(0n);
    expect((await refundable(bill.intentId)).paid).toBe(0n);
  });

  it("a second payment at the charged amount keeps the refund limit at the bill", async () => {
    const bill = await openFeeIntent();
    await settleAtCharged(bill);
    await confirmPayment(contextFor("webhook"), bill.intentId, {
      source: "verified_webhook",
      method: "ewallet",
      amountIdr: CHARGED,
      providerRef: `${bill.reference}-2`,
      at: new Date().toISOString(),
    });
    expect((await refundable(bill.intentId)).paid).toBe(BigInt(BILL_TOTAL));
  });
});

describe("payment.paid journal (§3)", () => {
  const roles: PostingAccountRole[] = [
    "gateway_clearing",
    "customer_deposit",
    "gateway_fee_expense",
  ];
  const accounts = new Map(
    roles.map((role, index) => [
      role,
      `0b1f2c3d-0000-4000-8000-00000000a00${index}` as never,
    ]),
  );
  const linesOf = (
    event: "payment.paid" | "payment.funds_unallocated",
    amounts: Record<string, number>,
  ) =>
    buildJournalLinesFromRule(
      resolvePostingRule(defaultPostingRules, { eventName: event }),
      amounts,
      accounts,
      { outletId: null },
    ).map((line) => ({
      role: roles.find((role) => accounts.get(role) === line.accountId),
      debitIdr: line.debitIdr,
      creditIdr: line.creditIdr,
    }));

  it.each(["payment.paid", "payment.funds_unallocated"] as const)(
    "%s: Dr clearing charged, Cr deposit bill, Cr fee expense fee; balanced",
    (event) => {
      const lines = linesOf(event, {
        receivedIdr: CHARGED,
        depositIdr: BILL_TOTAL,
        guestFeeIdr: GUEST_FEE,
      });
      expect(lines).toEqual([
        { role: "gateway_clearing", debitIdr: CHARGED, creditIdr: 0 },
        { role: "customer_deposit", debitIdr: 0, creditIdr: BILL_TOTAL },
        { role: "gateway_fee_expense", debitIdr: 0, creditIdr: GUEST_FEE },
      ]);
    },
  );

  it("without a fee the zero line is skipped (two lines, as before)", () => {
    expect(
      linesOf("payment.paid", {
        receivedIdr: BILL_TOTAL,
        depositIdr: BILL_TOTAL,
        guestFeeIdr: 0,
      }),
    ).toEqual([
      { role: "gateway_clearing", debitIdr: BILL_TOTAL, creditIdr: 0 },
      { role: "customer_deposit", debitIdr: 0, creditIdr: BILL_TOTAL },
    ]);
  });
});
