// legend-30hfs (P1), brief 967: DOIT reports a PARTIAL `payment.refunded` for
// a payment we already recorded as paid (the refund amount is below what was
// paid). Today the event is only stored; the money it moved is invisible to
// refunds, approvals and payouts. Written from the brief, the shared payment
// contract (packages/shared/src/payment/admin.ts) and the 958 fixtures, not
// from the implementation, and failing first.
//
// Rules asserted (money rules: "jangan sampai rugi"):
//  (1) one partial provider refund on a paid intent: exactly ONE new refund
//      audit row and ONE in-app alert to the outlet supervisor, even when two
//      webhooks with different event ids and the poller arrive at once, and
//      after the provider's later retries. It is counted once: the refund
//      screen shows paid - refund as still refundable.
//  (2) two partials add up (each its own audit row and alert); a third one
//      that would push the total past what was paid never makes the recorded
//      refunded amount exceed the paid amount (paid == refunded + refundable
//      always holds), and nothing more can then be refunded by staff.
//  (3) staff can only move paid - provider refunded: a manual refund above
//      that is refused 409, one within it is accepted; approving a refund
//      that no longer fits pays nothing (409, no provider call); an approved
//      but unsent refund that no longer fits is not sent; a parked unallocated
//      fund of the same payment cannot be resolved (409). One within net is
//      approved and paid once.
//  (4) the provider's refund event that merely echoes OUR OWN refund (same
//      provider refund id as the refund we sent) is not counted again: no
//      audit row, no alert, same refundable. A refund event with a refund id
//      we do not know IS counted (control).
//
// Assumptions (the brief does not fix them):
//  - Design fixed by the engineer (brief 967 DESIGN): a provider partial
//    refund arrives (a) as `payment.refunded` with data `{ payment_id,
//    refund_id, amount, status }`, or (b) as `refund.succeeded` with flat data
//    `{ amount, refund_id, payment_id }` that matches none of our refunds
//    (answered 500 and retried; recorded when it ends `ignored` after the
//    15-minute window, driven by backdating the stored event and running
//    reprocessStoredWebhookEvents, like payment-doit-refund-webhook.test.ts).
//    Dedupe key: refund_id. Audit action `payment.provider_refunded_partial`.
//    The poller cannot see partial refunds (the fake payment stays `paid`), so
//    "poller at once" is a poll running beside the webhooks; it adds nothing.
//  - "Recorded refunded" is what GET /refunds/refundable shows:
//    refundedAmountIdr + refundableAmountIdr == paidAmountIdr (a contract
//    invariant) and the provider's partial refunds count as refunded. A
//    payment with nothing left is absent from that list (see
//    payment-refund-approval.test.ts), read as refundable 0 / refunded paid.
//  - "Audit row" and "alert" as in the 958 file: a new audit_logs row of the
//    tenant mentioning the intent with an action containing "refund"; an
//    in-app notification for the outlet supervisor. Counted as deltas.
//  - The echo of our own refund has refund_id == payment_refunds.provider_ref.
//  - A refused manual refund / approve answers 409 (PROVIDER_REFUNDED or the
//    existing over-amount refusal; the code is not pinned). An over-paid
//    third partial is answered below 500 (provider must not retry forever).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-doit-partial-refund-967.test.ts" heavy pnpm test
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
import { outletIdSchema } from "@starter/shared/core";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";
import { FakeRefundGateway } from "./refund-fake-gateway";

vi.setConfig({ testTimeout: 120_000 });

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletId = outletIdSchema.parse(scope.outletId);
const actor = randomUUID();
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
const ADMIN = "/api/payments/admin";
const BILL_TOTAL = 144_375;
const SHORT_BY = 1_000;
const MINUTE = 60_000;

const apiKey = `doit-key-967-${randomBytes(12).toString("hex")}`;
const secret = `whsec-967-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
const saleOrderIds: string[] = [];
let integrationId = "";
let staff: ReturnType<typeof agent>;
let supervisorUserId = "";
let approver: ReturnType<typeof agent>;
let approverId = "";
let fake: FakeRefundGateway;

const unique = () => randomBytes(4).toString("hex");
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function outletContext(outletIds: readonly OutletId[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

// ---------------------------------------------------------------------------
// Fake DOIT server (same contract as payment-doit-refunded-late-paid.test.ts)
// ---------------------------------------------------------------------------

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

  /** The provider reports the payment as paid, crediting `amount`. */
  settle(id: string, amount: number = BILL_TOTAL): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** The provider gave the money back. */
  refund(id: string): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "refunded";
  }

  /** A `payment.<status>` webhook body for the payment. */
  eventFor(id: string, status: "paid" | "refunded" | "expired") {
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
      const idem = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(idem);
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
      if (idem) this.byIdempotencyKey.set(idem, payment);
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
// Fixtures
// ---------------------------------------------------------------------------

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scopeType: "tenant" | "outlet",
) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scopeType,
      scopeType === "outlet" ? outletId : null,
    ],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await scope.seed(owner);

  // Back-office owner: files refunds and resolves parked funds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Partial967 owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Partial967 approver");
  const approverSession = await approver.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who must hear about the refunded report.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Partial967 supervisor");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;
  userIds.push(supervisorUserId);
  await assign(supervisorUserId, "supervisor", "outlet");

  // Refund approvals need a policy (same as payment-unallocated-approval).
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleIdOf("finance")],
  );

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
  setPaymentRefundGateway(null);
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund'
         AND object_id IN (SELECT id::text FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents}))`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [tenantId, saleOrderIds],
    );
    await owner.query(
      "DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [tenantId, saleOrderIds],
    );
    await owner.query(
      "DELETE FROM orders WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, saleOrderIds],
    );
    await owner.query(
      `DELETE FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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
  await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
    integrationId,
  ]);
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
  fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
});

type Code = { id: string; providerRef: string; linkId: string };

/** A fresh bill with one pending QRIS code. */
async function newCode(): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R967-${unique()}`,
      tableLabel: "A06",
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
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [id],
  );
  if (!rows[0]?.provider_ref) throw new Error("Intent has no DOIT payment id");
  return { id, providerRef: rows[0].provider_ref, linkId: opened.linkId };
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

const pollAt = (at: Date) =>
  pollPendingGatewayIntents(tenantContext(), at, 100);
const pollSoon = () => pollAt(new Date(Date.now() + 2 * MINUTE));
const pollLater = () => pollAt(new Date(Date.now() + 3 * 60 * MINUTE));

const paid = (code: Code, amount: number = BILL_TOTAL) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

// ---------------------------------------------------------------------------
// Observations (what staff and the books show)
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

async function intentState(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!;
}

const evidence = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

async function fundsOf(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    resolution: string | null;
    resolved_at: Date | null;
  }>(
    `SELECT id, amount_idr::text AS amount_idr, resolution, resolved_at
       FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at`,
    [tenantId, intentId],
  );
  return rows;
}

async function paidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

const events = (name: string, intentId: string) =>
  count(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND event->'payload'->>'intentId' = $3`,
    [tenantId, name, intentId],
  );

/** Whole-tenant journal entries: no reversal, no duplicate may appear. */
const journals = () =>
  count(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [tenantId],
  );

/** Audit actions whose event mentions the intent, oldest first. */
async function auditActions(intentId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string | null }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'
      ORDER BY id`,
    [tenantId, intentId],
  );
  return rows.map((row) => row.action ?? "");
}

/** In-app alerts the outlet supervisor received. */
const supervisorAlerts = () =>
  count(
    "SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, supervisorUserId],
  );

const refundRowsOfIntent = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

const refundRowsOfFund = (fundId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

const manualRefund = (intentId: string, amountIdr: number) =>
  staff
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan minta uang kembali",
    });

const approveRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });

async function refundStatuses(intentId: string): Promise<string[]> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return rows.map((row) => row.status);
}

async function fundRefundId(fundId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );
  if (!rows[0]) throw new Error("no refund filed for the fund");
  return rows[0].id;
}

/** The refund was not paid out: no provider call, no journal, not completed. */
async function expectNotPaidOut(intentId: string, journalsBefore: number) {
  expect(fake.calls, "no provider refund call").toHaveLength(0);
  expect(fake.executionCount).toBe(0);
  expect(await journals(), "no payout journal").toBe(journalsBefore);
  for (const status of await refundStatuses(intentId))
    expect(["completed", "processing", "paid"]).not.toContain(status);
}

/** Snapshot of everything the refunded report must NOT change. */
async function books(code: Code) {
  return {
    paidIdr: await paidIdr(code.linkId),
    evidence: await evidence(code.id),
    funds: (await fundsOf(code.id)).map((f) => [f.id, f.amount_idr]),
    journals: await journals(),
    paidEvents: await events("payment.paid", code.id),
    fundsEvents: await events("payment.funds_unallocated", code.id),
  };
}

// ---------------------------------------------------------------------------
// Partial refund fixtures
// ---------------------------------------------------------------------------

const refundId = () => `rf_${randomBytes(6).toString("hex")}`;

type Channel = "payment" | "refund";

/**
 * The two doors a provider-initiated partial refund arrives through:
 *  - "payment": `payment.refunded` whose data is a status object
 *    `{ payment_id, refund_id, amount, status }`;
 *  - "refund": `refund.succeeded` with the flat sandbox data
 *    `{ amount, refund_id, payment_id }`. It matches none of our refunds, so
 *    it is retried for 15 minutes and only recorded when it ends `ignored`
 *    (driven like payment-doit-refund-webhook.test.ts: backdate, reprocess).
 */
function partialEvent(
  code: Code,
  providerRefundId: string,
  amount: number,
  channel: Channel,
) {
  const base = {
    id: `evt_${randomBytes(8).toString("hex")}`,
    created_at: new Date().toISOString(),
  };
  return channel === "payment"
    ? {
        ...base,
        type: "payment.refunded",
        data: {
          payment_id: code.providerRef,
          refund_id: providerRefundId,
          amount,
          status: "partially_refunded",
        },
      }
    : {
        ...base,
        type: "refund.succeeded",
        data: {
          amount,
          refund_id: providerRefundId,
          payment_id: code.providerRef,
        },
      };
}

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

/** Age the stored refund events past the retry window and run the worker. */
async function settleRefundEvents(eventIds: string[], workers = 1) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - interval '20 minutes',
            updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND event_id = ANY($2::text[])`,
    [tenantId, eventIds],
  );
  await Promise.all(
    Array.from({ length: workers }, () =>
      reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
        () => null,
      ),
    ),
  );
}

/** One delivery of one provider refund (returns once it is fully handled). */
async function deliverPartial(
  code: Code,
  providerRefundId: string,
  amount: number,
  channel: Channel = "payment",
) {
  const body = partialEvent(code, providerRefundId, amount, channel);
  const answer = await deliver(body);
  if (channel === "payment")
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
  else await settleRefundEvents([body.id]);
  return answer;
}

/**
 * The same provider refund through every door at once: two events with
 * different ids (provider retry), the poller, and (refund door) two workers.
 */
async function partialBurst(
  code: Code,
  providerRefundId: string,
  amount: number,
  channel: Channel = "payment",
) {
  const bodies = [
    partialEvent(code, providerRefundId, amount, channel),
    partialEvent(code, providerRefundId, amount, channel),
  ];
  const answers = await Promise.all([
    ...bodies.map((body) => deliver(body)),
    pollSoon().catch(() => null),
  ]);
  if (channel === "payment") {
    for (const answer of answers.slice(0, 2))
      expect(
        (answer as { status: number }).status,
        JSON.stringify((answer as { body: unknown }).body),
      ).toBeLessThan(500);
  } else {
    await settleRefundEvents(
      bodies.map((body) => body.id),
      2,
    );
  }
}

/** The refund screen's view of a paid intent; absent when nothing is left. */
async function refundView(intentId: string) {
  const response = await staff.get(
    `${ADMIN}/refunds/refundable?outletId=${outletId}`,
  );
  expect(response.status).toBe(200);
  const row = (
    response.body.data.payments as Array<{
      paymentIntentId: string;
      paidAmountIdr: number;
      refundedAmountIdr: number;
      refundableAmountIdr: number;
    }>
  ).find((p) => p.paymentIntentId === intentId);
  return {
    paid: row?.paidAmountIdr ?? BILL_TOTAL,
    refunded: row?.refundedAmountIdr ?? BILL_TOTAL,
    refundable: row?.refundableAmountIdr ?? 0,
  };
}

const PARTIAL_AUDIT = "payment.provider_refunded_partial";
const refundAudit = async (intentId: string) =>
  (await auditActions(intentId)).filter((a) => /refund/i.test(a));
const partialAudit = async (intentId: string) =>
  (await auditActions(intentId)).filter((a) => a === PARTIAL_AUDIT).length;

/** A paid code plus its baselines. */
async function paidCode() {
  const code = await newCode();
  expect((await paid(code)).status).toBe(200);
  return code;
}

/** The 958 hold: approved by a third person but never sent. */
async function approveWithoutSending(id: string) {
  await owner.query(
    `UPDATE payment_refunds
        SET status = 'approved', approved_by = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, approverId],
  );
}

const retryRefund = (id: string) =>
  approver
    .post(`${ADMIN}/refunds/${id}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

async function fileRefund(code: Code, amount: number): Promise<string> {
  const filed = await manualRefund(code.id, amount);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  return filed.body.data.id as string;
}

// ---------------------------------------------------------------------------
// (1) one partial provider refund, counted once
// ---------------------------------------------------------------------------

describe("legend-30hfs a partial provider refund on a paid intent", () => {
  it.each(["payment", "refund"] as const)(
    "967-1 via %s door: two events (different ids), a poll and later retries: ONE audit row, ONE supervisor alert, counted once",
    async (channel) => {
      const code = await paidCode();
      const auditBefore = await partialAudit(code.id);
      const alertsBefore = await supervisorAlerts();
      const before = await books(code);
      const rf = refundId();

      await partialBurst(code, rf, 40_000, channel);
      // The provider retries the same refund later, and the poller runs again.
      await deliverPartial(code, rf, 40_000, channel);
      await pollLater().catch(() => null);

      expect(
        (await partialAudit(code.id)) - auditBefore,
        "exactly one new partial-refund audit row",
      ).toBe(1);
      expect(
        (await supervisorAlerts()) - alertsBefore,
        "exactly one alert to the outlet supervisor",
      ).toBe(1);

      // Counted once: Rp40.000 refunded, the rest still refundable.
      expect(await refundView(code.id)).toEqual({
        paid: BILL_TOTAL,
        refunded: 40_000,
        refundable: BILL_TOTAL - 40_000,
      });
      // The provider's refund is not our payout: no journal, no provider call.
      expect(await books(code)).toEqual(before);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("967-1 the same provider refund id through both doors counts once: one audit row, one alert", async () => {
    const code = await paidCode();
    const auditBefore = await partialAudit(code.id);
    const alertsBefore = await supervisorAlerts();
    const rf = refundId();

    await Promise.all([
      partialBurst(code, rf, 40_000, "payment"),
      partialBurst(code, rf, 40_000, "refund"),
    ]);

    expect((await partialAudit(code.id)) - auditBefore).toBe(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    expect(await refundView(code.id)).toMatchObject({
      refunded: 40_000,
      refundable: BILL_TOTAL - 40_000,
    });
  });
});

// ---------------------------------------------------------------------------
// (2) partials add up, never past what was paid
// ---------------------------------------------------------------------------

describe("legend-30hfs repeated partial provider refunds", () => {
  it("967-2 two partials sum (one audit row and one alert each); a third past the paid amount never records refunded > paid", async () => {
    const code = await paidCode();
    const auditBefore = await partialAudit(code.id);
    const alertsBefore = await supervisorAlerts();

    await deliverPartial(code, refundId(), 100_000, "payment");
    expect((await partialAudit(code.id)) - auditBefore).toBe(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);

    await deliverPartial(code, refundId(), 30_000, "refund");
    expect((await partialAudit(code.id)) - auditBefore).toBe(2);
    expect((await supervisorAlerts()) - alertsBefore).toBe(2);
    expect(await refundView(code.id)).toEqual({
      paid: BILL_TOTAL,
      refunded: 130_000,
      refundable: BILL_TOTAL - 130_000,
    });

    // 130.000 + 20.000 would be 150.000, more than the 144.375 paid. The same
    // over-paid refund arrives twice at once (two event ids).
    const third = refundId();
    await partialBurst(code, third, 20_000, "payment");

    const view = await refundView(code.id);
    expect(
      view.refunded,
      "recorded refunded never exceeds paid",
    ).toBeLessThanOrEqual(BILL_TOTAL);
    expect(view.refunded).toBeGreaterThanOrEqual(130_000);
    expect(view.refundable).toBeGreaterThanOrEqual(0);
    expect(view.refunded + view.refundable).toBe(BILL_TOTAL);

    // Staff can never move more than what is left, and not 20.000 (the room
    // left is at most 14.375).
    const over = await manualRefund(code.id, 20_000);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(await refundRowsOfIntent(code.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (3) staff-side money is capped at paid - provider refunded
// ---------------------------------------------------------------------------

describe("legend-30hfs staff refunds, approvals, payouts and allocation after a partial provider refund", () => {
  it("967-3 manual refund above paid - provider refunded is 409; one within net is accepted", async () => {
    const code = await paidCode();
    await deliverPartial(code, refundId(), 40_000);
    const net = BILL_TOTAL - 40_000;

    const over = await manualRefund(code.id, net + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(await refundRowsOfIntent(code.id), "nothing filed").toBe(0);

    const exact = await manualRefund(code.id, net);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await refundRowsOfIntent(code.id)).toBe(1);
    expect(await refundView(code.id)).toMatchObject({ refundable: 0 });
  });

  it("967-3 a refund filed before the partial that no longer fits is refused on approve: 409, no provider call, no journal", async () => {
    const code = await paidCode();
    const filedId = await fileRefund(code, 100_000);
    await deliverPartial(code, refundId(), 100_000);
    const journalsBefore = await journals();

    const approved = await approveRefund(filedId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(409);
    await expectNotPaidOut(code.id, journalsBefore);
  });

  it("967-3 an approved but unsent refund that no longer fits is not sent by a payout retry", async () => {
    const code = await paidCode();
    const filedId = await fileRefund(code, 100_000);
    await approveWithoutSending(filedId);
    await deliverPartial(code, refundId(), 100_000);
    const journalsBefore = await journals();

    const attempt = await retryRefund(filedId);
    expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(500);
    await expectNotPaidOut(code.id, journalsBefore);
  });

  it("967-3 control: a refund within paid - provider refunded is approved and paid exactly once", async () => {
    const code = await paidCode();
    const filedId = await fileRefund(code, 20_000);
    await deliverPartial(code, refundId(), 40_000);

    const approved = await approveRefund(filedId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "one provider refund").toHaveLength(1);
    expect(fake.executionCount).toBe(1);
    const again = await approveRefund(filedId);
    expect(again.status).toBeLessThan(500);
    expect(fake.executionCount, "never paid twice").toBe(1);
  });

  it("967-3 a parked unallocated fund of a partially refunded payment cannot be resolved: 409, nothing filed", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect(fund, "short payment parked").toBeDefined();

    await deliverPartial(code, refundId(), 40_000);

    for (const resolution of ["refund", "credit"] as const) {
      const attempt = await resolveFund(fund!.id, resolution);
      expect(
        attempt.status,
        `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
    }
    expect(await refundRowsOfFund(fund!.id)).toBe(0);
    const [after] = await fundsOf(code.id);
    expect(after!.resolved_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4) the echo of our own refund is not counted again
// ---------------------------------------------------------------------------

describe("legend-30hfs a refund event echoing our own sent refund", () => {
  async function sentRefund(code: Code, amount: number) {
    const filedId = await fileRefund(code, amount);
    fake.enqueue("pending");
    const approved = await approveRefund(filedId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "our refund was sent").toHaveLength(1);
    const { rows } = await owner.query<{ provider_ref: string | null }>(
      "SELECT provider_ref FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
      [tenantId, filedId],
    );
    expect(rows[0]?.provider_ref, "our refund has a provider ref").toBeTruthy();
    return rows[0]!.provider_ref!;
  }

  it.each(["payment", "refund"] as const)(
    "967-4 via %s door: the provider echoes our own refund (refund_id = our provider ref, twice and a poll): no partial audit row, no alert, not counted again",
    async (channel) => {
      const code = await paidCode();
      const ourRef = await sentRefund(code, 30_000);
      const viewBefore = await refundView(code.id);
      expect(viewBefore).toEqual({
        paid: BILL_TOTAL,
        refunded: 30_000,
        refundable: BILL_TOTAL - 30_000,
      });
      const auditBefore = await refundAudit(code.id);
      const alertsBefore = await supervisorAlerts();
      const statusesBefore = await refundStatuses(code.id);

      await partialBurst(code, ourRef, 30_000, channel);
      await deliverPartial(code, ourRef, 30_000, channel);

      expect(await partialAudit(code.id), "no partial-refund audit row").toBe(
        0,
      );
      expect(await refundAudit(code.id), "no new refund audit row").toEqual(
        auditBefore,
      );
      expect(await supervisorAlerts(), "no false alert").toBe(alertsBefore);
      expect(await refundView(code.id), "counted once, not twice").toEqual(
        viewBefore,
      );
      expect(await refundStatuses(code.id), "our refund untouched").toEqual(
        statusesBefore,
      );
      expect(fake.calls, "no second payout").toHaveLength(1);
    },
  );

  it("967-4 control: a provider refund with a refund id we never sent IS counted next to our own", async () => {
    const code = await paidCode();
    const ourRef = await sentRefund(code, 30_000);
    const auditBefore = await partialAudit(code.id);
    const alertsBefore = await supervisorAlerts();

    await deliverPartial(code, ourRef, 30_000, "payment");
    await deliverPartial(code, refundId(), 25_000, "payment");

    expect((await partialAudit(code.id)) - auditBefore).toBe(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    expect(await refundView(code.id)).toEqual({
      paid: BILL_TOTAL,
      refunded: 55_000,
      refundable: BILL_TOTAL - 55_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Architect r1 fixes: edge cases of the net cap
// ---------------------------------------------------------------------------

describe("legend-30hfs a sale in use, a failed refund of ours, an in-flight refund, a pending intent", () => {
  /**
   * An open POS order of `amountIdr` whose authorized QRIS tender holds the
   * paid intent: the sale uses that much of the payment (row pattern of
   * pos-qris-capture-refund-race.test.ts).
   */
  async function holdBySale(code: Code, amountIdr: number) {
    const orderId = randomUUID();
    saleOrderIds.push(orderId);
    await owner.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'awaiting_payment', '2031-03-15', now())`,
      [orderId, tenantId, outletId, `S967-${unique()}`, amountIdr],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderId, tenantId, outletId],
    );
    await owner.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
          status, requested_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
               'authorized', now())`,
      [tenantId, outletId, orderId, code.linkId, code.id, amountIdr],
    );
  }

  it("967-r1a paid 144.375, a sale holds 104.375, our refund of 40.000 approved, then a provider partial of 40.000: the payout is blocked, money out never exceeds the net", async () => {
    const code = await paidCode();
    const filedId = await fileRefund(code, 40_000);
    await approveWithoutSending(filedId);
    // The sale takes the rest of the payment; then DOIT refunds 40.000 itself.
    await holdBySale(code, BILL_TOTAL - 40_000);
    await deliverPartial(code, refundId(), 40_000, "payment");
    const journalsBefore = await journals();

    // net = 144.375 - 40.000 provider - 104.375 sale = 0: nothing may go out.
    const attempt = await retryRefund(filedId);
    expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(500);
    await expectNotPaidOut(code.id, journalsBefore);
    const approved = await approveRefund(filedId);
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
    await expectNotPaidOut(code.id, journalsBefore);
  });

  it("967-r1b our refund FAILED with provider ref R, then provider refund R arrives: it is counted as a provider refund (one audit row, one alert, the cap shrinks)", async () => {
    const code = await paidCode();
    const filedId = await fileRefund(code, 30_000);
    const ourRef = refundId();
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'failed', provider_ref = $3, failure_reason = 'provider_declined'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, filedId, ourRef],
    );
    // A failed refund of ours reserves nothing.
    expect(await refundView(code.id)).toMatchObject({
      refunded: 0,
      refundable: BILL_TOTAL,
    });
    const auditBefore = await partialAudit(code.id);
    const alertsBefore = await supervisorAlerts();

    await deliverPartial(code, ourRef, 30_000, "payment");

    expect(
      (await partialAudit(code.id)) - auditBefore,
      "a failed refund is no echo: the provider really refunded",
    ).toBe(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    expect(await refundView(code.id)).toEqual({
      paid: BILL_TOTAL,
      refunded: 30_000,
      refundable: BILL_TOTAL - 30_000,
    });
  });

  it.each(["payment", "refund"] as const)(
    "967-r1c via %s door: the echo arrives while our refund is in flight (sent, provider ref still empty): not counted, no audit row, no alert inside the retry window",
    async (channel) => {
      const code = await paidCode();
      const filedId = await fileRefund(code, 30_000);
      fake.enqueue("throw");
      const approved = await approveRefund(filedId);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.data).toMatchObject({
        status: "approved",
        payoutAttempts: 1,
      });
      const { rows } = await owner.query<{ provider_ref: string | null }>(
        "SELECT provider_ref FROM payment_refunds WHERE id = $1",
        [filedId],
      );
      expect(rows[0]!.provider_ref, "ref not stored yet").toBeNull();
      const viewBefore = await refundView(code.id);
      const auditBefore = await partialAudit(code.id);
      const alertsBefore = await supervisorAlerts();

      // The provider's echo of that very refund carries a ref we do not know yet.
      const body = partialEvent(code, refundId(), 30_000, channel);
      await deliver(body);
      // Still inside the 15-minute window: a worker pass must not count it.
      await owner.query(
        `UPDATE gateway_webhook_events
            SET received_at = now() - interval '5 minutes',
                updated_at = now() - interval '5 minutes'
          WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, body.id],
      );
      await reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
        () => null,
      );

      expect(await partialAudit(code.id), "no partial audit row").toBe(
        auditBefore,
      );
      expect(await supervisorAlerts(), "no alert").toBe(alertsBefore);
      expect(await refundView(code.id), "not counted").toEqual(viewBefore);
    },
  );

  it("967-r1d partial refunds that sum to the whole amount of a still-pending intent: a later paid never settles the bill", async () => {
    const code = await newCode();
    const auditBefore = await partialAudit(code.id);

    await deliverPartial(code, refundId(), 100_000, "payment");
    await deliverPartial(code, refundId(), BILL_TOTAL - 100_000, "payment");
    expect((await partialAudit(code.id)) - auditBefore).toBe(2);

    const journalsBefore = await journals();
    const paidEventsBefore = await events("payment.paid", code.id);
    const late = await paid(code, BILL_TOTAL);
    expect(late.status, JSON.stringify(late.body)).toBeLessThan(500);
    await pollSoon().catch(() => null);

    expect(await paidIdr(code.linkId), "bill never credited").toBe(0);
    expect(await events("payment.paid", code.id)).toBe(paidEventsBefore);
    expect(await journals(), "nothing journalled").toBe(journalsBefore);
    expect((await intentState(code.id)).status).not.toBe("paid");
    // Any money it parked cannot be paid out again.
    for (const fund of await fundsOf(code.id)) {
      const attempt = await resolveFund(fund.id, "refund");
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    }
  });
});

// ---------------------------------------------------------------------------
// Architect r2 fixes
// ---------------------------------------------------------------------------

describe("legend-30hfs expired intents and rotated integrations", () => {
  it("967-r2a a partial provider refund recorded on an EXPIRED intent, then a late paid parks a fund: refund and resolve of that fund are 409 PROVIDER_REFUNDED", async () => {
    const code = await newCode();
    await owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '10 minutes' WHERE id = $1",
      [code.id],
    );
    doit.payments.get(code.providerRef)!.status = "failed";
    await pollSoon();
    expect(["expired", "failed"]).toContain(
      (await intentState(code.id)).status,
    );
    const auditBefore = await partialAudit(code.id);

    await deliverPartial(code, refundId(), 40_000, "payment");
    expect(
      (await partialAudit(code.id)) - auditBefore,
      "the partial refund is recorded on the expired intent",
    ).toBe(1);

    // The customer's late, short payment is parked as an unallocated fund.
    const late = await paid(code, BILL_TOTAL - SHORT_BY);
    expect(late.status, JSON.stringify(late.body)).toBeLessThan(500);
    const funds = await fundsOf(code.id);
    expect(funds, "late short payment parked").toHaveLength(1);

    for (const resolution of ["refund", "credit"] as const) {
      const attempt = await resolveFund(funds[0]!.id, resolution);
      expect(
        attempt.status,
        `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
      expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(await refundRowsOfFund(funds[0]!.id)).toBe(0);
    const [after] = await fundsOf(code.id);
    expect(after!.resolved_at).toBeNull();
  });

  it("967-r2c an old intent minted by an integration that was since rotated (intent's integration differs, previous secret still valid) still records the provider refund", async () => {
    const code = await paidCode();
    const credentials = (webhookSecret: string) => ({ apiKey, webhookSecret });
    const config = { baseUrl: doit.baseUrl };
    const newSecret = `whsec-967-rot-${randomBytes(12).toString("hex")}`;

    // The intent was minted by an earlier integration row (an outlet-scoped
    // one here), not by the tenant-wide integration that now verifies the call.
    const earlier = await upsertIntegration(
      tenantContext(),
      { outletId, provider: "doit", config, credentials: credentials(secret) },
      actor,
    );
    await owner.query(
      "UPDATE payment_intents SET gateway_integration_id = $2 WHERE id = $1",
      [code.id, earlier.id],
    );
    // The tenant-wide integration rotates its secret; `secret` is the previous
    // one and is still accepted during the grace window.
    await upsertIntegration(
      tenantContext(),
      {
        outletId: null,
        provider: "doit",
        config,
        credentials: credentials(newSecret),
      },
      actor,
    );
    clearDoitWebhookSecretCache();
    const auditBefore = await partialAudit(code.id);
    const alertsBefore = await supervisorAlerts();

    try {
      await deliverPartial(code, refundId(), 40_000, "payment");

      expect(
        (await partialAudit(code.id)) - auditBefore,
        "recorded although the intent's integration differs",
      ).toBe(1);
      expect((await supervisorAlerts()) - alertsBefore).toBe(1);
      expect(await refundView(code.id)).toMatchObject({
        refunded: 40_000,
        refundable: BILL_TOTAL - 40_000,
      });
    } finally {
      await owner.query(
        "UPDATE payment_intents SET gateway_integration_id = $2 WHERE id = $1",
        [code.id, integrationId],
      );
      await upsertIntegration(
        tenantContext(),
        {
          outletId: null,
          provider: "doit",
          config,
          credentials: credentials(secret),
        },
        actor,
      );
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        earlier.id,
      ]);
      clearDoitWebhookSecretCache();
    }
  });
});
