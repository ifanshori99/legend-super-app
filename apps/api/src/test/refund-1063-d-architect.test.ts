// (brief 1063, architect round, tier K "jangan sampai rugi"): tests written from
// docs/briefs/1063-shared-context.md section "Putaran architect", with the
// 1063-a / 1063-c fixtures as the pattern, not from the implementation. All must
// pass on the fixed code.
//
// Cases:
//  - P2-1: two ANONYMOUS holds (no refund id) Ha Rp10.000 and Hb Rp20.000 on a
//    bill that already carries provider facts P1 Rp10.000 and P2 Rp20.000;
//    resolved `same_as_counted` in both orders: facts stay Rp30.000, no extra
//    journal event, each hold is bound to a different fact (matched_fact_id).
//  - P2-2: our refund R Rp50.000 (ref X) of T1; the report X/T1 Rp100.000 is NOT
//    an echo (hold HOLD_TRANSACTION_CONFLICT, no fact). Controls: X/T1 Rp50.000
//    and X/T1 Rp30.000 are plain echoes.
//  - F1 gaps: R `approved` (pending at the provider) with ref X + report X/T2;
//    intent-level refund of T1 + report X/T2; X owned by our refund of ANOTHER
//    intent + report X/T2; control: fund refund whose evidence is T2 + report
//    X/T2 is an echo.
//  - Legacy control: a `same_as_counted` hold stored before matched_fact_id
//    existed (NULL) still counts as matched in unmatchedAnonymousFacts.
//
// Assumptions (the brief does not fix them):
//  - Control "fund refund with evidence T1": a fund whose evidence is T1 cannot be
//    created (409 "Payment evidence cannot represent this unallocated amount"),
//    so the control uses a fund refund of its own evidence T2 + report X/T2.
//  - "approved with ref X" = FakeRefundGateway answers `pending` on approve, so
//    the refund row stays in flight (not completed/failed) with provider_ref X.
//  - In P2-1 our refunds R1/R2 fail first (Ha, Hb), then the signed reports P1/P2
//    book the facts (a provider fact would block new refunds of the bill, 409
//    PROVIDER_REFUNDED). No anonymous fact exists, so the reports are booked.
//  - P2-1 binding is read from refund_recon_holds.matched_fact_id (named in the
//    brief): both holds carry a non-null, different value.
//  - Legacy control: a hold closed `same_as_counted` is made "old" by setting its
//    matched_fact_id to NULL; observable effect = the next report with a new id
//    for the same transaction is booked directly (nothing unmatched is left, so
//    it is not held), as before the binding existed.
//  - A conflict hold is recognised by the text HOLD_TRANSACTION_CONFLICT
//    (case-insensitive), with provider_refund_id X and the reported
//    provider_payment_ref.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-d-architect.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1063d-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1063d-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1063d owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1063d approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1063d supervisor");
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
      reference: `R1063D-${unique()}`,
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
const ownFailedHolds = async (intentId: string) =>
  (await allHolds(intentId)).filter(
    (hold) => hold.reason === OWN_FAILED_REASON,
  );
const openOf = async (intentId: string) =>
  (await allHolds(intentId)).filter((hold) => hold.resolved_at === null);

type Identity = "same_as_counted" | "separate";

const resolveHold = (
  holdId: string,
  resolution: "counted_against_intent" | "not_this_intent",
  providerRefundId?: string,
  identity?: Identity,
) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution,
      note: "Dicek di dashboard provider.",
      ...(providerRefundId === undefined ? {} : { providerRefundId }),
      ...(identity === undefined ? {} : { identity }),
    });

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

/** Rounds of everything that replays: delivery, poller, worker. */
async function replayAll(body: () => object, rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    await deliver(body());
    await pollLater().catch(() => null);
    await runWorker();
  }
}

// ---------------------------------------------------------------------------
// Building blocks for 1063-c
// ---------------------------------------------------------------------------

const R1_IDR = 10_000;
const R2_IDR = 20_000;
const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;
const reportP = (code: Code, providerRefundId: string, amount: number) =>
  replayAll(() => refundIdEvent(code.providerRef, providerRefundId, amount));

/** Our refund R is SENT, times out (no ref), then DECLINED with no ref: one anonymous own-failed hold. */
async function declineWithoutRef(
  code: Code,
  amountIdr: number,
): Promise<string> {
  const known = new Set((await ownFailedHolds(code.id)).map((row) => row.id));
  const filed = await manualRefund(code.id, amountIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(
    (await refundRow(refundId)).provider_ref,
    "premise: no ref",
  ).toBeNull();
  fake.setStatus(`refund:${refundId}`, {
    status: "failed",
    providerRef: null,
    code: "declined",
  });
  const retried = await retryRefund(refundId);
  expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  expect((await refundRow(refundId)).status, "premise: R failed").toBe(
    "failed",
  );
  const fresh = (await ownFailedHolds(code.id)).filter(
    (row) => !known.has(row.id),
  );
  expect(fresh, "premise: the failed refund filed one new hold").toHaveLength(
    1,
  );
  expect(fresh[0]!.provider_refund_id, "premise: hold is anonymous").toBeNull();
  return fresh[0]!.id;
}

const sameAsCounted = (holdId: string) =>
  resolveHold(holdId, "counted_against_intent", undefined, "same_as_counted");

// ---------------------------------------------------------------------------
// Building blocks for 1063-d
// ---------------------------------------------------------------------------

const CONFLICT = /HOLD_TRANSACTION_CONFLICT/i;
const conflictHolds = async (intentId: string) =>
  (await openOf(intentId)).filter((row) => CONFLICT.test(row.reason));

async function expectMoneyWithinPaid(code: Code, label: string) {
  const facts = await factTotal(code.id);
  const out = (await ourRefundedIdr(code.id)) + facts;
  expect(
    out,
    `${label}: our refunds not failed + provider facts (${out}) exceed what was paid (${BILL_IDR})`,
  ).toBeLessThanOrEqual(BILL_IDR);
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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

async function fundStamp(fundId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_at AS stamp FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [tenantId, fundId],
  );
  return rows[0]!.stamp;
}

const factsOfRef = async (intentId: string, ref: string) =>
  (await providerRows(intentId)).filter(
    (row) => row.provider_payment_ref === ref,
  );

/** Our refund of `amountIdr` filed and approved at the intent level. */
async function ownIntentRefund(
  code: Code,
  amountIdr: number,
  outcome: "completed" | "in_flight",
): Promise<{ refundId: string; x: string }> {
  if (outcome === "in_flight") fake.enqueue("pending");
  const filed = await manualRefund(code.id, amountIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  if (outcome === "completed")
    expect(row.status, "premise: our refund completed").toBe("completed");
  else
    expect(
      ["completed", "failed"],
      "premise: our refund is still in flight (approved)",
    ).not.toContain(row.status);
  expect(row.provider_ref, "premise: our refund carries ref X").toBeTruthy();
  return { refundId, x: row.provider_ref! };
}

/** The signed report is accepted and replays (poller, worker) are done. */
async function report(body: () => object) {
  const answered = await deliver(body());
  expect(answered.status, "signed report not rejected").not.toBe(401);
  await pollLater().catch(() => null);
  await runWorker();
}

/** A conflict hold for X on `ref`: exactly one, no fact, no stamp, replays add nothing. */
async function expectConflictOnly(
  code: Code,
  x: string,
  ref: string,
  label: string,
  fundId?: string,
) {
  const factsBefore = await providerRows(code.id);
  const eventsBefore = await refundEventsOfIntent(code.id);
  await replayAll(() => refundIdEvent(ref, x, BILL_IDR), 2);
  const conflicts = (await conflictHolds(code.id)).filter(
    (row) => row.provider_refund_id === x && row.provider_payment_ref === ref,
  );
  expect
    .soft(
      conflicts,
      `${label}: one open conflict hold for X on ${ref} (holds: ${JSON.stringify(await allHolds(code.id))})`,
    )
    .toHaveLength(1);
  expect
    .soft(await factsOfRef(code.id, ref), `${label}: no fact on ${ref}`)
    .toEqual([]);
  expect
    .soft(await providerRows(code.id), `${label}: replays add no fact`)
    .toEqual(factsBefore);
  expect
    .soft(await refundEventsOfIntent(code.id), `${label}: no journal event`)
    .toBe(eventsBefore);
  if (fundId !== undefined)
    expect
      .soft(await fundStamp(fundId), `${label}: fund not stamped`)
      .toBeNull();
}

async function matchedFactIdOf(holdId: string): Promise<string | null> {
  const { rows } = await owner.query<{ id: string | null }>(
    "SELECT matched_fact_id::text AS id FROM refund_recon_holds WHERE tenant_id = $1 AND id = $2",
    [tenantId, holdId],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// P2-1: two anonymous holds, two provider facts with ids
// ---------------------------------------------------------------------------

/**
 * Bill Rp100.000 paid. R1 (10.000) and R2 (20.000) of ours fail with no ref:
 * two anonymous holds Ha and Hb. Then the provider reports P1 (10.000) and P2
 * (20.000) with ids: two facts.
 */
async function factsThenAnonymousHolds() {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  // Our refunds fail first (an open hold or a provider fact blocks new refunds
  // of the bill, 409 PROVIDER_REFUNDED): both are sent before either fails.
  const sent: string[] = [];
  for (const amountIdr of [R1_IDR, R2_IDR]) {
    const filed = await manualRefund(code.id, amountIdr);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    sent.push(filed.body.data.id as string);
  }
  for (const refundId of sent) {
    fake.enqueue("throw");
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await refundRow(refundId)).provider_ref,
      "premise: no ref",
    ).toBeNull();
  }
  for (const refundId of sent) {
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: null,
      code: "declined",
    });
    const retried = await retryRefund(refundId);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await refundRow(refundId)).status, "premise: R failed").toBe(
      "failed",
    );
  }
  const anonymous = await ownFailedHolds(code.id);
  expect(anonymous, "premise: two anonymous own-failed holds").toHaveLength(2);
  expect(anonymous.every((row) => row.provider_refund_id === null)).toBe(true);
  const ha = anonymous.find((row) => row.amount_idr === R1_IDR)!.id;
  const hb = anonymous.find((row) => row.amount_idr === R2_IDR)!.id;
  await reportP(code, newRefundId(), R1_IDR);
  await reportP(code, newRefundId(), R2_IDR);
  expect(
    (await factAmounts(code.id)).sort((a, b) => a - b),
    "premise: provider facts P1 10k and P2 20k",
  ).toEqual([R1_IDR, R2_IDR]);
  expect(
    await refundEventsOfIntent(code.id),
    "premise: two journal events",
  ).toBe(2);
  return { code, ha, hb };
}

async function expectBoundToDifferentFacts(
  a: string,
  b: string,
  label: string,
) {
  const first = await matchedFactIdOf(a);
  const second = await matchedFactIdOf(b);
  expect.soft(first, `${label}: first hold is bound to a fact`).not.toBeNull();
  expect
    .soft(second, `${label}: second hold is bound to a fact`)
    .not.toBeNull();
  expect
    .soft(first, `${label}: the two holds are bound to different facts`)
    .not.toBe(second);
}

describe("P2-1 two anonymous holds resolved same_as_counted bind two different facts", () => {
  it("1063-d-P2-1-01 Ha (10k) then Hb (20k) same_as_counted: facts stay Rp30.000, no journal event added, net balance Rp70.000, different bound facts", async () => {
    const t = await factsThenAnonymousHolds();
    const first = await sameAsCounted(t.ha);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await sameAsCounted(t.hb);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    expect
      .soft((await factAmounts(t.code.id)).sort((a, b) => a - b))
      .toEqual([R1_IDR, R2_IDR]);
    expect.soft(await refundEventsOfIntent(t.code.id)).toBe(2);
    expect.soft(await factTotal(t.code.id)).toBe(R1_IDR + R2_IDR);
    expect
      .soft(
        BILL_IDR -
          (await ourRefundedIdr(t.code.id)) -
          (await factTotal(t.code.id)),
      )
      .toBe(BILL_IDR - R1_IDR - R2_IDR);
    expect.soft((await openOf(t.code.id)).length, "nothing waits").toBe(0);
    await expectBoundToDifferentFacts(t.ha, t.hb, "P2-1-01");
    await expectMoneyWithinPaid(t.code, "P2-1-01");
  });

  it("1063-d-P2-1-02 reverse order: Hb (20k) then Ha (10k) same_as_counted: facts stay Rp30.000, no journal event added, different bound facts; replays add nothing", async () => {
    const t = await factsThenAnonymousHolds();
    const first = await sameAsCounted(t.hb);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await sameAsCounted(t.ha);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    // A second resolve of each is not a server error and books nothing.
    const again = [await sameAsCounted(t.ha), await sameAsCounted(t.hb)];
    expect(
      again.every((response) => response.status < 500),
      JSON.stringify(again.map((response) => response.body)),
    ).toBe(true);

    expect
      .soft((await factAmounts(t.code.id)).sort((a, b) => a - b))
      .toEqual([R1_IDR, R2_IDR]);
    expect.soft(await refundEventsOfIntent(t.code.id)).toBe(2);
    expect.soft(await factTotal(t.code.id)).toBe(R1_IDR + R2_IDR);
    await expectBoundToDifferentFacts(t.ha, t.hb, "P2-1-02");
    await expectMoneyWithinPaid(t.code, "P2-1-02");
  });
});

// ---------------------------------------------------------------------------
// P2-2: the echo of our own refund is bounded by what we sent
// ---------------------------------------------------------------------------

const OWN_BIG_IDR = 50_000;

describe("P2-2 a report under our refund id is an echo only up to the amount we sent", () => {
  it("1063-d-P2-2-01 our refund R Rp50.000 (ref X) of T1, report X/T1 Rp100.000: held as HOLD_TRANSACTION_CONFLICT, no fact, replays add nothing", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const own = await ownIntentRefund(code, OWN_BIG_IDR, "completed");
    const callsBefore = fake.calls.length;

    await report(() => refundIdEvent(code.providerRef, own.x, BILL_IDR));
    await expectConflictOnly(code, own.x, code.providerRef, "P2-2-01");
    expect((await refundRow(own.refundId)).status).toBe("completed");
    expect(fake.calls, "nothing sent").toHaveLength(callsBefore);
  });

  it("1063-d-P2-2-02 control: report X/T1 of exactly Rp50.000 is a plain echo: no hold, no fact, no event, replays add nothing", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const own = await ownIntentRefund(code, OWN_BIG_IDR, "completed");
    const holdsBefore = (await allHolds(code.id)).length;
    const eventsBefore = await refundEventsOfIntent(code.id);

    await replayAll(
      () => refundIdEvent(code.providerRef, own.x, OWN_BIG_IDR),
      2,
    );
    expect(
      await allHolds(code.id),
      `no hold for a plain echo (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(holdsBefore);
    expect(await providerRows(code.id), "no fact").toEqual([]);
    expect(await refundEventsOfIntent(code.id), "no event").toBe(eventsBefore);
    await expectMoneyWithinPaid(code, "P2-2-02");
  });

  it("1063-d-P2-2-03 control: report X/T1 of Rp30.000 (less than we sent) is still an echo: no hold, no fact, no event", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const own = await ownIntentRefund(code, OWN_BIG_IDR, "completed");
    const holdsBefore = (await allHolds(code.id)).length;
    const eventsBefore = await refundEventsOfIntent(code.id);

    await replayAll(() => refundIdEvent(code.providerRef, own.x, 30_000), 2);
    expect(
      await allHolds(code.id),
      `no hold (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(holdsBefore);
    expect(await providerRows(code.id), "no fact").toEqual([]);
    expect(await refundEventsOfIntent(code.id), "no event").toBe(eventsBefore);
    await expectMoneyWithinPaid(code, "P2-2-03");
  });
});

// ---------------------------------------------------------------------------
// F1 gaps: our refund id X reported for another transaction or intent
// ---------------------------------------------------------------------------

describe("F1 gaps: X known as our refund id but reported for T2", () => {
  it("1063-d-F1-gap-01 our refund R is approved (in flight, not completed) with ref X; report X/T2: conflict hold, no fact, no stamp for T2", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
    const own = await ownIntentRefund(code, 30_000, "in_flight");

    await report(() => refundIdEvent(extra.providerRef, own.x, BILL_IDR));
    await expectConflictOnly(code, own.x, extra.providerRef, "gap-01", fundId);
    await expectMoneyWithinPaid(code, "gap-01");
  });

  it("1063-d-F1-gap-02 intent-level refund (not a fund refund) of T1 completed with ref X; report X/T2: conflict hold, no fact, no stamp for T2", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
    const own = await ownIntentRefund(code, 30_000, "completed");
    const { rows } = await owner.query<{ fund: string | null }>(
      "SELECT unallocated_fund_id::text AS fund FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
      [tenantId, own.refundId],
    );
    expect(
      rows[0]!.fund,
      "premise: an intent-level refund, no fund",
    ).toBeNull();

    await report(() => refundIdEvent(extra.providerRef, own.x, BILL_IDR));
    await expectConflictOnly(code, own.x, extra.providerRef, "gap-02", fundId);
    await expectMoneyWithinPaid(code, "gap-02");
  });

  it("1063-d-F1-gap-03 X is the ref of our refund in ANOTHER intent J; the report X/T2 in this intent I: conflict hold in I, no fact, no stamp for T2", async () => {
    const other = await newCode(BILL_IDR);
    expect((await paid(other, BILL_IDR)).status).toBe(200);
    const own = await ownIntentRefund(other, 30_000, "completed");

    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
    const otherHoldsBefore = (await allHolds(other.id)).length;

    await report(() => refundIdEvent(extra.providerRef, own.x, BILL_IDR));
    await expectConflictOnly(code, own.x, extra.providerRef, "gap-03", fundId);
    expect
      .soft((await allHolds(other.id)).length, "the other intent gets no hold")
      .toBe(otherHoldsBefore);
    expect((await refundRow(own.refundId)).status).toBe("completed");
  });

  it("1063-d-F1-gap-04 control: a FUND refund whose evidence is T2, completed with ref X; report X/T2 is an echo: no hold, no fact, no event", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
    const filed = await resolveFund(fundId, "refund");
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    const refundId = rows[0]!.id;
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await refundRow(refundId);
    expect(row.status, "premise: fund refund completed").toBe("completed");
    expect(row.provider_ref, "premise: ref X").toBeTruthy();
    const holdsBefore = (await allHolds(code.id)).length;
    const eventsBefore = await refundEventsOfIntent(code.id);

    await replayAll(
      () => refundIdEvent(extra.providerRef, row.provider_ref!, BILL_IDR),
      2,
    );
    expect(
      await allHolds(code.id),
      `no hold for the echo (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(holdsBefore);
    expect(await providerRows(code.id), "no fact").toEqual([]);
    expect(await refundEventsOfIntent(code.id), "no event").toBe(eventsBefore);
  });
});

// ---------------------------------------------------------------------------
// Legacy control
// ---------------------------------------------------------------------------

describe("legacy same_as_counted holds without matched_fact_id", () => {
  it("1063-d-legacy-01 a hold closed same_as_counted before the binding existed (matched_fact_id NULL) still counts as matched: the anonymous fact is not unmatched, a report with a new id is booked at once (not held)", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const h1 = await declineWithoutRef(code, R1_IDR);
    const counted = await resolveHold(h1, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(await factAmounts(code.id), "premise: anonymous fact").toEqual([
      R1_IDR,
    ]);

    const p1 = newRefundId();
    await reportP(code, p1, R1_IDR);
    const hold = (await openOf(code.id)).find(
      (row) => row.provider_refund_id === p1,
    );
    expect(
      hold,
      `premise: the report waits as a hold (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();
    const same = await sameAsCounted(hold!.id);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(await factAmounts(code.id), "same_as_counted: no new fact").toEqual([
      R1_IDR,
    ]);

    // Make the hold an "old" one: closed same_as_counted, no stored binding.
    await owner.query(
      "UPDATE refund_recon_holds SET matched_fact_id = NULL WHERE tenant_id = $1 AND id = $2",
      [tenantId, hold!.id],
    );

    const p2 = newRefundId();
    await reportP(code, p2, R2_IDR);
    expect(
      (await openOf(code.id)).filter((row) => row.provider_refund_id === p2),
      `the anonymous fact is already matched by the old hold: P2 is not held (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(0);
    expect(
      (await providerRows(code.id)).filter(
        (row) => row.provider_refund_id === p2,
      ),
      "P2 is booked once as its own refund",
    ).toHaveLength(1);
    expect(await factTotal(code.id)).toBe(R1_IDR + R2_IDR);
    await expectMoneyWithinPaid(code, "legacy-01");
  });
});
