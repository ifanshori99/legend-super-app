// legend-7uqbs (P1) and legend-3wwme (P3), brief 958: the provider says
// `refunded` for a code we ALREADY recorded as money (parked as unallocated
// funds, or a late payment that settled the bill). Written from the brief and
// the shared payment contract (packages/shared/src/payment/admin.ts), not from
// the implementation, and failing first.
//
// Rules asserted (money rules: "jangan sampai rugi"):
//  (a1) parked-unallocated: a verified `paid` webhook with a short amount parks
//       the money. Then DOIT reports `refunded` (webhook AND poller at once,
//       plus resends with new event ids): exactly ONE new audit row about the
//       intent, exactly ONE in-app alert to the outlet supervisor, the parked
//       fund can no longer be resolved by refund or credit (so the outlet
//       cannot pay it out a second time), no refund row exists for the fund,
//       and nothing is journalled, credited or re-parked.
//  (a2) late-paid settle: a code that expired, was answered `failed`, and was
//       then really paid settles the bill. Then DOIT reports `refunded`: same
//       one audit row and one supervisor alert, the bill stays credited (no
//       automatic reversal, the correction is staff's decision), no journal is
//       added, the payment can no longer be refunded manually, no second
//       `payment.paid` event.
//  (a3) controls that must keep working (and pass before the fix): a parked
//       fund with no provider refund can still be resolved by refund; a paid
//       payment with no provider refund can still be refunded manually; a
//       replayed `paid` webhook after the refunded report adds nothing.
//  (a4) a refund already filed (parked fund or paid intent) when the provider
//       reports `refunded`: approving it pays nothing; webhook + poller +
//       approve together never pay out twice.
//  (a5) architect r1 P1-1: a fund whose own flag is empty but whose INTENT is
//       stamped refunded (the refunded webhook overlapped the late-paid one)
//       still cannot be resolved: 409 PROVIDER_REFUNDED. Simulated with direct
//       DB state (the stamp on payment_intents), since the race itself cannot
//       be forced from outside.
//  (a6) architect r1 P2-a: the provider echoing `refunded` for OUR OWN refund
//       (sent, with a provider ref, still pending) flags nothing, alerts
//       nobody, writes no audit row and leaves our refund as it was.
//  (P1-2) lives in payment-doit-refunded-after-paid-958-bill-lock.test.ts.
//  (a7) concurrent late-paid vs refunded webhook on one intent: whatever the
//       interleaving, no fund survives unflagged-and-resolvable (no fund, or
//       resolve is 409 PROVIDER_REFUNDED), at most one refund audit row, at
//       most one refunded alert beyond the normal parking alert.
//  (a8) a refund approved but NOT yet sent (no provider ref, 0 attempts), then
//       the provider's refunded echo: flagged, one alert, the approved refund
//       is not sent (no provider call), not completed.
//  (a9) a fund refund that was sent (attempts > 0) and then FAILS while the
//       provider-refunded condition holds: the fund is stamped
//       provider_refunded_at (column named by the engineer) so the declined
//       refund cannot free the money for a second request.
//  (b)  legend-3wwme: a `payment.refunded` webhook whose data is not a payment
//       object (a partial-refund / refund object) is answered 2xx, stored with
//       a rejected note (never `failed`, so DOIT stops retrying) and moves
//       nothing. Today it answers 500.
//  (b2) a `payment.refunded` that LOOKS like a payment (string id and
//       reference) but fails the schema is still a malformed event: 500,
//       stored `failed` with MALFORMED (unchanged behavior, guard).
//
// Assumptions (the brief does not fix them):
//  - "Audit row" = a new `audit_logs` row of the tenant whose event mentions
//    the intent id, and whose action contains "refund" (exact action name not
//    pinned). "Exactly once" is a delta over the rows that existed right
//    before the provider's refunded report.
//  - "Alert" = in-app `notifications` row for a user holding the supervisor
//    role at the intent's outlet (title/body not pinned), created synchronously
//    with the webhook / poll (same as the existing staff warnings, e.g.
//    qr-va-912-p2-architect.test.ts). Counted as a delta for that user.
//  - "Cannot be allocated again" = POST unallocated-funds/:id/resolve answers
//    a 4xx and files no payment_refunds row, the fund stays unresolved.
//    "Cannot be refunded manually again" = POST /refunds answers a 4xx and
//    files no payment_refunds row. The exact 4xx code (409 or 422) is not
//    pinned.
//  - (engineer's contract, 14 Nov coordinator note) the guards answer 409 with
//    error code PROVIDER_REFUNDED; the paid-intent flag lives in
//    payment_intents.provider_refunded_after_paid_at (not read by these
//    tests, only observable behavior is asserted).
//  - A refund filed BEFORE the provider's refunded report is never paid out
//    after it: approving it makes no provider refund call, adds no journal and
//    answers a 4xx, or the refund is voided (status not completed). The
//    exact status is not pinned.
//  - A non-payment `payment.refunded` webhook answers 2xx and its
//    gateway_webhook_events row has status `rejected` or `ignored` (never
//    `failed`) with a non-null last_error_code (the "rejected note").
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-doit-refunded-after-paid-958.test.ts" heavy pnpm test
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
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
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

const apiKey = `doit-key-958-${randomBytes(12).toString("hex")}`;
const secret = `whsec-958-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
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
  const email = await signUp(staff, "Refunded958 owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refunded958 approver");
  const approverSession = await approver.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who must hear about the refunded report.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refunded958 supervisor");
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
      reference: `R958-${unique()}`,
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

/**
 * DOIT reports `refunded` through every door at once: two webhooks with
 * different event ids (provider retry) and the poller. Then the provider
 * retries again later. Returns nothing: callers assert the end state.
 */
async function providerRefundsEverywhere(code: Code) {
  doit.refund(code.providerRef);
  const [first, second] = await Promise.all([
    deliver(doit.eventFor(code.providerRef, "refunded")),
    deliver(doit.eventFor(code.providerRef, "refunded")),
    pollSoon().catch(() => null),
  ]);
  expect(first.status).toBeLessThan(500);
  expect(second.status).toBeLessThan(500);
}

async function providerRetriesLater(code: Code) {
  const again = await deliver(doit.eventFor(code.providerRef, "refunded"));
  expect(again.status).toBeLessThan(500);
  await pollLater().catch(() => null);
}

// ---------------------------------------------------------------------------
// (a1) parked as unallocated funds, then provider refunded
// ---------------------------------------------------------------------------

describe("legend-7uqbs provider refunded AFTER the money was parked as unallocated funds", () => {
  async function parkedCode() {
    const code = await newCode();
    const answered = await paid(code, BILL_TOTAL - SHORT_BY);
    expect(answered.status).toBeLessThan(500);
    // Precondition: the short payment is parked, never credited.
    expect(await paidIdr(code.linkId)).toBe(0);
    const funds = await fundsOf(code.id);
    expect(funds, "short payment parked").toHaveLength(1);
    expect(Number(funds[0]!.amount_idr)).toBe(BILL_TOTAL - SHORT_BY);
    return { code, fund: funds[0]! };
  }

  it("958-a1 refunded via webhook and poller at once: one audit row, one supervisor alert, fund cannot be resolved, nothing journalled or re-parked", async () => {
    const { code, fund } = await parkedCode();
    const before = await books(code);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    await providerRefundsEverywhere(code);

    const newAudit = (await auditActions(code.id)).slice(auditBefore.length);
    expect(newAudit, "exactly one new audit row about the intent").toHaveLength(
      1,
    );
    expect(newAudit[0]).toMatch(/refund/i);
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "exactly one alert to the outlet supervisor",
    ).toBe(1);

    // The parked money is the provider's again: staff cannot pay it out.
    for (const resolution of ["refund", "credit"] as const) {
      const attempt = await resolveFund(fund.id, resolution);
      expect(
        attempt.status,
        `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
      expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(await refundRowsOfFund(fund.id), "no refund filed").toBe(0);
    const [after] = await fundsOf(code.id);
    expect(after!.resolution).toBeNull();
    expect(after!.resolved_at).toBeNull();

    // No automatic correction: books unchanged.
    expect(await books(code)).toEqual(before);
  });

  it("958-a1 the provider's retries and later polls add no second audit row and no second alert", async () => {
    const { code } = await parkedCode();
    await providerRefundsEverywhere(code);
    const audit = await auditActions(code.id);
    const alerts = await supervisorAlerts();
    const before = await books(code);

    await providerRetriesLater(code);
    await providerRetriesLater(code);

    expect(await auditActions(code.id)).toEqual(audit);
    expect(await supervisorAlerts()).toBe(alerts);
    expect(await books(code)).toEqual(before);
  });

  it("958-a1 a late paid webhook resend after the refunded report parks nothing more", async () => {
    const { code } = await parkedCode();
    await providerRefundsEverywhere(code);
    const before = await books(code);

    const resend = await deliver(doit.eventFor(code.providerRef, "paid"));
    expect(resend.status).toBeLessThan(500);
    expect(await books(code)).toEqual(before);
  });

  it("958-a3 control: a parked fund the provider did NOT refund can still be resolved by refund (files one pending refund)", async () => {
    const { code, fund } = await parkedCode();
    const attempt = await resolveFund(fund.id, "refund");
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(200);
    expect(await refundRowsOfFund(fund.id)).toBe(1);
    // The refunded report arrives after staff already filed a refund: the
    // fund is not paid out twice (still exactly one refund row).
    await providerRefundsEverywhere(code);
    expect(await refundRowsOfFund(fund.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (a2) late paid settled the bill, then provider refunded
// ---------------------------------------------------------------------------

describe("legend-7uqbs provider refunded AFTER a late payment settled the bill", () => {
  async function settledLate() {
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

    const answered = await paid(code);
    expect(answered.status).toBe(200);
    // Precondition: the late payment settled the bill once.
    expect((await intentState(code.id)).status).toBe("paid");
    expect(await paidIdr(code.linkId)).toBe(BILL_TOTAL);
    expect(await evidence(code.id)).toBe(1);
    expect(await events("payment.paid", code.id)).toBe(1);
    return code;
  }

  it("958-a2 refunded via webhook and poller at once: one audit row, one supervisor alert, bill stays credited, no journal added, no second paid event", async () => {
    const code = await settledLate();
    const before = await books(code);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    await providerRefundsEverywhere(code);

    const newAudit = (await auditActions(code.id)).slice(auditBefore.length);
    expect(newAudit, "exactly one new audit row about the intent").toHaveLength(
      1,
    );
    expect(newAudit[0]).toMatch(/refund/i);
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "exactly one alert to the outlet supervisor",
    ).toBe(1);

    // No automatic reversal: the correction is staff's decision.
    expect(await books(code)).toEqual(before);
    expect((await intentState(code.id)).status).toBe("paid");
    expect(await paidIdr(code.linkId)).toBe(BILL_TOTAL);
  });

  it("958-a2 staff cannot refund the same payment manually again once the provider refunded it", async () => {
    const code = await settledLate();
    await providerRefundsEverywhere(code);

    const attempt = await manualRefund(code.id, BILL_TOTAL);
    expect(
      attempt.status,
      `manual refund: ${JSON.stringify(attempt.body)}`,
    ).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowsOfIntent(code.id), "no refund filed").toBe(0);
  });

  it("958-a2 provider retries and later polls add no second audit row and no second alert", async () => {
    const code = await settledLate();
    await providerRefundsEverywhere(code);
    const audit = await auditActions(code.id);
    const alerts = await supervisorAlerts();
    const before = await books(code);

    await providerRetriesLater(code);
    await providerRetriesLater(code);

    expect(await auditActions(code.id)).toEqual(audit);
    expect(await supervisorAlerts()).toBe(alerts);
    expect(await books(code)).toEqual(before);
  });

  it("958-a3 control: a paid payment the provider did NOT refund can still be refunded manually (one pending refund)", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBe(200);
    const attempt = await manualRefund(code.id, BILL_TOTAL);
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(201);
    expect(await refundRowsOfIntent(code.id)).toBe(1);
  });

  it("958-a3 control: a replayed paid webhook after the refunded report adds no payment, no evidence and no alert", async () => {
    const code = await settledLate();
    await providerRefundsEverywhere(code);
    const before = await books(code);
    const alerts = await supervisorAlerts();
    const audit = await auditActions(code.id);

    const replay = await deliver(doit.eventFor(code.providerRef, "paid"));
    expect(replay.status).toBeLessThan(500);
    expect(await books(code)).toEqual(before);
    expect(await supervisorAlerts()).toBe(alerts);
    expect(await auditActions(code.id)).toEqual(audit);
  });
});

// ---------------------------------------------------------------------------
// (a4) a refund filed BEFORE the provider reported `refunded`
// ---------------------------------------------------------------------------

describe("legend-7uqbs a refund already filed when the provider reports refunded is never paid out", () => {
  async function parkedFundWithPendingRefund() {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect(fund, "short payment parked").toBeDefined();
    const filed = await resolveFund(fund!.id, "refund");
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const refundId = await fundRefundId(fund!.id);
    expect(await refundStatuses(code.id)).toEqual(["pending"]);
    return { code, fund: fund!, refundId };
  }

  async function paidIntentWithPendingRefund() {
    const code = await newCode();
    expect((await paid(code)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_TOTAL);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(await refundStatuses(code.id)).toEqual(["pending"]);
    return { code, refundId: filed.body.data.id as string };
  }

  it("958-a4 parked fund: refund pending, provider refunded, then approve: no provider call, no journal, fund not paid out", async () => {
    const { code, fund, refundId } = await parkedFundWithPendingRefund();
    await providerRefundsEverywhere(code);
    const journalsBefore = await journals();

    const approved = await approveRefund(refundId);
    // Refused (4xx, expected 409) or voided; never a payout.
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
    if (approved.status < 300)
      expect(approved.body.data.status).not.toBe("completed");
    await expectNotPaidOut(code.id, journalsBefore);
    expect(await refundRowsOfFund(fund.id), "one refund row, no second").toBe(
      1,
    );

    // Approving again, or filing a new request, still pays nothing.
    const again = await approveRefund(refundId);
    expect(again.status).toBeLessThan(500);
    expect((await resolveFund(fund.id, "refund")).status).toBe(409);
    await expectNotPaidOut(code.id, journalsBefore);
    expect(await refundRowsOfFund(fund.id)).toBe(1);
  });

  it("958-a4 paid intent: manual refund pending, provider refunded, then approve: no provider call, no journal", async () => {
    const { code, refundId } = await paidIntentWithPendingRefund();
    await providerRefundsEverywhere(code);
    const journalsBefore = await journals();

    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
    if (approved.status < 300)
      expect(approved.body.data.status).not.toBe("completed");
    await expectNotPaidOut(code.id, journalsBefore);
    expect(await refundStatuses(code.id)).toHaveLength(1);
    // No second manual refund on top of the first.
    const second = await manualRefund(code.id, BILL_TOTAL);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    expect(await refundStatuses(code.id)).toHaveLength(1);
  });

  it("958-a4 webhook + poller + approve at once on a parked fund: at most one payout, one audit row, one alert, never a double", async () => {
    const { code, fund, refundId } = await parkedFundWithPendingRefund();
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    doit.refund(code.providerRef);
    const [hook, hook2, approved] = await Promise.all([
      deliver(doit.eventFor(code.providerRef, "refunded")),
      deliver(doit.eventFor(code.providerRef, "refunded")),
      approveRefund(refundId),
      pollSoon().catch(() => null),
    ]);
    expect(hook.status).toBeLessThan(500);
    expect(hook2.status).toBeLessThan(500);
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
    await providerRetriesLater(code);

    // Whoever wins the race, the money leaves at most once.
    expect(fake.calls.length).toBeLessThanOrEqual(1);
    expect(fake.executionCount).toBeLessThanOrEqual(1);
    expect(await refundRowsOfFund(fund.id)).toBe(1);
    expect(
      (await auditActions(code.id))
        .slice(auditBefore.length)
        .filter((a) => /refund/i.test(a)),
      "one audit row for the provider's refunded report",
    ).toHaveLength(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);

    // Approving once more after the dust settled pays nothing new.
    const callsAfterRace = fake.calls.length;
    const late = await approveRefund(refundId);
    expect(late.status).toBeLessThan(500);
    expect(fake.calls).toHaveLength(callsAfterRace);
  });

  it("958-a4 control: with no provider refund the same pending refund is approved and paid out exactly once", async () => {
    const { code, fund, refundId } = await parkedFundWithPendingRefund();
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
    expect((await approveRefund(refundId)).status).toBeLessThan(500);
    expect(fake.calls).toHaveLength(1);
    expect(await refundRowsOfFund(fund.id)).toBe(1);
    expect(await refundStatuses(code.id)).toEqual(["completed"]);
  });
});

// ---------------------------------------------------------------------------
// (a5) architect P1-1: intent stamped refunded, fund's own flag still empty
// ---------------------------------------------------------------------------

describe("legend-7uqbs a fund of an intent already stamped refunded is blocked even with an empty fund flag", () => {
  it.each(["provider_refunded_at", "provider_refunded_after_paid_at"])(
    "958-a5 intent stamped via %s, fund unflagged: resolve by refund or credit is 409 PROVIDER_REFUNDED and files no refund",
    async (column) => {
      const code = await newCode();
      expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(
        500,
      );
      const [fund] = await fundsOf(code.id);
      expect(fund, "short payment parked").toBeDefined();
      expect(fund!.resolution).toBeNull();

      // The overlapping refunded webhook stamped the intent only.
      await owner.query(
        `UPDATE payment_intents SET ${column} = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, code.id],
      );

      for (const resolution of ["refund", "credit"] as const) {
        const attempt = await resolveFund(fund!.id, resolution);
        expect(
          attempt.status,
          `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
        ).toBe(409);
        expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
      }
      expect(await refundRowsOfFund(fund!.id), "no refund filed").toBe(0);
      const [after] = await fundsOf(code.id);
      expect(after!.resolution).toBeNull();
      expect(after!.resolved_at).toBeNull();
    },
  );

  it("958-a5 a fund of an intent NOT stamped refunded can still be resolved (control)", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    const attempt = await resolveFund(fund!.id, "refund");
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(200);
    expect(await refundRowsOfFund(fund!.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (a6) architect P2-a: DOIT echoes refunded for OUR OWN sent refund
// ---------------------------------------------------------------------------

describe("legend-7uqbs the provider echo of our own refund is not a provider-initiated refund", () => {
  /** The echo: webhook (two event ids) plus the poller. */
  async function echo(code: Code) {
    doit.refund(code.providerRef);
    const [first, second] = await Promise.all([
      deliver(doit.eventFor(code.providerRef, "refunded")),
      deliver(doit.eventFor(code.providerRef, "refunded")),
      pollSoon().catch(() => null),
    ]);
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);
    await pollLater().catch(() => null);
  }

  async function expectEchoIgnored(
    code: Code,
    refundStatusesBefore: string[],
    refundAuditBefore: string[],
    alertsBefore: number,
  ) {
    expect(
      (await auditActions(code.id)).filter((a) => /refund/i.test(a)),
      "no new refund audit row",
    ).toEqual(refundAuditBefore);
    expect(await supervisorAlerts(), "no false alert").toBe(alertsBefore);
    expect(await refundStatuses(code.id), "our refund untouched").toEqual(
      refundStatusesBefore,
    );
  }

  it("958-a6 paid intent, our manual refund sent and still pending at the provider, then the provider echoes refunded: nothing flagged, no alert, refund untouched", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_TOTAL);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    fake.enqueue("pending");
    const approved = await approveRefund(filed.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "our refund was sent").toHaveLength(1);
    const statuses = await refundStatuses(code.id);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).not.toBe("failed");

    const audit = (await auditActions(code.id)).filter((a) =>
      /refund/i.test(a),
    );
    const alerts = await supervisorAlerts();
    await echo(code);
    await expectEchoIgnored(code, statuses, audit, alerts);
    expect(fake.calls, "no second payout").toHaveLength(1);
  });

  it("958-a6 parked fund, our refund of it sent and still pending, then the provider echoes refunded: nothing flagged, no alert", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect((await resolveFund(fund!.id, "refund")).status).toBe(200);
    fake.enqueue("pending");
    const approved = await approveRefund(await fundRefundId(fund!.id));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "our refund was sent").toHaveLength(1);
    const statuses = await refundStatuses(code.id);
    const audit = (await auditActions(code.id)).filter((a) =>
      /refund/i.test(a),
    );
    const alerts = await supervisorAlerts();

    await echo(code);
    await expectEchoIgnored(code, statuses, audit, alerts);
    expect(fake.calls, "no second payout").toHaveLength(1);
    expect(await refundRowsOfFund(fund!.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (a7) concurrent late-paid vs refunded webhook
// ---------------------------------------------------------------------------

describe("legend-7uqbs overlapping late-paid and refunded webhooks never leave a resolvable fund", () => {
  const ROUNDS = 4;

  it("958-a7 Promise.all(paid-short webhook, refunded webhook, poller): no fund, or a fund that resolves 409 PROVIDER_REFUNDED; at most one refund audit row and one refunded alert", async () => {
    // Baseline: how many alerts parking alone raises (sequential, no refund).
    const lone = await newCode();
    const loneAlerts = await supervisorAlerts();
    expect((await paid(lone, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const parkingAlerts = (await supervisorAlerts()) - loneAlerts;

    for (let round = 0; round < ROUNDS; round += 1) {
      const code = await newCode();
      const auditBefore = await auditActions(code.id);
      const alertsBefore = await supervisorAlerts();

      doit.settle(code.providerRef, BILL_TOTAL - SHORT_BY);
      const paidEvent = doit.eventFor(code.providerRef, "paid");
      const refundedEvent = doit.eventFor(code.providerRef, "refunded");
      doit.refund(code.providerRef);
      const [paidAnswer, refundedAnswer] = await Promise.all([
        deliver(paidEvent),
        deliver(refundedEvent),
        pollSoon().catch(() => null),
      ]);
      expect(paidAnswer.status, `round ${round}`).toBeLessThan(500);
      expect(refundedAnswer.status, `round ${round}`).toBeLessThan(500);
      // The provider retries both.
      await deliver(doit.eventFor(code.providerRef, "paid"));
      await deliver(doit.eventFor(code.providerRef, "refunded"));

      for (const fund of await fundsOf(code.id)) {
        for (const resolution of ["refund", "credit"] as const) {
          const attempt = await resolveFund(fund.id, resolution);
          expect(
            attempt.status,
            `round ${round} ${resolution}: ${JSON.stringify(attempt.body)}`,
          ).toBe(409);
          expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
        }
        expect(await refundRowsOfFund(fund.id)).toBe(0);
      }
      expect(await paidIdr(code.linkId), "never credited").toBe(0);
      expect(
        (await auditActions(code.id))
          .slice(auditBefore.length)
          .filter((a) => /refund/i.test(a)).length,
        `round ${round} refund audit rows`,
      ).toBeLessThanOrEqual(1);
      expect(
        (await supervisorAlerts()) - alertsBefore,
        `round ${round} alerts (parking alone raises ${parkingAlerts})`,
      ).toBeLessThanOrEqual(parkingAlerts + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// (a8) refund approved but not sent, then the provider refunded echo
// ---------------------------------------------------------------------------

describe("legend-7uqbs an approved refund that was never sent is held when the provider refunded", () => {
  /** Approved by a third person but not yet sent: 0 attempts, no provider ref. */
  async function approveWithoutSending(refundId: string) {
    await owner.query(
      `UPDATE payment_refunds
          SET status = 'approved', approved_by = $3, decided_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId, approverId],
    );
    const { rows } = await owner.query<{
      status: string;
      provider_ref: string | null;
      payout_attempts: number;
    }>(
      "SELECT status, provider_ref, payout_attempts FROM payment_refunds WHERE id = $1",
      [refundId],
    );
    expect(rows[0]).toMatchObject({
      status: "approved",
      provider_ref: null,
      payout_attempts: 0,
    });
  }

  const retryRefund = (refundId: string) =>
    approver
      .post(`${ADMIN}/refunds/${refundId}/retry`)
      .set(originHeader)
      .send({ idempotencyKey: key("retry") });

  async function fundFlag(fundId: string) {
    const { rows } = await owner.query<{ at: Date | null }>(
      "SELECT provider_refunded_at AS at FROM payment_unallocated_funds WHERE id = $1",
      [fundId],
    );
    return rows[0]!.at;
  }

  it("958-a8 parked fund: approved-not-sent refund, provider echoes refunded: fund flagged, one refund audit row, one alert, the payout is held (no provider call, not completed)", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect((await resolveFund(fund!.id, "refund")).status).toBe(200);
    const refundId = await fundRefundId(fund!.id);
    await approveWithoutSending(refundId);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    await providerRefundsEverywhere(code);

    expect(await fundFlag(fund!.id), "fund flagged").not.toBeNull();
    expect(
      (await auditActions(code.id))
        .slice(auditBefore.length)
        .filter((a) => /refund/i.test(a)),
    ).toHaveLength(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);

    // The held payout: trying to send it pays nothing.
    const journalsBefore = await journals();
    const attempt = await retryRefund(refundId);
    expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(500);
    await expectNotPaidOut(code.id, journalsBefore);
    expect(await refundRowsOfFund(fund!.id)).toBe(1);
  });

  it("958-a8 paid intent: approved-not-sent partial refund, provider echoes refunded: one alert, payout held, a new manual refund is 409 PROVIDER_REFUNDED", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBe(200);
    const filed = await manualRefund(code.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    await approveWithoutSending(refundId);
    const alertsBefore = await supervisorAlerts();

    await providerRefundsEverywhere(code);

    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    const journalsBefore = await journals();
    const attempt = await retryRefund(refundId);
    expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(500);
    await expectNotPaidOut(code.id, journalsBefore);
    const second = await manualRefund(code.id, 5_000);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("PROVIDER_REFUNDED");
  });
});

// ---------------------------------------------------------------------------
// (a9) a sent fund refund fails while the provider-refunded condition holds
// ---------------------------------------------------------------------------

describe("legend-7uqbs a declined fund refund does not free the money when the provider refunded", () => {
  it("958-a9 fund refund sent (timeout, attempts 1), provider-refunded condition holds, then the lookup says declined: refund failed, fund stamped provider_refunded_at, no second request possible", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect((await resolveFund(fund!.id, "refund")).status).toBe(200);
    const refundId = await fundRefundId(fund!.id);
    fake.enqueue("throw");
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "approved",
      payoutAttempts: 1,
    });

    // The provider-refunded condition holds (the overlapping refunded report
    // stamped the intent), then the provider says our refund was declined.
    await owner.query(
      "UPDATE payment_intents SET provider_refunded_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenantId, code.id],
    );
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: "PR-LOOKUP-DECLINED-958",
      code: "declined",
    });
    const looked = await approver
      .post(`${ADMIN}/refunds/${refundId}/retry`)
      .set(originHeader)
      .send({ idempotencyKey: key("retry") });
    expect(looked.status, JSON.stringify(looked.body)).toBe(200);
    expect(looked.body.data.status).toBe("failed");

    const { rows } = await owner.query<{ at: Date | null }>(
      "SELECT provider_refunded_at AS at FROM payment_unallocated_funds WHERE id = $1",
      [fund!.id],
    );
    expect(rows[0]!.at, "fund stamped refunded").not.toBeNull();

    // The declined refund must not let staff pay the same money out again.
    const again = await resolveFund(fund!.id, "refund");
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundStatuses(code.id)).toEqual(["failed"]);
    expect(fake.calls, "only the first, timed-out call").toHaveLength(1);
  });

  it("958-a9 control: a declined fund refund with NO provider refund frees the money (the fund can be requested again)", async () => {
    const code = await newCode();
    expect((await paid(code, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect((await resolveFund(fund!.id, "refund")).status).toBe(200);
    const refundId = await fundRefundId(fund!.id);
    fake.enqueue("throw");
    expect((await approveRefund(refundId)).status).toBe(200);
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: "PR-LOOKUP-DECLINED-958C",
      code: "declined",
    });
    const looked = await approver
      .post(`${ADMIN}/refunds/${refundId}/retry`)
      .set(originHeader)
      .send({ idempotencyKey: key("retry") });
    expect(looked.status, JSON.stringify(looked.body)).toBe(200);
    expect(looked.body.data.status).toBe("failed");
    const { rows } = await owner.query<{ at: Date | null }>(
      "SELECT provider_refunded_at AS at FROM payment_unallocated_funds WHERE id = $1",
      [fund!.id],
    );
    expect(rows[0]!.at).toBeNull();
    const again = await resolveFund(fund!.id, "refund");
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (b) legend-3wwme: payment.refunded without a payment object
// ---------------------------------------------------------------------------

describe("legend-3wwme payment.refunded whose data is not a payment object", () => {
  // legend-30hfs (967): a partial refund object naming our payment (payment_id
  // + amount) is no longer only stored; see "958-b a partial refund object"
  // below.
  const BODIES: Array<[string, (code: Code) => Record<string, unknown>]> = [
    ["an empty object", () => ({})],
    [
      "a nested refund and no payment fields",
      (code) => ({
        refund: { id: `rf_${randomBytes(6).toString("hex")}`, amount: 5_000 },
        payment: code.providerRef,
      }),
    ],
  ];

  async function eventRow(eventId: string) {
    const { rows } = await owner.query<{
      status: string;
      signature_valid: boolean;
      last_error_code: string | null;
    }>(
      `SELECT status, signature_valid, last_error_code
         FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, eventId],
    );
    return rows;
  }

  it.each(BODIES)(
    "958-b %s answers 2xx, is stored with a rejected note (not failed), and moves nothing",
    async (_label, makeData) => {
      const code = await newCode();
      const before = await books(code);
      const auditBefore = await auditActions(code.id);
      const alertsBefore = await supervisorAlerts();
      const body = {
        id: `evt_${randomBytes(8).toString("hex")}`,
        type: "payment.refunded",
        created_at: new Date().toISOString(),
        data: makeData(code),
      };

      const answer = await deliver(body);
      expect(
        answer.status,
        `DOIT must not retry: ${JSON.stringify(answer.body)}`,
      ).toBeGreaterThanOrEqual(200);
      expect(answer.status).toBeLessThan(300);

      const rows = await eventRow(body.id);
      expect(rows, "one stored row for the event").toHaveLength(1);
      expect(rows[0]!.signature_valid).toBe(true);
      expect(["rejected", "ignored"]).toContain(rows[0]!.status);
      expect(rows[0]!.last_error_code, "a rejected note").not.toBeNull();

      // Nothing moved, nobody was alerted, no audit row.
      expect(await books(code)).toEqual(before);
      expect(await auditActions(code.id)).toEqual(auditBefore);
      expect(await supervisorAlerts()).toBe(alertsBefore);

      // DOIT's resend of the same event is a plain duplicate, still 2xx.
      const resend = await deliver(body);
      expect(resend.status).toBeGreaterThanOrEqual(200);
      expect(resend.status).toBeLessThan(300);
      expect(await eventRow(body.id)).toHaveLength(1);
    },
  );

  it("958-b a partial refund object naming our payment without a refund id answers 2xx and is taken as a full refund in doubt: the code is blocked, nothing else moves", async () => {
    const code = await newCode();
    const before = await books(code);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();
    const body = {
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "payment.refunded",
      created_at: new Date().toISOString(),
      data: {
        id: `rf_${randomBytes(6).toString("hex")}`,
        payment_id: code.providerRef,
        amount: 5_000,
        status: "partially_refunded",
      },
    };

    const answer = await deliver(body);
    expect(
      answer.status,
      `DOIT must not retry: ${JSON.stringify(answer.body)}`,
    ).toBeGreaterThanOrEqual(200);
    expect(answer.status).toBeLessThan(300);

    const rows = await eventRow(body.id);
    expect(rows, "one stored row for the event").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signature_valid: true,
      status: "processed",
    });

    // legend-30hfs: no refund id, so the refund may be the whole payment. The
    // pending code is marked provider-refunded: a later paid message can never
    // settle it.
    const { rows: flagged } = await owner.query<{ at: Date | null }>(
      "SELECT provider_refunded_at AS at FROM payment_intents WHERE id = $1",
      [code.id],
    );
    expect(flagged[0]!.at, "the code is blocked").not.toBeNull();
    expect((await intentState(code.id)).status).toBe("pending");

    // Nothing moved, nobody was alerted (no money was recorded), no audit row.
    expect(await books(code)).toEqual(before);
    expect(await auditActions(code.id)).toEqual(auditBefore);
    expect(await supervisorAlerts()).toBe(alertsBefore);

    // DOIT's resend of the same event is a plain duplicate, still 2xx.
    const resend = await deliver(body);
    expect(resend.status).toBeGreaterThanOrEqual(200);
    expect(resend.status).toBeLessThan(300);
    expect(await eventRow(body.id)).toHaveLength(1);
  });

  it.each([
    [
      "missing amount and rail",
      (code: Code) => ({
        id: code.providerRef,
        reference: `ref-${code.id}`,
        status: "refunded",
      }),
    ],
    [
      "a non-numeric amount",
      (code: Code) => ({
        id: code.providerRef,
        reference: code.id,
        status: "refunded",
        amount: "not-a-number",
      }),
    ],
  ])(
    "958-b2 a payment-looking payment.refunded with %s still ends failed/MALFORMED (500, DOIT retries)",
    async (_label, makeData) => {
      const code = await newCode();
      const before = await books(code);
      const body = {
        id: `evt_${randomBytes(8).toString("hex")}`,
        type: "payment.refunded",
        created_at: new Date().toISOString(),
        data: makeData(code),
      };
      const answer = await deliver(body);
      expect(answer.status).toBe(500);
      const rows = await eventRow(body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        signature_valid: true,
        status: "failed",
        last_error_code: "MALFORMED",
      });
      expect(await books(code)).toEqual(before);
    },
  );

  it("958-b control: a real payment.refunded for a pending code is still accepted (processed, 200)", async () => {
    const code = await newCode();
    doit.refund(code.providerRef);
    const answer = await deliver(doit.eventFor(code.providerRef, "refunded"));
    expect(answer.status).toBe(200);
  });
});
