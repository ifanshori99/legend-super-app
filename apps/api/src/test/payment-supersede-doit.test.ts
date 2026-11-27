// A superseded DOIT code that is still payable (review K, item A4).
//
// Creating a new intent for a bill supersedes the previous pending one:
// `supersedePending` (payment.service.ts) only flips it to `expired` in our
// database (reason `superseded`). The gateway has no cancel call, so the old
// DOIT payment stays payable at DOIT. These tests trace what happens when the
// guest pays that old code anyway. Since legend-osqou.41 the route refuses a
// second live code on a link with no order (409 ORDER_CODE_ACTIVE); the
// superseded state is built directly (see `supersededBill`).
//
// Observed behaviour (asserted below):
// - Webhook for the old (expired, superseded) intent while a newer one is
//   pending: the lifecycle accepts it as a late payment. The bill is settled
//   once, the old intent ends `paid` with flag `late_payment`, one evidence
//   row, no unallocated funds. The newer intent stays `pending` and payable.
// - The newer intent paid afterwards (webhook or poll): its money is not
//   allocated again (the bill is covered). The intent ends `paid`, flagged
//   `double_payment`, and an unallocated-funds row (`double_payment`, full
//   amount) is recorded once, so the money is parked for refund or credit, not
//   lost. Replays are no-ops.
// - The reverse order (newer paid first, then the old one) parks the old
//   code's money the same way (flags `late_payment` and `double_payment`).
// - Lost webhook: the poller also asks DOIT about recently expired intents
//   whose code is still payable (review K, F7). A payment on the old code is
//   settled as a late payment; an underpayment is parked as unallocated funds.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import { agent } from "./helpers";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const webhookPath = `/api/webhooks/payments/doit/${tenantA}`;
const BILL_TOTAL = 144_375;

// Fake credentials: only this file's fake DOIT and webhook signer know them.
const apiKey = `doit-key-s-${randomBytes(12).toString("hex")}`;
const secret = `whsec-s-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdLinkIds: string[] = [];
let integrationId = "";

const unique = () => randomBytes(4).toString("hex");

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
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

// ---------------------------------------------------------------------------
// Fake DOIT server (same contract as payment-webhook-api.test.ts)
// ---------------------------------------------------------------------------

/** Official DOIT payment object (https://doit.id/docs/en/): no paid amount;
 * a paid payment credits the bill `amount`. */
type DoitPayment = {
  id: string;
  status: "pending" | "paid" | "refunded" | "expired" | "failed";
  amount: number;
  rail: string | null;
  reference: string;
  qr_content: string | null;
  va_number: string | null;
  va_bank: string | null;
  hosted_url: string | null;
  return_url: string | null;
  provider: string;
  provider_ref: string | null;
  fee_amount: number;
  fee_payer: string;
  total_amount: number;
  expires_at: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

class FakeDoit {
  readonly payments = new Map<string, DoitPayment>();
  private readonly byIdempotencyKey = new Map<string, DoitPayment>();
  /** Every request the fake received, to prove nothing cancelled a code. */
  readonly calls: string[] = [];
  private server: Server | null = null;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((accept) =>
      this.server!.listen(0, "127.0.0.1", accept),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((accept) =>
      this.server ? this.server.close(() => accept()) : accept(),
    );
  }

  /** The provider reports the payment as paid, crediting `amount` (the
   * whole bill by default). */
  settle(id: string, amount: number = BILL_TOTAL): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** A `payment.paid` / `payment.expired` webhook body for the payment. */
  eventFor(id: string, status: "paid" | "expired") {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return {
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: `payment.${status}`,
      created_at: new Date().toISOString(),
      data: { ...payment, status },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    this.calls.push(`${req.method} ${url.pathname}`);

    if (req.headers.authorization !== `Bearer ${apiKey}`)
      return send(401, {
        error: { code: "unauthorized", message: "Invalid API key" },
      });
    if (req.method === "GET" && url.pathname === "/v1/methods")
      return send(200, {
        environment: "sandbox",
        amount: null,
        data: [
          {
            code: "qris",
            label: "QRIS",
            rail: "qris",
            bank: null,
            fee_flat: 0,
            fee_pct: 0,
            fee_payer: "merchant",
            min_amount: null,
            max_amount: null,
            fee_amount: 0,
            total_amount: null,
            within_limits: true,
            limit: null,
          },
        ],
      });
    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(key);
      if (known) return send(200, known);
      const input = JSON.parse(body) as {
        amount: number;
        rail: string;
        reference: string;
        expires_in: number;
      };
      const id = `dp_${randomBytes(8).toString("hex")}`;
      const createdAt = new Date();
      const payment: DoitPayment = {
        id,
        status: "pending",
        amount: input.amount,
        rail: input.rail,
        reference: input.reference,
        qr_content: "00020101021226610014ID.CO.DOIT.FAKE",
        va_number: null,
        va_bank: null,
        hosted_url: `https://pay.doit.id/p/${id}`,
        return_url: null,
        provider: "pjp",
        provider_ref: null,
        fee_amount: 0,
        fee_payer: "merchant",
        total_amount: input.amount,
        expires_at: new Date(
          createdAt.getTime() + input.expires_in * 1000,
        ).toISOString(),
        paid_at: null,
        metadata: null,
        created_at: createdAt.toISOString(),
      };
      this.payments.set(payment.id, payment);
      if (key) this.byIdempotencyKey.set(key, payment);
      return send(201, payment);
    }
    const found = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && found) {
      const payment = this.payments.get(decodeURIComponent(found[1]!));
      return payment ? send(200, payment) : send(404, { error: "not_found" });
    }
    return send(404, { error: "not_found" });
  }
}

const doit = new FakeDoit();

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  const context = tenantContext();
  const created = await upsertIntegration(
    context,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(context, created.id, { status: "active" }, actor);
  integrationId = created.id;
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
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantA,
  ]);
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantA, createdLinkIds],
    );
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
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
  }
  await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
    integrationId,
  ]);
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

type Intent = { id: string; providerRef: string };
type Bill = { token: string; linkId: string };

async function openBill(): Promise<Bill> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `S-${unique()}`,
      tableLabel: "A04",
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
  return { token: opened.token, linkId: opened.linkId };
}

/** A new QRIS code for the bill; any pending code before it is superseded. */
async function newCode(bill: Bill): Promise<Intent> {
  const created = await agent(app)
    .post(`/api/payments/links/${bill.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [id],
  );
  const providerRef = rows[0]?.provider_ref;
  if (!providerRef) throw new Error("Intent has no DOIT payment id");
  return { id, providerRef };
}

/** A bill whose first code was superseded by a second, both payable at DOIT. */
async function supersededBill(): Promise<{
  bill: Bill;
  oldCode: Intent;
  newerCode: Intent;
}> {
  const bill = await openBill();
  const oldCode = await newCode(bill);
  // legend-osqou.41 (1bdbf0a8b, CTO 27 Nov): a link with no order refuses a
  // new code while the old one is live, so the route no longer supersedes.
  // The superseded state (expired here, not final at DOIT) still exists for
  // codes issued before that rule; it is built by closing the old code just
  // long enough to issue the newer one, then reopening it at the provider.
  await owner.query(
    "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
    [tenantA, oldCode.id],
  );
  const newerCode = await newCode(bill);
  await owner.query(
    "UPDATE payment_intents SET provider_final_at = NULL WHERE tenant_id = $1 AND id = $2",
    [tenantA, oldCode.id],
  );
  expect((await intentRow(oldCode.id)).status).toBe("expired");
  expect((await intentRow(newerCode.id)).status).toBe("pending");
  return { bill, oldCode, newerCode };
}

function signatureHeader(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

async function deliver(body: object) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

const payAtDoit = (code: Intent) =>
  deliver(doit.eventFor(code.providerRef, "paid"));

const pollLater = () =>
  pollPendingGatewayIntents(
    tenantContext(),
    new Date(Date.now() + 120_000),
    100,
  );

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{ status: string; flags: string[] }>(
    "SELECT status, flags FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

const evidenceCount = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );

async function unallocatedRows(intentId: string) {
  const { rows } = await owner.query<{ reason: string; amount_idr: string }>(
    "SELECT reason, amount_idr::text AS amount_idr FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return rows.map((row) => ({
    reason: row.reason,
    amountIdr: Number(row.amount_idr),
  }));
}

async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

/** Total money DOIT confirmed for the bill == allocated + parked funds. */
async function parkedIdr(codes: Intent[]): Promise<number> {
  let total = 0;
  for (const code of codes)
    for (const row of await unallocatedRows(code.id)) total += row.amountIdr;
  return total;
}

// ---------------------------------------------------------------------------
// A4
// ---------------------------------------------------------------------------

describe("A4 a superseded DOIT code that is still payable", () => {
  it("supersede only expires the code in our database; nothing cancels it at DOIT", async () => {
    const { oldCode, newerCode } = await supersededBill();
    expect(doit.payments.get(oldCode.providerRef)?.status).toBe("pending");
    expect(doit.payments.get(newerCode.providerRef)?.status).toBe("pending");
    // The adapter only creates payments; there is no cancel call.
    expect(
      doit.calls.filter((call) => /^(DELETE|PUT|PATCH)\b/.test(call)),
    ).toEqual([]);
    expect(doit.calls.some((call) => /cancel/i.test(call))).toBe(false);
  });

  it("the old code paid by webhook settles the bill once, flagged late_payment", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    const response = await payAtDoit(oldCode);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");

    const old = await intentRow(oldCode.id);
    expect(old.status).toBe("paid");
    expect(old.flags).toEqual(["late_payment"]);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await unallocatedRows(oldCode.id)).toEqual([]);
    // Nothing is lost, nothing is double counted; the newer code is untouched.
    expect((await intentRow(newerCode.id)).status).toBe("pending");
    expect(await evidenceCount(newerCode.id)).toBe(0);
  });

  it("replaying the old code's webhook records nothing more", async () => {
    const { bill, oldCode } = await supersededBill();
    const event = doit.eventFor(oldCode.providerRef, "paid");
    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);
    expect((await payAtDoit(oldCode)).status).toBe(200);

    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await unallocatedRows(oldCode.id)).toEqual([]);
    expect((await intentRow(oldCode.id)).flags).toEqual(["late_payment"]);
  });

  it("then the newer code paid by webhook is parked as double_payment, not lost", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    expect((await payAtDoit(oldCode)).status).toBe(200);
    const event = doit.eventFor(newerCode.providerRef, "paid");
    const response = await deliver(event);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");

    const newer = await intentRow(newerCode.id);
    expect(newer.status).toBe("paid");
    expect(newer.flags).toContain("double_payment");
    // The bill is not credited twice.
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(newerCode.id)).toBe(1);
    expect(await unallocatedRows(newerCode.id)).toEqual([
      { reason: "double_payment", amountIdr: BILL_TOTAL },
    ]);

    // Replays stay a no-op.
    expect((await deliver(event)).status).toBe(200);
    expect((await payAtDoit(newerCode)).status).toBe(200);
    expect(await evidenceCount(newerCode.id)).toBe(1);
    expect(await unallocatedRows(newerCode.id)).toHaveLength(1);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it("then the newer code found paid by the poller is parked as double_payment too", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    expect((await payAtDoit(oldCode)).status).toBe(200);
    doit.settle(newerCode.providerRef);

    const result = await pollLater();
    expect(result.settled).toBeGreaterThanOrEqual(1);

    expect((await intentRow(newerCode.id)).status).toBe("paid");
    expect((await intentRow(newerCode.id)).flags).toContain("double_payment");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(newerCode.id)).toBe(1);
    expect(await unallocatedRows(newerCode.id)).toEqual([
      { reason: "double_payment", amountIdr: BILL_TOTAL },
    ]);
    // The webhook for the same payment arriving after the poll adds nothing.
    expect((await payAtDoit(newerCode)).status).toBe(200);
    expect(await evidenceCount(newerCode.id)).toBe(1);
    expect(await unallocatedRows(newerCode.id)).toHaveLength(1);
  });

  it("reverse order: the newer code paid first, the old code paid later is parked", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    expect((await payAtDoit(newerCode)).status).toBe(200);
    expect((await intentRow(newerCode.id)).flags).toEqual([]);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);

    const late = await payAtDoit(oldCode);
    expect(late.status).toBe(200);
    const old = await intentRow(oldCode.id);
    expect(old.status).toBe("paid");
    expect([...old.flags].sort()).toEqual(["double_payment", "late_payment"]);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await unallocatedRows(oldCode.id)).toEqual([
      { reason: "double_payment", amountIdr: BILL_TOTAL },
    ]);
    expect(await unallocatedRows(newerCode.id)).toEqual([]);
  });

  it("every rupee DOIT confirmed is either allocated to the bill or parked", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    await payAtDoit(oldCode);
    await payAtDoit(newerCode);
    const confirmed = 2 * BILL_TOTAL;
    expect(
      (await linkPaidIdr(bill.linkId)) +
        (await parkedIdr([oldCode, newerCode])),
    ).toBe(confirmed);
  });

  // Closed gap (review K, F7): the poller also asks about recently expired
  // intents whose DOIT code is still payable, so a payment on a superseded
  // code is found even when its webhook never arrives.
  it("lost webhook: a payment on the old code is found by the poller and settled as late", async () => {
    const { bill, oldCode } = await supersededBill();
    doit.settle(oldCode.providerRef);

    const result = await pollLater();
    expect(result.settled).toBeGreaterThanOrEqual(1);

    const old = await intentRow(oldCode.id);
    expect(old.status).toBe("paid");
    expect(old.flags).toContain("late_payment");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await unallocatedRows(oldCode.id)).toEqual([]);
    // The webhook arriving later, and another poll, add nothing.
    expect((await payAtDoit(oldCode)).status).toBe(200);
    await pollLater();
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it("lost webhook: an underpayment on the old code is parked, the intent stays expired", async () => {
    const { bill, oldCode } = await supersededBill();
    doit.settle(oldCode.providerRef, BILL_TOTAL - 1_000);

    await pollLater();
    await pollLater();

    expect((await intentRow(oldCode.id)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await evidenceCount(oldCode.id)).toBe(1);
    expect(await unallocatedRows(oldCode.id)).toEqual([
      { reason: "double_payment", amountIdr: BILL_TOTAL - 1_000 },
    ]);
  });

  it("an old code DOIT still reports pending is left alone by the poller", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();

    await pollLater();

    expect((await intentRow(oldCode.id)).status).toBe("expired");
    expect((await intentRow(newerCode.id)).status).toBe("pending");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
    expect(await evidenceCount(oldCode.id)).toBe(0);
  });
  /** Superseded 20 minutes ago; its code lapsed 10 minutes ago, well past
   * the 60-second grace that used to end its poll. */
  const lapseSuperseded = (code: Intent) =>
    owner.query(
      `UPDATE payment_intents
       SET updated_at = now() - interval '20 minutes',
           expires_at = now() - interval '10 minutes'
       WHERE id = $1`,
      [code.id],
    );
  const statusReads = (code: Intent) =>
    doit.calls.filter((call) => call === `GET /v1/payments/${code.providerRef}`)
      .length;

  it("a gateway error after the old code lapsed does not drop it: a later poll still settles it", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode);
    const first = new Date(Date.now() + 120_000);
    const payment = doit.payments.get(oldCode.providerRef)!;
    doit.payments.delete(oldCode.providerRef);
    try {
      await pollPendingGatewayIntents(tenantContext(), first, 100);
    } finally {
      doit.payments.set(oldCode.providerRef, payment);
    }
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    expect(await evidenceCount(oldCode.id)).toBe(0);

    doit.settle(oldCode.providerRef);
    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(first.getTime() + 20 * 60_000),
      100,
    );
    const old = await intentRow(oldCode.id);
    expect(old.status).toBe("paid");
    expect(old.flags).toContain("late_payment");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it("a definitive DOIT answer after the old code lapsed ends its poll", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode);
    doit.payments.get(oldCode.providerRef)!.status = "expired";
    const first = new Date(Date.now() + 120_000);
    await pollPendingGatewayIntents(tenantContext(), first, 100);
    const reads = statusReads(oldCode);
    expect(reads).toBeGreaterThanOrEqual(1);

    // Later runs no longer ask DOIT about it.
    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(first.getTime() + 2 * 60 * 60_000),
      100,
    );
    expect(statusReads(oldCode)).toBe(reads);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
  });
});
