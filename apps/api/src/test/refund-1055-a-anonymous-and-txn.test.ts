// (brief 1055, "SO refund ronde 4", tier K "jangan sampai rugi"): red-first
// tests for G1 (P1) and G2 (P2), written from docs/briefs/sub-1055-refund-so4.md,
// docs/qa/second-opinion-refund-ronde4-1055.md and the 1045-f / 1025d fixtures,
// not from the implementation.
//
//  - G1 one real refund of the provider must never be booked as two facts when
//    a hold WITHOUT a provider refund id was counted (synthetic fact) and the
//    provider then reports the same refund with its id P (or the other order).
//    Finance gets a way out: counted with `providerRefundId` (binds the
//    anonymous hold to a known fact, or books a fact under that id).
//  - G2 a fact of another transaction (same intent, same refund id) must not
//    close a hold of this transaction, automatically or by finance's counted
//    resolve (409 HOLD_TRANSACTION_CONFLICT); not_this_intent still closes it.
//
// Assumptions (the brief does not fix them):
//  - "R declined WITHOUT ref" = approve times out (approved, tried, no ref), then
//    the retry route's lookup answers `failed` with providerRef null. The test
//    asserts that R.provider_ref and the hold's provider_refund_id stay NULL.
//  - The new hold's reason is matched by the text REFUND_MAY_DUPLICATE_ANONYMOUS
//    (case-insensitive); its provider_refund_id is the reported refund id and
//    its kind is `provider`.
//  - ARCHITECT ROUND (brief section "Temuan architect xhigh"): finance's
//    counted_against_intent on a duplicate-anonymous hold (and on any hold with
//    an id while the transaction has an unbound anonymous fact) now REQUIRES the
//    body field `identity` ("same_as_counted" | "separate"); without it 409
//    HOLD_IDENTITY_AMBIGUOUS. G1-04b/c were changed accordingly: they now send
//    identity `separate` (before, plain counted meant "separate"). not_this_intent
//    on such a hold closes it without a fact and does NOT bind the anonymous fact;
//    `identity`/`providerRefundId` on not_this_intent are 422.
//  - G1-07c: "the next report P stays held" is tested with a NEW refund id P2
//    (the anonymous fact is still unbound); the same-id replay is G1-04a.
//  - G2-04: the conflict hold's reason is matched by the text
//    HOLD_TRANSACTION_CONFLICT; its alert is counted on the supervisor's
//    notifications (rises, then stays on replays).
//  - Error codes are read from body.error.code (as in 1045-e PROVIDER_REFUNDED).
//  - After a not_this_intent on the duplicate-anonymous hold, a replay of the
//    same report must not add a fact (it is "the same as the anonymous fact").
//  - G1-05: because the strict validator rejects unknown keys today, the test
//    first proves `providerRefundId` is accepted on an anonymous hold, so the
//    422 on an id-bearing hold cannot pass for the wrong reason.
//  - Money invariant: our refunds not failed + provider facts <= paid, and
//    facts per provider transaction <= what that transaction paid.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1055-a-anonymous-and-txn.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1055a-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1055a-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1055a owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1055a approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1055a supervisor");
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
      reference: `R1055A-${unique()}`,
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
// Building blocks for 1055
// ---------------------------------------------------------------------------

const DUPLICATE_ANON = /REFUND_MAY_DUPLICATE_ANONYMOUS/i;
const R_IDR = 30_000;
const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;
const errorCode = (body: { error?: { code?: string } }) => body?.error?.code;

type Declined = { code: Code; refundId: string; callsBefore: number };

/**
 * Bill paid Rp100.000; our refund R (Rp30.000) was SENT, timed out (no ref),
 * then DECLINED with no ref: the own-failed hold is anonymous.
 */
async function declinedWithoutRef(
  refundIdr: number = R_IDR,
): Promise<Declined> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, refundIdr);
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
  const row = await refundRow(refundId);
  expect(row.status, "premise: R failed").toBe("failed");
  expect(row.provider_ref, "premise: R still has NO provider ref").toBeNull();
  const own = await ownFailedHolds(code.id);
  expect(own, "premise: the failed sent refund filed its hold").toHaveLength(1);
  expect(
    own[0]?.provider_refund_id,
    "premise: the own-failed hold is anonymous",
  ).toBeNull();
  return { code, refundId, callsBefore: fake.calls.length };
}

const reportP = (code: Code, providerRefundId: string, amount = R_IDR) =>
  replayAll(() => refundIdEvent(code.providerRef, providerRefundId, amount));

async function duplicateAnonymousHolds(
  intentId: string,
  providerRefundId: string,
) {
  return (await allHolds(intentId)).filter(
    (hold) =>
      DUPLICATE_ANON.test(hold.reason) &&
      hold.provider_refund_id === providerRefundId,
  );
}

async function expectMoneyWithinPaid(code: Code, label: string) {
  const facts = await factTotal(code.id);
  const out = (await ourRefundedIdr(code.id)) + facts;
  expect(
    out,
    `${label}: our refunds not failed + provider facts (${out}) exceed what was paid (${BILL_IDR})`,
  ).toBeLessThanOrEqual(BILL_IDR);
}

/** G1-01 up to the second report: anonymous hold counted, then P is reported. */
async function countedThenReported() {
  const t = await declinedWithoutRef();
  const hold = (await ownFailedHolds(t.code.id))[0]!;
  const counted = await resolveHold(hold.id, "counted_against_intent");
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  expect(await factAmounts(t.code.id), "premise: one synthetic fact").toEqual([
    R_IDR,
  ]);
  expect(await refundEventsOfIntent(t.code.id), "premise: one event").toBe(1);
  const refundId = newRefundId();
  await reportP(t.code, refundId);
  return { ...t, refundId, holdId: hold.id };
}

// ---------------------------------------------------------------------------
// G1: anonymous hold counted + the provider's own id for the same refund
// ---------------------------------------------------------------------------

describe("G1 (P1) a hold without a refund id and the provider's report of it are ONE refund", () => {
  it("1055-a-G1-01 R of Rp30.000 declined with no ref, finance counts the anonymous hold (synthetic fact), then the provider reports id P of Rp30.000: no second fact, a REFUND_MAY_DUPLICATE_ANONYMOUS hold waits for finance, one journal event, replays with new event ids add nothing", async () => {
    const t = await declinedWithoutRef();
    const hold = (await ownFailedHolds(t.code.id))[0]!;
    const counted = await resolveHold(hold.id, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(await factAmounts(t.code.id), "premise: finance booked 30k").toEqual(
      [R_IDR],
    );

    const alertsBefore = (await supervisorAlertRows()).length;
    const refundId = newRefundId();
    await reportP(t.code, refundId);

    expect
      .soft(
        await factAmounts(t.code.id),
        "ONE fact for one real refund (P is the same Rp30.000)",
      )
      .toEqual([R_IDR]);
    expect
      .soft(await refundEventsOfIntent(t.code.id), "ONE journal event")
      .toBe(1);
    const held = await duplicateAnonymousHolds(t.code.id, refundId);
    expect
      .soft(
        held.filter((row) => row.resolved_at === null),
        `a REFUND_MAY_DUPLICATE_ANONYMOUS hold for P waits (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
      )
      .toHaveLength(1);
    expect.soft(held[0]?.amount_idr, "hold carries the report").toBe(R_IDR);
    expect.soft(held[0]?.provider_refund_id_kind).toBe("provider");
    expect
      .soft((await supervisorAlertRows()).length, "the report alerts")
      .toBeGreaterThan(alertsBefore);

    // Replays with NEW event ids (delivery, poller, worker) add nothing.
    const alertsAfterFirst = (await supervisorAlertRows()).length;
    await reportP(t.code, refundId);
    await reportP(t.code, refundId);
    expect
      .soft(await factAmounts(t.code.id), "replays add no fact")
      .toEqual([R_IDR]);
    expect.soft(await refundEventsOfIntent(t.code.id)).toBe(1);
    expect
      .soft(
        (await duplicateAnonymousHolds(t.code.id, refundId)).length,
        "replays add no second hold",
      )
      .toBe(1);
    expect
      .soft((await supervisorAlertRows()).length, "the alert is raised once")
      .toBe(alertsAfterFirst);

    await expectMoneyWithinPaid(t.code, "G1-01");
    await expectRefusedNewRefunds(t.code.id, t.callsBefore, "G1-01");
  });

  it("1055-a-G1-02 reverse order: the provider reports id P (Rp30.000) first, then finance counts the anonymous hold: without providerRefundId it is refused 409 HOLD_IDENTITY_AMBIGUOUS (hold stays open, no fact); with providerRefundId=P it closes with NO new fact", async () => {
    const t = await declinedWithoutRef();
    const refundId = newRefundId();
    await reportP(t.code, refundId);
    expect(
      await factAmounts(t.code.id),
      "premise: the report is booked once (fits what is left)",
    ).toEqual([R_IDR]);
    const hold = (await ownFailedHolds(t.code.id))[0]!;
    expect(hold.resolved_at, "premise: the anonymous hold is open").toBeNull();

    const blind = await resolveHold(hold.id, "counted_against_intent");
    expect
      .soft(
        [blind.status, errorCode(blind.body)],
        `counting an anonymous hold when the transaction already has a fact is ambiguous: ${JSON.stringify(blind.body)}`,
      )
      .toEqual([409, "HOLD_IDENTITY_AMBIGUOUS"]);
    expect(await factAmounts(t.code.id), "no second fact").toEqual([R_IDR]);
    expect(
      (await allHolds(t.code.id)).find((row) => row.id === hold.id)
        ?.resolved_at,
      "the hold stays open for finance",
    ).toBeNull();
    await expectRefusedNewRefunds(t.code.id, t.callsBefore, "G1-02 refused");

    const bound = await resolveHold(
      hold.id,
      "counted_against_intent",
      refundId,
    );
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    const closed = (await allHolds(t.code.id)).find(
      (row) => row.id === hold.id,
    )!;
    expect(closed.resolution).toBe("counted_against_intent");
    expect(closed.resolved_at).not.toBeNull();
    expect(await factAmounts(t.code.id), "bound to P: no new fact").toEqual([
      R_IDR,
    ]);
    expect(await refundEventsOfIntent(t.code.id), "ONE journal event").toBe(1);

    await reportP(t.code, refundId);
    expect(await factAmounts(t.code.id), "replays add nothing").toEqual([
      R_IDR,
    ]);
    await expectMoneyWithinPaid(t.code, "G1-02");
  });

  it("1055-a-G1-03 control, two different refunds: the anonymous hold counted with providerRefundId Q (a new id) books fact Q; the provider's report P (another id) is booked too when it fits what is left: two facts, total Rp60.000, no duplicate hold", async () => {
    const t = await declinedWithoutRef();
    const hold = (await ownFailedHolds(t.code.id))[0]!;
    const qId = newRefundId();
    const counted = await resolveHold(hold.id, "counted_against_intent", qId);
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const afterQ = await providerRows(t.code.id);
    expect(
      afterQ.map((row) => [row.provider_refund_id, row.amount_idr]),
      "fact Q is booked under the id finance named",
    ).toEqual([[qId, R_IDR]]);

    const pId = newRefundId();
    await reportP(t.code, pId);

    const facts = await providerRows(t.code.id);
    expect(
      facts.map((row) => [row.provider_refund_id, row.amount_idr]).sort(),
      "two real refunds, two facts",
    ).toEqual(
      [
        [qId, R_IDR],
        [pId, R_IDR],
      ].sort(),
    );
    expect(await factTotal(t.code.id)).toBe(2 * R_IDR);
    expect(await refundEventsOfIntent(t.code.id), "two journal events").toBe(2);
    expect(
      await duplicateAnonymousHolds(t.code.id, pId),
      "Q is a known id: P is not held as a possible duplicate",
    ).toEqual([]);
    expect(await openOf(t.code.id), "nothing waits").toEqual([]);
    await expectMoneyWithinPaid(t.code, "G1-03");
  });

  it("1055-a-G1-04a REFUND_MAY_DUPLICATE_ANONYMOUS hold, finance says not_this_intent: the hold closes, no new fact, nothing is booked from a replay", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const resolved = await resolveHold(held!.id, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const closed = (await allHolds(t.code.id)).find(
      (row) => row.id === held!.id,
    )!;
    expect(closed.resolution).toBe("not_this_intent");
    expect(
      await factAmounts(t.code.id),
      "no fact from not_this_intent",
    ).toEqual([R_IDR]);
    await reportP(t.code, t.refundId);
    expect(await factAmounts(t.code.id), "a replay adds no fact").toEqual([
      R_IDR,
    ]);
    expect(await refundEventsOfIntent(t.code.id)).toBe(1);
    await expectMoneyWithinPaid(t.code, "G1-04a");
  });

  it("1055-a-G1-04b REFUND_MAY_DUPLICATE_ANONYMOUS hold, finance says counted_against_intent with identity `separate` (a separate refund is proven): exactly one fact for P is booked, total Rp60.000, two journal events", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const resolved = await resolveHold(
      held!.id,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const facts = await providerRows(t.code.id);
    expect(
      facts.filter((row) => row.provider_refund_id === t.refundId),
      "one fact for P",
    ).toHaveLength(1);
    expect(await factTotal(t.code.id)).toBe(2 * R_IDR);
    expect(await refundEventsOfIntent(t.code.id)).toBe(2);
    await reportP(t.code, t.refundId);
    expect(await factTotal(t.code.id), "a replay adds nothing").toBe(2 * R_IDR);
    await expectMoneyWithinPaid(t.code, "G1-04b");
  });

  it("1055-a-G1-04c REFUND_MAY_DUPLICATE_ANONYMOUS hold resolved twice (identity `separate`) at the same time: P is booked exactly once, nobody gets a server error", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const answers = await Promise.all([
      resolveHold(held!.id, "counted_against_intent", undefined, "separate"),
      resolveHold(held!.id, "counted_against_intent", undefined, "separate"),
    ]);
    const statuses = answers.map((answer) => answer.status).sort();
    expect(
      statuses.every((status) => status < 500),
      `no server error: ${JSON.stringify(answers.map((a) => [a.status, a.body]))}`,
    ).toBe(true);
    expect(statuses, "one wins").toContain(200);
    const facts = await providerRows(t.code.id);
    expect(
      facts.filter((row) => row.provider_refund_id === t.refundId),
      "ONE fact for P",
    ).toHaveLength(1);
    expect(await factTotal(t.code.id)).toBe(2 * R_IDR);
    expect(await refundEventsOfIntent(t.code.id)).toBe(2);
    await expectMoneyWithinPaid(t.code, "G1-04c");
  });

  it("1055-a-G1-05 providerRefundId belongs to anonymous holds only: accepted on an anonymous hold (books fact under that id), refused 422 on a hold that already has a refund id (hold stays open, no fact)", async () => {
    // Anonymous hold: the field is accepted.
    const anon = await declinedWithoutRef();
    const anonHold = (await ownFailedHolds(anon.code.id))[0]!;
    const qId = newRefundId();
    const accepted = await resolveHold(
      anonHold.id,
      "counted_against_intent",
      qId,
    );
    expect(
      accepted.status,
      `providerRefundId is accepted on an anonymous hold: ${JSON.stringify(accepted.body)}`,
    ).toBe(200);
    expect(
      (await providerRows(anon.code.id)).map((r) => r.provider_refund_id),
    ).toEqual([qId]);

    // Hold with a refund id: R sent with ref, then failed.
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, R_IDR);
    fake.enqueue("pending");
    expect((await approveRefund(filed.body.data.id as string)).status).toBe(
      200,
    );
    const ref = (await refundRow(filed.body.data.id as string)).provider_ref!;
    expect(await failOwn(ref)).toBeNull();
    const idHold = (await ownFailedHolds(code.id))[0]!;
    expect(idHold.provider_refund_id, "premise: the hold carries R's ref").toBe(
      ref,
    );

    const refused = await resolveHold(
      idHold.id,
      "counted_against_intent",
      newRefundId(),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(
      (await allHolds(code.id)).find((row) => row.id === idHold.id)
        ?.resolved_at,
      "hold stays open",
    ).toBeNull();
    expect(await factAmounts(code.id), "no fact").toEqual([]);
  });

  it("1055-a-G1-06 the hold LP(P) with a refund id exists BEFORE the anonymous fact (live-own hold, then R fails with no ref, finance counts the anonymous hold H): counting LP without identity is refused 409 HOLD_IDENTITY_AMBIGUOUS; with identity `same_as_counted` it closes with NO new fact, total stays Rp30.000", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, R_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    fake.enqueue("throw");
    expect((await approveRefund(refundId)).status).toBe(200);
    expect(
      (await refundRow(refundId)).provider_ref,
      "premise: no ref",
    ).toBeNull();
    const callsBefore = fake.calls.length;

    // The provider's report P arrives while R is live: a hold with id P.
    const pId = newRefundId();
    const answered = await deliver(refundIdEvent(code.providerRef, pId, R_IDR));
    expect(answered.status, "signed report not rejected").not.toBe(401);
    const lp = (await openOf(code.id)).find(
      (row) => row.provider_refund_id === pId,
    );
    expect(
      lp,
      `premise: hold LP(P) is open (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();

    // R then fails with no ref: the anonymous own-failed hold H.
    fake.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: null,
      code: "declined",
    });
    expect((await retryRefund(refundId)).status).toBe(200);
    expect((await refundRow(refundId)).status, "premise: R failed").toBe(
      "failed",
    );
    const h = (await ownFailedHolds(code.id))[0];
    expect(h, "premise: anonymous hold H").toBeDefined();
    expect(h!.provider_refund_id, "premise: H is anonymous").toBeNull();

    // Finance counts H: the anonymous fact.
    const countedH = await resolveHold(h!.id, "counted_against_intent");
    expect(countedH.status, JSON.stringify(countedH.body)).toBe(200);
    expect(await factAmounts(code.id), "premise: anonymous fact 30k").toEqual([
      R_IDR,
    ]);
    const lpNow = (await allHolds(code.id)).find((row) => row.id === lp!.id)!;
    expect(lpNow.resolved_at, "premise: LP still open").toBeNull();

    const blind = await resolveHold(lp!.id, "counted_against_intent");
    expect
      .soft(
        [blind.status, errorCode(blind.body)],
        `LP counted while an unbound anonymous fact exists is ambiguous: ${JSON.stringify(blind.body)}`,
      )
      .toEqual([409, "HOLD_IDENTITY_AMBIGUOUS"]);
    expect(await factAmounts(code.id), "no second fact").toEqual([R_IDR]);
    expect(
      (await allHolds(code.id)).find((row) => row.id === lp!.id)?.resolved_at,
      "LP stays open",
    ).toBeNull();

    const same = await resolveHold(
      lp!.id,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(await factAmounts(code.id), "same_as_counted: no new fact").toEqual([
      R_IDR,
    ]);
    expect(await refundEventsOfIntent(code.id), "ONE journal event").toBe(1);
    await reportP(code, pId);
    expect(await factAmounts(code.id), "replays add nothing").toEqual([R_IDR]);
    await expectMoneyWithinPaid(code, "G1-06");
    expect(fake.calls, "no payout").toHaveLength(callsBefore);
  });

  it("1055-a-G1-07a duplicate-anonymous hold: counted_against_intent WITHOUT identity is refused 409 HOLD_IDENTITY_AMBIGUOUS (hold open, no fact); with identity `same_as_counted` it closes with NO new fact, total Rp30.000", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const blind = await resolveHold(held!.id, "counted_against_intent");
    expect
      .soft(
        [blind.status, errorCode(blind.body)],
        `identity is required: ${JSON.stringify(blind.body)}`,
      )
      .toEqual([409, "HOLD_IDENTITY_AMBIGUOUS"]);
    expect(await factAmounts(t.code.id), "no fact without identity").toEqual([
      R_IDR,
    ]);
    expect(
      (await allHolds(t.code.id)).find((row) => row.id === held!.id)
        ?.resolved_at,
      "hold stays open",
    ).toBeNull();

    const same = await resolveHold(
      held!.id,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(
      await factAmounts(t.code.id),
      "same_as_counted: no new fact",
    ).toEqual([R_IDR]);
    expect(await refundEventsOfIntent(t.code.id)).toBe(1);
    await reportP(t.code, t.refundId);
    expect(await factAmounts(t.code.id), "replays add nothing").toEqual([
      R_IDR,
    ]);
    await expectMoneyWithinPaid(t.code, "G1-07a");
  });

  it("1055-a-G1-07b duplicate-anonymous hold: identity `separate` books exactly ONE fact for P (total Rp60.000); the same call without identity is refused 409 first", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const blind = await resolveHold(held!.id, "counted_against_intent");
    expect
      .soft([blind.status, errorCode(blind.body)], JSON.stringify(blind.body))
      .toEqual([409, "HOLD_IDENTITY_AMBIGUOUS"]);
    expect(await factAmounts(t.code.id), "nothing booked yet").toEqual([R_IDR]);

    const separate = await resolveHold(
      held!.id,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(separate.status, JSON.stringify(separate.body)).toBe(200);
    expect(
      (await providerRows(t.code.id)).filter(
        (row) => row.provider_refund_id === t.refundId,
      ),
      "ONE fact for P",
    ).toHaveLength(1);
    expect(await factTotal(t.code.id)).toBe(2 * R_IDR);
    expect(await refundEventsOfIntent(t.code.id)).toBe(2);
    await expectMoneyWithinPaid(t.code, "G1-07b");
  });

  it("1055-a-G1-07c duplicate-anonymous hold: not_this_intent closes it with no fact and does NOT bind the anonymous fact, so a later report (new id P2) is held again; identity on not_this_intent is 422", async () => {
    const t = await countedThenReported();
    const held = (await duplicateAnonymousHolds(t.code.id, t.refundId))[0];
    expect(held, "premise: the duplicate-anonymous hold exists").toBeDefined();

    const refused = await resolveHold(
      held!.id,
      "not_this_intent",
      undefined,
      "separate",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(
      (await allHolds(t.code.id)).find((row) => row.id === held!.id)
        ?.resolved_at,
      "hold stays open after the refused call",
    ).toBeNull();

    const exit = await resolveHold(held!.id, "not_this_intent");
    expect(exit.status, JSON.stringify(exit.body)).toBe(200);
    expect(await factAmounts(t.code.id), "no fact").toEqual([R_IDR]);

    const p2 = newRefundId();
    await reportP(t.code, p2);
    expect(await factAmounts(t.code.id), "P2 is not booked blindly").toEqual([
      R_IDR,
    ]);
    expect(
      (await duplicateAnonymousHolds(t.code.id, p2)).filter(
        (row) => row.resolved_at === null,
      ),
      "P2 is held: the anonymous fact is still unbound",
    ).toHaveLength(1);
    await expectMoneyWithinPaid(t.code, "G1-07c");
  });

  it("1055-a-G1-08 same_as_counted must not book too little: bill Rp100.000, anonymous fact A of Rp30.000 (counted), the provider's report P is Rp100.000 (hold), finance picks `same_as_counted`: the difference Rp70.000 is booked once, total facts Rp100.000, nothing is left to refund, one extra journal event; a second resolve and replays add nothing", async () => {
    const t = await declinedWithoutRef();
    const anon = (await ownFailedHolds(t.code.id))[0]!;
    const countedA = await resolveHold(anon.id, "counted_against_intent");
    expect(countedA.status, JSON.stringify(countedA.body)).toBe(200);
    expect(await factAmounts(t.code.id), "premise: anonymous fact A").toEqual([
      R_IDR,
    ]);

    const pId = newRefundId();
    await reportP(t.code, pId, BILL_IDR);
    const hold = (await openOf(t.code.id)).find(
      (row) => row.provider_refund_id === pId,
    );
    expect(
      hold,
      `premise: the report P of Rp100.000 waits as a hold (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
    ).toBeDefined();
    expect(await factAmounts(t.code.id), "premise: P not booked yet").toEqual([
      R_IDR,
    ]);

    const same = await resolveHold(
      hold!.id,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect
      .soft(
        (await factAmounts(t.code.id)).sort((a, b) => a - b),
        "A (30k) plus the difference (70k) are on the books",
      )
      .toEqual([R_IDR, BILL_IDR - R_IDR]);
    expect
      .soft(await factTotal(t.code.id), "total facts = the report")
      .toBe(BILL_IDR);
    expect
      .soft(
        await refundEventsOfIntent(t.code.id),
        "one event for A, one for the difference",
      )
      .toBe(2);

    // A second resolve and replays add nothing.
    const again = await resolveHold(
      hold!.id,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
    await reportP(t.code, pId, BILL_IDR);
    expect.soft(await factTotal(t.code.id), "no growth").toBe(BILL_IDR);
    expect.soft(await refundEventsOfIntent(t.code.id)).toBe(2);
    await expectMoneyWithinPaid(t.code, "G1-08");
    // Nothing is left of the bill: a new refund is refused, no payout.
    await expectRefusedNewRefunds(t.code.id, t.callsBefore, "G1-08");
  });
});

// ---------------------------------------------------------------------------
// G2: a fact of another transaction must not close this transaction's hold
// ---------------------------------------------------------------------------

type CrossTxn = {
  code: Code;
  extra: Extra;
  fundId: string;
  refundId: string;
  holdId: string;
  x: string;
  t1FactId: string;
  callsBefore: number;
};

/**
 * Intent I: T1 (Rp100.000 paid) and T2 (evidence, Rp100.000, parked as a fund).
 * Fact X of Rp30.000 is booked on T1. Our refund R (Rp20.000, T1) is tried with
 * no ref; the signed report X/T2 (Rp100.000) files a live-own hold for T2; then R
 * completes with another ref.
 */
async function crossTransactionHold(): Promise<CrossTxn> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const { extra, fundId } = await addParkedExtra(code, BILL_IDR);

  const x = newRefundId();
  await replayAll(() => refundIdEvent(code.providerRef, x, 30_000), 1);
  const t1 = await factsOfRef(code.id, code.providerRef);
  expect(
    t1.map((row) => [row.provider_refund_id, row.amount_idr]),
    "premise: X is booked on T1",
  ).toEqual([[x, 30_000]]);

  const filed = await manualRefund(code.id, 20_000);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  expect((await approveRefund(refundId)).status).toBe(200);
  expect(
    (await refundRow(refundId)).provider_ref,
    "premise: no ref",
  ).toBeNull();

  const answered = await deliver(
    refundIdEvent(extra.providerRef, x, BILL_IDR, BILL_IDR),
  );
  expect(answered.status, "signed report not rejected").not.toBe(401);
  const hold = (await openOf(code.id)).find(
    (row) => row.provider_payment_ref === extra.providerRef,
  );
  expect(
    hold,
    `premise: a hold for the report X/T2 is open (holds: ${JSON.stringify(await allHolds(code.id))})`,
  ).toBeDefined();

  fake.setStatus(`refund:${refundId}`, {
    status: "succeeded",
    providerRef: `PR-DONE-${unique()}`,
  });
  expect((await retryRefund(refundId)).status).toBe(200);
  expect((await refundRow(refundId)).status, "premise: R completed").toBe(
    "completed",
  );
  return {
    code,
    extra,
    fundId,
    refundId,
    holdId: hold!.id,
    x,
    t1FactId: t1[0]!.id,
    callsBefore: fake.calls.length,
  };
}

const holdOf = async (t: CrossTxn) =>
  (await allHolds(t.code.id)).find((row) => row.id === t.holdId)!;

async function expectT1Untouched(t: CrossTxn, label: string) {
  const t1 = await factsOfRef(t.code.id, t.code.providerRef);
  expect(
    t1.map((row) => [row.id, row.provider_refund_id, row.amount_idr]),
    `${label}: T1's fact is unchanged`,
  ).toEqual([[t.t1FactId, t.x, 30_000]]);
  expect(
    await factsOfRef(t.code.id, t.extra.providerRef),
    `${label}: no fact on T2`,
  ).toEqual([]);
  expect(await refundEventsOfIntent(t.code.id), `${label}: one event`).toBe(1);
}

describe("G2 (P2) a fact of transaction T1 is not a fact of transaction T2", () => {
  it("1055-a-G2-01 fact X is on T1, the hold is for X/T2: replays of X/T2 (new event ids, poller, worker) keep T2's hold OPEN; T1's fact is unchanged, T2 has no fact", async () => {
    const t = await crossTransactionHold();
    await replayAll(() => refundIdEvent(t.extra.providerRef, t.x, BILL_IDR));

    const hold = await holdOf(t);
    expect(
      hold.resolved_at,
      `the hold of T2 stays open (it closed as ${hold.resolution}) although T2 has no fact`,
    ).toBeNull();
    await expectT1Untouched(t, "G2-01");
    await expectMoneyWithinPaid(t.code, "G2-01");
  });

  it("1055-a-G2-02 finance's counted_against_intent on the hold of X/T2 is refused 409 HOLD_TRANSACTION_CONFLICT (hold stays open, no fact); the refund of T2's fund is refused 409 with no payout; not_this_intent closes the hold", async () => {
    const t = await crossTransactionHold();

    const counted = await resolveHold(t.holdId, "counted_against_intent");
    expect(
      [counted.status, errorCode(counted.body)],
      `X belongs to T1, not T2: ${JSON.stringify(counted.body)}`,
    ).toEqual([409, "HOLD_TRANSACTION_CONFLICT"]);
    expect((await holdOf(t)).resolved_at, "hold stays open").toBeNull();
    await expectT1Untouched(t, "G2-02 after counted");

    // T2's money is held: its fund cannot be refunded while the hold is open.
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
    expect(fake.calls, "no payout for T2").toHaveLength(t.callsBefore);

    const exit = await resolveHold(t.holdId, "not_this_intent");
    expect(exit.status, JSON.stringify(exit.body)).toBe(200);
    expect((await holdOf(t)).resolution).toBe("not_this_intent");
    await expectT1Untouched(t, "G2-02 after not_this_intent");
    await expectMoneyWithinPaid(t.code, "G2-02");
  });

  it("1055-a-G2-03 fact X is on T1, the hold is for X/T2: a replay of the report X/T1 (new event ids, poller, worker) does NOT close T2's hold; T1's fact is unchanged, T2 has no fact", async () => {
    const t = await crossTransactionHold();
    await replayAll(() => refundIdEvent(t.code.providerRef, t.x, 30_000));

    const hold = await holdOf(t);
    expect(
      hold.resolved_at,
      `the hold of T2 stays open (it closed as ${hold.resolution}) after a replay of X/T1`,
    ).toBeNull();
    await expectT1Untouched(t, "G2-03");
    await expectMoneyWithinPaid(t.code, "G2-03");
  });

  it("1055-a-G2-04 fact X is on T1, no refund of ours runs, the signed report X/T2 arrives: a conflict hold (HOLD_TRANSACTION_CONFLICT, id X, transaction T2) is filed with one alert, replays add nothing; T2's fund refund is refused 409 with no payout", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);
    const x = newRefundId();
    await replayAll(() => refundIdEvent(code.providerRef, x, 30_000), 1);
    const t1 = await factsOfRef(code.id, code.providerRef);
    expect(
      t1.map((row) => [row.provider_refund_id, row.amount_idr]),
      "premise: X is booked on T1",
    ).toEqual([[x, 30_000]]);
    const callsBefore = fake.calls.length;
    const alertsBefore = (await supervisorAlertRows()).length;

    await replayAll(() => refundIdEvent(extra.providerRef, x, BILL_IDR), 1);

    const conflicts = (await openOf(code.id)).filter(
      (row) =>
        /HOLD_TRANSACTION_CONFLICT/i.test(row.reason) &&
        row.provider_refund_id === x &&
        row.provider_payment_ref === extra.providerRef,
    );
    expect
      .soft(
        conflicts,
        `one conflict hold for X on T2 (holds: ${JSON.stringify(await allHolds(code.id))})`,
      )
      .toHaveLength(1);
    expect
      .soft((await supervisorAlertRows()).length, "the conflict alerts")
      .toBeGreaterThan(alertsBefore);
    const alertsAfterFirst = (await supervisorAlertRows()).length;

    await replayAll(() => refundIdEvent(extra.providerRef, x, BILL_IDR), 2);
    expect
      .soft(
        (await openOf(code.id)).filter((row) =>
          /HOLD_TRANSACTION_CONFLICT/i.test(row.reason),
        ),
        "replays add no second hold",
      )
      .toHaveLength(1);
    expect
      .soft((await supervisorAlertRows()).length, "alerted once")
      .toBe(alertsAfterFirst);
    expect(
      (await factsOfRef(code.id, code.providerRef)).map((row) => row.id),
      "T1's fact is unchanged",
    ).toEqual([t1[0]!.id]);
    expect(
      await factsOfRef(code.id, extra.providerRef),
      "no fact on T2",
    ).toEqual([]);

    // T2's money is held until finance decides.
    const filed = await resolveFund(fundId, "refund");
    if (filed.status === 200) {
      const rows = await owner.query<{ id: string }>(
        "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
        [tenantId, fundId],
      );
      const approved = await approveRefund(rows.rows[0]!.id);
      expect(
        approved.status,
        `approving T2's fund refund: ${JSON.stringify(approved.body)}`,
      ).toBe(409);
    } else {
      expect(filed.status, JSON.stringify(filed.body)).toBe(409);
    }
    expect(fake.calls, "no payout for T2").toHaveLength(callsBefore);
    await expectMoneyWithinPaid(code, "G2-04");
  });

  it("1055-a-G2-05 LP(X)/T1 was filed and closed because X/T1 is booked; later the signed report X/T2 arrives with no refund of ours running: a conflict hold is filed anyway (the closed X hold of T1 does not block it) with an alert; T2's fund refund is refused 409 with no payout", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra, fundId } = await addParkedExtra(code, BILL_IDR);

    // R is live (tried, no ref) when the report X/T1 arrives: hold LP(X)/T1.
    const filed = await manualRefund(code.id, 20_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    fake.enqueue("throw");
    expect((await approveRefund(refundId)).status).toBe(200);
    const x = newRefundId();
    const answered = await deliver(refundIdEvent(code.providerRef, x, 30_000));
    expect(answered.status, "signed report not rejected").not.toBe(401);
    const lp = (await openOf(code.id)).find(
      (row) =>
        row.provider_refund_id === x &&
        row.provider_payment_ref === code.providerRef,
    );
    expect(
      lp,
      `premise: hold LP(X)/T1 is open (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();

    // R completes; finance counts LP: X is booked on T1 and the hold closes.
    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: `PR-DONE-${unique()}`,
    });
    expect((await retryRefund(refundId)).status).toBe(200);
    expect((await refundRow(refundId)).status, "premise: R completed").toBe(
      "completed",
    );
    const counted = await resolveHold(lp!.id, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const t1 = await factsOfRef(code.id, code.providerRef);
    expect(
      t1.filter((row) => row.provider_refund_id === x),
      "premise: X is booked on T1",
    ).toHaveLength(1);
    expect(
      (await allHolds(code.id)).find((row) => row.id === lp!.id)?.resolved_at,
      "premise: LP(X)/T1 is closed",
    ).not.toBeNull();
    const t1FactIds = t1.map((row) => row.id);
    const callsBefore = fake.calls.length;
    const alertsBefore = (await supervisorAlertRows()).length;

    // Now X is reported for T2, nothing of ours is running.
    await replayAll(() => refundIdEvent(extra.providerRef, x, BILL_IDR), 1);

    const conflicts = (await openOf(code.id)).filter(
      (row) =>
        /HOLD_TRANSACTION_CONFLICT/i.test(row.reason) &&
        row.provider_refund_id === x &&
        row.provider_payment_ref === extra.providerRef,
    );
    expect
      .soft(
        conflicts,
        `one open conflict hold for X on T2 (holds: ${JSON.stringify(await allHolds(code.id))})`,
      )
      .toHaveLength(1);
    expect
      .soft((await supervisorAlertRows()).length, "the conflict alerts")
      .toBeGreaterThan(alertsBefore);
    expect(
      (await factsOfRef(code.id, code.providerRef)).map((row) => row.id),
      "T1's facts are unchanged",
    ).toEqual(t1FactIds);
    expect(
      await factsOfRef(code.id, extra.providerRef),
      "no fact on T2",
    ).toEqual([]);

    const fundTry = await resolveFund(fundId, "refund");
    if (fundTry.status === 200) {
      const rows = await owner.query<{ id: string }>(
        "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
        [tenantId, fundId],
      );
      const approved = await approveRefund(rows.rows[0]!.id);
      expect(
        approved.status,
        `approving T2's fund refund: ${JSON.stringify(approved.body)}`,
      ).toBe(409);
    } else {
      expect(fundTry.status, JSON.stringify(fundTry.body)).toBe(409);
    }
    expect(fake.calls, "no payout for T2").toHaveLength(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// G1-09 / G1-10 (regression 140 files, brief "Regresi 140 berkas"): an
// anonymous hold on a transaction that already has a fact takes `identity`
// too (finance without a refund id still has a way out), and the view tells
// when identity is needed (never for a conflict hold).
// ---------------------------------------------------------------------------

type HoldView = { id: string; needsIdentity: boolean };

/** The view of one open hold, paging through the tenant's open holds. */
async function openHoldView(holdId: string): Promise<HoldView | undefined> {
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const answer = await staff
      .get(`${ADMIN}/refund-recon-holds`)
      .query({ status: "open", limit: 100, ...(cursor ? { cursor } : {}) });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const found = (answer.body.data as HoldView[]).find(
      (row) => row.id === holdId,
    );
    if (found) return found;
    cursor = answer.body.meta.nextCursor as string | null;
    if (!cursor) return undefined;
  }
  return undefined;
}

/** Bill Rp100.000; R (Rp30.000) declined with no ref: anonymous hold H; then
 * the provider's report P of Rp40.000 is booked on the same transaction. */
async function anonymousHoldOnBookedTransaction() {
  const t = await declinedWithoutRef();
  const pId = newRefundId();
  await reportP(t.code, pId, 40_000);
  expect(await factAmounts(t.code.id), "premise: fact P of 40k").toEqual([
    40_000,
  ]);
  const hold = (await ownFailedHolds(t.code.id))[0]!;
  expect(hold.resolved_at, "premise: H is open").toBeNull();
  return { ...t, hold, pId };
}

describe("G1-09/G1-10 identity on an anonymous hold, and when the view asks for it", () => {
  it("1055-a-G1-09a anonymous hold H (30k) on a transaction with fact P (40k): the view asks for identity; counted without identity is 409 HOLD_IDENTITY_AMBIGUOUS; `separate` books H's 30k (total 70k, two events)", async () => {
    const t = await anonymousHoldOnBookedTransaction();
    expect(
      (await openHoldView(t.hold.id))?.needsIdentity,
      "the view asks for identity",
    ).toBe(true);

    const blind = await resolveHold(t.hold.id, "counted_against_intent");
    expect([blind.status, errorCode(blind.body)]).toEqual([
      409,
      "HOLD_IDENTITY_AMBIGUOUS",
    ]);

    const separate = await resolveHold(
      t.hold.id,
      "counted_against_intent",
      undefined,
      "separate",
    );
    expect(separate.status, JSON.stringify(separate.body)).toBe(200);
    expect(
      (await factAmounts(t.code.id)).sort((a, b) => a - b),
      "H's 30k is booked next to P's 40k",
    ).toEqual([R_IDR, 40_000]);
    expect(await factTotal(t.code.id)).toBe(70_000);
    expect(await refundEventsOfIntent(t.code.id)).toBe(2);
    await expectMoneyWithinPaid(t.code, "G1-09a");
  });

  it("1055-a-G1-09b anonymous hold H (30k), fact P (40k): providerRefundId together with identity is 422; `same_as_counted` closes H with no new fact (30k <= 40k)", async () => {
    const t = await anonymousHoldOnBookedTransaction();

    const both = await resolveHold(
      t.hold.id,
      "counted_against_intent",
      t.pId,
      "same_as_counted",
    );
    expect(both.status, JSON.stringify(both.body)).toBe(422);
    expect(
      (await allHolds(t.code.id)).find((row) => row.id === t.hold.id)
        ?.resolved_at,
      "H stays open after the refused call",
    ).toBeNull();

    const same = await resolveHold(
      t.hold.id,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const closed = (await allHolds(t.code.id)).find(
      (row) => row.id === t.hold.id,
    )!;
    expect(closed.resolution).toBe("counted_against_intent");
    expect(await factAmounts(t.code.id), "no new fact").toEqual([40_000]);
    expect(await refundEventsOfIntent(t.code.id)).toBe(1);
    await expectMoneyWithinPaid(t.code, "G1-09b");
  });

  it("1055-a-G1-09c a synthetic_full hold (the whole transaction) counted with `same_as_counted` is 422 and stays open", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const holdId = randomUUID();
    await owner.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, provider_refund_id_kind, amount_idr, reason, provider_payment_ref)
       VALUES ($1, $2, $3, $4, $5, 'synthetic_full', 0, 'The payment is refunded while a refund of ours ran', $5)`,
      [holdId, tenantId, code.id, randomUUID(), code.providerRef],
    );
    const same = await resolveHold(
      holdId,
      "counted_against_intent",
      undefined,
      "same_as_counted",
    );
    expect(same.status, JSON.stringify(same.body)).toBe(422);
    expect(
      (await allHolds(code.id)).find((row) => row.id === holdId)?.resolved_at,
      "hold stays open",
    ).toBeNull();
    expect(await factAmounts(code.id), "no fact").toEqual([]);
  });

  it("1055-a-G1-10 a conflict hold (X on T1, report X/T2) never asks for identity, even when T2 has a refund counted without an id", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const { extra } = await addParkedExtra(code, BILL_IDR);
    const x = newRefundId();
    await replayAll(() => refundIdEvent(code.providerRef, x, 30_000), 1);
    await replayAll(() => refundIdEvent(extra.providerRef, x, BILL_IDR), 1);
    const conflict = (await openOf(code.id)).find(
      (row) =>
        /HOLD_TRANSACTION_CONFLICT/i.test(row.reason) &&
        row.provider_payment_ref === extra.providerRef,
    );
    expect(
      conflict,
      `premise: conflict hold for X/T2 (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toBeDefined();

    // A refund of T2 counted without an id (anonymous hold, counted).
    const anonId = randomUUID();
    await owner.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, amount_idr, reason, provider_payment_ref)
       VALUES ($1, $2, $3, $4, 10000, 'Refund penyedia tanpa nomor', $5)`,
      [anonId, tenantId, code.id, randomUUID(), extra.providerRef],
    );
    const countedAnon = await resolveHold(anonId, "counted_against_intent");
    expect(countedAnon.status, JSON.stringify(countedAnon.body)).toBe(200);
    expect(
      (await factsOfRef(code.id, extra.providerRef)).map((r) => r.amount_idr),
      "premise: anonymous fact on T2",
    ).toEqual([10_000]);

    expect(
      (await openHoldView(conflict!.id))?.needsIdentity,
      "a conflict hold is closed only as not_this_intent: no identity asked",
    ).toBe(false);
  });
});
