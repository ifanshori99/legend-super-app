// (brief 1063, F1 legend-9dh7x, tier K "jangan sampai rugi"): red-first tests,
// written from docs/briefs/1063-shared-context.md and the second-opinion finding
// F1 (docs/qa/second-opinion-refund-ronde5-1062.md), with the 1055-a fixtures as
// the pattern, not from the implementation.
//
// Scenario: one intent with T1 (paid, the bill) and T2 (evidence of a second
// payment of the same bill, parked as an unallocated fund). OUR refund R of T1
// completed (payment_refunds completed + approved) and carries provider ref X.
// The provider then sends a signed `payment.refunded` report with refund id X
// but for T2 (Rp100.000). X is a known id of ANOTHER transaction: that is a
// conflict, never an echo of our own refund.
//
// Assumptions (the brief does not fix them):
//  - "fact T1 unchanged" = the rows of payment_provider_refunds of the intent are
//    identical before and after (our own refund is not a provider fact).
//  - "no stamp for T2" = payment_unallocated_funds.provider_refunded_at of T2's
//    fund stays NULL.
//  - The conflict hold's reason is matched by the text HOLD_TRANSACTION_CONFLICT
//    (case-insensitive); its provider_refund_id is X and its provider_payment_ref
//    is T2's ref (as in refund-1055-a G2-04). Its alert is counted on the
//    supervisor's notifications: rises on the first report, stays on replays.
//  - "fund T2 request/approve/payout rejected (409)": resolving the fund with
//    `refund` is either refused 409 right away, or (if the request is filed) the
//    approve call is refused 409; in both cases the refund gateway is not called.
//  - Error codes are read from body.error.code only where asserted.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-a-own-echo-conflict.test.ts" heavy pnpm test

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
const ADMIN = "/api/payments/admin";
const BILL_IDR = 100_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1063a-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1063a-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1063a owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1063a approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1063a supervisor");
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
      reference: `R1063A-${unique()}`,
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
type HoldRow = {
  id: string;
  reason: string;
  amount_idr: number;
  provider_refund_id: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  provider_payment_ref: string | null;
  provider_refund_id_kind: string | null;
};

async function allHolds(intentId: string): Promise<HoldRow[]> {
  const { rows } = await owner.query<
    Omit<HoldRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, reason, amount_idr::text AS amount_idr, provider_refund_id, resolved_at, resolution,
           provider_payment_ref, provider_refund_id_kind
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY flagged_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

const openOf = async (intentId: string) =>
  (await allHolds(intentId)).filter((hold) => hold.resolved_at === null);

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

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

async function expectMoneyWithinPaid(code: Code, label: string) {
  const facts = await factTotal(code.id);
  const out = (await ourRefundedIdr(code.id)) + facts;
  expect(
    out,
    `${label}: our refunds not failed + provider facts (${out}) exceed what was paid (${BILL_IDR})`,
  ).toBeLessThanOrEqual(BILL_IDR);
}

// ---------------------------------------------------------------------------
// F1: our own refund X of T1 must not hide a report X/T2
// ---------------------------------------------------------------------------

const R_IDR = 30_000;
const CONFLICT = /HOLD_TRANSACTION_CONFLICT/i;

type Own = {
  code: Code;
  extra: Extra;
  fundId: string;
  refundId: string;
  x: string;
};

/**
 * Intent I: T1 (Rp100.000 paid) and T2 (Rp100.000 evidence, parked as a fund).
 * Our refund R (Rp30.000, T1) is filed, approved and completed: the provider
 * answered with ref X, so payment_refunds holds a completed, approved row.
 */
async function ownCompletedRefund(): Promise<Own> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const { extra, fundId } = await addParkedExtra(code, BILL_IDR);

  const filed = await manualRefund(code.id, R_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.status, "premise: our refund R completed").toBe("completed");
  expect(
    row.provider_ref,
    "premise: R carries the provider ref X",
  ).toBeTruthy();
  return { code, extra, fundId, refundId, x: row.provider_ref! };
}

async function fundStamp(fundId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_at AS stamp FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [tenantId, fundId],
  );
  return rows[0]!.stamp;
}

const conflictHolds = async (intentId: string) =>
  (await openOf(intentId)).filter((row) => CONFLICT.test(row.reason));

describe("F1 (P1) our own refund X of T1 is not an echo of a report X/T2", () => {
  it("1063-a-F1-01 our refund R of T1 completed with ref X; the signed report X/T2 (Rp100.000) files a HOLD_TRANSACTION_CONFLICT hold (id X, transaction T2, one alert), books no fact and no stamp for T2, T1's rows stay unchanged, replays add nothing; T2's fund is refused 409 and nothing is sent to the guest", async () => {
    const t = await ownCompletedRefund();
    const factsBefore = await providerRows(t.code.id);
    const eventsBefore = await refundEventsOfIntent(t.code.id);
    const callsBefore = fake.calls.length;
    const alertsBefore = (await supervisorAlertRows()).length;

    const answered = await deliver(
      refundIdEvent(t.extra.providerRef, t.x, BILL_IDR),
    );
    expect(answered.status, "signed report not rejected").not.toBe(401);
    await pollLater().catch(() => null);
    await runWorker();

    const conflicts = (await conflictHolds(t.code.id)).filter(
      (row) =>
        row.provider_refund_id === t.x &&
        row.provider_payment_ref === t.extra.providerRef,
    );
    expect
      .soft(
        conflicts,
        `one open conflict hold for X on T2 (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
      )
      .toHaveLength(1);
    expect
      .soft((await supervisorAlertRows()).length, "the conflict alerts")
      .toBeGreaterThan(alertsBefore);
    const alertsAfterFirst = (await supervisorAlertRows()).length;

    expect
      .soft(await providerRows(t.code.id), "T1's fact rows are unchanged")
      .toEqual(factsBefore);
    expect
      .soft(await factsOfRef(t.code.id, t.extra.providerRef), "no fact on T2")
      .toEqual([]);
    expect
      .soft(await fundStamp(t.fundId), "T2's fund is not stamped")
      .toBeNull();
    expect
      .soft(await refundEventsOfIntent(t.code.id), "no new journal event")
      .toBe(eventsBefore);
    expect
      .soft((await refundRow(t.refundId)).status, "R is untouched")
      .toBe("completed");

    // Replays (new event ids, poller, worker) add nothing.
    await replayAll(() => refundIdEvent(t.extra.providerRef, t.x, BILL_IDR), 2);
    expect
      .soft(
        await conflictHolds(t.code.id),
        "replays add no second hold and do not close the first",
      )
      .toHaveLength(1);
    expect
      .soft((await supervisorAlertRows()).length, "alerted once")
      .toBe(alertsAfterFirst);
    expect.soft(await providerRows(t.code.id)).toEqual(factsBefore);
    expect.soft(await fundStamp(t.fundId)).toBeNull();
    expect.soft(await refundEventsOfIntent(t.code.id)).toBe(eventsBefore);

    // T2's money is held until finance decides: request / approve / payout.
    const filed = await resolveFund(t.fundId, "refund");
    if (filed.status === 200) {
      const rows = await owner.query<{ id: string }>(
        "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
        [tenantId, t.fundId],
      );
      const approved = await approveRefund(rows.rows[0]!.id);
      expect(
        approved.status,
        `approving T2's fund refund: ${JSON.stringify(approved.body)}`,
      ).toBe(409);
    } else {
      expect(filed.status, JSON.stringify(filed.body)).toBe(409);
    }
    expect(fake.calls, "port.refund not called for T2").toHaveLength(
      callsBefore,
    );
    await expectMoneyWithinPaid(t.code, "F1-01");
  });

  it("1063-a-F1-02 control, a true echo: the report X/T1 (the transaction our refund R refunded) files no hold, books no fact, adds no event, replays add nothing", async () => {
    const t = await ownCompletedRefund();
    const factsBefore = await providerRows(t.code.id);
    const eventsBefore = await refundEventsOfIntent(t.code.id);
    const holdsBefore = (await allHolds(t.code.id)).length;
    const callsBefore = fake.calls.length;

    await replayAll(() => refundIdEvent(t.code.providerRef, t.x, R_IDR), 2);

    expect(
      await allHolds(t.code.id),
      `no hold for the echo of our own refund (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
    ).toHaveLength(holdsBefore);
    expect(await providerRows(t.code.id), "no fact").toEqual(factsBefore);
    expect(await refundEventsOfIntent(t.code.id), "no event").toBe(
      eventsBefore,
    );
    expect((await refundRow(t.refundId)).status).toBe("completed");
    expect(fake.calls, "nothing sent").toHaveLength(callsBefore);
    await expectMoneyWithinPaid(t.code, "F1-02");
  });
});
