// legend-04izi (brief 1035, finding A, tier K "jangan sampai rugi"): a refund of
// OURS that is still live (approved / pending at the provider) and already holds
// a provider reference is NOT proof of success: the provider may still decline it
// ("failed"). Scenario of the second opinion (1034, finding 1): extra transaction
// B (Rp100.000, evidence of the intent) is parked as a fund; staff refunds the
// fund, the provider answers PENDING with reference R; then the provider ALSO
// reports B refunded (`payment.refunded`, status door or id door) on its own;
// afterwards R is declined (failed). Today the webhook counts our live refund as
// the one that returned B's money (echo), writes no fact, no stamp, no hold; when
// R fails nothing remembers that the provider really gave B back, the fund is
// refundable again and the real refund is never journaled (guest paid twice,
// outlet loses Rp100.000).
// Written from the brief, the coordinator's decision A and the 1020 / 1025c /
// 1025d fixtures, not from the implementation, and failing first.
//
// Decision A (coordinator), asserted:
//  - A `refunded` status of the transaction while our refund is still live
//    (approved / pending, with or without provider_ref) and covers the whole
//    rest creates ONE open refund-recon hold (live-own); replays keep ONE hold;
//    the intent / fund is blocked (new refunds and payouts refused) until
//    finance resolves the hold. No auto-close of the hold.
//  - Our refund then FAILS: the hold stays open, the fund still cannot be paid
//    out, no provider fact is written yet; finance resolves the hold
//    `counted_against_intent`: the provider's refund is recorded exactly ONCE
//    (one `payment.provider_refunded` journal event), the fund stays blocked
//    (409 PROVIDER_REFUNDED). While R is still live that resolve is 422.
//  - Our refund COMPLETES: no extra provider fact (echo), total out = our
//    refund; the fund cannot be paid out again.
//  - Money counted once: "our refund of B not failed" + "provider rows of B"
//    never exceeds Rp100.000 at any stage, and is exactly Rp100.000 whenever
//    nothing is in doubt (pending, succeeded, after finance resolved).
//  - Adjustment (coordinator): a real provider refund ID (id door) while our fund
//    refund is live records the fact and blocks the fund (a hold is not
//    required; tests -11/-12). After our refund failed, a replay of the status
//    `refunded` MAY record the rest: the asserted invariant is ONE provider fact
//    of the real amount, ONE event, finance's resolve afterwards adds no fact,
//    fund not payable (not "replays record nothing").
//  - Same for the PRIMARY transaction (intent-level refund with a reference),
//    noticed by the webhook or the poller. Another bill is not touched.
//
// Assumptions (the brief does not fix them):
//  - "pending with reference" = FakeRefundGateway answers `pending` on approve;
//    the row keeps a provider_ref (premise asserted).
//  - R is declined/completed through the public service the provider webhook and
//    poller feed: applyRefundProviderUpdate(tenant, { providerRef, status }).
//  - The hold is found by tenant + intent (open) and resolved through
//    POST /refund-recon-holds/:id/resolve as the owner (payment.reconcile), as in
//    refund-1025-d-resolve-hold.test.ts.
//  - "Blocked" = a new refund / fund resolve answers 409 or 422 (code not
//    pinned, except PROVIDER_REFUNDED once the provider fact is recorded).
//  - The id-door provider refund id is a fresh `rf_...` id, different from R.
//  - Order "race" (report vs R's failure): end state is either the hold open
//    (then finance resolves it) or the fact already recorded; never neither.
//  - Poller path for B is not reachable (fake DOIT knows A only); the poller
//    runs as a no-op replay there and is meaningful only for the primary tests.
//
// Ordinary bill refund (final decision, B1 cancelled): OUR intent-level bill
// refund is pending WITH a provider reference R when the status `refunded` of
// the main transaction arrives (tests -21..-25, -07, -08):
//  (a) the FIRST report makes ONE hold at once (no retry window, no wait for
//      force); no fact; no new refund while ours is live; replays keep one hold;
//  (b) ours COMPLETED, event repeated: own - no hold, no fact;
//  (c) ours FAILED, event repeated: the fact is recorded once, the intent is
//      blocked by the old rule (409 PROVIDER_REFUNDED);
//  (d) the window passes (worker): still ONE hold, no fact;
//  (e) report accepted, R fails BEFORE any replay: a new full refund is refused
//      (409/422); replays + finance end with ONE fact;
//  (f) poller only: known limit (a paid bill is not polled), no fact, no hold.
// Only a bill refund WITHOUT a reference keeps the old retry behavior (not
// tested here). Alerts are not asserted.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1035-a-pending-ref-own.test.ts" heavy pnpm test

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
import { applyRefundProviderUpdate } from "../services/payment-refund.service";
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
const BILL_IDR = 100_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1035a-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1035a-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
let staff: ReturnType<typeof agent>;
let approver: ReturnType<typeof agent>;
let supervisorUserId = "";
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
// Fake DOIT server (same contract as payment-extra-txn-fund-refund-1020.test.ts)
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
  const email = await signUp(staff, "Refund1035a owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1035a approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who would hear about an alert (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1035a supervisor");
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
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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
async function newCode(amountIdr: number = BILL_IDR): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1025D-${unique()}`,
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

const paid = (code: Code, amount: number = BILL_IDR) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

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

type ProviderRow = {
  id: string;
  provider_refund_id: string;
  provider_payment_ref: string;
  amount_idr: number;
};

async function providerRows(intentId: string): Promise<ProviderRow[]> {
  const { rows } = await owner.query<
    Omit<ProviderRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, provider_refund_id, provider_payment_ref, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

const providerRowsOfRef = async (intentId: string, ref: string) =>
  (await providerRows(intentId)).filter(
    (row) => row.provider_payment_ref === ref,
  );

/** Distinct `payment.provider_refunded` events emitted for these rows. */
async function refundEventsOfRows(rowIds: string[]): Promise<number> {
  return count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'providerRefundId' = ANY($2::text[])`,
    [tenantId, rowIds],
  );
}

/** Distinct `payment.provider_refunded` events of the whole intent. */
const refundEventsOfIntent = (intentId: string) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [tenantId, intentId],
  );

const refundRowsOfIntent = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

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
  }>(
    `SELECT status, provider_ref, amount_idr::text AS amount_idr
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId],
  );
  return rows[0]!;
}

async function fundRefundId(fundId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );
  if (!rows[0]) throw new Error("no refund filed for the fund");
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Secondary transaction B of the intent (evidence + parked fund)
// ---------------------------------------------------------------------------

type Extra = { providerRef: string; evidenceId: string; amountIdr: number };

const newExtraId = () => `dp_extra_${randomBytes(8).toString("hex")}`;

async function addExtraTxn(
  code: Code,
  amountIdr: number = BILL_IDR,
): Promise<Extra> {
  const providerRef = newExtraId();
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletId, code.id, providerRef, amountIdr],
  );
  return { providerRef, evidenceId: rows[0]!.id, amountIdr };
}

async function parkExtra(code: Code, extra: Extra): Promise<string> {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, code.id, extra.evidenceId, extra.amountIdr],
  );
  return fundId;
}

/** Status-object door: `payment.refunded` carrying B's payment object. */
function statusEvent(code: Code, extraRef: string, amountIdr: number) {
  const base = doit.payments.get(code.providerRef);
  if (!base) throw new Error(`No fake DOIT payment ${code.providerRef}`);
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.refunded",
    created_at: new Date().toISOString(),
    data: {
      ...base,
      id: extraRef,
      status: "refunded",
      amount: amountIdr,
      total_amount: amountIdr,
    },
  };
}

/** Id door: `payment.refunded` with `{ payment_id, refund_id, amount, status }`. */
function idEvent(
  paymentRef: string,
  providerRefundId: string,
  amountIdr: number,
  total: number = BILL_IDR,
) {
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.refunded",
    created_at: new Date().toISOString(),
    data: {
      payment_id: paymentRef,
      refund_id: providerRefundId,
      amount: amountIdr,
      status: amountIdr >= total ? "refunded" : "partially_refunded",
    },
  };
}

type Door = "status" | "id";

async function expectAnswered(answer: { status: number; body: unknown }) {
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
}

const providerRefundedEvent = (
  code: Code,
  extra: Extra,
  door: Door,
  refundId: string,
) =>
  door === "status"
    ? statusEvent(code, extra.providerRef, extra.amountIdr)
    : idEvent(extra.providerRef, refundId, extra.amountIdr);

const webhookTenant = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);
const runWorker = () =>
  reprocessStoredWebhookEvents(
    webhookTenant,
    new Date(Date.now() + 20 * MINUTE),
    100,
  ).catch(() => null);

/** The provider declines / completes our refund (webhook or poll result). */
const failOwn = (providerRef: string) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef,
    status: "failed",
    code: "declined",
  }).then(
    () => null,
    (error: unknown) => error,
  );
const succeedOwn = (providerRef: string, amountIdr: number) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef,
    status: "succeeded",
    amountIdr,
  }).then(
    () => null,
    (error: unknown) => error,
  );

async function openHoldIds(intentId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND resolved_at IS NULL
      ORDER BY flagged_at`,
    [tenantId, intentId],
  );
  return rows.map((row) => row.id);
}

const resolveHold = (holdId: string) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution: "counted_against_intent",
      note: "Provider mengembalikan dana; refund kami gagal.",
    });

async function listedOpenHoldIds(): Promise<string[]> {
  const listed = await staff.get(`${ADMIN}/refund-recon-holds?status=open`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as { id: string }[]).map((item) => item.id);
}

/** Our refunds of the fund that are not failed (money we sent or may send). */
async function ownFundRefundedIdr(fundId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total FROM payment_refunds
      WHERE tenant_id = $1 AND unallocated_fund_id = $2 AND status <> 'failed'`,
    [tenantId, fundId],
  );
  return Number(rows[0]!.total);
}

const providerTotal = async (intentId: string, ref: string) =>
  (await providerRowsOfRef(intentId, ref)).reduce(
    (sum, row) => sum + row.amount_idr,
    0,
  );

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Pending = {
  code: Code;
  extra: Extra;
  fundId: string;
  refundId: string;
  ownRef: string;
};

/** A paid; B parked; the fund's refund of B is pending at the provider (ref R). */
async function fundRefundPending(): Promise<Pending> {
  const sentBefore = fake.calls.length;
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const extra = await addExtraTxn(code, BILL_IDR);
  const fundId = await parkExtra(code, extra);
  const filed = await resolveFund(fundId, "refund");
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  const refundId = await fundRefundId(fundId);
  fake.enqueue("pending");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(
    ["completed", "failed"],
    "premise: refund of B is in flight",
  ).not.toContain(row.status);
  expect(row.provider_ref, "premise: the pending answer stored R").toBeTruthy();
  expect(fake.calls, "B's refund was sent once").toHaveLength(sentBefore + 1);
  return { code, extra, fundId, refundId, ownRef: row.provider_ref! };
}

/** Money of B counted: ours (not failed) + provider facts. */
async function countedB(p: Pending): Promise<number> {
  return (
    (await ownFundRefundedIdr(p.fundId)) +
    (await providerTotal(p.code.id, p.extra.providerRef))
  );
}

/** New refunds and payouts are refused (409 / 422) and nothing is sent. */
async function expectBlocked(p: Pending, callsBefore: number, why: string) {
  for (const resolution of ["refund", "credit"] as const) {
    const attempt = await resolveFund(p.fundId, resolution);
    expect(
      [409, 422],
      `${why}: fund B by ${resolution}: ${JSON.stringify(attempt.body)}`,
    ).toContain(attempt.status);
  }
  const refused = await manualRefund(p.code.id, 1_000);
  expect(
    [409, 422],
    `${why}: new refund of the intent: ${JSON.stringify(refused.body)}`,
  ).toContain(refused.status);
  expect(
    await ownFundRefundedIdr(p.fundId),
    `${why}: no new live refund of fund B`,
  ).toBe(
    (await refundRow(p.refundId)).status === "failed" ? 0 : p.extra.amountIdr,
  );
  expect(fake.calls, `${why}: nothing sent to the guest`).toHaveLength(
    callsBefore,
  );
}

async function expectFundBProviderRefunded(p: Pending) {
  for (const resolution of ["refund", "credit"] as const) {
    const attempt = await resolveFund(p.fundId, resolution);
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
  }
}

/** Finance resolves the one open hold; the provider's refund is counted once. */
async function financeCountsTheHold(p: Pending, callsBefore: number) {
  const holds = await openHoldIds(p.code.id);
  expect(holds, "exactly one open hold").toHaveLength(1);
  expect(await listedOpenHoldIds(), "the hold is on finance's list").toContain(
    holds[0],
  );
  const resolved = await resolveHold(holds[0]!);
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const rows = await providerRowsOfRef(p.code.id, p.extra.providerRef);
  expect(
    rows.map((row) => row.amount_idr),
    "the provider's refund of B is recorded once, in full",
  ).toEqual([BILL_IDR]);
  expect(
    await refundEventsOfRows(rows.map((row) => row.id)),
    "one journal event",
  ).toBe(1);
  expect(await openHoldIds(p.code.id), "hold closed by the resolve").toEqual(
    [],
  );
  expect(await countedB(p), "B's money counted once").toBe(p.extra.amountIdr);
  await expectFundBProviderRefunded(p);
  expect(fake.calls).toHaveLength(callsBefore);
}

/** The provider resends its report; the poller and the worker run again. */
async function replayReports(p: Pending, door: Door, refundId: string) {
  for (let round = 0; round < 2; round += 1) {
    await expectAnswered(
      await deliver(providerRefundedEvent(p.code, p.extra, door, refundId)),
    );
    await pollLater().catch(() => null);
    await runWorker();
    await failOwn(p.ownRef);
  }
}

/**
 * Final invariant (decision A, adjusted): after our refund R failed, replays and
 * finance's resolve end with exactly ONE provider fact of the real amount and
 * ONE journal event; resolving an open hold never adds a fact; fund B cannot be
 * paid out; nothing is sent to the guest.
 */
async function finishAndExpectSingleFact(p: Pending, callsBefore: number) {
  for (const holdId of await openHoldIds(p.code.id)) {
    const resolved = await resolveHold(holdId);
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(500);
  }
  const rows = await providerRowsOfRef(p.code.id, p.extra.providerRef);
  expect(
    rows.map((row) => row.amount_idr),
    "total provider facts of B = one row = the real amount",
  ).toEqual([BILL_IDR]);
  expect(
    await refundEventsOfRows(rows.map((row) => row.id)),
    "one journal event",
  ).toBe(1);
  expect(await refundEventsOfIntent(p.code.id)).toBe(1);
  expect(await countedB(p), "B's money counted once").toBe(p.extra.amountIdr);
  await expectFundBProviderRefunded(p);
  expect(fake.calls, "nothing sent to the guest").toHaveLength(callsBefore);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("legend-04izi our live refund with a provider reference is not proof of success", () => {
  describe("provider report on the status door (`payment.refunded` carrying the transaction)", () => {
    const door = "status" as const;

    it("1035-04izi-01 fund refund of B pending (ref R), provider refunds B: ONE hold (replays keep one), fund and intent blocked, counted once, finance cannot count it while R is live", async () => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;

      // Two deliveries (new event ids) and a poll at once, then the worker.
      const [first, second] = await Promise.all([
        deliver(providerRefundedEvent(p.code, p.extra, door, providerRefundId)),
        deliver(providerRefundedEvent(p.code, p.extra, door, providerRefundId)),
        pollSoon().catch(() => null),
      ]);
      await expectAnswered(first);
      await expectAnswered(second);
      await runWorker();

      expect(
        await openHoldIds(p.code.id),
        "ONE open hold while our refund is live",
      ).toHaveLength(1);
      expect(await countedB(p), "B counted once while R is pending").toBe(
        p.extra.amountIdr,
      );
      await expectBlocked(p, callsBefore, "R pending");

      const holdId = (await openHoldIds(p.code.id))[0]!;
      const early = await resolveHold(holdId);
      expect(
        early.status,
        `counting while R is live is refused: ${JSON.stringify(early.body)}`,
      ).toBe(422);
      expect(await openHoldIds(p.code.id)).toEqual([holdId]);
      expect(await providerTotal(p.code.id, p.extra.providerRef)).toBe(0);

      // Replays while R is still live change nothing.
      const rows = await providerRows(p.code.id);
      for (let round = 0; round < 2; round += 1) {
        await expectAnswered(
          await deliver(
            providerRefundedEvent(p.code, p.extra, door, providerRefundId),
          ),
        );
        await pollLater().catch(() => null);
        await runWorker();
      }
      expect(await providerRows(p.code.id), "replays: no new row").toEqual(
        rows,
      );
      expect(await openHoldIds(p.code.id), "still ONE hold").toHaveLength(1);
      expect(fake.calls).toHaveLength(callsBefore);
    });

    it("1035-04izi-02 then R fails: fund B stays blocked and not payable; replays and finance's resolve end with ONE provider fact of the real amount, one journal event, fund B PROVIDER_REFUNDED", async () => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;
      await expectAnswered(
        await deliver(
          providerRefundedEvent(p.code, p.extra, door, providerRefundId),
        ),
      );
      expect(await failOwn(p.ownRef), "R fails").toBeNull();
      expect((await refundRow(p.refundId)).status).toBe("failed");

      expect(
        await openHoldIds(p.code.id),
        "the hold stays open after R failed",
      ).toHaveLength(1);
      expect(await countedB(p)).toBeLessThanOrEqual(p.extra.amountIdr);
      await expectBlocked(p, callsBefore, "R failed");

      // A replay of `refunded` may now record the rest; finance may resolve.
      await replayReports(p, door, providerRefundId);
      await finishAndExpectSingleFact(p, callsBefore);
      await replayReports(p, door, providerRefundId);
      await finishAndExpectSingleFact(p, callsBefore);
    });

    it("1035-04izi-03 control: R succeeds after the provider refunded B: no provider fact, no provider_refunded event, total out = our refund, fund B cannot be paid out again", async () => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;
      await expectAnswered(
        await deliver(
          providerRefundedEvent(p.code, p.extra, door, providerRefundId),
        ),
      );
      expect(await succeedOwn(p.ownRef, BILL_IDR)).toBeNull();
      await replayReports(p, door, providerRefundId);

      expect((await refundRow(p.refundId)).status).toBe("completed");
      expect(
        await providerTotal(p.code.id, p.extra.providerRef),
        "no second record of the same money",
      ).toBe(0);
      expect(await refundEventsOfIntent(p.code.id)).toBe(0);
      expect(await countedB(p), "total out = our refund").toBe(
        p.extra.amountIdr,
      );
      for (const resolution of ["refund", "credit"] as const) {
        const attempt = await resolveFund(p.fundId, resolution);
        expect([409, 422], JSON.stringify(attempt.body)).toContain(
          attempt.status,
        );
      }
      expect(fake.calls, "no second payout").toHaveLength(callsBefore);
    });
  });

  describe("provider report on the id door (a real provider refund id, not the transaction status)", () => {
    const door = "id" as const;

    it("1035-04izi-11 fund refund of B pending (ref R), the provider reports its own refund id for B: the fact is recorded once and fund B is blocked (a hold is not required); replays add nothing", async () => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;

      const [first, second] = await Promise.all([
        deliver(providerRefundedEvent(p.code, p.extra, door, providerRefundId)),
        deliver(providerRefundedEvent(p.code, p.extra, door, providerRefundId)),
        pollSoon().catch(() => null),
      ]);
      await expectAnswered(first);
      await expectAnswered(second);
      await runWorker();

      const rows = await providerRowsOfRef(p.code.id, p.extra.providerRef);
      expect(
        rows.map((row) => row.amount_idr),
        "the provider's refund of B is recorded once, in full",
      ).toEqual([BILL_IDR]);
      expect(
        await refundEventsOfRows(rows.map((row) => row.id)),
        "one journal event",
      ).toBe(1);
      expect(
        (await openHoldIds(p.code.id)).length,
        "at most one hold",
      ).toBeLessThanOrEqual(1);
      for (const resolution of ["refund", "credit"] as const) {
        const attempt = await resolveFund(p.fundId, resolution);
        expect([409, 422], JSON.stringify(attempt.body)).toContain(
          attempt.status,
        );
      }
      expect(fake.calls, "nothing new sent to the guest").toHaveLength(
        callsBefore,
      );

      await replayReports(p, door, providerRefundId);
      expect(
        (await providerRowsOfRef(p.code.id, p.extra.providerRef)).map(
          (row) => row.amount_idr,
        ),
        "replays: still one row",
      ).toEqual([BILL_IDR]);
      expect(await refundEventsOfIntent(p.code.id)).toBe(1);
    });

    it("1035-04izi-12 then R fails: total provider facts of B = ONE = Rp100.000, one event, finance's resolve of any open hold adds none, fund B PROVIDER_REFUNDED", async () => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;
      await expectAnswered(
        await deliver(
          providerRefundedEvent(p.code, p.extra, door, providerRefundId),
        ),
      );
      expect(await failOwn(p.ownRef), "R fails").toBeNull();
      await replayReports(p, door, providerRefundId);
      await finishAndExpectSingleFact(p, callsBefore);
      await replayReports(p, door, providerRefundId);
      await finishAndExpectSingleFact(p, callsBefore);
    });
  });

  it.each(["status", "id"] as const)(
    "1035-04izi-04 order: R fails BEFORE the provider reports B (%s door): no live refund, so the fact is recorded at once, once, fund B blocked, no hold needed",
    async (door) => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;
      expect(await failOwn(p.ownRef)).toBeNull();
      for (let delivery = 0; delivery < 2; delivery += 1)
        await expectAnswered(
          await deliver(
            providerRefundedEvent(p.code, p.extra, door, providerRefundId),
          ),
        );
      await pollLater().catch(() => null);
      await runWorker();

      const rows = await providerRowsOfRef(p.code.id, p.extra.providerRef);
      expect(rows.map((row) => row.amount_idr)).toEqual([BILL_IDR]);
      expect(await refundEventsOfRows(rows.map((row) => row.id))).toBe(1);
      expect(await countedB(p)).toBe(p.extra.amountIdr);
      await expectFundBProviderRefunded(p);
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it.each(["status", "id"] as const)(
    "1035-04izi-05 order: the report and R's failure race (%s door): never lost, never twice: either the hold is open or the fact is recorded; after finance, one fact, one event, fund blocked",
    async (door) => {
      const p = await fundRefundPending();
      const providerRefundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;
      const [answer] = await Promise.all([
        deliver(providerRefundedEvent(p.code, p.extra, door, providerRefundId)),
        failOwn(p.ownRef),
      ]);
      await expectAnswered(answer);
      await expectAnswered(
        await deliver(
          providerRefundedEvent(p.code, p.extra, door, providerRefundId),
        ),
      );
      await runWorker();

      expect((await refundRow(p.refundId)).status).toBe("failed");
      const holds = await openHoldIds(p.code.id);
      const recorded = await providerTotal(p.code.id, p.extra.providerRef);
      expect(
        holds.length === 1 || recorded === BILL_IDR,
        `the provider's refund is neither held nor recorded (holds ${holds.length}, recorded ${recorded})`,
      ).toBe(true);
      expect(holds.length).toBeLessThanOrEqual(1);
      expect(await countedB(p)).toBeLessThanOrEqual(p.extra.amountIdr);
      if (holds.length === 1) await financeCountsTheHold(p, callsBefore);
      const rows = await providerRowsOfRef(p.code.id, p.extra.providerRef);
      expect(rows.map((row) => row.amount_idr)).toEqual([BILL_IDR]);
      expect(await refundEventsOfRows(rows.map((row) => row.id))).toBe(1);
      expect(await countedB(p)).toBe(p.extra.amountIdr);
      await expectFundBProviderRefunded(p);
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it("1035-04izi-06 another bill with its own pending refund is not touched by this bill's events", async () => {
    const bystander = await fundRefundPending();
    const p = await fundRefundPending();
    await expectAnswered(
      await deliver(statusEvent(p.code, p.extra.providerRef, BILL_IDR)),
    );
    expect(await failOwn(p.ownRef)).toBeNull();
    await pollLater().catch(() => null);
    await runWorker();

    expect((await refundRow(bystander.refundId)).status).toBe("approved");
    expect(
      await providerRows(bystander.code.id),
      "no provider fact on the other bill",
    ).toEqual([]);
    expect(await openHoldIds(bystander.code.id)).toEqual([]);
    expect(await countedB(bystander)).toBe(bystander.extra.amountIdr);
  });

  // -------------------------------------------------------------------------
  // Ordinary bill refund (not a parked fund) of ours, pending with a provider
  // reference R, while the provider reports the main transaction `refunded`.
  // Decision (coordinator, B1 cancelled): a live bill refund of ours WITH a
  // reference makes a hold at once (no retry window, no wait for force); only a
  // live bill refund WITHOUT a reference keeps the old retry behavior.
  // -------------------------------------------------------------------------
  describe("ordinary bill refund of ours pending with a provider reference R", () => {
    /** Bill A paid; our intent-level refund of all of it is pending with ref R. */
    async function ordinaryPending() {
      const code = await newCode(BILL_IDR);
      expect((await paid(code, BILL_IDR)).status).toBe(200);
      const filed = await manualRefund(code.id, BILL_IDR);
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const refundId = filed.body.data.id as string;
      fake.enqueue("pending");
      expect((await approveRefund(refundId)).status).toBe(200);
      const row = await refundRow(refundId);
      expect(["completed", "failed"], "premise: in flight").not.toContain(
        row.status,
      );
      expect(row.provider_ref, "premise: R stored").toBeTruthy();
      doit.refund(code.providerRef);
      return { code, refundId, ownRef: row.provider_ref! };
    }

    type Ordinary = Awaited<ReturnType<typeof ordinaryPending>>;

    /** The main transaction's `refunded` status, a fresh event id each time. */
    const reportRefunded = (o: Ordinary) => {
      const event = doit.eventFor(o.code.providerRef, "refunded");
      return deliver(event).then((answer) => ({ answer, eventId: event.id }));
    };

    async function expectNothingRecorded(o: Ordinary, why: string) {
      expect(await providerRows(o.code.id), `${why}: no fact`).toEqual([]);
      expect(await refundEventsOfIntent(o.code.id), `${why}: no event`).toBe(0);
      expect(await openHoldIds(o.code.id), `${why}: no hold`).toEqual([]);
    }

    async function expectNewRefundRefused(o: Ordinary, why: string) {
      for (const amount of [BILL_IDR, 1_000]) {
        const attempt = await manualRefund(o.code.id, amount);
        expect(
          [409, 422],
          `${why}: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}`,
        ).toContain(attempt.status);
      }
    }

    async function ageEvent(eventId: string) {
      await owner.query(
        `UPDATE gateway_webhook_events
            SET received_at = now() - interval '20 minutes',
                updated_at = now() - interval '20 minutes'
          WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, eventId],
      );
    }

    it("1035-04izi-21 (a) the first report while R is live, still inside the retry window: ONE hold at once, no fact, no new refund; replays keep one hold", async () => {
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;

      await expectAnswered((await reportRefunded(o)).answer);
      expect(
        await openHoldIds(o.code.id),
        "ONE hold from the first report",
      ).toHaveLength(1);
      expect(await providerRows(o.code.id), "no fact while R is live").toEqual(
        [],
      );
      expect(await refundEventsOfIntent(o.code.id)).toBe(0);
      await expectNewRefundRefused(o, "R live, hold open");

      for (let round = 0; round < 2; round += 1) {
        await expectAnswered((await reportRefunded(o)).answer);
        await pollSoon().catch(() => null);
        await runWorker();
      }
      expect(
        await openHoldIds(o.code.id),
        "replays keep ONE hold",
      ).toHaveLength(1);
      expect(await providerRows(o.code.id)).toEqual([]);
      expect(await refundRowsOfIntent(o.code.id), "still one refund").toBe(1);
      expect((await refundRow(o.refundId)).status).not.toBe("failed");
      expect(fake.calls, "nothing sent to the guest").toHaveLength(callsBefore);
    });

    it("1035-04izi-22 (b) our refund COMPLETED, then the event repeats: own - no hold, no fact, no second payout", async () => {
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;
      expect(await succeedOwn(o.ownRef, BILL_IDR)).toBeNull();
      expect((await refundRow(o.refundId)).status).toBe("completed");

      for (let round = 0; round < 2; round += 1) {
        await expectAnswered((await reportRefunded(o)).answer);
        await pollLater().catch(() => null);
        await runWorker();
      }

      await expectNothingRecorded(o, "ours completed");
      expect(await ourRefundedIdr(o.code.id)).toBe(BILL_IDR);
      expect(fake.calls, "no second payout").toHaveLength(callsBefore);
      await expectNewRefundRefused(o, "ours completed");
    });

    it("1035-04izi-23 (c) our refund FAILED, then the event repeats: the fact is recorded once, the intent is blocked (PROVIDER_REFUNDED)", async () => {
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;
      expect(await failOwn(o.ownRef)).toBeNull();
      expect((await refundRow(o.refundId)).status).toBe("failed");

      for (let round = 0; round < 3; round += 1) {
        await expectAnswered((await reportRefunded(o)).answer);
        await pollLater().catch(() => null);
        await runWorker();
        const rows = await providerRowsOfRef(o.code.id, o.code.providerRef);
        expect(
          rows.map((row) => row.amount_idr),
          `round ${round}: the provider's refund is ONE fact, the real amount`,
        ).toEqual([BILL_IDR]);
        expect(await refundEventsOfRows(rows.map((row) => row.id))).toBe(1);
      }

      expect(await refundEventsOfIntent(o.code.id)).toBe(1);
      const blocked = await manualRefund(o.code.id, BILL_IDR);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
      expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
      expect(
        (await ourRefundedIdr(o.code.id)) +
          (await providerTotal(o.code.id, o.code.providerRef)),
        "the guest got back what was paid, once",
      ).toBe(BILL_IDR);
      expect(fake.calls, "no second payout").toHaveLength(callsBefore);
    });

    it("1035-04izi-24 (d) a report while R is live, then the window passes (worker, aged event): still ONE hold, no fact, intent blocked", async () => {
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;
      const { eventId } = await reportRefunded(o);
      expect(await openHoldIds(o.code.id), "ONE hold at once").toHaveLength(1);
      await ageEvent(eventId);
      await runWorker();

      for (let round = 0; round < 2; round += 1) {
        const again = await reportRefunded(o);
        await ageEvent(again.eventId);
        await pollLater().catch(() => null);
        await runWorker();
      }

      expect(
        await openHoldIds(o.code.id),
        "replays keep ONE hold",
      ).toHaveLength(1);
      expect(
        await providerRows(o.code.id),
        "no fact while ours is live",
      ).toEqual([]);
      expect(await refundEventsOfIntent(o.code.id)).toBe(0);
      await expectNewRefundRefused(o, "forced, R live");
      expect(fake.calls, "nothing sent to the guest").toHaveLength(callsBefore);
    });

    it("1035-04izi-25 the report is accepted (hold), R FAILS BEFORE any replay or worker: a new full refund is refused (409/422), nothing is sent; replays and finance's resolve end with ONE fact, one event", async () => {
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;
      await expectAnswered((await reportRefunded(o)).answer);
      expect(await openHoldIds(o.code.id)).toHaveLength(1);

      expect(await failOwn(o.ownRef)).toBeNull();
      expect((await refundRow(o.refundId)).status).toBe("failed");

      // Strict (money): the provider already refunded the transaction.
      const blocked = await manualRefund(o.code.id, BILL_IDR);
      let probe = "";
      if (blocked.status === 201) {
        const newId = blocked.body.data.id as string;
        const approved = await approveRefund(newId);
        probe = ` | probe: approve -> HTTP ${approved.status}, refund ${(await refundRow(newId)).status}, gateway calls +${fake.calls.length - callsBefore}`;
      }
      expect(
        [409, 422],
        `new full refund after R failed: HTTP ${blocked.status} ${JSON.stringify(blocked.body)}${probe}`,
      ).toContain(blocked.status);
      expect(fake.calls, "nothing sent to the guest").toHaveLength(callsBefore);

      // Replays may record the rest; finance may resolve the open hold.
      for (let round = 0; round < 2; round += 1) {
        await expectAnswered((await reportRefunded(o)).answer);
        await pollLater().catch(() => null);
        await runWorker();
        for (const holdId of await openHoldIds(o.code.id)) {
          const resolved = await resolveHold(holdId);
          expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(
            500,
          );
        }
        const rows = await providerRowsOfRef(o.code.id, o.code.providerRef);
        expect(
          rows.map((row) => row.amount_idr),
          "ONE fact, the real amount",
        ).toEqual([BILL_IDR]);
        expect(await refundEventsOfIntent(o.code.id)).toBe(1);
      }
      await expectNewRefundRefused(o, "provider refund recorded");
      expect(
        (await ourRefundedIdr(o.code.id)) +
          (await providerTotal(o.code.id, o.code.providerRef)),
        "the guest got back what was paid, once",
      ).toBe(BILL_IDR);
      expect(fake.calls, "no second payout").toHaveLength(callsBefore);
    });

    it("1035-04izi-07 our refund of A pending (ref R), provider refunds A: the first report makes ONE hold; R fails before any replay: new refund refused; one fact in the end", async () => {
      // Same flow as -25, kept under its original id for the webhook door of the
      // primary transaction: the hold comes from the FIRST delivery (no force).
      const o = await ordinaryPending();
      const callsBefore = fake.calls.length;
      await expectAnswered((await reportRefunded(o)).answer);
      expect(
        await openHoldIds(o.code.id),
        "hold from the first delivery",
      ).toHaveLength(1);
      expect(await providerTotal(o.code.id, o.code.providerRef)).toBe(0);
      await expectNewRefundRefused(o, "R live");
      expect(await failOwn(o.ownRef)).toBeNull();
      await expectNewRefundRefused(o, "R failed, before replay");
      expect(await providerTotal(o.code.id, o.code.providerRef)).toBe(0);
      expect(fake.calls).toHaveLength(callsBefore);
    });

    // KNOWN LIMIT (honest boundary, tracked as a bead by the coordinator): the
    // POLLER cannot be the door that learns the provider refunded a transaction
    // that is already PAID. pollPendingGatewayIntents only picks intents that
    // are pending / expired / failed, and bill A is `paid`, so the system never
    // finds out through polling. Only the webhook does. This test pins that
    // boundary and nothing else: with only the poller running there is no fact
    // and no hold. It asserts NO money outcome (a new refund is not judged here).
    it("1035-04izi-08 poller only: a paid bill whose provider status becomes refunded is not noticed by the poller (known limit): no fact, no hold", async () => {
      const o = await ordinaryPending();
      for (let round = 0; round < 2; round += 1) {
        await pollSoon().catch(() => null);
        await pollLater().catch(() => null);
      }
      await expectNothingRecorded(o, "poller only, R live");
      expect(await failOwn(o.ownRef)).toBeNull();
      await pollLater().catch(() => null);
      await expectNothingRecorded(o, "poller only, R failed");
    });
  });
});
