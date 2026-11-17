// legend-qbsbr (P1), brief 1020 F1: a refund of an EXTRA transaction's parked
// money (payment_refunds.unallocated_fund_id) must not be counted as a refund
// of the MAIN transaction's money. Scenario: bill A Rp100.000 paid; a second
// transaction B of Rp100.000 for the same intent is parked as an unallocated
// fund and that fund is refunded by staff (completed, or still in flight at the
// provider); then the PROVIDER refunds A's own payment (`payment.refunded`,
// 100.000). Today the fund refund is summed with A's own refunds, so A looks
// like "our own refund echoed back" and nothing is flagged: A stays refundable.
// Written from the brief and the 958/967 fixtures, not from the implementation,
// and failing first.
//
// Rules asserted (money rules: "jangan sampai rugi"):
//  (1) after the provider refunded A: A's intent is stamped
//      provider_refunded_after_paid_at, exactly ONE new refund audit row about A
//      and ONE supervisor alert (webhooks with two event ids + poller + later
//      retries), and no new payout (no journal, no provider refund call).
//  (2) A can no longer be refunded again: a new manual refund request is 409
//      PROVIDER_REFUNDED (no row filed); approving a refund of A that was
//      pending before is refused/voided (never completed, never sent); a stuck
//      approved refund of A cannot be settled by hand (409 PROVIDER_REFUNDED).
//  (3) the fund refund of B (completed, or in flight) is untouched: same status,
//      provider ref and attempts, no new provider call.
//
// Assumptions (the brief does not fix them):
//  - "Refund B completed" = the parked fund resolved by refund through the API
//    and approved (FakeRefundGateway answers succeeded); "in flight" = the fake
//    answers pending. Extra transaction B is a direct DB evidence + fund row,
//    as in the 967 file.
//  - The audit action name of a full provider refund is not pinned: it must
//    match /provider_refunded/. The 967 partial name stays untouched.
//  - Approving a pending refund of A after the provider refunded: status < 500;
//    when it is an error it is 409 PROVIDER_REFUNDED (a void answering 2xx is
//    accepted, as in 958-a4) and nothing is completed or sent.
//  - Manual settle: a refund of A seeded as approved + MANUAL_RECONCILIATION
//    (like payment-refund-stuck-settle-980), the fake provider answering
//    `failed`, settled by a second owner.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-extra-txn-fund-refund-1020.test.ts" heavy pnpm test
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
const BILL_IDR = 100_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1020-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1020-${randomBytes(16).toString("hex")}`;

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
let ops: ReturnType<typeof agent>;
let opsId = "";
let staffId = "";
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
  const email = await signUp(staff, "Fund1020 owner");
  const session = await staff.get("/api/auth/get-session");
  staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Fund1020 approver");
  const approverSession = await approver.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // A second owner: settles by hand a refund the first owner filed.
  ops = agent(app).set("Host", scope.hostname);
  const opsEmail = await signUp(ops, "Fund1020 ops");
  const opsSession = await ops.get("/api/auth/get-session");
  opsId = opsSession.body.user.id as string;
  userIds.push(opsId);
  await verifySessionMfa(opsEmail);
  await assign(opsId, "owner", "tenant");

  // The outlet supervisor who must hear about the refunded report.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Fund1020 supervisor");
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
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [[integrationId]],
  );
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
      reference: `R1020-${unique()}`,
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
async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

const EXTRA_IDR = 30_000;
type EvidenceSource = "verified_webhook" | "gateway_status";
type Extra = { providerRef: string; evidenceId: string; amountIdr: number };

const newExtraId = () => `dp_extra_${randomBytes(8).toString("hex")}`;

/** Another provider transaction recorded as evidence of the code's intent. */
async function addExtraTxn(
  code: Code,
  {
    amountIdr = EXTRA_IDR,
    source = "verified_webhook",
  }: { amountIdr?: number; source?: EvidenceSource } = {},
): Promise<Extra> {
  const providerRef = newExtraId();
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', $5, $6, now())
     RETURNING id`,
    [tenantId, outletId, code.id, providerRef, source, amountIdr],
  );
  return { providerRef, evidenceId: rows[0]!.id, amountIdr };
}

/** The extra transaction's money, parked as unallocated funds. */
async function parkExtra(code: Code, extra: Extra): Promise<string> {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, code.id, extra.evidenceId, extra.amountIdr],
  );
  return fundId;
}

// ---------------------------------------------------------------------------
// Observations and actions specific to this file
// ---------------------------------------------------------------------------

const ADMIN_PATH = ADMIN;
const MANUAL_RECONCILIATION = "MANUAL_RECONCILIATION";

const refundRowsOfIntent = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

const manualRefund = (intentId: string, amountIdr: number) =>
  staff
    .post(`${ADMIN_PATH}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan minta uang kembali",
    });

const approveRefund = (refundId: string) =>
  approver
    .post(`${ADMIN_PATH}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });

const settleByHand = (refundId: string) =>
  ops
    .post(`${ADMIN_PATH}/refunds/${refundId}/settle-manually`)
    .set(originHeader)
    .send({
      idempotencyKey: key("settle"),
      paidAt: new Date(Date.now() - MINUTE).toISOString(),
      channel: "bank_transfer",
      externalReference: `TRX-${randomUUID().slice(0, 8)}`,
      amountIdr: 30_000,
      note: "Dibayar manual oleh finance lewat transfer bank.",
    });

async function fundRefundId(fundId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );
  if (!rows[0]) throw new Error("no refund filed for the fund");
  return rows[0].id;
}

async function refundRow(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    payout_attempts: number;
    amount_idr: string;
  }>(
    `SELECT status, provider_ref, payout_attempts, amount_idr::text AS amount_idr
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId],
  );
  return rows[0]!;
}

async function intentStamp(intentId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
  );
  return rows[0]!.stamp;
}

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
  );
  return rows[0]!.status;
}

/** The provider refunded A's own payment: two webhooks (two event ids) + poller. */
async function providerRefundsMain(code: Code) {
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

type Scenario = {
  code: Code;
  fundId: string;
  fundRefundId: string;
  /** A pending manual refund of A filed before the provider refund, when asked. */
  manualRefundId: string | null;
};

/**
 * Bill A (Rp100.000) paid. Transaction B (Rp100.000, extra evidence of A) parked
 * as a fund and its refund filed and approved: completed, or in flight at the
 * provider. Optionally a pending manual refund of A (Rp30.000) filed first.
 */
async function scenario({
  fundRefund,
  pendingManualRefundOfA = false,
}: {
  fundRefund: "completed" | "in_flight";
  pendingManualRefundOfA?: boolean;
}): Promise<Scenario> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  // Precondition: A is settled and nothing is flagged.
  expect(await intentStatus(code.id)).toBe("paid");
  expect(await paidIdr(code.linkId)).toBe(BILL_IDR);
  expect(await intentStamp(code.id)).toBeNull();

  let manualRefundId: string | null = null;
  if (pendingManualRefundOfA) {
    const filed = await manualRefund(code.id, 30_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    manualRefundId = filed.body.data.id as string;
  }

  const extraB = await addExtraTxn(code, { amountIdr: BILL_IDR });
  const fundId = await parkExtra(code, extraB);
  const filedB = await resolveFund(fundId, "refund");
  expect(filedB.status, JSON.stringify(filedB.body)).toBe(200);
  const refundId = await fundRefundId(fundId);
  if (fundRefund === "in_flight") fake.enqueue("pending");
  const approvedB = await approveRefund(refundId);
  expect(approvedB.status, JSON.stringify(approvedB.body)).toBe(200);
  expect(fake.calls, "B's refund was sent once").toHaveLength(1);
  const row = await refundRow(refundId);
  expect(row.amount_idr).toBe(String(BILL_IDR));
  if (fundRefund === "completed") expect(row.status).toBe("completed");
  else expect(["completed", "failed"]).not.toContain(row.status);
  // B's refund was neither a refund of A's money nor a provider-initiated one.
  expect(await intentStamp(code.id)).toBeNull();
  return { code, fundId, fundRefundId: refundId, manualRefundId };
}

describe("legend-qbsbr the refund of an extra transaction's parked fund is not a refund of the main transaction", () => {
  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr fund refund of B %s, then the provider refunds A: A is stamped, one audit row, one alert, no new payout, B untouched",
    async (fundRefund) => {
      const { code, fundRefundId: bRefundId } = await scenario({ fundRefund });
      const bBefore = await refundRow(bRefundId);
      const callsBefore = fake.calls.length;
      const journalsBefore = await journals();
      const auditBefore = await auditActions(code.id);
      const alertsBefore = await supervisorAlerts();

      await providerRefundsMain(code);

      expect(
        await intentStamp(code.id),
        "provider refund of A stamps the intent",
      ).not.toBeNull();
      const newAudit = (await auditActions(code.id)).slice(auditBefore.length);
      expect(newAudit, "exactly one new audit row about A").toHaveLength(1);
      expect(newAudit[0]).toMatch(/provider_refunded/);
      expect(
        (await supervisorAlerts()) - alertsBefore,
        "exactly one alert to the outlet supervisor",
      ).toBe(1);
      expect(fake.calls, "no new payout").toHaveLength(callsBefore);
      expect(await journals(), "no journal added").toBe(journalsBefore);
      // B's refund is not turned into an echo of A's refund.
      const bAfter = await refundRow(bRefundId);
      expect(bAfter.status).toBe(bBefore.status);
      expect(bAfter.provider_ref).toBe(bBefore.provider_ref);
      expect(bAfter.payout_attempts).toBe(bBefore.payout_attempts);
      // Recording is not a correction: A stays credited, nothing re-parked.
      expect(await paidIdr(code.linkId)).toBe(BILL_IDR);
      expect(await fundsOf(code.id)).toHaveLength(1);

      // Replays: the provider retries (new event ids) and polls again.
      const audit = await auditActions(code.id);
      const alerts = await supervisorAlerts();
      await providerRetriesLater(code);
      await providerRetriesLater(code);
      expect(await auditActions(code.id), "no second audit row").toEqual(audit);
      expect(await supervisorAlerts(), "no second alert").toBe(alerts);
      expect(await intentStamp(code.id)).not.toBeNull();
      expect(fake.calls, "still no new payout").toHaveLength(callsBefore);
      expect(await journals()).toBe(journalsBefore);
    },
  );

  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr fund refund of B %s, provider refunded A: a new manual refund of A is 409 PROVIDER_REFUNDED and files nothing",
    async (fundRefund) => {
      const { code } = await scenario({ fundRefund });
      await providerRefundsMain(code);
      const rowsBefore = await refundRowsOfIntent(code.id);
      const callsBefore = fake.calls.length;

      const attempt = await manualRefund(code.id, 1_000);

      expect(
        attempt.status,
        `manual refund: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
      expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
      expect(await refundRowsOfIntent(code.id), "no refund filed").toBe(
        rowsBefore,
      );
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr fund refund of B %s, a refund of A pending before the provider refunded A: approving it is refused or voided, never sent",
    async (fundRefund) => {
      const { code, manualRefundId } = await scenario({
        fundRefund,
        pendingManualRefundOfA: true,
      });
      await providerRefundsMain(code);
      const callsBefore = fake.calls.length;
      const journalsBefore = await journals();

      const approved = await approveRefund(manualRefundId!);

      expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
      if (approved.status >= 300) {
        expect(approved.status).toBe(409);
        expect(approved.body.error.code).toBe("PROVIDER_REFUNDED");
      } else {
        expect(approved.body.data.status).not.toBe("completed");
      }
      expect((await refundRow(manualRefundId!)).status).not.toBe("completed");
      expect(fake.calls, "A's refund is never sent").toHaveLength(callsBefore);
      expect(await journals(), "no payout journal").toBe(journalsBefore);
      // Approving again still pays nothing.
      expect((await approveRefund(manualRefundId!)).status).toBeLessThan(500);
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it("1020-qbsbr fund refund of B completed, provider refunded A: a stuck approved refund of A cannot be settled by hand (409 PROVIDER_REFUNDED)", async () => {
    const { code } = await scenario({ fundRefund: "completed" });
    await providerRefundsMain(code);
    expect(await intentStamp(code.id)).not.toBeNull();

    // A stuck refund of A, as in payment-refund-stuck-settle-980.
    const refundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                    requested_by, approved_by, decided_at, provider_ref, payout_attempts,
                                    last_payout_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 30000, 'Pengembalian uji', 'approved', $5, $6, now(), $7, 8, $8,
               now() - interval '3 hours', now() - interval '2 hours')`,
      [
        refundId,
        tenantId,
        outletId,
        code.id,
        staffId,
        approverId,
        `PR-STUCK-${randomUUID()}`,
        MANUAL_RECONCILIATION,
      ],
    );
    // The provider answers `failed`, so only the provider-refunded rule can block.
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: "PR-DECLINED",
      code: "declined",
    });
    const callsBefore = fake.calls.length;

    const settled = await settleByHand(refundId);

    expect(settled.status, JSON.stringify(settled.body)).toBe(409);
    expect(settled.body.error.code).toBe("PROVIDER_REFUNDED");
    expect((await refundRow(refundId)).status).toBe("approved");
    expect(fake.calls).toHaveLength(callsBefore);
    expect(opsId).not.toBe(staffId);
  });

  it("1020-qbsbr control: fund refund of B completed and the provider did NOT refund A: A is not stamped, no audit row, no alert", async () => {
    const { code } = await scenario({ fundRefund: "completed" });
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    // Polls with nothing refunded at the provider change nothing.
    await pollSoon().catch(() => null);
    await pollLater().catch(() => null);

    expect(await intentStamp(code.id)).toBeNull();
    expect(await auditActions(code.id)).toEqual(auditBefore);
    expect(await supervisorAlerts()).toBe(alertsBefore);
    expect(await intentStatus(code.id)).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Variant: the parked fund belongs to A's OWN transaction (overpayment).
// Bill A Rp50.000 is paid with ONE transaction of Rp150.000 (evidence 150.000,
// intent amount 50.000). The extra Rp100.000 is parked as A's own fund and that
// fund is refunded by staff (completed, or in flight). Then the provider
// refunds the rest of A's transaction (payment.refunded, remaining Rp50.000).
// The refund of the parked excess (Rp100.000) is not the provider echo of A's
// bill: A must still be stamped, flagged once, and closed to further refunds.
//
// Assumptions: the overpay webhook parks the excess automatically as a fund
// linked to the same evidence (as in payment-overpay-provider-refund-1016);
// "refund of the fund" is filed through the API resolve endpoint and approved,
// the fake refund gateway answering succeeded (completed) or pending
// (in_flight). The audit action must match /provider_refunded/.
// ---------------------------------------------------------------------------

const OVERPAY_BILL_IDR = 50_000;
const OVERPAY_PAID_IDR = 150_000;
const OVERPAY_EXCESS_IDR = 100_000;

async function overpaidScenario(
  fundRefund: "completed" | "in_flight",
  { pendingManualRefundOfA = false }: { pendingManualRefundOfA?: boolean } = {},
): Promise<Scenario> {
  const code = await newCode(OVERPAY_BILL_IDR);
  expect((await paid(code, OVERPAY_PAID_IDR)).status).toBe(200);
  expect(await intentStatus(code.id)).toBe("paid");
  expect(await paidIdr(code.linkId)).toBe(OVERPAY_BILL_IDR);
  expect(await intentStamp(code.id)).toBeNull();

  // Premise: one transaction of 150.000 for a 50.000 bill; 100.000 parked as A's own fund.
  const { rows: evidence } = await owner.query<{ amount_idr: string }>(
    "SELECT amount_idr::text AS amount_idr FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, code.id],
  );
  expect(evidence, "one transaction").toHaveLength(1);
  expect(evidence[0]!.amount_idr).toBe(String(OVERPAY_PAID_IDR));
  const funds = await fundsOf(code.id);
  expect(funds, "the excess is parked once").toHaveLength(1);
  expect(funds[0]!.amount_idr).toBe(String(OVERPAY_EXCESS_IDR));
  expect(funds[0]!.resolved_at).toBeNull();
  const fundId = funds[0]!.id;

  let manualRefundId: string | null = null;
  if (pendingManualRefundOfA) {
    const filed = await manualRefund(code.id, 30_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    manualRefundId = filed.body.data.id as string;
  }

  const filedFund = await resolveFund(fundId, "refund");
  expect(filedFund.status, JSON.stringify(filedFund.body)).toBe(200);
  const refundId = await fundRefundId(fundId);
  if (fundRefund === "in_flight") fake.enqueue("pending");
  const approvedFund = await approveRefund(refundId);
  expect(approvedFund.status, JSON.stringify(approvedFund.body)).toBe(200);
  expect(fake.calls, "the fund refund was sent once").toHaveLength(1);
  const row = await refundRow(refundId);
  expect(row.amount_idr).toBe(String(OVERPAY_EXCESS_IDR));
  if (fundRefund === "completed") expect(row.status).toBe("completed");
  else expect(["completed", "failed"]).not.toContain(row.status);
  // Our own refund of the excess is not a provider-initiated refund.
  expect(await intentStamp(code.id)).toBeNull();
  return { code, fundId, fundRefundId: refundId, manualRefundId };
}

describe("legend-qbsbr variant: refund of A's own parked overpayment excess is not the provider echo of A's bill", () => {
  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr-own-fund fund refund of the excess %s, then the provider refunds A: A is stamped, one audit row, one alert, no new payout, fund refund untouched",
    async (fundRefund) => {
      const { code, fundRefundId: fundRefundRowId } =
        await overpaidScenario(fundRefund);
      const before = await refundRow(fundRefundRowId);
      const callsBefore = fake.calls.length;
      const journalsBefore = await journals();
      const auditBefore = await auditActions(code.id);
      const alertsBefore = await supervisorAlerts();

      await providerRefundsMain(code);

      expect(
        await intentStamp(code.id),
        "provider refund of the remaining A money stamps the intent",
      ).not.toBeNull();
      const newAudit = (await auditActions(code.id)).slice(auditBefore.length);
      expect(newAudit, "exactly one new audit row about A").toHaveLength(1);
      expect(newAudit[0]).toMatch(/provider_refunded/);
      expect(
        (await supervisorAlerts()) - alertsBefore,
        "exactly one alert to the outlet supervisor",
      ).toBe(1);
      expect(fake.calls, "no new payout").toHaveLength(callsBefore);
      expect(await journals(), "no journal added").toBe(journalsBefore);
      const after = await refundRow(fundRefundRowId);
      expect(after.status).toBe(before.status);
      expect(after.provider_ref).toBe(before.provider_ref);
      expect(after.payout_attempts).toBe(before.payout_attempts);

      // Replays: new event ids and polls add nothing.
      const audit = await auditActions(code.id);
      const alerts = await supervisorAlerts();
      await providerRetriesLater(code);
      await providerRetriesLater(code);
      expect(await auditActions(code.id), "no second audit row").toEqual(audit);
      expect(await supervisorAlerts(), "no second alert").toBe(alerts);
      expect(await intentStamp(code.id)).not.toBeNull();
      expect(fake.calls, "still no new payout").toHaveLength(callsBefore);
      expect(await journals()).toBe(journalsBefore);
    },
  );

  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr-own-fund fund refund of the excess %s, provider refunded A: a new manual refund of A is 409 PROVIDER_REFUNDED and files nothing",
    async (fundRefund) => {
      const { code } = await overpaidScenario(fundRefund);
      await providerRefundsMain(code);
      const rowsBefore = await refundRowsOfIntent(code.id);
      const callsBefore = fake.calls.length;

      const attempt = await manualRefund(code.id, 1_000);

      expect(
        attempt.status,
        `manual refund: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
      expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
      expect(await refundRowsOfIntent(code.id), "no refund filed").toBe(
        rowsBefore,
      );
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr-own-fund fund refund of the excess %s, a refund of A pending before the provider refunded A: approving it is 409 PROVIDER_REFUNDED (or voided), never sent",
    async (fundRefund) => {
      const { code, manualRefundId } = await overpaidScenario(fundRefund, {
        pendingManualRefundOfA: true,
      });
      await providerRefundsMain(code);
      const callsBefore = fake.calls.length;
      const journalsBefore = await journals();

      const approved = await approveRefund(manualRefundId!);

      expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
      if (approved.status >= 300) {
        expect(approved.status).toBe(409);
        expect(approved.body.error.code).toBe("PROVIDER_REFUNDED");
      } else {
        expect(approved.body.data.status).not.toBe("completed");
      }
      expect((await refundRow(manualRefundId!)).status).not.toBe("completed");
      expect(fake.calls, "A's refund is never sent").toHaveLength(callsBefore);
      expect(await journals(), "no payout journal").toBe(journalsBefore);
    },
  );

  it.each(["completed", "in_flight"] as const)(
    "1020-qbsbr-own-fund fund refund of the excess %s, provider refunded A: a stuck approved refund of A cannot be settled by hand (409 PROVIDER_REFUNDED)",
    async (fundRefund) => {
      const { code } = await overpaidScenario(fundRefund);
      await providerRefundsMain(code);
      expect(await intentStamp(code.id)).not.toBeNull();

      const refundId = randomUUID();
      await owner.query(
        `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                      requested_by, approved_by, decided_at, provider_ref, payout_attempts,
                                      last_payout_error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 30000, 'Pengembalian uji', 'approved', $5, $6, now(), $7, 8, $8,
                 now() - interval '3 hours', now() - interval '2 hours')`,
        [
          refundId,
          tenantId,
          outletId,
          code.id,
          staffId,
          approverId,
          `PR-STUCK-${randomUUID()}`,
          MANUAL_RECONCILIATION,
        ],
      );
      // The provider answers `failed`, so only the provider-refunded rule can block.
      fake.setStatus(`refund:${refundId}`, {
        status: "failed",
        providerRef: "PR-DECLINED",
        code: "declined",
      });
      const callsBefore = fake.calls.length;

      const settled = await settleByHand(refundId);

      expect(settled.status, JSON.stringify(settled.body)).toBe(409);
      expect(settled.body.error.code).toBe("PROVIDER_REFUNDED");
      expect((await refundRow(refundId)).status).toBe("approved");
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );
});
