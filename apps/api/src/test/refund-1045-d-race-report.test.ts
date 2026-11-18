// legend-w2td5 / legend-d7im9 (brief 1045, "Matriks race" M1, tier K "jangan
// sampai rugi"): the provider's report (webhook / poller) x our own refund R x a
// NEW refund, in every order the second opinion (1044) and the CTO (Retro 46)
// name. Written from the brief (docs/briefs/sub-1045-refund-so3.md, "Matriks
// race" + F1/F2), the 1035-a / 1045-a / 1045-b fixtures and the spec rule "no
// certainty about the provider's status -> hold and refuse new refunds", not
// from the implementation.
//
// Invariant asserted in EVERY test (explicitly, with the numbers in the message
// and printed in the summary at the end of the run):
//     MONEY OUT <= PAID (Rp100.000)
//   money out = our refunds that COMPLETED (the fake gateway paid them out)
//             + what the provider refunded on its own (declared per scenario)
//   plus: provider facts (payment_provider_refunds) <= paid, facts + our
//   not-failed refunds <= paid, and a new refund after the provider's report is
//   refused (409/422) and sends nothing to the guest.
//
// Assumptions (the brief does not fix them):
//  - "R live with ref" = the fake refund gateway answers `pending` on approve
//    (provider_ref stored). "R in-flight without ref" = the fake throws a timeout
//    on approve (status approved, payout_attempts 1, provider_ref NULL).
//  - R fails with ref: applyRefundProviderUpdate(failed) (the webhook/poll feed).
//    R fails without ref: lookup answer `failed` + POST /refunds/:id/retry
//    (as in 1045-b). R completes with ref: applyRefundProviderUpdate(succeeded).
//  - "Provider refunded on its own" = the fake DOIT payment turns `refunded`
//    (what the poller reads) and/or a signed `payment.refunded` webhook arrives.
//  - When R COMPLETES the provider's `refunded` status is the echo of OUR payout
//    (one movement of money): provider-own money counted 0 in M1-02. When R
//    failed the provider's refund is real money of its own: counted 100k (or the
//    40k of M1-06).
//  - Order is forced with await / Promise.all barriers, never with sleeps.
//  - Hold existence is read over ALL hold reasons (live-own, own-failed, ...):
//    "held or recorded" is what the CTO rule requires between the steps.
//  - M1-06: a new refund of Rp60.000 after the provider's Rp40.000 may be
//    accepted or refused (it is the real remainder); only the money invariant
//    and "Rp100.000 is refused" are pinned.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1045-d-race-report.test.ts" heavy pnpm test

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
const ADMIN = "/api/payments/admin";
const BILL_IDR = 100_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1045d-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045d-${randomBytes(16).toString("hex")}`;

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
// Second tenant is never set up in this file; the guards below stay for parity
// with the sibling fixtures.
const tenantB = null as {
  scope: ReturnType<typeof paymentTestScope>;
  integrationId: string;
  linkIds: string[];
} | null;

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
  const email = await signUp(staff, "Refund1045d owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1045d approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

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
      // Credentials per tenant (the second tenant has its own integration).
      loadCredentials: async (context: { tenant: { tenantId: string } }) => ({
        integration: {
          id:
            tenantB && context.tenant.tenantId === tenantB.scope.tenantId
              ? tenantB.integrationId
              : integrationId,
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
  if (tenantB) {
    const other = tenantB.scope.tenantId;
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_unallocated_funds",
      "payment_evidence",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intentsOf})`,
        [other, tenantB.linkIds],
      );
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [other],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [other, tenantB.linkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [other, tenantB.linkIds],
    );
    await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      tenantB.integrationId,
    ]);
  }
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
      reference: `R1045D-${unique()}`,
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

/** Every open hold of the intent, whatever its reason (live-own, own-failed...). */
async function allOpenHolds(intentId: string): Promise<number> {
  return count(
    `SELECT count(*)::text AS n FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND resolved_at IS NULL`,
    [tenantId, intentId],
  );
}

/** Money our refunds really paid out (the fake gateway completed them). */
async function completedPayouts(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

const ledger = new Map<string, string>();

/**
 * MONEY OUT <= PAID. `providerOwnIdr` = what the provider refunded on its own and
 * is real money (0 when its report is only the echo of our completed refund).
 */
async function expectMoneyOutWithinPaid(
  label: string,
  intentId: string,
  providerOwnIdr: number,
  step: string,
  // While R is still live (not yet paid out nor failed) its amount is exposure,
  // not money out: the combined facts + live refunds check is skipped then only.
  rStillLive = false,
) {
  const ours = await completedPayouts(intentId);
  const facts = await factTotal(intentId);
  const notFailed = await ourRefundedIdr(intentId);
  const out = ours + providerOwnIdr;
  ledger.set(
    label,
    `uang keluar Rp${out} (payout kita ${ours} + provider sendiri ${providerOwnIdr}) vs dibayar Rp${BILL_IDR}; fact provider ${facts}; refund kita tidak gagal ${notFailed}; langkah terakhir: ${step}`,
  );
  expect(
    out,
    `${label} ${step}: money out ${out} (ours paid ${ours} + provider own ${providerOwnIdr}) must not exceed paid ${BILL_IDR}`,
  ).toBeLessThanOrEqual(BILL_IDR);
  expect(
    facts,
    `${label} ${step}: provider facts ${facts} must not exceed paid`,
  ).toBeLessThanOrEqual(BILL_IDR);
  if (!rStillLive)
    expect(
      facts + notFailed,
      `${label} ${step}: provider facts ${facts} + our live refunds ${notFailed} must not exceed paid`,
    ).toBeLessThanOrEqual(BILL_IDR);
}

afterAll(() => {
  const lines = [...ledger.entries()].map(([k, v]) => `  ${k}: ${v}`);
  process.stdout.write(`\n[M1 uang keluar vs dibayar]\n${lines.join("\n")}\n`);
});

// ---------------------------------------------------------------------------
// Scenario building blocks
// ---------------------------------------------------------------------------

type Own = {
  code: Code;
  refundId: string;
  refundIdr: number;
  /** Provider reference of R (null when the provider call timed out). */
  ref: string | null;
  /** Gateway calls made so far: nothing may add to it afterwards. */
  callsBefore: number;
};

/** Bill paid; our refund R was SENT and is pending at the provider (ref stored). */
async function liveWithRef(refundIdr: number = BILL_IDR): Promise<Own> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, refundIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("pending");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
  const row = await refundRow(refundId);
  expect(row.provider_ref, "premise: R was sent (ref stored)").toBeTruthy();
  expect(row.status, "premise: R is live").not.toBe("failed");
  expect(fake.calls, "premise: R sent once").toHaveLength(1);
  return {
    code,
    refundId,
    refundIdr,
    ref: row.provider_ref,
    callsBefore: fake.calls.length,
  };
}

/** Bill paid; our refund R was TRIED (timeout): approved, no provider reference. */
async function triedNoRef(refundIdr: number = BILL_IDR): Promise<Own> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, refundIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.status, "premise: R in flight").toBe("approved");
  expect(row.provider_ref, "premise: R has no ref").toBeNull();
  expect(row.payout_attempts, "premise: R was tried").toBeGreaterThan(0);
  return {
    code,
    refundId,
    refundIdr,
    ref: null,
    callsBefore: fake.calls.length,
  };
}

/** The provider refunds the bill on its own: what the poller reads turns `refunded`. */
const providerRefundsBill = (o: Own) => doit.refund(o.code.providerRef);

const statusReport = (o: Own) => doit.eventFor(o.code.providerRef, "refunded");

/** Refund-id door: the provider's own refund id (partial or whole). */
const idReport = (o: Own, amountIdr: number) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "payment.refunded",
  created_at: new Date().toISOString(),
  data: {
    payment_id: o.code.providerRef,
    refund_id: `rf_${randomBytes(6).toString("hex")}`,
    amount: amountIdr,
    status: amountIdr >= BILL_IDR ? "refunded" : "partially_refunded",
  },
});

/** The signed report arrives; whatever it answers (200 or a retry 5xx), it was received. */
async function receive(body: object) {
  const answer = await deliver(body);
  expect(answer.status, "the signed report is not rejected").not.toBe(401);
  expect(answer.status, "the signed report is not rejected").not.toBe(403);
  return answer;
}

/** R (with ref) is declined by the provider. */
const failWithRef = (o: Own) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef: o.ref!,
    status: "failed",
    code: "declined",
  }).then(
    () => null,
    (error: unknown) => error,
  );

/** R (with ref) completes at the provider. */
const completeWithRef = (o: Own) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef: o.ref!,
    status: "succeeded",
    amountIdr: o.refundIdr,
  }).then(
    () => null,
    (error: unknown) => error,
  );

/** R (no ref) is declined by the provider: lookup answer + the retry route. */
async function failNoRef(o: Own) {
  fake.setStatus(`refund:${o.refundId}`, {
    status: "failed",
    providerRef: `PR-DECLINED-${unique()}`,
    code: "declined",
  });
  return retryRefund(o.refundId);
}

const failOwnRefund = (o: Own) => (o.ref ? failWithRef(o) : failNoRef(o));

/** R must be failed; if a racing step did not fail it, fail it again (idempotent). */
async function ensureRFailed(o: Own) {
  if ((await refundRow(o.refundId)).status !== "failed") await failOwnRefund(o);
  expect((await refundRow(o.refundId)).status, "R failed").toBe("failed");
}

const pollAs = (at: Date) =>
  pollPendingGatewayIntents(tenantContext(), at, 100).catch(() => null);
/** The poller, soon and much later, twice: a schedule window hides nothing. */
async function pollRounds() {
  for (let round = 0; round < 2; round += 1) {
    await pollAs(new Date(Date.now() + 2 * MINUTE));
    await pollAs(new Date(Date.now() + 3 * 60 * MINUTE));
    await pollAs(new Date(Date.now() + 400 * 24 * 60 * MINUTE));
  }
}

/** The report is delivered again, the poller and the worker run. */
async function replay(report: () => object, rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    await receive(report());
    await pollRounds();
    await runWorker();
  }
}

/** One try at a new refund; a wrongly accepted one is approved to show its payout. */
async function tryNewRefund(o: Own, amountIdr: number) {
  const attempt = await manualRefund(o.code.id, amountIdr);
  let probe = "";
  if (attempt.status === 201) {
    const newId = attempt.body.data.id as string;
    const approved = await approveRefund(newId);
    probe = ` | probe: approve -> HTTP ${approved.status}, refund ${(await refundRow(newId)).status}, gateway calls +${fake.calls.length - o.callsBefore}`;
  }
  return { attempt, probe };
}

/** New refunds are refused (409 / 422) and nothing is sent to the guest. */
async function expectNewRefundsRefused(
  o: Own,
  why: string,
  amounts: number[] = [BILL_IDR, 1_000],
) {
  for (const amount of amounts) {
    const { attempt, probe } = await tryNewRefund(o, amount);
    expect(
      [409, 422],
      `${why}: new refund of ${amount}: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}${probe}`,
    ).toContain(attempt.status);
  }
  expect(fake.calls, `${why}: no payout to the guest`).toHaveLength(
    o.callsBefore,
  );
}

/** Between the steps the provider's refund is either held or already recorded. */
async function expectHeldOrRecorded(o: Own, why: string, amountIdr: number) {
  const holds = await allOpenHolds(o.code.id);
  const recorded = await factTotal(o.code.id);
  expect(
    holds > 0 || recorded >= amountIdr,
    `${why}: the provider's refund is neither held nor recorded (open holds ${holds}, recorded ${recorded})`,
  ).toBe(true);
}

/** End state: the provider's refund is ONE fact of the real amount, ONE journal event, intent blocked. */
async function expectRecordedOnceAndBlocked(o: Own, why: string) {
  expect(
    await factAmounts(o.code.id),
    `${why}: ONE fact, the real amount`,
  ).toEqual([BILL_IDR]);
  expect(
    await refundEventsOfIntent(o.code.id),
    `${why}: ONE journal event`,
  ).toBe(1);
  const blocked = await manualRefund(o.code.id, BILL_IDR);
  expect(blocked.status, `${why}: ${JSON.stringify(blocked.body)}`).toBe(409);
  expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
  expect(fake.calls, `${why}: no second payout`).toHaveLength(o.callsBefore);
}

// ---------------------------------------------------------------------------
// M1: report x our refund x a new refund
// ---------------------------------------------------------------------------

describe("M1 race matrix: provider report x our refund x new refund", () => {
  it("M1-01 the full `refunded` status arrives while R is live with a ref, R fails, a new refund is tried, the report is replayed: refused each time, one fact, money out <= paid", async () => {
    const L = "M1-01";
    const o = await liveWithRef();
    providerRefundsBill(o);
    await receive(statusReport(o));
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "report received, R live",
    );

    expect(await failWithRef(o), "R fails").toBeNull();
    expect((await refundRow(o.refundId)).status).toBe("failed");
    await expectHeldOrRecorded(o, "R failed, before the replay", BILL_IDR);
    await expectNewRefundsRefused(o, "R failed, before the replay");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "new refund tried before replay",
    );

    await replay(() => statusReport(o));
    await expectNewRefundsRefused(o, "after the replay");
    await expectRecordedOnceAndBlocked(o, "after the replay");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "after replay and new refund",
    );
  });

  it("M1-02 the full `refunded` status arrives while R is live, R COMPLETES (the status is the echo of our payout), replay, a new refund is tried: refused, no second payout, money out <= paid", async () => {
    const L = "M1-02";
    const o = await liveWithRef();
    providerRefundsBill(o);
    await receive(statusReport(o));

    expect(await completeWithRef(o), "R completes").toBeNull();
    expect((await refundRow(o.refundId)).status).toBe("completed");
    await replay(() => statusReport(o));

    expect(
      await completedPayouts(o.code.id),
      "our payout is the money out",
    ).toBe(BILL_IDR);
    await expectNewRefundsRefused(o, "R completed, provider reported refunded");
    // The provider's refunded status is the echo of OUR payout: one movement.
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      0,
      "R completed, replay, new refund tried",
    );
  });

  it("M1-03 the report arrives while R is in flight WITHOUT a ref, R fails BEFORE the worker, a new refund is tried, then the worker replays: refused each time, one fact, money out <= paid", async () => {
    const L = "M1-03";
    const o = await triedNoRef();
    providerRefundsBill(o);
    await receive(statusReport(o));
    await expectNewRefundsRefused(o, "R live, report received (retry)");

    const failed = await failNoRef(o);
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect((await refundRow(o.refundId)).status, "R failed").toBe("failed");
    // The window: the worker has not replayed the event yet.
    await expectHeldOrRecorded(o, "R failed, before the worker", BILL_IDR);
    await expectNewRefundsRefused(o, "R failed, before the worker replays");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "new refund tried before the worker",
    );

    await runWorker();
    await runWorker();
    await expectNewRefundsRefused(o, "after the worker replay");
    await replay(() => statusReport(o), 1);
    await expectRecordedOnceAndBlocked(o, "after the worker replay");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "after the worker replay",
    );
  });

  it("M1-04 no webhook at all: the provider refunded the bill, R fails, a new refund is tried BEFORE the poller (refused), the poller runs, a new refund is tried again (refused): one fact, money out <= paid", async () => {
    const L = "M1-04";
    const o = await liveWithRef();
    providerRefundsBill(o);
    expect(await failWithRef(o), "R fails").toBeNull();
    expect((await refundRow(o.refundId)).status).toBe("failed");

    await expectHeldOrRecorded(o, "R failed, before the poller", BILL_IDR);
    await expectNewRefundsRefused(o, "R failed, before the poller");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "new refund tried before the poller",
    );

    await pollRounds();
    await runWorker();
    await pollRounds();
    await expectNewRefundsRefused(o, "after the poller");
    await expectRecordedOnceAndBlocked(o, "after the poller");
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      BILL_IDR,
      "after poller and new refund",
    );
  });

  describe("M1-05 the webhook and the poller at the same time while R is live", () => {
    const together = (o: Own) =>
      Promise.all([receive(statusReport(o)), pollRounds()]);

    it.each([
      [
        "M1-05a the report (webhook + poller together) first, then R fails",
        "report-first",
      ],
      [
        "M1-05b R fails first, then the report (webhook + poller together)",
        "fail-first",
      ],
      ["M1-05c all three at once", "all-at-once"],
    ] as const)(
      "%s: never lost, never twice, refused, money out <= paid",
      async (title, order) => {
        const L = title.slice(0, 6);
        const o = await liveWithRef();
        providerRefundsBill(o);

        if (order === "report-first") {
          await together(o);
          await failWithRef(o);
        } else if (order === "fail-first") {
          await failWithRef(o);
          await together(o);
        } else {
          await Promise.all([together(o), failWithRef(o)]);
        }
        await ensureRFailed(o);

        await expectHeldOrRecorded(o, `${order}: R failed`, BILL_IDR);
        await expectNewRefundsRefused(o, `${order}: R failed`);
        await expectMoneyOutWithinPaid(
          L,
          o.code.id,
          BILL_IDR,
          `${order}: after R failed`,
        );

        await replay(() => statusReport(o));
        await expectNewRefundsRefused(o, `${order}: after the replay`);
        await expectRecordedOnceAndBlocked(o, `${order}: after the replay`);
        await expectMoneyOutWithinPaid(
          L,
          o.code.id,
          BILL_IDR,
          `${order}: after replay`,
        );
      },
    );
  });

  it("M1-06 the provider reports its own refund id of Rp40.000 while R (Rp100.000) is live, R fails: a new refund of Rp100.000 is refused, one of Rp60.000 never lets money out exceed paid", async () => {
    const L = "M1-06";
    const PARTIAL = 40_000;
    const o = await liveWithRef(BILL_IDR);
    const report = idReport(o, PARTIAL);
    await receive(report);
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      PARTIAL,
      "report received, R live",
      true,
    );

    expect(await failWithRef(o), "R fails").toBeNull();
    expect((await refundRow(o.refundId)).status).toBe("failed");
    await expectHeldOrRecorded(o, "R failed, before the replay", PARTIAL);

    // Rp100.000 can never be refunded: the provider already gave Rp40.000 back.
    const whole = await tryNewRefund(o, BILL_IDR);
    expect(
      [409, 422],
      `Rp100.000 after a provider refund of ${PARTIAL}: HTTP ${whole.attempt.status} ${JSON.stringify(whole.attempt.body)}${whole.probe}`,
    ).toContain(whole.attempt.status);
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      PARTIAL,
      "Rp100.000 tried before the replay",
    );

    // Rp60.000 is the real remainder: accepted or refused, never over the paid amount.
    const rest = await tryNewRefund(o, 60_000);
    ledger.set(
      `${L} (Rp60.000 sebelum replay)`,
      `HTTP ${rest.attempt.status}${rest.probe}`,
    );
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      PARTIAL,
      "Rp60.000 tried before the replay",
    );

    await replay(() => report, 2);
    expect(
      await factTotal(o.code.id),
      "the provider's partial refund is recorded as at most Rp40.000",
    ).toBeLessThanOrEqual(PARTIAL);
    const wholeAgain = await tryNewRefund(o, BILL_IDR);
    expect(
      [409, 422],
      `Rp100.000 after the replay: HTTP ${wholeAgain.attempt.status} ${JSON.stringify(wholeAgain.attempt.body)}${wholeAgain.probe}`,
    ).toContain(wholeAgain.attempt.status);
    await tryNewRefund(o, 60_000);
    await expectMoneyOutWithinPaid(
      L,
      o.code.id,
      PARTIAL,
      "Rp100.000 and Rp60.000 tried after the replay",
    );
  });

  describe("M1-07 two events (two ids) and R's failure race with the worker's replay", () => {
    it.each([
      ["M1-07a events and worker first, R's failure last in the list", false],
      ["M1-07b R's failure and worker first, events last in the list", true],
    ] as const)(
      "%s: never lost, never twice, refused, money out <= paid",
      async (title, failureFirst) => {
        const L = title.slice(0, 6);
        const o = await triedNoRef();
        providerRefundsBill(o);
        const first = statusReport(o);
        const second = statusReport(o);

        if (failureFirst)
          await Promise.all([
            failNoRef(o),
            runWorker(),
            deliver(first),
            deliver(second),
          ]);
        else
          await Promise.all([
            deliver(first),
            deliver(second),
            runWorker(),
            failNoRef(o),
          ]);
        await ensureRFailed(o);

        await expectHeldOrRecorded(o, "after the race", BILL_IDR);
        expect(
          await factTotal(o.code.id),
          "two event ids never make two facts",
        ).toBeLessThanOrEqual(BILL_IDR);
        await expectNewRefundsRefused(o, "after the race");
        await expectMoneyOutWithinPaid(
          L,
          o.code.id,
          BILL_IDR,
          "after the race",
        );

        await replay(() => statusReport(o));
        await runWorker();
        await expectNewRefundsRefused(o, "after the replays");
        await expectRecordedOnceAndBlocked(o, "after the replays");
        await expectMoneyOutWithinPaid(L, o.code.id, BILL_IDR, "after replays");
      },
    );
  });

  it("M1-08 control, no refund of ours: the provider refunds Rp100.000 (webhook), a new refund is tried: refused (PROVIDER_REFUNDED), one fact, no payout, money out <= paid", async () => {
    const L = "M1-08";
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const o: Own = {
      code,
      refundId: "",
      refundIdr: 0,
      ref: null,
      callsBefore: fake.calls.length,
    };
    providerRefundsBill(o);
    await receive(statusReport(o));
    await runWorker();

    await expectNewRefundsRefused(o, "provider refunded, no refund of ours");
    await replay(() => statusReport(o));
    await expectNewRefundsRefused(o, "after replays");
    await expectRecordedOnceAndBlocked(o, "control");
    expect(await completedPayouts(code.id), "we paid nothing").toBe(0);
    await expectMoneyOutWithinPaid(L, code.id, BILL_IDR, "control");
  });
});
