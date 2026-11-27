// legend-3wpf: the four DOIT reconciliation findings that remained after the
// first round (card C of brief 941). Written from the money rules, not from
// the implementation, and failing first.
//
// F1 `expireDueIntents` without options must never expire a code the gateway
//    still owns (it has a provider reference): the poller needs the pending row
//    to find money that lands late. Safe is the default.
// F2 A code that is already expired/superseded and still unanswered 24 h past
//    its expiry (GATEWAY_POLL_WINDOW_MS) gets one
//    `payment.reconciliation_timed_out` audit row (like the pending-code path).
//    Polling does NOT stop (founder/CTO decision, SO-885): money may still land
//    on it, so it is asked again with backoff until the provider answers
//    final; replayed polls add no second audit row.
// F3 A DOIT payment the provider reports as `refunded` is a terminal answer,
//    not `pending`: the intent leaves `pending`, is never paid (no credit to
//    the bill), and is not audited as a `gateway_unconfirmed` timeout.
// F4 "The provider answered" is stored in its own column
//    `payment_intents.provider_answered_at`, not inferred from
//    `updated_at < expires_at`. An unrelated touch of `updated_at` must not
//    end the poll and hide a late payment; a real answer must stick.
//
// Money rule asserted throughout: the bill is credited at most once, no
// unallocated funds appear, evidence is recorded at most once, replays add
// nothing.
//
// Not covered (needs implementation knowledge, left to the engineer): the
// late-payment `paidAt` floor that reads `current.updatedAt` as the close
// time, and the migration backfill of `provider_answered_at`.
// Tests that pass before the fix are guards: F1 no-providerRef, F2 inside the
// window, F3 refunded old code, F4 unrelated touch of updated_at.
//
// Ambiguity (assumption): for F3 the spec does not name the terminal local
// status of a refunded code, so the tests accept `expired` or `failed` (both
// are terminal and not paid) and pin only what protects money and labels.
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
  expireDueIntents,
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

/** A pending code whose life ended `age` ago (a PostgreSQL interval). */
const lapse = (code: Intent, age: string) =>
  owner.query(
    "UPDATE payment_intents SET expires_at = now() - $2::interval WHERE id = $1",
    [code.id, age],
  );

/** A superseded (expired) code: superseded 5 minutes before its life ended,
 * and that life ended `age` ago. */
const lapseSuperseded = (code: Intent, age: string) =>
  owner.query(
    `UPDATE payment_intents
     SET expires_at = now() - $2::interval,
         updated_at = now() - $2::interval - interval '5 minutes'
     WHERE id = $1`,
    [code.id, age],
  );

const statusReads = (code: Intent) =>
  doit.calls.filter((call) => call === `GET /v1/payments/${code.providerRef}`)
    .length;

async function timeoutAudits(intentId: string): Promise<string[]> {
  const { rows } = await owner.query<{ reason: string | null }>(
    `SELECT event->>'reason' AS reason FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenantA, "payment.reconciliation_timed_out", intentId],
  );
  return rows.map((row) => String(row.reason));
}

/** DOIT does not know the code: every status read fails. */
async function withDoitDown<T>(code: Intent, run: () => Promise<T>) {
  const payment = doit.payments.get(code.providerRef)!;
  doit.payments.delete(code.providerRef);
  try {
    return await run();
  } finally {
    doit.payments.set(code.providerRef, payment);
  }
}

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

// ---------------------------------------------------------------------------
// F1 expireDueIntents is safe by default
// ---------------------------------------------------------------------------

describe("F1 expireDueIntents without options keeps a gateway-owned code for the poller", () => {
  it("a lapsed DOIT code stays pending after the plain sweep; the poller then settles it once", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "1 hour");

    await expireDueIntents(tenantContext(), new Date(Date.now() + MINUTE));
    expect((await intentRow(code.id)).status).toBe("pending");
    await expectNoMoney(bill, code);

    // The guest paid before the code lapsed; DOIT answers later.
    doit.settle(code.providerRef);
    await pollSoon();
    await expectPaidOnce(bill, code);
    expect((await intentRow(code.id)).flags).toContain("late_payment");

    // Replays (second sweep, second poll, webhook) never pay twice.
    await expireDueIntents(tenantContext(), new Date(Date.now() + MINUTE));
    await pollSoon();
    expect((await payAtDoit(code)).status).toBe(200);
    await expectPaidOnce(bill, code);
  });

  it("the plain sweep also leaves the code alone with an explicit `leaveGatewayReconciling: false`", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "1 hour");
    await expireDueIntents(
      tenantContext(),
      new Date(Date.now() + MINUTE),
      200,
      {
        leaveGatewayReconciling: false,
      },
    );
    expect((await intentRow(code.id)).status).toBe("pending");
  });

  it("a lapsed code with no provider reference (nothing at the gateway to ask) still expires", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await owner.query(
      "UPDATE payment_intents SET provider_ref = NULL, expires_at = now() - interval '1 hour' WHERE id = $1",
      [code.id],
    );
    await expireDueIntents(tenantContext(), new Date(Date.now() + MINUTE));
    expect((await intentRow(code.id)).status).toBe("expired");
    await expectNoMoney(bill, code);
  });
});

// ---------------------------------------------------------------------------
// F2 24 h mark for expired / superseded codes: one audit row, polling goes on
// ---------------------------------------------------------------------------

describe("F2 an expired or superseded code unanswered past 24 h is audited once and still polled", () => {
  it("inside the window an unanswered code is still asked and no timeout is audited", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode, "23 hours");
    await pollSoon();
    expect(statusReads(oldCode)).toBeGreaterThanOrEqual(1);
    expect(await timeoutAudits(oldCode.id)).toEqual([]);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    await expectNoMoney(bill, oldCode);
  });

  it("after the window, DOIT still pending: one reconciliation_timed_out audit (gateway_unconfirmed); polling goes on, replays add no audit", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    await lapseSuperseded(oldCode, "25 hours");
    await pollSoon();
    expect(await timeoutAudits(oldCode.id)).toEqual(["gateway_unconfirmed"]);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    await expectNoMoney(bill, oldCode);

    // The audit is not a stop: the unanswered code is still asked (money may
    // land late), and no later run repeats the audit.
    const reads = statusReads(oldCode);
    await pollAt(new Date(Date.now() + 3 * 60 * MINUTE));
    // 20 h later: still inside the newer code's own 24 h window (30 h would
    // time that live code out too, which is correct and not under test).
    await pollAt(new Date(Date.now() + 20 * 60 * MINUTE));
    expect(statusReads(oldCode)).toBeGreaterThan(reads);
    expect(await timeoutAudits(oldCode.id)).toEqual(["gateway_unconfirmed"]);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    expect(await answeredAt(oldCode.id)).toBeNull();
    // The newer code of the bill is untouched.
    expect((await intentRow(newerCode.id)).status).toBe("pending");
    expect(await timeoutAudits(newerCode.id)).toEqual([]);
  });

  it("after the window, DOIT unreachable: one audit (gateway_unreachable); the next run asks again without a second audit", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode, "25 hours");
    await withDoitDown(oldCode, pollSoon);
    expect(await timeoutAudits(oldCode.id)).toEqual(["gateway_unreachable"]);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    await expectNoMoney(bill, oldCode);

    const reads = statusReads(oldCode);
    await pollAt(new Date(Date.now() + 3 * 60 * MINUTE));
    expect(statusReads(oldCode)).toBeGreaterThan(reads);
    expect(await timeoutAudits(oldCode.id)).toEqual(["gateway_unreachable"]);
  });

  it("a plain expired pending code (not superseded) follows the same window and audit", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "25 hours");
    await expireDueIntents(
      tenantContext(),
      new Date(Date.now() + MINUTE),
      200,
      {
        leaveGatewayReconciling: true,
      },
    );
    await pollSoon();
    expect((await intentRow(code.id)).status).toBe("expired");
    expect(await timeoutAudits(code.id)).toEqual(["gateway_unconfirmed"]);
    // Still polled afterwards (never marked final), the audit is not repeated.
    const reads = statusReads(code);
    await pollAt(new Date(Date.now() + 5 * 60 * MINUTE));
    expect(statusReads(code)).toBeGreaterThan(reads);
    expect(await timeoutAudits(code.id)).toEqual(["gateway_unconfirmed"]);
    await expectNoMoney(bill, code);
  });
});

// ---------------------------------------------------------------------------
// F3 a refunded DOIT payment is terminal, never pending, never paid
// ---------------------------------------------------------------------------

describe("F3 DOIT status refunded", () => {
  it("getStatus does not report refunded as pending or paid (raw status kept)", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    doit.payments.get(code.providerRef)!.status = "refunded";
    const answer = await doitGateway.getStatus({
      context: tenantContext(),
      providerRef: code.providerRef,
    });
    expect(answer.rawStatus).toBe("refunded");
    expect(answer.status).not.toBe("pending");
    expect(answer.status).not.toBe("paid");
  });

  it("a lapsed code DOIT reports refunded leaves pending without paying the bill, and is not asked again", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "10 minutes");
    doit.payments.get(code.providerRef)!.status = "refunded";

    await pollSoon();
    expect(["expired", "failed"]).toContain((await intentRow(code.id)).status);
    await expectNoMoney(bill, code);
    expect(await timeoutAudits(code.id)).toEqual([]);

    const reads = statusReads(code);
    expect(reads).toBeGreaterThanOrEqual(1);
    await pollAt(new Date(Date.now() + 3 * 60 * MINUTE));
    expect(statusReads(code)).toBe(reads);
    await expectNoMoney(bill, code);
  });

  it("past the window a refunded answer is never audited as a gateway_unconfirmed timeout", async () => {
    const bill = await openBill();
    const code = await newCode(bill);
    await lapse(code, "25 hours");
    doit.payments.get(code.providerRef)!.status = "refunded";
    await pollSoon();
    expect(["expired", "failed"]).toContain((await intentRow(code.id)).status);
    expect(await timeoutAudits(code.id)).not.toContain("gateway_unconfirmed");
    await expectNoMoney(bill, code);
  });

  it("a refunded old code never settles the bill; the newer code still can, once", async () => {
    const { bill, oldCode, newerCode } = await supersededBill();
    await lapseSuperseded(oldCode, "10 minutes");
    doit.payments.get(oldCode.providerRef)!.status = "refunded";
    await pollSoon();
    await expectNoMoney(bill, oldCode);

    expect((await payAtDoit(newerCode)).status).toBe(200);
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(newerCode.id)).toBe(1);
    expect(await unallocatedRows(newerCode.id)).toEqual([]);
    expect(await evidenceCount(oldCode.id)).toBe(0);
    expect(await unallocatedRows(oldCode.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F4 provider_answered_at replaces `updated_at < expires_at`
// ---------------------------------------------------------------------------

async function answeredAt(intentId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ answered: Date | null }>(
    "SELECT provider_answered_at AS answered FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.answered;
}

describe("F4 provider_answered_at marks that the provider answered", () => {
  it("payment_intents has a nullable timestamptz column provider_answered_at", async () => {
    const { rows } = await owner.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'payment_intents' AND column_name = 'provider_answered_at'`,
    );
    expect(rows).toEqual([
      { data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
  });

  // Guard (green before the fix too, the poll does not read updated_at today):
  // it must stay green once the marker moves to provider_answered_at.
  it("an unrelated touch of updated_at after the lapse does not end the poll: a late payment is still found once", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode, "10 minutes");
    // Something else updates the row after its life ended (a flag, a lease):
    // updated_at is now later than expires_at, yet DOIT never answered.
    await owner.query(
      "UPDATE payment_intents SET updated_at = now() WHERE id = $1",
      [oldCode.id],
    );
    doit.settle(oldCode.providerRef);

    await pollSoon();
    await expectPaidOnce(bill, oldCode);
    expect((await intentRow(oldCode.id)).flags).toContain("late_payment");

    // Replays pay nothing more.
    await pollSoon();
    expect((await payAtDoit(oldCode)).status).toBe(200);
    await expectPaidOnce(bill, oldCode);
  });

  it("a definitive DOIT answer is stored; later runs never ask again even when updated_at looks unanswered", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode, "10 minutes");
    expect(await answeredAt(oldCode.id)).toBeNull();
    doit.payments.get(oldCode.providerRef)!.status = "expired";

    await pollSoon();
    expect(await answeredAt(oldCode.id)).not.toBeNull();
    const reads = statusReads(oldCode);
    expect(reads).toBeGreaterThanOrEqual(1);

    // Put updated_at back before expires_at (the old marker says "not
    // answered"): the stored answer still ends the poll.
    await owner.query(
      "UPDATE payment_intents SET updated_at = now() - interval '2 days' WHERE id = $1",
      [oldCode.id],
    );
    await pollAt(new Date(Date.now() + 2 * 60 * MINUTE));
    expect(statusReads(oldCode)).toBe(reads);
    expect((await intentRow(oldCode.id)).status).toBe("expired");
    await expectNoMoney(bill, oldCode);
  });

  it("no answer (DOIT unreachable, or still pending) leaves provider_answered_at empty", async () => {
    const { bill, oldCode } = await supersededBill();
    await lapseSuperseded(oldCode, "10 minutes");

    await withDoitDown(oldCode, pollSoon);
    expect(await answeredAt(oldCode.id)).toBeNull();
    await pollAt(new Date(Date.now() + 90 * MINUTE));
    expect(await answeredAt(oldCode.id)).toBeNull();

    // Still asked afterwards: the late payment is found, once.
    doit.settle(oldCode.providerRef);
    await pollAt(new Date(Date.now() + 3 * 60 * MINUTE));
    await expectPaidOnce(bill, oldCode);
  });
});
