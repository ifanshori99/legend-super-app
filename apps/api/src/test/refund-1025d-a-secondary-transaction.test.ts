// legend-9dzxc (brief 1025d, tier K "jangan sampai rugi"): a provider refund of
// a SECONDARY transaction B of an intent must not be mistaken for an echo of
// the intent's own (primary transaction A) refunds. Scenario: A Rp100.000 paid;
// a second transaction B of Rp100.000 recorded as evidence of the same intent
// and parked as an unallocated fund; staff refunds A in full through the system
// (completed, an intent-level refund: no fund link). Then the PROVIDER reports
// B refunded. Today B's event is netted against A's intent-level refund, the
// remainder is zero, nothing is recorded and fund B is not blocked, so staff can
// refund B's money a second time (guest paid twice, outlet loses Rp100.000).
// Written from the brief and the 967 / 1020 / 1025c fixtures, not from the
// implementation, and failing first.
//
// Rules asserted:
//  (1) provider refunded B (status-object door: `payment.refunded` carrying B's
//      payment object, and id door: `payment.refunded` with
//      `{ payment_id, refund_id, amount, status }`) -> B's provider refund is
//      recorded ONCE (payment_provider_refunds, provider_payment_ref = B's
//      reference, full amount), exactly one `payment.provider_refunded`
//      journal event for that row, fund B is stamped provider_refunded_at and
//      can no longer be resolved by refund or credit (409 PROVIDER_REFUNDED),
//      no refund row is filed for it and no second provider call happens.
//      Replays (new event ids, later retries, poller) add nothing.
//  (2) the guest never gets more than was paid: our refunds (not failed) plus
//      provider refund rows <= A + B.
//  (3) controls (these already hold and must keep holding): B refunded with no
//      refund of A; a refund of fund B's OWN transaction echoed by the provider
//      still counts (no second row); A's refund echoed by the provider for the
//      primary transaction still leaves nothing (no double row, no second
//      payout).
//
// Assumptions (the brief does not fix them):
//  - "Refund of A completed (system refund)" = a manual intent-level refund of
//    Rp100.000 filed through POST /refunds and approved (the fake refund
//    gateway answers succeeded).
//  - B is simulated with direct DB rows (evidence + parked fund 'double_payment',
//    evidence ref B), as in the 967 / 1020 files.
//  - "Provider fact recorded" is read from payment_provider_refunds by the
//    provider payment reference; the row's refund id is NOT pinned (the
//    status-object door uses a synthetic id by design).
//  - "Journal event once" = one distinct outbox event `payment.provider_refunded`
//    whose payload.providerRefundId is that row's id (as in 1025-B).
//  - Poller path: the poller only reaches the primary payment of the intent
//    (the fake DOIT knows A only), so for B it is run in the burst and in later
//    replays as a no-op that must add nothing; B's own poller observation is
//    not reachable and is not tested here. For A (control) it is meaningful.
//  - A partial provider refund of B is asserted only as "recorded in full";
//    whether it also blocks the fund is not pinned.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025d-a-secondary-transaction.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1025d-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1025d-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1025d owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1025d approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

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

const refundRowsOfFund = (fundId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
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

async function fundState(fundId: string) {
  const { rows } = await owner.query<{
    resolution: string | null;
    resolved_at: Date | null;
    provider_refunded_at: Date | null;
  }>(
    `SELECT resolution, resolved_at, provider_refunded_at
       FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, fundId],
  );
  return rows[0]!;
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

/** One delivery of the provider's report that B was refunded (in full). */
function bEvent(code: Code, extra: Extra, door: Door, refundId: string) {
  return door === "status"
    ? statusEvent(code, extra.providerRef, extra.amountIdr)
    : idEvent(extra.providerRef, refundId, extra.amountIdr);
}

async function expectAnswered(answer: { status: number; body: unknown }) {
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = {
  code: Code;
  extra: Extra;
  fundId: string;
  aRefundId: string | null;
};

/**
 * A (Rp100.000) paid; B (Rp100.000, evidence ref B) parked as a fund. When
 * `refundA`, staff refunds A in full through the system and it completes.
 */
async function scenario({ refundA }: { refundA: boolean }): Promise<Scenario> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const extra = await addExtraTxn(code, BILL_IDR);
  const fundId = await parkExtra(code, extra);

  let aRefundId: string | null = null;
  if (refundA) {
    const filed = await manualRefund(code.id, BILL_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    aRefundId = filed.body.data.id as string;
    const approved = await approveRefund(aRefundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await refundRow(aRefundId);
    expect(row.status, "premise: the refund of A is completed").toBe(
      "completed",
    );
    expect(row.amount_idr).toBe(String(BILL_IDR));
    expect(fake.calls, "A's refund was sent once").toHaveLength(1);
  }
  // Premise: no provider refund recorded for B yet, fund B open and unflagged.
  expect(await providerRowsOfRef(code.id, extra.providerRef)).toHaveLength(0);
  const fund = await fundState(fundId);
  expect(fund).toMatchObject({
    resolution: null,
    resolved_at: null,
    provider_refunded_at: null,
  });
  return { code, extra, fundId, aRefundId };
}

/** Two events (different ids, same refund) and a poll at once. */
async function burst(
  code: Code,
  extra: Extra,
  door: Door,
  refundId: string,
): Promise<void> {
  const [first, second] = await Promise.all([
    deliver(bEvent(code, extra, door, refundId)),
    deliver(bEvent(code, extra, door, refundId)),
    pollSoon().catch(() => null),
  ]);
  await expectAnswered(first);
  await expectAnswered(second);
}

/** The provider retries later (new event ids) and the poller runs again. */
async function retriesLater(
  code: Code,
  extra: Extra,
  door: Door,
  refundId: string,
): Promise<void> {
  const again = await deliver(bEvent(code, extra, door, refundId));
  await expectAnswered(again);
  await pollLater().catch(() => null);
}

/** Fund B refused by refund and by credit; nothing filed, nothing sent. */
async function expectFundBlocked(s: Scenario, callsBefore: number) {
  expect(
    (await fundState(s.fundId)).provider_refunded_at,
    "fund B is flagged as refunded by the provider",
  ).not.toBeNull();
  for (const resolution of ["refund", "credit"] as const) {
    const attempt = await resolveFund(s.fundId, resolution);
    expect(
      attempt.status,
      `resolve fund B by ${resolution}: ${JSON.stringify(attempt.body)}`,
    ).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
  }
  expect(await refundRowsOfFund(s.fundId), "no refund filed for fund B").toBe(
    0,
  );
  const fund = await fundState(s.fundId);
  expect(fund.resolution).toBeNull();
  expect(fund.resolved_at).toBeNull();
  expect(fake.calls, "no second payout to the guest").toHaveLength(callsBefore);
}

/** The guest never receives more than was paid (A + B). */
async function expectNotPaidMore(s: Scenario) {
  const providerTotal = (await providerRows(s.code.id)).reduce(
    (sum, row) => sum + row.amount_idr,
    0,
  );
  expect(
    (await ourRefundedIdr(s.code.id)) + providerTotal,
    "ours + provider refunds never exceed what was paid",
  ).toBeLessThanOrEqual(BILL_IDR + s.extra.amountIdr);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("legend-9dzxc the provider refund of a secondary transaction is not an echo of the primary's refund", () => {
  it.each(["status", "id"] as const)(
    "1025d-9dzxc-01 A refunded by the system, provider refunds B in full (%s door): B's refund is recorded once, fund B is blocked, no second payout, one journal event, replays add nothing",
    async (door) => {
      const s = await scenario({ refundA: true });
      const refundId = `rf_${randomBytes(6).toString("hex")}`;
      const callsBefore = fake.calls.length;

      await burst(s.code, s.extra, door, refundId);

      const rows = await providerRowsOfRef(s.code.id, s.extra.providerRef);
      expect(
        rows.map((row) => row.amount_idr),
        "the provider's refund of B is recorded once, in full",
      ).toEqual([BILL_IDR]);
      expect(
        await refundEventsOfRows(rows.map((row) => row.id)),
        "one journal event for the row",
      ).toBe(1);
      await expectFundBlocked(s, callsBefore);
      await expectNotPaidMore(s);

      // Replays: later retries with new event ids, and the poller again.
      const intentEvents = await refundEventsOfIntent(s.code.id);
      for (let round = 0; round < 2; round += 1)
        await retriesLater(s.code, s.extra, door, refundId);
      expect(
        (await providerRowsOfRef(s.code.id, s.extra.providerRef)).map(
          (row) => row.amount_idr,
        ),
        "no second row after replays",
      ).toEqual([BILL_IDR]);
      expect(await refundEventsOfIntent(s.code.id)).toBe(intentEvents);
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it("1025d-9dzxc-02 A refunded by the system, provider refunds B in part (id door, 40.000): the 40.000 is recorded once, not netted against A's refund, guest not paid more", async () => {
    const s = await scenario({ refundA: true });
    const refundId = `rf_${randomBytes(6).toString("hex")}`;

    for (let delivery = 0; delivery < 2; delivery += 1)
      await expectAnswered(
        await deliver(idEvent(s.extra.providerRef, refundId, 40_000)),
      );

    const rows = await providerRowsOfRef(s.code.id, s.extra.providerRef);
    expect(rows.map((row) => row.amount_idr)).toEqual([40_000]);
    expect(rows[0]!.provider_refund_id).toBe(refundId);
    expect(await refundEventsOfRows(rows.map((row) => row.id))).toBe(1);
    await expectNotPaidMore(s);
  });

  it("1025d-9dzxc-03 control: nobody refunded A, the provider refunds B in full (status door): recorded once and fund B blocked", async () => {
    const s = await scenario({ refundA: false });
    const callsBefore = fake.calls.length;

    await burst(s.code, s.extra, "status", "unused");

    const rows = await providerRowsOfRef(s.code.id, s.extra.providerRef);
    expect(rows.map((row) => row.amount_idr)).toEqual([BILL_IDR]);
    await expectFundBlocked(s, callsBefore);
    await expectNotPaidMore(s);
  });

  it.each(["status", "id"] as const)(
    "1025d-9dzxc-04 control: fund B refunded by staff (completed), the provider echoes B's own refund (%s door): it still counts, no second row, no second payout",
    async (door) => {
      const s = await scenario({ refundA: false });
      const filed = await resolveFund(s.fundId, "refund");
      expect(filed.status, JSON.stringify(filed.body)).toBe(200);
      const refundId = await fundRefundId(s.fundId);
      const approved = await approveRefund(refundId);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const ours = await refundRow(refundId);
      expect(ours.status, "premise: fund B's refund completed").toBe(
        "completed",
      );
      expect(fake.calls, "B's refund was sent once").toHaveLength(1);
      const rowsBefore = await providerRows(s.code.id);
      const eventsBefore = await refundEventsOfIntent(s.code.id);

      // The echo names our own refund id on the id door.
      await burst(s.code, s.extra, door, ours.provider_ref ?? "missing");
      await retriesLater(s.code, s.extra, door, ours.provider_ref ?? "missing");

      expect(
        await providerRows(s.code.id),
        "B's own refund already counts: nothing new recorded",
      ).toEqual(rowsBefore);
      expect(await refundEventsOfIntent(s.code.id)).toBe(eventsBefore);
      expect(await refundRowsOfFund(s.fundId)).toBe(1);
      expect(fake.calls, "no second payout").toHaveLength(1);
      await expectNotPaidMore(s);
    },
  );

  it.each(["status", "id"] as const)(
    "1025d-9dzxc-05 control: A refunded by the system, the provider echoes the primary transaction's own refund (%s door): nothing counted twice, no second payout",
    async (door) => {
      const code = await newCode(BILL_IDR);
      expect((await paid(code, BILL_IDR)).status).toBe(200);
      const filed = await manualRefund(code.id, BILL_IDR);
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const refundId = filed.body.data.id as string;
      expect((await approveRefund(refundId)).status).toBe(200);
      const ours = await refundRow(refundId);
      expect(ours.status).toBe("completed");
      expect(fake.calls).toHaveLength(1);
      const rowsBefore = await providerRows(code.id);
      const eventsBefore = await refundEventsOfIntent(code.id);

      doit.refund(code.providerRef);
      const echo = () =>
        door === "status"
          ? doit.eventFor(code.providerRef, "refunded")
          : idEvent(code.providerRef, ours.provider_ref ?? "missing", BILL_IDR);
      const [first, second] = await Promise.all([
        deliver(echo()),
        deliver(echo()),
        pollSoon().catch(() => null),
      ]);
      await expectAnswered(first);
      await expectAnswered(second);
      await expectAnswered(await deliver(echo()));
      await pollLater().catch(() => null);

      expect(
        await providerRows(code.id),
        "our own refund echoed: still nothing left to record",
      ).toEqual(rowsBefore);
      expect(await refundEventsOfIntent(code.id)).toBe(eventsBefore);
      expect(await refundRowsOfIntent(code.id), "no new refund of ours").toBe(
        1,
      );
      expect(fake.calls, "no second payout").toHaveLength(1);
      expect(await ourRefundedIdr(code.id)).toBe(BILL_IDR);
    },
  );
});
