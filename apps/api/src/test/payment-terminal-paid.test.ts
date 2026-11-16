// Terminal intent states versus a "paid" signal, and unusual DOIT answers
// for the pending poller (bead legend-rfiof, tier K money).
//
// Covered here:
// 1. A verified DOIT `paid` webhook for a `refunded` / `partially_refunded`
//    intent never reopens it: status stays, the money is parked as
//    `double_payment` (flag, unallocated funds, audit), the webhook event is
//    `processed`.
// 2. The poller never asks DOIT about `failed`, `refunded` or
//    `partially_refunded` intents and never changes them.
//    NOTE (open founder decision, do NOT lock or reverse it here): a `paid`
//    webhook for a `failed` intent today settles as a late payment; that is
//    pinned by `payment-webhook-api.test.ts` ("PAY-03 failed then paid ...").
//    This file deliberately asserts nothing about that webhook path.
// 3. Poller: unknown DOIT statuses ("settled", "cancelled") never settle a
//    pending intent; gateway errors (HTTP 500, dropped connection) leave the
//    intent untouched and the round continues with other intents.
//    Assumption: a response that never arrives (timeout) is not simulated,
//    because the adapter timeout is not part of the brief; a dropped
//    connection stands in for network failure.
// 4. Webhook then poller, and poller then webhook, settle exactly once.
//
// Test setup follows `payment-supersede-doit.test.ts` (fake DOIT server,
// signed webhooks, direct DB reads through the owner pool).
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
const apiKey = `doit-key-t-${randomBytes(12).toString("hex")}`;
const secret = `whsec-t-${randomBytes(16).toString("hex")}`;

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
// Fake DOIT server with fault injection
// ---------------------------------------------------------------------------

type DoitPayment = {
  id: string;
  status: string;
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

/** What the status read (`GET /v1/payments/:id`) does for one payment. */
type Fault = "http500" | "drop";

class FakeDoit {
  readonly payments = new Map<string, DoitPayment>();
  readonly faults = new Map<string, Fault>();
  private readonly byIdempotencyKey = new Map<string, DoitPayment>();
  /** Every request the fake received. */
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

  /** The provider reports the payment as paid, crediting the whole bill. */
  settle(id: string, amount: number = BILL_TOTAL): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** The provider reports a status the adapter does not know. */
  report(id: string, status: string): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = status;
  }

  /** Number of status reads DOIT received for the payment. */
  statusReads(id: string): number {
    return this.calls.filter((call) => call === `GET /v1/payments/${id}`)
      .length;
  }

  /** A `payment.<type>` webhook body; `status` is the data status. */
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

  /** The way DOIT reports a failed payment (same shape as in
   * payment-webhook-api.test.ts). */
  failedEvent(id: string) {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return {
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "payment.expired",
      created_at: new Date().toISOString(),
      data: { ...payment, status: "failed" },
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
      const id = decodeURIComponent(found[1]!);
      const fault = this.faults.get(id);
      if (fault === "http500")
        return send(500, {
          error: { code: "internal", message: "boom" },
        });
      if (fault === "drop") {
        req.socket.destroy();
        return;
      }
      const payment = this.payments.get(id);
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

beforeEach(async () => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  doit.faults.clear();
  // Isolation between tests: intents left payable by an earlier test of this
  // file must not be settled or counted by the next poll. `failed` intents
  // with `provider_final_at` are never polled (SO-896).
  if (createdLinkIds.length > 0)
    await owner.query(
      `UPDATE payment_intents SET status = 'failed', provider_final_at = now()
       WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])
         AND status IN ('pending', 'expired')`,
      [tenantA, createdLinkIds],
    );
});

type Intent = { id: string; providerRef: string; linkId: string };

/** One bill with one pending QRIS code (one DOIT payment). */
async function pendingIntent(): Promise<Intent> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
    {
      outletId: outletA,
      reference: `T-${unique()}`,
      tableLabel: "A05",
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
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
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
  return { id, providerRef, linkId: opened.linkId };
}

/** Put the intent in a terminal state directly (the refund flow that gets
 * there is covered by the refund test files). */
async function forceStatus(
  intent: Intent,
  status: "refunded" | "partially_refunded",
) {
  // A refunded intent was paid once: the table requires `paid_at` for it.
  await owner.query(
    "UPDATE payment_intents SET status = $2, paid_at = now() WHERE id = $1",
    [intent.id, status],
  );
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

/** `payment.paid` events produced for the intent (the settle event). */
const settleEvents = (intentId: string) =>
  count(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [tenantA, intentId],
  );

/** Audit rows of the double-payment flag that mention the intent. */
const doublePaymentAudits = (intentId: string) =>
  count(
    `SELECT count(*)::text AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = 'payment.double_payment_flagged'
       AND event::text LIKE '%' || $2 || '%'`,
    [tenantA, intentId],
  );

async function webhookEventRows(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    payment_intent_id: string | null;
    signature_valid: boolean;
  }>(
    `SELECT status, payment_intent_id, signature_valid FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantA, eventId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 1. Webhook paid for a refunded intent
// ---------------------------------------------------------------------------

describe("a verified paid webhook for a refunded intent", () => {
  async function deliverPaidToTerminal(
    terminal: "refunded" | "partially_refunded",
  ) {
    const intent = await pendingIntent();
    await forceStatus(intent, terminal);
    const event = doit.eventFor(intent.providerRef, "paid");
    const response = await deliver(event);
    return { intent, event, response };
  }

  it.each(["refunded", "partially_refunded"] as const)(
    "answers 200 processed, keeps the intent %s and does not credit the bill",
    async (terminal) => {
      const { intent, event, response } = await deliverPaidToTerminal(terminal);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("processed");

      expect((await intentRow(intent.id)).status).toBe(terminal);
      expect(await linkPaidIdr(intent.linkId)).toBe(0);
      expect(await settleEvents(intent.id)).toBe(0);
      expect(await webhookEventRows(event.id)).toEqual([
        {
          status: "processed",
          payment_intent_id: intent.id,
          signature_valid: true,
        },
      ]);
    },
  );

  // The intent's own DOIT payment reported paid again is a replay of money the
  // intent already holds (`decidePaymentConfirmation`: same providerRef gives
  // `duplicate`), so nothing new is recorded. Only a DIFFERENT DOIT payment id
  // for the same reference is a second payment (next test).
  it.each(["refunded", "partially_refunded"] as const)(
    "the same DOIT payment on a %s intent is a replay: nothing new is recorded",
    async (terminal) => {
      const { intent } = await deliverPaidToTerminal(terminal);
      expect((await intentRow(intent.id)).flags).toEqual([]);
      expect(await unallocatedRows(intent.id)).toEqual([]);
      expect(await doublePaymentAudits(intent.id)).toBe(0);
    },
  );

  it.each(["refunded", "partially_refunded"] as const)(
    "a different DOIT payment id for a %s intent is ignored as a reference mismatch",
    async (terminal) => {
      const intent = await pendingIntent();
      await forceStatus(intent, terminal);
      const original = doit.eventFor(intent.providerRef, "paid");
      const event = {
        ...original,
        data: { ...original.data, id: `pay_other_${unique()}` },
      };
      const response = await deliver(event);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ignored");
      const row = await intentRow(intent.id);
      expect(row.status).toBe(terminal);
      expect(row.flags).toEqual([]);
      expect(await unallocatedRows(intent.id)).toEqual([]);
      expect(await linkPaidIdr(intent.linkId)).toBe(0);
      expect(await webhookEventRows(event.id)).toEqual([
        {
          status: "ignored",
          payment_intent_id: null,
          signature_valid: true,
        },
      ]);
    },
  );
});

describe("SO-896 P2-3 parked money from a DOIT webhook ends the poll of the closed code", () => {
  it("a verified paid webhook with an amount off the bill parks the money and sets provider_final_at on the expired code", async () => {
    const intent = await pendingIntent();
    // The code lapsed unconfirmed (superseded / timed out), not yet final.
    await owner.query(
      "UPDATE payment_intents SET status = 'expired' WHERE id = $1",
      [intent.id],
    );
    const original = doit.eventFor(intent.providerRef, "paid");
    const event = {
      ...original,
      data: { ...original.data, amount: BILL_TOTAL - 1_000 },
    };
    const response = await deliver(event);
    expect(response.status).toBe(200);
    expect((await unallocatedRows(intent.id)).length).toBe(1);

    expect((await intentRow(intent.id)).status).toBe("expired");
    const { rows } = await owner.query<{ final: boolean }>(
      "SELECT provider_final_at IS NOT NULL AS final FROM payment_intents WHERE id = $1",
      [intent.id],
    );
    expect(rows[0]!.final).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 and 3. The poller leaves failed / refunded intents alone
// ---------------------------------------------------------------------------

describe("the poller ignores intents that are not payable", () => {
  it("a failed intent the provider already answered final for is not asked about at DOIT and stays failed", async () => {
    const intent = await pendingIntent();
    expect((await deliver(doit.failedEvent(intent.providerRef))).status).toBe(
      200,
    );
    expect((await intentRow(intent.id)).status).toBe("failed");
    // SO-896: a failed code stays in the poll until the provider answered
    // final (`provider_final_at`); with that proof it is left alone.
    await owner.query(
      "UPDATE payment_intents SET provider_final_at = now() WHERE id = $1",
      [intent.id],
    );
    // Even if DOIT would now say paid, the poller must not look.
    doit.settle(intent.providerRef);
    const readsBefore = doit.statusReads(intent.providerRef);

    await pollLater();

    expect(doit.statusReads(intent.providerRef)).toBe(readsBefore);
    expect((await intentRow(intent.id)).status).toBe("failed");
    expect(await evidenceCount(intent.id)).toBe(0);
    expect(await linkPaidIdr(intent.linkId)).toBe(0);
  });

  it("a failed intent without final proof is asked about at DOIT (it may still be paid)", async () => {
    const intent = await pendingIntent();
    expect((await deliver(doit.failedEvent(intent.providerRef))).status).toBe(
      200,
    );
    expect((await intentRow(intent.id)).status).toBe("failed");
    const readsBefore = doit.statusReads(intent.providerRef);

    await pollLater();

    expect(doit.statusReads(intent.providerRef)).toBeGreaterThan(readsBefore);
  });

  it.each(["refunded", "partially_refunded"] as const)(
    "a %s intent is not asked about at DOIT and keeps its status",
    async (terminal) => {
      const intent = await pendingIntent();
      await forceStatus(intent, terminal);
      doit.settle(intent.providerRef);
      const readsBefore = doit.statusReads(intent.providerRef);

      await pollLater();

      expect(doit.statusReads(intent.providerRef)).toBe(readsBefore);
      expect((await intentRow(intent.id)).status).toBe(terminal);
      expect(await evidenceCount(intent.id)).toBe(0);
      expect(await unallocatedRows(intent.id)).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Unknown DOIT statuses and gateway errors
// ---------------------------------------------------------------------------

describe("the poller with unusual DOIT answers", () => {
  it.each(["settled", "cancelled"])(
    "DOIT answering %s does not settle a pending intent",
    async (unknown) => {
      const intent = await pendingIntent();
      doit.report(intent.providerRef, unknown);

      const result = await pollLater();

      expect(doit.statusReads(intent.providerRef)).toBeGreaterThanOrEqual(1);
      expect(result.checked).toBeGreaterThanOrEqual(1);
      expect(result.settled).toBe(0);
      expect((await intentRow(intent.id)).status).toBe("pending");
      expect(await evidenceCount(intent.id)).toBe(0);
      expect(await linkPaidIdr(intent.linkId)).toBe(0);
    },
  );

  it.each(["http500", "drop"] as const)(
    "a gateway error (%s) leaves the intent pending and the round goes on",
    async (fault) => {
      const broken = await pendingIntent();
      const healthy = await pendingIntent();
      doit.faults.set(broken.providerRef, fault);
      doit.settle(healthy.providerRef);

      const result = await pollLater();

      expect(doit.statusReads(broken.providerRef)).toBeGreaterThanOrEqual(1);
      expect((await intentRow(broken.id)).status).toBe("pending");
      expect(await evidenceCount(broken.id)).toBe(0);
      // The other intent of the same round is still settled.
      expect((await intentRow(healthy.id)).status).toBe("paid");
      expect(await linkPaidIdr(healthy.linkId)).toBe(BILL_TOTAL);
      expect(result.settled).toBe(1);

      // Once DOIT recovers, a later poll settles the broken one.
      doit.faults.clear();
      doit.settle(broken.providerRef);
      await pollLater();
      expect((await intentRow(broken.id)).status).toBe("paid");
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Webhook and poller together settle once
// ---------------------------------------------------------------------------

describe("webhook and poller on the same intent settle once", () => {
  async function expectSettledOnce(intent: Intent) {
    const row = await intentRow(intent.id);
    expect(row.status).toBe("paid");
    expect(await evidenceCount(intent.id)).toBe(1);
    expect(await settleEvents(intent.id)).toBe(1);
    expect(await linkPaidIdr(intent.linkId)).toBe(BILL_TOTAL);
    expect(await unallocatedRows(intent.id)).toEqual([]);
  }

  it("webhook first, then the poller changes nothing", async () => {
    const intent = await pendingIntent();
    doit.settle(intent.providerRef);
    expect(
      (await deliver(doit.eventFor(intent.providerRef, "paid"))).status,
    ).toBe(200);
    await expectSettledOnce(intent);
    const before = await intentRow(intent.id);

    const result = await pollLater();
    await pollLater();

    expect(result.settled).toBe(0);
    expect(await intentRow(intent.id)).toEqual(before);
    await expectSettledOnce(intent);
  });

  it("poller first, then the webhook changes nothing", async () => {
    const intent = await pendingIntent();
    doit.settle(intent.providerRef);

    const result = await pollLater();
    expect(result.settled).toBeGreaterThanOrEqual(1);
    await expectSettledOnce(intent);
    const before = await intentRow(intent.id);

    expect(
      (await deliver(doit.eventFor(intent.providerRef, "paid"))).status,
    ).toBe(200);
    await pollLater();

    expect(await intentRow(intent.id)).toEqual(before);
    await expectSettledOnce(intent);
  });
});
