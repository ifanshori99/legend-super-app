// legend-3wpf reopened (brief 952, second-opinion P1): a code the provider
// answered `refunded` must never be paid by a LATE `payment.paid` webhook.
// Written from the money rules (the provider gave the money back, so the
// outlet must not book it as paid), not from the implementation, and failing
// first.
//
// Rules asserted:
//  R1 A code DOIT reports `refunded` (answered by the poller before OR after
//     its expiry) is later hit by a genuine, correctly signed `payment.paid`
//     webhook with the same reference and amount: the bill stays unpaid
//     (paid_idr = 0), the intent never becomes `paid`, no `payment.paid`
//     event is published, no evidence row and no unallocated (refundable)
//     funds appear. Resending the webhook (same body, or a fresh event id)
//     adds nothing either.
//  R2 Control (must keep working): a code that merely FAILED (not refunded)
//     and is then really paid is still reconciled, exactly once.
//  R3 Reverse order: the genuine paid webhook arrives first, the poll answer
//     `refunded` comes after: the bill is credited once, never twice, and
//     nothing extra is published.
//
// Tests that pass before the fix are guards: R2 and R3. R1 fails first
// because the stored `failed`/`expired` carries no proof of the refund, so
// the late webhook settles the bill with money the provider already returned.
//
// Assumptions (the spec does not fix them):
//  - The HTTP status the webhook endpoint answers for the ignored payment is
//    not pinned beyond "not a server error" (the provider only needs a
//    non-5xx so it stops retrying).
//  - The terminal local status of a refunded code is `failed` or `expired`
//    (same assumption as payment-doit-recon-remainder.test.ts F3).
//  - QRIS is used as the rail because the fake DOIT here only offers QRIS;
//    the money rule is rail independent (the SO text speaks of a VA).
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
let doitGateway: ReturnType<typeof createDoitGateway>;

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
  doitGateway = createDoitGateway({
    loadCredentials: async () => ({
      integration: {
        id: integrationId,
        outletId: null,
        config: { baseUrl: doit.baseUrl },
      },
      credentials: { apiKey, webhookSecret: secret },
    }),
  });
  setPaymentGateway(doitGateway);
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
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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

// ---------------------------------------------------------------------------
// Helpers for the new findings
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const pollAt = (at: Date) =>
  pollPendingGatewayIntents(tenantContext(), at, 100);
const pollSoon = () => pollAt(new Date(Date.now() + 2 * MINUTE));
const pollAtLater = () => pollAt(new Date(Date.now() + 3 * 60 * MINUTE));

/** A pending code whose life ended `age` ago (a PostgreSQL interval). */
const lapse = (code: Intent, age: string) =>
  owner.query(
    "UPDATE payment_intents SET expires_at = now() - $2::interval WHERE id = $1",
    [code.id, age],
  );

/** Nothing was credited, parked or recorded for the code and its bill. */
async function expectNoMoney(bill: Bill, code: Intent) {
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  expect(await evidenceCount(code.id)).toBe(0);
  expect(await unallocatedRows(code.id)).toEqual([]);
}

/** The bill was credited once, by this code, with one evidence row. */
async function expectPaidOnce(bill: Bill, code: Intent) {
  expect((await intentRow(code.id)).status).toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  expect(await evidenceCount(code.id)).toBe(1);
  expect(await unallocatedRows(code.id)).toEqual([]);
}

async function paidEvents(intentId: string): Promise<number> {
  return count(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [tenantA, intentId],
  );
}

const REFUNDED_STATUSES = ["expired", "failed"];

/** The late webhook is acknowledged or refused, never a server error. */
function expectNotServerError(status: number) {
  expect(status).toBeLessThan(500);
}

/** Nothing was credited, published, parked or recorded for the code. */
async function expectNothingBooked(bill: Bill, code: Intent) {
  expect((await intentRow(code.id)).status).not.toBe("paid");
  await expectNoMoney(bill, code);
  expect(await paidEvents(code.id)).toBe(0);
}

/** The provider says `refunded`; the poller reads it. */
async function pollRefunded(code: Intent, lapsedFor?: string) {
  if (lapsedFor) await lapse(code, lapsedFor);
  doit.payments.get(code.providerRef)!.status = "refunded";
  await pollSoon();
  expect(REFUNDED_STATUSES).toContain((await intentRow(code.id)).status);
}

describe("legend-3wpf/952 P1 refunded code is never paid by a late paid webhook", () => {
  it("poll answers refunded BEFORE expiry, then a genuine payment.paid webhook arrives: nothing is booked, resend adds nothing", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await pollRefunded(code);
    await expectNothingBooked(bill, code);

    const late = doit.eventFor(code.providerRef, "paid");
    expectNotServerError((await deliver(late)).status);
    await expectNothingBooked(bill, code);

    // Resend: the identical body, then the provider's retry with a new event id.
    expectNotServerError((await deliver(late)).status);
    expectNotServerError(
      (await deliver(doit.eventFor(code.providerRef, "paid"))).status,
    );
    await expectNothingBooked(bill, code);
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
  });

  it("poll answers refunded AFTER expiry, then a genuine payment.paid webhook arrives: nothing is booked, resend adds nothing", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await pollRefunded(code, "10 minutes");
    await expectNothingBooked(bill, code);

    const late = doit.eventFor(code.providerRef, "paid");
    expectNotServerError((await deliver(late)).status);
    await expectNothingBooked(bill, code);

    expectNotServerError((await deliver(late)).status);
    expectNotServerError(
      (await deliver(doit.eventFor(code.providerRef, "paid"))).status,
    );
    await expectNothingBooked(bill, code);
    expect(await linkPaidIdr(bill.linkId)).toBe(0);
  });

  it("a refunded code never blocks a different, genuinely paid code of the same bill (paid once)", async () => {
    const bill = await openBill();
    const refunded = await newCode(bill);
    // legend-osqou.41 (1bdbf0a8b): the next code is issued only once the
    // provider answer is final, i.e. after the refunded code lapsed.
    await pollRefunded(refunded, "10 minutes");
    expectNotServerError((await payAtDoit(refunded)).status);
    await expectNothingBooked(bill, refunded);

    const fresh = await newCode(bill);
    expect((await payAtDoit(fresh)).status).toBe(200);
    await expectPaidOnce(bill, fresh);
    expect(await paidEvents(fresh.id)).toBe(1);
    // The refunded code still holds nothing.
    expect(await evidenceCount(refunded.id)).toBe(0);
    expect(await unallocatedRows(refunded.id)).toEqual([]);
    expect(await paidEvents(refunded.id)).toBe(0);
  });

  it("control: a code that only FAILED (not refunded) and is then really paid is still reconciled once, resend adds nothing", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    doit.payments.get(code.providerRef)!.status = "failed";
    await pollSoon();
    expect(REFUNDED_STATUSES).toContain((await intentRow(code.id)).status);
    await expectNoMoney(bill, code);

    expect((await payAtDoit(code)).status).toBe(200);
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);

    expect((await payAtDoit(code)).status).toBeLessThan(500);
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);
  });

  it("control: a lapsed code answered failed by the poller, then really paid, is still reconciled once", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "10 minutes");
    doit.payments.get(code.providerRef)!.status = "failed";
    await pollSoon();
    expect(REFUNDED_STATUSES).toContain((await intentRow(code.id)).status);

    expect((await payAtDoit(code)).status).toBe(200);
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);
  });

  it("reverse order: paid webhook first, then the poll answers refunded: credited once, nothing doubled or published again", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    expect((await payAtDoit(code)).status).toBe(200);
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);

    doit.payments.get(code.providerRef)!.status = "refunded";
    await pollSoon();
    await pollAtLater();
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);

    // Even a resend of the paid webhook after the refunded answer adds nothing.
    expectNotServerError((await payAtDoit(code)).status);
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);
  });

  it("reverse order on a lapsed code: paid webhook first, refunded answer later: credited once", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "10 minutes");
    expect((await payAtDoit(code)).status).toBe(200);
    await expectPaidOnce(bill, code);

    doit.payments.get(code.providerRef)!.status = "refunded";
    await pollSoon();
    await pollAtLater();
    await expectPaidOnce(bill, code);
    expect(await paidEvents(code.id)).toBe(1);
  });
});
