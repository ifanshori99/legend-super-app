// (brief 1045, "Temuan architect xhigh" A1..A4, tier K "jangan sampai
// rugi"): red-first tests for the architect's findings, written from the brief
// (docs/briefs/sub-1045-refund-so3.md) and the 1045-a/-b/-e + 1035-a fixtures,
// not from the implementation.
//
//  - A1 (P1) hold of nominal 0 stuck: an intent with two transactions, the
//    parked fund of T2 is being refunded (tried, no provider ref), the full
//    `refunded` status of the MAIN transaction T1 arrives. The hold must carry at
//    least what is at risk of T1 (Rp100.000, not 0); after the force window the
//    fact is booked while T2's refund still runs; finance must always have a way
//    out (counted_against_intent answers 200, the hold closes, no second fact).
//  - A2 (P1) provider fact twice: our refund R (Rp100.000) was sent and failed ->
//    own-failed hold; finance counts it; the late echo of R (the provider's own
//    refund id P) must not book Rp100.000 again (total facts <= paid). Variants:
//    echo first and resolve after; no provider ref and a provider report that
//    exceeds what is left (hold for finance, no fact over the paid amount).
//  - A3 (P2) the own-failed hold raises the same alert as the live-own hold, once.
//  - A4 (P2) closing a hold as "duplicate" requires that the existing fact is
//    the SAME intent: a fact of another bill with the same refund id must not
//    close the hold as counted.
//
// Assumptions (the brief does not fix them):
//  - "R tried without ref" = the fake refund gateway throws a timeout on approve;
//    "R sent with ref" = fake answers `pending` (ref stored). R is failed through
//    applyRefundProviderUpdate (with ref) or the retry route's lookup (no ref),
//    as in 1045-a/-b.
//  - The force window passes by aging the stored webhook event by 20 minutes and
//    running the worker, as in 1035-a (-24).
//  - The own-failed hold (reason `own_refund_failed_unverified`) is told apart from
//    the report holds by its reason; the finance exit of that hold is
//    `not_this_intent`.
//  - A3 compares the alert CATEGORY of the live-own hold (the notification the
//    report raised for the outlet supervisor) with what the failed refund raises.
//  - The facts of the intent are read from payment_provider_refunds; the money
//    invariant is: our refunds not failed + provider facts <= paid.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1045-f-architect.test.ts" heavy pnpm test

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
import { applyRefundProviderUpdate } from "../services/payment-refund.service";
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
const ADMIN = "/api/payments/admin";
const BILL_IDR = 100_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1045f-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045f-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
let staff: ReturnType<typeof agent>;
let approver: ReturnType<typeof agent>;
let fake: FakeRefundGateway;
let supervisorUserId = "";

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
// Fake DOIT server (same contract as refund-1035-a-pending-ref-own.test.ts)
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
  /** Exact id of the next created payment (the second-tenant scenario). */
  nextId: string | null = null;

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
  settle(id: string, amount: number = BILL_IDR): void {
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
      const id = this.nextId ?? `dp_${randomBytes(8).toString("hex")}`;
      this.nextId = null;
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

  // Back-office owner: files refunds and resolves holds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1045f owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1045f approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1045f supervisor");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;
  userIds.push(supervisorUserId);
  await assign(supervisorUserId, "supervisor", "outlet");

  // Refund approvals need a policy (same as refund-1035-a).
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
  const intentsOf =
    "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  if (createdLinkIds.length > 0) {
    await owner.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund'
         AND object_id IN (SELECT id::text FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intentsOf}))`,
      [tenantId, createdLinkIds],
    );
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intentsOf})`,
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

/** A fresh bill with one pending QRIS code (optionally with an exact provider id). */
async function newCode(
  amountIdr: number = BILL_IDR,
  exactRef: string | null = null,
): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1045F-${unique()}`,
      tableLabel: "A06",
      pax: 2,
      subtotalIdr: amountIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: amountIdr,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  doit.nextId = exactRef;
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  doit.nextId = null;
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

async function deliverTo(path: string, body: object) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
const deliver = (body: object) => deliverTo(webhookPath, body);

const pollAt = (at: Date) =>
  pollPendingGatewayIntents(tenantContext(), at, 100);
const pollLater = () => pollAt(new Date(Date.now() + 3 * 60 * MINUTE));

const paid = (code: Code, amount: number = BILL_IDR) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

const webhookTenant = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);
/** The retry worker reprocesses stored events once they are old enough. */
const runWorker = () =>
  reprocessStoredWebhookEvents(
    webhookTenant,
    new Date(Date.now() + 20 * MINUTE),
    100,
  ).catch(() => null);

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

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

const retryRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

type ProviderRow = {
  id: string;
  provider_refund_id: string;
  provider_payment_ref: string;
  amount_idr: number;
};

async function providerRowsOf(
  forTenant: string,
  intentId: string,
): Promise<ProviderRow[]> {
  const { rows } = await owner.query<
    Omit<ProviderRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, provider_refund_id, provider_payment_ref, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [forTenant, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

const providerRows = (intentId: string) => providerRowsOf(tenantId, intentId);
const factAmounts = async (intentId: string) =>
  (await providerRows(intentId)).map((row) => row.amount_idr);
const factTotal = async (intentId: string) =>
  (await factAmounts(intentId)).reduce((sum, amount) => sum + amount, 0);

const refundEventsOf = (forTenant: string, intentId: string) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [forTenant, intentId],
  );
const refundEventsOfIntent = (intentId: string) =>
  refundEventsOf(tenantId, intentId);

async function ourRefundedIdr(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

async function refundRow(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    amount_idr: string;
    payout_attempts: number;
  }>(
    `SELECT status, provider_ref, amount_idr::text AS amount_idr, payout_attempts
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId],
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// More observations and building blocks
// ---------------------------------------------------------------------------

const OWN_FAILED_REASON = "own_refund_failed_unverified";

type HoldRow = {
  id: string;
  reason: string;
  amount_idr: number;
  provider_refund_id: string | null;
  resolved_at: Date | null;
  resolution: string | null;
};

async function allHolds(intentId: string): Promise<HoldRow[]> {
  const { rows } = await owner.query<
    Omit<HoldRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, reason, amount_idr::text AS amount_idr, provider_refund_id, resolved_at, resolution
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY flagged_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}
const reportHolds = async (intentId: string, open = true) =>
  (await allHolds(intentId)).filter(
    (hold) =>
      (hold.resolved_at === null) === open && hold.reason !== OWN_FAILED_REASON,
  );
const ownFailedHolds = async (intentId: string) =>
  (await allHolds(intentId)).filter(
    (hold) => hold.reason === OWN_FAILED_REASON,
  );
const openOf = async (intentId: string) =>
  (await allHolds(intentId)).filter((hold) => hold.resolved_at === null);

const resolveHold = (
  holdId: string,
  resolution: "counted_against_intent" | "not_this_intent",
) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution,
      note: "Dicek di dashboard provider.",
    });

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

async function fundRefundIdOf(fundId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );
  if (!rows[0]) throw new Error("no refund filed for the fund");
  return rows[0].id;
}

const supervisorAlertRows = async () => {
  const { rows } = await owner.query<{
    id: string;
    category: string;
    title: string;
  }>(
    "SELECT id, category, title FROM notifications WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, supervisorUserId],
  );
  return rows;
};

/** The stored event is old enough for the worker to force it (past the window). */
async function ageEvent(eventId: string) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - interval '20 minutes',
            updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
}

/** Our own refund fails at the provider (webhook / poll result with its ref). */
const failOwn = (providerRef: string) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef,
    status: "failed",
    code: "declined",
  }).then(
    () => null,
    (error: unknown) => error,
  );

/** Our refund fails without a ref: the retry route's lookup answers `failed`. */
async function failByLookup(refundId: string) {
  fake.setStatus(`refund:${refundId}`, {
    status: "failed",
    providerRef: `PR-DECLINED-${unique()}`,
    code: "declined",
  });
  const answer = await retryRefund(refundId);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect((await refundRow(refundId)).status, "R failed").toBe("failed");
}

type Extra = { providerRef: string; evidenceId: string; amountIdr: number };

/** A second transaction T2 of the same bill (evidence), parked as a fund. */
async function addParkedExtra(code: Code, amountIdr: number = BILL_IDR) {
  const providerRef = `dp_extra_${randomBytes(8).toString("hex")}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletId, code.id, providerRef, amountIdr],
  );
  const extra: Extra = {
    providerRef,
    evidenceId: evidence.rows[0]!.id,
    amountIdr,
  };
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, code.id, extra.evidenceId, amountIdr],
  );
  return { extra, fundId };
}

/** Provider report, id door: its own refund id for the payment. */
const refundIdEvent = (
  paymentRef: string,
  providerRefundId: string,
  amountIdr: number,
  total: number = BILL_IDR,
) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "payment.refunded",
  created_at: new Date().toISOString(),
  data: {
    payment_id: paymentRef,
    refund_id: providerRefundId,
    amount: amountIdr,
    status: amountIdr >= total ? "refunded" : "partially_refunded",
  },
});

const factsOfRef = async (intentId: string, ref: string) =>
  (await providerRows(intentId)).filter(
    (row) => row.provider_payment_ref === ref,
  );

/** Rounds of everything that replays: delivery, poller, worker. */
async function replayAll(body: () => object, rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    await deliver(body());
    await pollLater().catch(() => null);
    await runWorker();
  }
}

async function expectRefusedNewRefunds(
  intentId: string,
  callsBefore: number,
  why: string,
) {
  for (const amount of [BILL_IDR, 1_000]) {
    const attempt = await manualRefund(intentId, amount);
    let probe = "";
    if (attempt.status === 201) {
      const approved = await approveRefund(attempt.body.data.id as string);
      probe = ` | probe: approve -> HTTP ${approved.status}, provider calls +${fake.calls.length - callsBefore}`;
    }
    expect(
      [409, 422],
      `${why}: new refund of ${amount}: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}${probe}`,
    ).toContain(attempt.status);
  }
  expect(fake.calls, `${why}: nothing sent to the guest`).toHaveLength(
    callsBefore,
  );
}

// ---------------------------------------------------------------------------
// A1: two transactions, hold of nominal 0
// ---------------------------------------------------------------------------

const PAID_TWO_TXN = 2 * BILL_IDR;

type TwoTxn = {
  code: Code;
  extra: Extra;
  fundId: string;
  fundRefundId: string;
  callsBefore: number;
};

/**
 * Bill T1 (Rp100.000) paid; T2 (Rp100.000) parked as a fund; the fund's refund
 * was TRIED (timeout: approved, no provider ref). The provider then refunds the
 * main transaction T1 on its own.
 */
async function twoTxnFundRefundInFlight(): Promise<TwoTxn> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
  const filed = await resolveFund(fundId, "refund");
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  const refundId = await fundRefundIdOf(fundId);
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.status, "premise: T2's refund is in flight").toBe("approved");
  expect(row.provider_ref, "premise: no provider ref").toBeNull();
  expect(row.payout_attempts, "premise: tried").toBeGreaterThan(0);
  doit.refund(code.providerRef);
  return {
    code,
    extra,
    fundId,
    fundRefundId: refundId,
    callsBefore: fake.calls.length,
  };
}

async function moneyOutWithinPaid(t: TwoTxn, label: string) {
  const out = (await ourRefundedIdr(t.code.id)) + (await factTotal(t.code.id));
  expect(
    out,
    `${label}: our refunds not failed + provider facts (${out}) exceed what was paid (${PAID_TWO_TXN})`,
  ).toBeLessThanOrEqual(PAID_TWO_TXN);
}

describe("A1 (P1) a hold of nominal 0 must never trap the intent", () => {
  it("1045-f-A1-01 T2's refund runs, T1's `refunded` status arrives: the hold covers at least T1's Rp100.000; after the force window finance can always count it (200), the hold closes, T1 is booked at most once", async () => {
    const t = await twoTxnFundRefundInFlight();
    const event = doit.eventFor(t.code.providerRef, "refunded");
    const answered = await deliver(event);
    expect(answered.status, "signed report not rejected").not.toBe(401);

    const holds = await reportHolds(t.code.id);
    expect(holds, "the report is remembered as a hold").toHaveLength(1);
    expect(
      holds[0]?.amount_idr,
      `the hold carries what is at risk of T1 (hold: ${JSON.stringify(holds[0])})`,
    ).toBeGreaterThanOrEqual(BILL_IDR);

    // The force window passes while T2's refund is still running.
    await ageEvent(event.id);
    await runWorker();
    await runWorker();
    expect((await refundRow(t.fundRefundId)).status, "T2 still in flight").toBe(
      "approved",
    );

    for (const hold of await reportHolds(t.code.id)) {
      const counted = await resolveHold(hold.id, "counted_against_intent");
      expect(
        counted.status,
        `finance's way out of hold ${hold.id} (amount ${hold.amount_idr}): ${JSON.stringify(counted.body)}`,
      ).toBe(200);
    }
    expect(await reportHolds(t.code.id), "the hold is closed").toEqual([]);

    const t1Facts = await factsOfRef(t.code.id, t.code.providerRef);
    expect(
      t1Facts.reduce((sum, row) => sum + row.amount_idr, 0),
      "T1's refund is booked at most once",
    ).toBeLessThanOrEqual(BILL_IDR);
    await moneyOutWithinPaid(t, "A1-01");
    expect(fake.calls, "nothing sent to the guest").toHaveLength(t.callsBefore);
  });

  it("1045-f-A1-02 T2's refund then FAILS: replays book T1 once, finance closes every open hold, nothing stays open on the intent, money out <= paid", async () => {
    const t = await twoTxnFundRefundInFlight();
    const event = doit.eventFor(t.code.providerRef, "refunded");
    await deliver(event);
    await ageEvent(event.id);
    await runWorker();

    await failByLookup(t.fundRefundId);
    await replayAll(() => doit.eventFor(t.code.providerRef, "refunded"));

    // Finance closes whatever is open: report holds by counting, the own-failed
    // hold by checking the provider (not this intent: T2's money never left).
    for (const hold of await openOf(t.code.id)) {
      const resolution =
        hold.reason === OWN_FAILED_REASON
          ? "not_this_intent"
          : "counted_against_intent";
      const resolved = await resolveHold(hold.id, resolution);
      expect(
        resolved.status,
        `finance's way out of ${hold.reason} (amount ${hold.amount_idr}) by ${resolution}: ${JSON.stringify(resolved.body)}`,
      ).toBe(200);
    }
    expect(await openOf(t.code.id), "nothing is left open").toEqual([]);

    expect(
      (await factsOfRef(t.code.id, t.code.providerRef)).map(
        (row) => row.amount_idr,
      ),
      "T1's refund is booked exactly once",
    ).toEqual([BILL_IDR]);
    await moneyOutWithinPaid(t, "A1-02");
    expect(fake.calls, "nothing sent to the guest").toHaveLength(t.callsBefore);
  });
});

// ---------------------------------------------------------------------------
// A2: provider fact twice
// ---------------------------------------------------------------------------

type Failed = {
  code: Code;
  refundId: string;
  /** Provider reference of R, when R was sent with one. */
  ownRef: string | null;
  refundIdr: number;
  callsBefore: number;
};

/**
 * Bill paid Rp100.000; our refund R of `refundIdr` was SENT and then FAILED
 * (own-failed hold filed). `withRef`: the provider answered `pending` with a
 * reference first; otherwise the call timed out (no reference).
 */
async function sentThenFailed(
  withRef: boolean,
  refundIdr: number = BILL_IDR,
): Promise<Failed> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, refundIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue(withRef ? "pending" : "throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  let ownRef: string | null = null;
  if (withRef) {
    expect(row.provider_ref, "premise: R stored its ref").toBeTruthy();
    ownRef = row.provider_ref;
    expect(await failOwn(ownRef!)).toBeNull();
    expect((await refundRow(refundId)).status, "R failed").toBe("failed");
  } else {
    expect(row.provider_ref, "premise: no ref").toBeNull();
    await failByLookup(refundId);
  }
  expect(
    await ownFailedHolds(code.id),
    "premise: the failed sent refund filed its own-failed hold",
  ).toHaveLength(1);
  return {
    code,
    refundId,
    ownRef,
    refundIdr,
    callsBefore: fake.calls.length,
  };
}

async function expectFactsWithinPaid(code: Code, label: string) {
  const facts = await providerRows(code.id);
  const total = facts.reduce((sum, row) => sum + row.amount_idr, 0);
  expect(
    total,
    `${label}: provider facts ${JSON.stringify(facts.map((row) => [row.provider_refund_id.slice(0, 14), row.amount_idr]))} exceed what was paid`,
  ).toBeLessThanOrEqual(BILL_IDR);
}

describe("A2 (P1) one real refund is never booked as two provider facts", () => {
  it("1045-f-A2-01 R (ref P) sent and failed, finance counts the hold (Rp100.000 booked), then R's late echo with refund id P arrives: still ONE fact, total <= paid, no payout", async () => {
    const t = await sentThenFailed(true);
    const hold = (await ownFailedHolds(t.code.id))[0]!;
    const counted = await resolveHold(hold.id, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(await factTotal(t.code.id), "finance booked the Rp100.000").toBe(
      BILL_IDR,
    );

    await replayAll(() =>
      refundIdEvent(t.code.providerRef, t.ownRef!, BILL_IDR),
    );

    await expectFactsWithinPaid(t.code, "A2-01");
    expect(await factAmounts(t.code.id), "ONE fact").toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(t.code.id), "ONE journal event").toBe(1);
    await expectRefusedNewRefunds(t.code.id, t.callsBefore, "A2-01");
  });

  it("1045-f-A2-02 variant echo first: R (ref P) sent and failed, the echo with refund id P arrives, THEN finance counts the hold: total facts <= paid, no payout", async () => {
    const t = await sentThenFailed(true);
    await replayAll(
      () => refundIdEvent(t.code.providerRef, t.ownRef!, BILL_IDR),
      1,
    );
    await expectFactsWithinPaid(t.code, "A2-02 after the echo");

    const hold = (await ownFailedHolds(t.code.id))[0]!;
    const counted = await resolveHold(hold.id, "counted_against_intent");
    // Soft: finance's exit; the money assertions below run either way.
    expect
      .soft(
        counted.status,
        `finance counts the own-failed hold: ${JSON.stringify(counted.body)}`,
      )
      .toBe(200);

    await replayAll(
      () => refundIdEvent(t.code.providerRef, t.ownRef!, BILL_IDR),
      1,
    );
    await expectFactsWithinPaid(t.code, "A2-02 after finance counted");
    expect(await refundEventsOfIntent(t.code.id)).toBeLessThanOrEqual(1);
    await expectRefusedNewRefunds(t.code.id, t.callsBefore, "A2-02");
  });

  it.each([
    [100_000, 100_000],
    [100_000, 40_000],
    [60_000, 60_000],
  ] as const)(
    "1045-f-A2-03 no provider ref: R of %i sent and failed, finance counts it, then the provider reports its own refund of %i (id P): no fact beyond what was paid, the surplus waits as a hold for finance, no payout",
    async (refundIdr, reportIdr) => {
      const t = await sentThenFailed(false, refundIdr);
      const hold = (await ownFailedHolds(t.code.id))[0]!;
      const counted = await resolveHold(hold.id, "counted_against_intent");
      expect(counted.status, JSON.stringify(counted.body)).toBe(200);
      expect(await factTotal(t.code.id), "finance booked R's amount").toBe(
        refundIdr,
      );

      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      await replayAll(() =>
        refundIdEvent(t.code.providerRef, providerRefundId, reportIdr),
      );

      await expectFactsWithinPaid(t.code, "A2-03");
      expect(
        await refundEventsOfIntent(t.code.id),
        "journal events never exceed the facts",
      ).toBeLessThanOrEqual((await providerRows(t.code.id)).length);
      if (refundIdr + reportIdr > BILL_IDR)
        expect
          .soft(
            (await reportHolds(t.code.id)).length,
            "the surplus of the report waits as a hold for finance",
          )
          .toBeGreaterThanOrEqual(1);
      await expectRefusedNewRefunds(t.code.id, t.callsBefore, "A2-03");
    },
  );
});

// ---------------------------------------------------------------------------
// A3: the own-failed hold alerts like the live-own hold
// ---------------------------------------------------------------------------

describe("A3 (P2) a new own-failed hold alerts the outlet supervisor, once", () => {
  it("1045-f-A3-01 the failed sent refund raises the same alert category as the live-own hold, exactly once, however often it is replayed", async () => {
    // Reference: what a live-own hold (report while R is live) alerts.
    const reference = await newCode(BILL_IDR);
    expect((await paid(reference, BILL_IDR)).status).toBe(200);
    const filedRef = await manualRefund(reference.id, BILL_IDR);
    fake.enqueue("throw");
    expect((await approveRefund(filedRef.body.data.id as string)).status).toBe(
      200,
    );
    doit.refund(reference.providerRef);
    const seenBefore = new Set((await supervisorAlertRows()).map((r) => r.id));
    await deliver(doit.eventFor(reference.providerRef, "refunded"));
    expect(
      (await reportHolds(reference.id)).length,
      "premise: the live-own hold exists",
    ).toBe(1);
    const liveAlerts = (await supervisorAlertRows()).filter(
      (row) => !seenBefore.has(row.id),
    );
    const categories = new Set(liveAlerts.map((row) => row.category));
    expect(
      categories.size,
      `premise: the live-own hold alerts the supervisor (${JSON.stringify(liveAlerts)})`,
    ).toBeGreaterThan(0);

    // The failed sent refund: a fresh bill, R sent with ref, then failed.
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_IDR);
    fake.enqueue("pending");
    expect((await approveRefund(filed.body.data.id as string)).status).toBe(
      200,
    );
    const ref = (await refundRow(filed.body.data.id as string)).provider_ref!;
    const before = new Set((await supervisorAlertRows()).map((r) => r.id));
    expect(await failOwn(ref)).toBeNull();
    expect(
      await ownFailedHolds(code.id),
      "premise: own-failed hold",
    ).toHaveLength(1);
    const raised = (await supervisorAlertRows()).filter(
      (row) => !before.has(row.id) && categories.has(row.category),
    );
    expect(
      raised,
      `the new own-failed hold alerts like the live-own hold (categories ${[...categories].join(", ")})`,
    ).toHaveLength(1);

    // Repeats (a second failure notice, poller, worker) add no alert. 1191
    // (legend-rdg29): the poller 3 hours later MAY send the periodic "still
    // open" reminder (its own title, once a day); that is not a repeat of the
    // filing alert, so it is left out of this count (b-05 covers the reminder).
    await failOwn(ref);
    await pollLater().catch(() => null);
    await runWorker();
    const after = (await supervisorAlertRows()).filter(
      (row) =>
        !before.has(row.id) &&
        categories.has(row.category) &&
        row.title !== "Refund kami yang gagal masih menunggu pemeriksaan",
    );
    expect(after, "the same hold never alerts twice").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A4: closing as "duplicate" needs the same intent
// ---------------------------------------------------------------------------

describe("A4 (P2) a fact of another intent is not a duplicate of this hold", () => {
  it("1045-f-A4-01 hold on bill A names refund id X, X is already booked on bill B: finance's counted resolve does not close A's hold without a fact on A; not_this_intent still closes it; B's fact is untouched", async () => {
    const a = await newCode(BILL_IDR);
    const b = await newCode(BILL_IDR);
    expect((await paid(a, BILL_IDR)).status).toBe(200);
    expect((await paid(b, BILL_IDR)).status).toBe(200);

    // The provider refunded bill B with refund id X: booked on B.
    const refundX = `rf_${randomBytes(6).toString("hex")}`;
    await replayAll(() => refundIdEvent(b.providerRef, refundX, BILL_IDR), 1);
    expect(await factAmounts(b.id), "premise: X booked on B").toEqual([
      BILL_IDR,
    ]);

    // A hold on bill A that reports the very same refund id X (a mismatch).
    const holdId = randomUUID();
    await owner.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, provider_refund_id_kind, amount_idr, reason, provider_payment_ref)
       VALUES ($1, $2, $3, $4, $5, 'provider', $6, 'Reference names another intent', $7)`,
      [holdId, tenantId, a.id, randomUUID(), refundX, BILL_IDR, a.providerRef],
    );

    const counted = await resolveHold(holdId, "counted_against_intent");
    expect(counted.status, "no server error").toBeLessThan(500);
    const hold = (await allHolds(a.id)).find((row) => row.id === holdId)!;
    const aFacts = await factTotal(a.id);
    expect(
      hold.resolved_at === null || aFacts > 0,
      `counted closed A's hold (${hold.resolution}) although A has no fact (A facts ${aFacts}, answer ${counted.status} ${JSON.stringify(counted.body)})`,
    ).toBe(true);

    // Finance's exit stays: the id belongs to B, so this hold is not A's.
    const still = (await allHolds(a.id)).find((row) => row.id === holdId);
    if (still?.resolved_at === null) {
      const exit = await resolveHold(holdId, "not_this_intent");
      expect(exit.status, JSON.stringify(exit.body)).toBe(200);
    }
    expect(await factAmounts(b.id), "B's fact is untouched").toEqual([
      BILL_IDR,
    ]);
  });
});
