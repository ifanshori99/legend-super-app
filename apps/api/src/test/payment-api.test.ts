// Payment links, intent lifecycle, routing and unallocated funds over the real
// Express app and PostgreSQL (bead legend-gz3; PRD v1.7 §3.13, PAY-01/02/04/05).
//
// The gateway is a test double installed through the port: it returns
// instructions the way a real adapter does and can settle a payment, which is
// how the webhook adapter will call `confirmPayment`. Cross-tenant and
// cross-outlet isolation at the database role live in payment-db.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type {
  PaymentChannel,
  PaymentInstructions,
} from "@starter/shared/payment";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  confirmPayment,
  createPaymentLink,
  expireDueIntents,
  getIntentView,
  getPaymentLinkView,
  requestPayAtCashier,
  type CreatePaymentLinkInput,
} from "../services/payment.service";
import { upsertRoutingRule } from "../services/payment-routing.service";
import {
  listUnallocatedFunds,
  resolveUnallocatedFund,
  unallocatedFundsOfIntent,
} from "../services/payment-unallocated.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdLinkIds: string[] = [];
const createdUserIds: string[] = [];

/** The guest route mints this context from the token; tests mint it directly. */
function contextFor(
  outletIds: readonly OutletId[] = [outletA],
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

/** Tenant-wide configuration (gateway routing) needs a tenant-level scope. */
function tenantWideContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

const unique = () => randomBytes(4).toString("hex");

/** Same bill as the payment contract fixture: Rp125.000 + 5% + 10% PBJT. */
async function openBill(
  overrides: Partial<CreatePaymentLinkInput> = {},
): Promise<{ token: string; linkId: string }> {
  const opened = await createPaymentLink(
    contextFor(),
    {
      outletId: outletA,
      reference: `A03-${unique()}`,
      tableLabel: "A03",
      pax: 3,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: 144_375,
      returnPath: "/t/v1.abc",
      ...overrides,
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  return opened;
}

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  healthValue: "available" | "degraded" | "down" = "available";
  /** Shorten every code's life to exercise expiry without a clock jump. */
  expiresInMs: number | null = null;
  lastCreated: string | null = null;
  private sequence = 0;
  private readonly payments = new Map<string, GatewayPaymentStatus>();

  async health() {
    return { status: this.healthValue };
  }

  async createIntent(input: GatewayIntentRequest) {
    // Provider references are unique per provider transaction in production;
    // the fake keeps the same contract so persisted evidence from an earlier
    // test can never collide with a later one.
    const providerRef = `FAKE-${randomBytes(6).toString("hex")}-${++this.sequence}`;
    this.lastCreated = providerRef;
    this.payments.set(providerRef, {
      status: "pending",
      providerRef,
      amountIdr: input.amountIdr,
    });
    const instructions: PaymentInstructions =
      input.method === "qris"
        ? { method: "qris", qrPayload: "00020101021226FAKEDOIT", issuer: null }
        : input.method === "va"
          ? {
              method: "va",
              channelCode: input.channelCode ?? "bca",
              channelName: "BCA",
              virtualAccountNumber: "8808123456789012",
            }
          : {
              method: "bank_transfer",
              channelCode: input.channelCode ?? "bca",
              channelName: "BCA",
              accountNumber: "1234567890",
              accountHolder: "Cafe Legend",
              uniqueCode: "123",
              transferTotalIdr: idr(input.amountIdr + 123),
            };
    return {
      providerRef,
      instructions,
      expiresAt:
        this.expiresInMs === null
          ? input.expiresAt
          : new Date(Date.now() + this.expiresInMs).toISOString(),
    };
  }

  async getStatus(input: { providerRef: string }) {
    return (
      this.payments.get(input.providerRef) ?? {
        status: "pending" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      }
    );
  }

  async channels(
    _context: ScopedTenantContext,
    method: "qris" | "va" | "bank_transfer",
  ): Promise<PaymentChannel[]> {
    return method === "qris" ? [] : [{ code: "bca", name: "BCA" }];
  }

  settle(providerRef: string, amountIdr?: number) {
    const found = this.payments.get(providerRef);
    if (!found) throw new Error(`No fake payment ${providerRef}`);
    this.payments.set(providerRef, {
      ...found,
      status: "paid",
      amountIdr: amountIdr ?? found.amountIdr,
    });
  }
}

let gateway: FakeGateway;

beforeEach(() => {
  gateway = new FakeGateway();
  setPaymentGateway(gateway);
});

afterEach(() => {
  setPaymentGateway(null);
});

afterAll(async () => {
  if (createdLinkIds.length > 0) {
    await owner.query(
      "DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))",
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))",
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdLinkIds],
    );
  }
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
  await owner.end();
});

async function signedIn(name = "Payment user") {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function assign(userId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
}

describe("PAY-01 server-priced intents behind a payment link", () => {
  it("PAY-01 the link view carries the server bill and payable methods", async () => {
    const { token } = await openBill();
    const response = await agent(app).get(`/api/payments/links/${token}`);
    expect(response.status).toBe(200);
    const view = response.body.data;
    expect(view.bill.totals).toEqual({
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: 144_375,
      paidIdr: 0,
      outstandingIdr: 144_375,
    });
    expect(view.timeZone).toBe("Asia/Jakarta");
    expect(view.methods).toEqual([
      {
        method: "qris",
        enabled: true,
        unavailableReason: null,
        channels: [],
      },
      {
        method: "va",
        enabled: true,
        unavailableReason: null,
        channels: [{ code: "bca", name: "BCA" }],
      },
      {
        method: "bank_transfer",
        enabled: true,
        unavailableReason: null,
        channels: [{ code: "bca", name: "BCA" }],
      },
    ]);
    expect(view.activeIntent).toBeNull();
  });

  it("PAY-01 an unknown token is not found", async () => {
    const response = await agent(app).get(
      `/api/payments/links/pl_${"z".repeat(43)}`,
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("PAY-01 the API creates the intent at the link's outstanding amount and rejects a client amount", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "idem-key-1",
      });
    expect(created.status).toBe(201);
    expect(created.body.data.amountIdr).toBe(144_375);
    expect(created.body.data.status).toBe("pending");
    expect(created.body.data.instructions.method).toBe("qris");
    expect(created.body.data.paidAfterExpiry).toBe(false);

    const injected = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "idem-key-2",
        amountIdr: 1,
      });
    expect(injected.status).toBe(422);
  });

  it("PAY-01 a retried create with the same key returns the first intent", async () => {
    const { token } = await openBill();
    const first = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "same-key" });
    const second = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "same-key" });
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
      [tenantId, createdLinkIds.at(-1)],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("PAY-01 the same idempotency key with another method is refused", async () => {
    const { token } = await openBill();
    await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "reuse-key" });
    const reused = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "va", channelCode: "bca", idempotencyKey: "reuse-key" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("PAY-01 an idempotency key is bound to the whole request fingerprint (link + method + channel)", async () => {
    const first = await openBill();
    const other = await openBill();
    const key = "fingerprint-key";
    const created = await agent(app)
      .post(`/api/payments/links/${first.token}/intents`)
      .send({ method: "va", channelCode: "bca", idempotencyKey: key });
    expect(created.status).toBe(201);

    // Same key and payload on the same link is a retry, not a reuse.
    const retry = await agent(app)
      .post(`/api/payments/links/${first.token}/intents`)
      .send({ method: "va", channelCode: "bca", idempotencyKey: key });
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(created.body.data.id);

    // Another link with the same key is a different request.
    const otherLink = await agent(app)
      .post(`/api/payments/links/${other.token}/intents`)
      .send({ method: "va", channelCode: "bca", idempotencyKey: key });
    expect(otherLink.status).toBe(409);
    expect(otherLink.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // Another channel with the same key is a different request too.
    const otherChannel = await agent(app)
      .post(`/api/payments/links/${first.token}/intents`)
      .send({ method: "va", channelCode: "bni", idempotencyKey: key });
    expect(otherChannel.status).toBe(409);
    expect(otherChannel.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("PAY-01 a new intent supersedes the previous pending code", async () => {
    const { token } = await openBill();
    const first = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "old-key-1" });
    await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "new-key-1" });
    const oldIntent = await agent(app).get(
      `/api/payments/links/${token}/intents/${first.body.data.id}`,
    );
    expect(oldIntent.status).toBe(200);
    expect(oldIntent.body.data.status).toBe("expired");
  });
});

describe("PAY-02 only verified evidence settles", () => {
  it("PAY-02 a gateway status check is the source of truth for a pending intent", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "poll-key" });
    const intentId = created.body.data.id as string;

    const pending = await agent(app).get(
      `/api/payments/links/${token}/intents/${intentId}`,
    );
    expect(pending.body.data.status).toBe("pending");

    // A browser redirect cannot change anything: polling before the gateway
    // confirms still answers pending.
    expect(pending.body.data.paidAt).toBeNull();

    gateway.settle(gateway.lastCreated!);
    const paid = await agent(app).get(
      `/api/payments/links/${token}/intents/${intentId}`,
    );
    expect(paid.body.data.status).toBe("paid");
    expect(paid.body.data.paidAt).not.toBeNull();

    const link = await agent(app).get(`/api/payments/links/${token}`);
    expect(link.body.data.bill.totals.paidIdr).toBe(144_375);
    expect(link.body.data.bill.totals.outstandingIdr).toBe(0);
  });

  it("PAY-02 a browser redirect source is not an accepted confirmation", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "redirect" });
    await expect(
      confirmPayment(
        contextFor(),
        created.body.data.id,
        {
          source: "browser_redirect" as never,
          method: "qris",
          amountIdr: 144_375,
          providerRef: "REDIRECT-1",
          at: new Date().toISOString(),
        },
        { type: "system" },
      ),
    ).rejects.toThrow();
    const after = await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    expect(after.body.data.status).toBe("pending");
  });

  it("PAY-02 authorized cash settles only a cash intent", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "cash-key" });
    await expect(
      confirmPayment(
        contextFor(),
        created.body.data.id,
        {
          source: "authorized_cash",
          method: "cash",
          amountIdr: 144_375,
          providerRef: "CASH-1",
          at: new Date().toISOString(),
        },
        { type: "user", id: "00000000-0000-4000-8000-000000000002" },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("PAY-04 an underpayment never settles", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "under-key" });
    await expect(
      confirmPayment(contextFor(), created.body.data.id, {
        source: "verified_webhook",
        method: "qris",
        amountIdr: 100_000,
        providerRef: "WEBHOOK-UNDER",
        at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("PAY-04 unallocated funds", () => {
  it("PAY-04 an overpayment records the excess as unallocated funds", async () => {
    const { token } = await openBill({
      subtotalIdr: 100_000,
      serviceChargeIdr: 0,
      taxIdr: 0,
      totalIdr: 100_000,
    });
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "over-key" });
    gateway.settle(gateway.lastCreated!, 144_375);
    const settled = await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    expect(settled.body.data.status).toBe("paid");

    const funds = await unallocatedFundsOfIntent(
      contextFor(),
      created.body.data.id,
    );
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      amountIdr: 44_375,
      reason: "overpayment",
      resolution: null,
    });
    const link = await agent(app).get(`/api/payments/links/${token}`);
    expect(link.body.data.bill.totals.paidIdr).toBe(100_000);
    expect(link.body.data.bill.totals.outstandingIdr).toBe(0);
  });

  it("PAY-04 a second payment for a settled intent becomes unallocated double funds", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "double-key",
      });
    gateway.settle(gateway.lastCreated!);
    await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );

    const intent = await confirmPayment(contextFor(), created.body.data.id, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: 144_375,
      providerRef: "WEBHOOK-SECOND",
      at: new Date().toISOString(),
    });
    expect(intent.status).toBe("paid");
    expect(intent.flags).toContain("double_payment");

    const funds = await unallocatedFundsOfIntent(
      contextFor(),
      created.body.data.id,
    );
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      amountIdr: 144_375,
      reason: "double_payment",
    });
  });

  it("HIGH payment.service.ts:923 a retried second payment records unallocated funds once (unique provider evidence)", async () => {
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "double-retry-key",
      });
    gateway.settle(gateway.lastCreated!);
    await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );

    // The same provider transaction is delivered twice (webhook retry).
    const evidence = {
      source: "verified_webhook" as const,
      method: "qris" as const,
      amountIdr: 144_375,
      providerRef: "WEBHOOK-SECOND-RETRY",
      at: new Date().toISOString(),
    };
    await confirmPayment(contextFor(), created.body.data.id, evidence);
    await confirmPayment(contextFor(), created.body.data.id, evidence);

    const funds = await unallocatedFundsOfIntent(
      contextFor(),
      created.body.data.id,
    );
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      amountIdr: 144_375,
      reason: "double_payment",
    });
    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
      [tenantId, created.body.data.id, evidence.providerRef],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("HIGH payment.service.ts:980 concurrent settlements lock the bill row and never double-allocate", async () => {
    const { token, linkId } = await openBill();
    const first = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "race-intent-a",
      });
    // The second intent supersedes the first code; a late payment on the first
    // is still accepted (PRD §3.13 "Siklus Pembayaran").
    const second = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "race-intent-b",
      });

    // Hold the first settlement inside its link update long enough for the
    // second one to read the same balance without the FOR UPDATE lock.
    await owner.query(
      `CREATE OR REPLACE FUNCTION slow_link_update() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`,
    );
    await owner.query(
      "CREATE TRIGGER slow_link_update BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION slow_link_update()",
    );
    try {
      const results = await Promise.allSettled([
        confirmPayment(contextFor(), first.body.data.id, {
          source: "verified_webhook",
          method: "qris",
          amountIdr: 144_375,
          providerRef: "WEBHOOK-RACE-A",
          at: new Date().toISOString(),
        }),
        confirmPayment(contextFor(), second.body.data.id, {
          source: "verified_webhook",
          method: "qris",
          amountIdr: 144_375,
          providerRef: "WEBHOOK-RACE-B",
          at: new Date().toISOString(),
        }),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      await owner.query(
        "DROP TRIGGER IF EXISTS slow_link_update ON payment_links",
      );
      await owner.query("DROP FUNCTION IF EXISTS slow_link_update()");
    }

    const link = await owner.query<{ paid_idr: string }>(
      "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
      [linkId],
    );
    expect(link.rows[0]?.paid_idr).toBe("144375");
    const funds = await owner.query<{ total: string; reason: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS total, min(reason) AS reason FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])",
      [tenantId, [first.body.data.id, second.body.data.id]],
    );
    // Exactly one of the two payments fits the bill; the other is unallocated.
    expect(funds.rows[0]).toEqual({
      total: "144375",
      reason: "double_payment",
    });
  });

  it("PAY-04 a resolution needs payment.reconcile and an approval reference", async () => {
    const { token } = await openBill({
      subtotalIdr: 100_000,
      serviceChargeIdr: 0,
      taxIdr: 0,
      totalIdr: 100_000,
    });
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "resolve-key",
      });
    gateway.settle(gateway.lastCreated!, 120_000);
    await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    const funds = await unallocatedFundsOfIntent(
      contextFor(),
      created.body.data.id,
    );
    expect(funds).toHaveLength(1);

    const { userId } = await signedIn("Finance");
    await expect(
      resolveUnallocatedFund(
        contextFor(),
        funds[0]!.id,
        { resolution: "refund", approvalRef: "APR-1" },
        userId,
      ),
    ).rejects.toThrow();
    // Missing approval reference is refused before any write.
    await assign(userId, "finance");
    await expect(
      resolveUnallocatedFund(
        contextFor(),
        funds[0]!.id,
        { resolution: "refund", approvalRef: "" },
        userId,
      ),
    ).rejects.toThrow();
    const resolved = await resolveUnallocatedFund(
      contextFor(),
      funds[0]!.id,
      { resolution: "refund", approvalRef: "APR-1" },
      userId,
    );
    expect(resolved).toMatchObject({
      resolution: "refund",
      resolvedBy: userId,
      approvalRef: "APR-1",
    });
    await expect(
      resolveUnallocatedFund(
        contextFor(),
        funds[0]!.id,
        { resolution: "credit", approvalRef: "APR-2" },
        userId,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const list = await listUnallocatedFunds(
      contextFor(),
      { limit: 10, resolved: "true", outletId: outletA },
      userId,
    );
    expect(list.data.some((fund) => fund.id === funds[0]!.id)).toBe(true);
  });
});

describe("late payment and refresh", () => {
  it("PAY-04 a payment after expiry is accepted and flagged late_payment", async () => {
    gateway.expiresInMs = 40;
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "late-key-1",
      });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const now = new Date(Date.now() + 60_000);
    const swept = await expireDueIntents(contextFor(), now);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const expired = await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    expect(expired.body.data.status).toBe("expired");

    const paid = await confirmPayment(contextFor(), created.body.data.id, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: 144_375,
      providerRef: "WEBHOOK-LATE",
      at: new Date(now.getTime() + 1_000).toISOString(),
    });
    expect(paid.status).toBe("paid");
    expect(paid.flags).toContain("late_payment");
    const view = await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    expect(view.body.data.paidAfterExpiry).toBe(true);
  });

  it("PAY-01 refresh mints a new code with the outstanding server amount", async () => {
    gateway.expiresInMs = 40;
    const { token } = await openBill();
    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "refresh-key",
      });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const refreshed = await agent(app).post(
      `/api/payments/links/${token}/intents/${created.body.data.id}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.id).not.toBe(created.body.data.id);
    expect(refreshed.body.data.status).toBe("pending");
    expect(refreshed.body.data.amountIdr).toBe(144_375);
  });

  it("pay at cashier acknowledges and is refused once the bill is paid", async () => {
    const { token } = await openBill();
    const ack = await agent(app).post(
      `/api/payments/links/${token}/pay-at-cashier`,
    );
    expect(ack.status).toBe(200);
    expect(Date.parse(ack.body.data.requestedAt)).not.toBeNaN();

    const created = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "cashier-key",
      });
    gateway.settle(gateway.lastCreated!);
    await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    const paid = await agent(app).post(
      `/api/payments/links/${token}/pay-at-cashier`,
    );
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe("CONFLICT");
  });
});

describe("gateway outage and routing", () => {
  it("PAY-02 a down gateway disables the online methods and refuses a new intent", async () => {
    gateway.healthValue = "down";
    const { token } = await openBill();
    const view = await agent(app).get(`/api/payments/links/${token}`);
    expect(view.body.data.gateway.status).toBe("down");
    for (const method of view.body.data.methods)
      expect(method).toMatchObject({
        enabled: false,
        unavailableReason: "gateway_down",
      });
    const refused = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "gateway-down",
      });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("SERVICE_UNAVAILABLE");

    const ack = await requestPayAtCashier(contextFor(), token);
    expect(Date.parse(ack.requestedAt)).not.toBeNaN();
  });

  it("PAY-05 a routing change affects new intents only", async () => {
    const { userId } = await signedIn("Owner");
    await expect(
      upsertRoutingRule(
        tenantWideContext(),
        {
          outletId: null,
          method: "qris",
          provider: "duitku",
          fallbackProvider: null,
          enabled: true,
        },
        userId,
      ),
    ).rejects.toThrow();
    await assign(userId, "owner");

    const before = await openBill();
    const first = await agent(app)
      .post(`/api/payments/links/${before.token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: "pre-route" });
    const firstRow = await owner.query<{ provider: string }>(
      "SELECT provider FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.body.data.id],
    );
    expect(firstRow.rows[0]?.provider).toBe("doit"); // PRD §3.13 default

    const saved = await upsertRoutingRule(
      tenantWideContext(),
      {
        outletId: null,
        method: "qris",
        provider: "duitku",
        fallbackProvider: "doit",
        enabled: true,
      },
      userId,
    );
    expect(saved).toMatchObject({
      method: "qris",
      provider: "duitku",
      outletId: null,
    });

    const after = await openBill();
    const second = await agent(app)
      .post(`/api/payments/links/${after.token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: "post-route",
      });
    const secondRow = await owner.query<{ provider: string }>(
      "SELECT provider FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, second.body.data.id],
    );
    expect(secondRow.rows[0]?.provider).toBe("duitku");

    // The intent created before the switch keeps its provider and status.
    const unchanged = await owner.query<{
      provider: string;
      status: string;
    }>(
      "SELECT provider, status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.body.data.id],
    );
    expect(unchanged.rows[0]).toEqual({ provider: "doit", status: "pending" });

    await owner.query(
      "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND method = 'qris' AND outlet_id IS NULL",
      [tenantId],
    );
  });
});

describe("isolation at the service boundary", () => {
  it("TEN-03 a link of another outlet is not reachable with an outlet-scoped context", async () => {
    const { token } = await openBill();
    // The link belongs to outlet A: a context scoped to outlet B is denied at
    // the service boundary (TEN-03), never silently served.
    await expect(
      getPaymentLinkView(contextFor([outletB]), token),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      getIntentView(
        contextFor([outletB]),
        token,
        "00000000-0000-4000-8000-0000000000aa",
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("TEN-03 a link cannot be opened for an outlet outside the caller's scope", async () => {
    await expect(
      createPaymentLink(
        contextFor([outletA]),
        {
          outletId: outletB,
          reference: `B-${unique()}`,
          tableLabel: null,
          pax: null,
          subtotalIdr: 10_000,
          discountIdr: 0,
          serviceChargeIdr: 0,
          taxIdr: 0,
          roundingIdr: 0,
          totalIdr: 10_000,
          returnPath: null,
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("TEN-02 a token of an expired link is not resolved", async () => {
    const opened = await createPaymentLink(
      contextFor(),
      {
        outletId: outletA,
        reference: `EXP-${unique()}`,
        tableLabel: null,
        pax: null,
        subtotalIdr: 10_000,
        discountIdr: 0,
        serviceChargeIdr: 0,
        taxIdr: 0,
        roundingIdr: 0,
        totalIdr: 10_000,
        returnPath: null,
        expiresInMinutes: 1,
      },
      "00000000-0000-4000-8000-000000000001",
    );
    createdLinkIds.push(opened.linkId);
    // Backdate both the link and its token index the way a day-old bill looks.
    await owner.query(
      "UPDATE payment_link_tokens SET expires_at = now() - interval '1 minute' WHERE payment_link_id = $1",
      [opened.linkId],
    );
    const response = await agent(app).get(
      `/api/payments/links/${opened.token}`,
    );
    expect(response.status).toBe(404);
  });
});

describe("TEN-01 tenant id can never come from the caller", () => {
  it("TEN-01 a strict create body rejects a submitted tenantId", async () => {
    const { token } = await openBill();
    const response = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: `t-${randomUUID()}`,
        tenantId: randomUUID(),
      });
    expect(response.status).toBe(422);
  });
});
