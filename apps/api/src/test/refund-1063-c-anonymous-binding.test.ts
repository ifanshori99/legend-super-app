// (brief 1063, "SO refund ronde 5", finding F3 / legend-flj83, tier K "jangan
// sampai rugi"): red-first tests, written from docs/briefs/1063-shared-context.md,
// docs/qa/second-opinion-refund-ronde5-1062.md and the 1055-a fixtures, not from
// the implementation.
//
// F3: `same_as_counted` must bind to ONE anonymous fact and never reuse a fact
// that is already bound. Two anonymous facts (10.000 and 20.000) on one bill,
// then the provider reports P1 (10.000) and P2 (20.000) with ids; finance
// resolves both as `same_as_counted`. Nothing may be booked for them: total
// facts / journal events stay at the two anonymous ones (Rp30.000, 2 events)
// and the net balance stays Rp70.000. Today the second resolve picks the
// smallest anonymous fact (10.000) again and books a surplus.
//
// Assumptions (the brief does not fix them):
//  - R1/R2 "fails with no ref" = approve times out (approved, tried, no ref), then
//    the retry route's lookup answers `failed` with providerRef null (as 1055-a).
//  - H1 is counted without `identity` (no anonymous fact exists yet); H2 is
//    counted with identity `separate` (an unbound anonymous fact exists, so the
//    1055 rule demands identity; the brief says "identity separate").
//  - A provider report with an id while unbound anonymous facts exist waits as a
//    hold carrying that id (1055-a G1-01); the tests assert it as a premise.
//  - "net balance" = paid - our refunds not failed - provider facts (= Rp70.000),
//    probed through the API too: a manual refund of Rp70.001 is refused (409/422)
//    and one of Rp70.000 is accepted (201).
//  - Control (1055-a G1-08): one anonymous fact A, a report bigger than A; the
//    same_as_counted resolve books only the difference.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-c-anonymous-binding.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1063c-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1063c-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1063c owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1063c approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1063c supervisor");
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
      reference: `R1063C-${unique()}`,
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

type TwoAnonymous = { code: Code; p1: string; p2: string };

/**
 * Bill Rp100.000 paid. R1 (10.000) fails with no ref, H1 counted: anonymous fact
 * 10.000. R2 (20.000) fails with no ref, H2 counted (identity separate):
 * anonymous fact 20.000. Then the provider reports P1 (10.000) and P2 (20.000);
 * both wait as holds.
 */
async function twoAnonymousThenReported(): Promise<
  TwoAnonymous & { holdP1: string; holdP2: string }
> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);

  const h1 = await declineWithoutRef(code, R1_IDR);
  const counted1 = await resolveHold(h1, "counted_against_intent");
  expect(counted1.status, JSON.stringify(counted1.body)).toBe(200);
  expect(await factAmounts(code.id), "premise: anonymous fact 10k").toEqual([
    R1_IDR,
  ]);

  const h2 = await declineWithoutRef(code, R2_IDR);
  const counted2 = await resolveHold(
    h2,
    "counted_against_intent",
    undefined,
    "separate",
  );
  expect(counted2.status, JSON.stringify(counted2.body)).toBe(200);
  expect(
    (await factAmounts(code.id)).sort((a, b) => a - b),
    "premise: two anonymous facts, 10k and 20k",
  ).toEqual([R1_IDR, R2_IDR]);
  expect(await refundEventsOfIntent(code.id), "premise: two events").toBe(2);

  const p1 = newRefundId();
  const p2 = newRefundId();
  await reportP(code, p1, R1_IDR);
  await reportP(code, p2, R2_IDR);
  const holdOf = async (id: string) => {
    const hold = (await openOf(code.id)).find(
      (row) => row.provider_refund_id === id,
    );
    expect(
      hold,
      `premise: the report ${id} waits as a hold (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();
    return hold!.id;
  };
  const holdP1 = await holdOf(p1);
  const holdP2 = await holdOf(p2);
  expect(
    (await factAmounts(code.id)).sort((a, b) => a - b),
    "premise: the reports are not booked yet",
  ).toEqual([R1_IDR, R2_IDR]);
  return { code, p1, p2, holdP1, holdP2 };
}

const sameAsCounted = (holdId: string) =>
  resolveHold(holdId, "counted_against_intent", undefined, "same_as_counted");

/** Facts, events and money after both reports are settled as the same refunds. */
async function expectNothingExtraBooked(code: Code, label: string) {
  expect
    .soft(
      (await factAmounts(code.id)).sort((a, b) => a - b),
      `${label}: only the two anonymous facts (10k, 20k); no fact grows from the same refunds`,
    )
    .toEqual([R1_IDR, R2_IDR]);
  expect
    .soft(
      await refundEventsOfIntent(code.id),
      `${label}: still two journal events`,
    )
    .toBe(2);
  expect
    .soft(
      (await ourRefundedIdr(code.id)) + (await factTotal(code.id)),
      `${label}: total refunded is exactly Rp30.000`,
    )
    .toBe(R1_IDR + R2_IDR);
  expect
    .soft(
      BILL_IDR - (await ourRefundedIdr(code.id)) - (await factTotal(code.id)),
      `${label}: net balance is Rp70.000`,
    )
    .toBe(BILL_IDR - R1_IDR - R2_IDR);
  expect
    .soft(
      (await openOf(code.id)).map((row) => row.provider_refund_id),
      `${label}: nothing waits`,
    )
    .toEqual([]);
}

/** The API agrees with the net balance: 70.001 is refused, 70.000 is accepted. */
async function expectNetBalanceThroughApi(code: Code, label: string) {
  const over = await manualRefund(code.id, BILL_IDR - R1_IDR - R2_IDR + 1);
  expect(
    [409, 422],
    `${label}: Rp70.001 exceeds the net balance: HTTP ${over.status} ${JSON.stringify(over.body)}`,
  ).toContain(over.status);
  const exact = await manualRefund(code.id, BILL_IDR - R1_IDR - R2_IDR);
  expect(
    exact.status,
    `${label}: Rp70.000 is still refundable: ${JSON.stringify(exact.body)}`,
  ).toBe(201);
}

describe("F3 (P2, legend-flj83) same_as_counted binds one anonymous fact and never reuses a bound one", () => {
  it("1063-c-F3-01 two anonymous facts (10k, 20k), reports P1 then P2 resolved same_as_counted: no fact, no journal event added, total Rp30.000, net balance Rp70.000", async () => {
    const t = await twoAnonymousThenReported();

    const first = await sameAsCounted(t.holdP1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(
      (await allHolds(t.code.id)).find((row) => row.id === t.holdP1)
        ?.resolution,
    ).toBe("counted_against_intent");
    const second = await sameAsCounted(t.holdP2);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    await expectNothingExtraBooked(t.code, "F3-01");
    await expectNetBalanceThroughApi(t.code, "F3-01");
  });

  it("1063-c-F3-02 reverse order: P2 (20k) is resolved same_as_counted first, then P1 (10k): no fact, no journal event added, total Rp30.000, net balance Rp70.000", async () => {
    const t = await twoAnonymousThenReported();

    const first = await sameAsCounted(t.holdP2);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await sameAsCounted(t.holdP1);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    await expectNothingExtraBooked(t.code, "F3-02");
    await expectNetBalanceThroughApi(t.code, "F3-02");
  });

  it("1063-c-F3-03 replays: a second resolve of each hold and the reports of P1 and P2 delivered again (new event ids, poller, worker) add no fact and no journal event", async () => {
    const t = await twoAnonymousThenReported();

    expect((await sameAsCounted(t.holdP1)).status).toBe(200);
    // Replay between the two resolves, then the second resolve.
    await reportP(t.code, t.p1, R1_IDR);
    expect((await sameAsCounted(t.holdP2)).status).toBe(200);

    const again1 = await sameAsCounted(t.holdP1);
    const again2 = await sameAsCounted(t.holdP2);
    expect(
      [again1.status, again2.status].every((status) => status < 500),
      `no server error on a second resolve: ${JSON.stringify([again1.body, again2.body])}`,
    ).toBe(true);
    await reportP(t.code, t.p1, R1_IDR);
    await reportP(t.code, t.p2, R2_IDR);

    await expectNothingExtraBooked(t.code, "F3-03");
    const stillOpen = (await openOf(t.code.id)).length;
    expect(stillOpen, "a replay opens no new hold").toBe(0);
  });

  it("1063-c-F3-04 control (1055-a G1-08): one anonymous fact of Rp10.000, the report P is Rp100.000 (bigger than the fact), same_as_counted books only the difference Rp90.000: total Rp100.000, two journal events; a replay adds nothing", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const h1 = await declineWithoutRef(code, R1_IDR);
    const counted = await resolveHold(h1, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(await factAmounts(code.id), "premise: anonymous fact").toEqual([
      R1_IDR,
    ]);

    const pId = newRefundId();
    await reportP(code, pId, BILL_IDR);
    const hold = (await openOf(code.id)).find(
      (row) => row.provider_refund_id === pId,
    );
    expect(
      hold,
      `premise: the report waits as a hold (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();

    const same = await sameAsCounted(hold!.id);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(
      (await factAmounts(code.id)).sort((a, b) => a - b),
      "anonymous 10k plus the difference 90k",
    ).toEqual([R1_IDR, BILL_IDR - R1_IDR]);
    expect(await factTotal(code.id)).toBe(BILL_IDR);
    expect(await refundEventsOfIntent(code.id)).toBe(2);

    await sameAsCounted(hold!.id);
    await reportP(code, pId, BILL_IDR);
    expect(await factTotal(code.id), "no growth").toBe(BILL_IDR);
    expect(await refundEventsOfIntent(code.id)).toBe(2);
  });
});
