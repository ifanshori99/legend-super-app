// legend-d7im9 (brief 1045, finding F2, tier K "jangan sampai rugi"): when the
// provider's refund report arrives while a refund of OURS was already tried
// (approved, no provider reference yet) the recorder answers "retry" and the
// event waits for the worker. Today nothing remembers the report in that
// window: if our refund R then FAILS before the worker replays the event, a new
// refund is accepted and paid out although the provider already gave the money
// back (guest paid twice, outlet loses Rp100.000).
// Written from the brief (docs/briefs/sub-1045-refund-so3.md, F2 + Test), the
// second opinion (docs/qa/second-opinion-refund-ronde3-1044.md, finding 2) and
// the 1035-a / 958 fixtures, not from the implementation.
//
// Rule asserted (CTO): no certainty about the provider's status -> HOLD and
// refuse new refunds; never leave a retry open without a hold.
//  - Second opinion scenario 2 exactly: intent paid Rp100.000; R (Rp100.000) was
//    tried and has no provider reference; the signed webhook with the full
//    `refunded` status of the transaction arrives (-> retry); R fails BEFORE the
//    worker replays; a new refund is refused (409/422) and nothing is paid out.
//  - Variant: the provider reports its own refund id (id door).
//  - Variant mustWait: our live refund (Rp60.000) is smaller than what the
//    provider reports refunded (Rp100.000), on both doors.
//  - Replay after R failed: the provider's refund is recorded ONCE and the hold
//    closes by itself; replays add nothing; the intent stays blocked.
//  - R COMPLETES: the hold stays open for finance (own / duplicate never close
//    it); no fact, no journal event, nothing sent again.
//  - Race worker vs R's failure (both start orders): never lost, never twice.
//  - Duplicate events (same id and new ids, concurrently, plus worker): ONE hold.
//  - Another tenant with the same provider payment id is not touched, not
//    blocked, not treated as a duplicate.
//
// Assumptions (the brief does not fix them):
//  - "R tried without ref" = the fake refund gateway throws a timeout on approve
//    (refund stays `approved`, payout_attempts 1, provider_ref NULL), as in
//    payment-doit-refunded-after-paid-958.test.ts.
//  - R is failed / completed without a ref through the public lookup the retry
//    route uses: fake.setStatus(`refund:<id>`, ...) then
//    POST /refunds/:id/retry (as in 958-a9).
//  - The first webhook delivery may answer any status below 500 or a 5xx (retry
//    window); the answer is not pinned, only what the user can do afterwards.
//  - "Blocked" = a new refund answers 409 or 422; after the provider's refund is
//    recorded the code is PROVIDER_REFUNDED (409), as in 1035-a -23.
//  - The hold is found by tenant + intent (open) and its auto close is read as
//    resolved_at set with resolution `counted_against_intent` (brief).
//  - Hold existence checks use expect.soft so the money assertions (new refund
//    refused, no second payout) are still reported when the hold is missing.
//  - mustWait: R = Rp60.000 live without ref, provider reports Rp100.000 (full
//    status, or its own refund id for the whole payment). A new refund of the
//    remaining Rp40.000 is refused too (the provider already refunded it all).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1045-b-retry-holds.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1045b-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045b-${randomBytes(16).toString("hex")}`;

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
let tenantB: {
  scope: ReturnType<typeof paymentTestScope>;
  integrationId: string;
  linkIds: string[];
} | null = null;

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
  const email = await signUp(staff, "Refund1045b owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1045b approver");
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
      reference: `R1045B-${unique()}`,
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

// The hold of the second opinion window (F2) is the "live own" hold. A refund of
// ours that failed after it was sent also files its own hold (F1, reason
// `own_refund_failed_unverified`, finance/poller verifies it, tested in
// refund-1045-a); it is not what this file counts.
const OWN_FAILED = "own_refund_failed_unverified";

async function holdsOf(forTenant: string, intentId: string, open: boolean) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    resolution: string | null;
    reason: string;
  }>(
    `SELECT id, amount_idr::text AS amount_idr, resolution, reason FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
        AND (resolved_at IS NULL) = $3
        AND reason <> $4
      ORDER BY flagged_at`,
    [forTenant, intentId, open, OWN_FAILED],
  );
  return rows;
}

const openHolds = (intentId: string) => holdsOf(tenantId, intentId, true);
const closedHolds = (intentId: string) => holdsOf(tenantId, intentId, false);

const anyHoldRows = (forTenant: string) =>
  count(
    "SELECT count(*)::text AS n FROM refund_recon_holds WHERE tenant_id = $1",
    [forTenant],
  );

// ---------------------------------------------------------------------------
// Scenario building blocks
// ---------------------------------------------------------------------------

type Tried = {
  code: Code;
  refundId: string;
  refundIdr: number;
  /** Provider calls made so far: nothing may add to it afterwards. */
  callsBefore: number;
  /** The provider's payment object as it was when A was refunded (tenant B may reuse the id). */
  payment: DoitPayment;
  /** The provider's own refund id: every delivery of the same report repeats it. */
  providerRefundId: string;
};

/**
 * Bill A paid; our refund R of `refundIdr` was TRIED (the provider call timed
 * out): R is `approved`, has no provider reference. The provider itself then
 * refunds A (fake status becomes refunded).
 */
async function triedRefund(
  refundIdr: number = BILL_IDR,
  exactRef: string | null = null,
): Promise<Tried> {
  const code = await newCode(BILL_IDR, exactRef);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, refundIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.status, "premise: R is in flight").toBe("approved");
  expect(row.provider_ref, "premise: R has no provider ref").toBeNull();
  expect(row.payout_attempts, "premise: R was tried").toBeGreaterThan(0);
  doit.refund(code.providerRef);
  return {
    code,
    refundId,
    refundIdr,
    callsBefore: fake.calls.length,
    payment: structuredClone(
      doit.payments.get(code.providerRef)!,
    ) as DoitPayment,
    providerRefundId: `rf_${randomBytes(6).toString("hex")}`,
  };
}

/** Provider report, status door: the full `refunded` status of the transaction. */
const statusReport = (t: Tried) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "payment.refunded",
  created_at: new Date().toISOString(),
  data: { ...t.payment, status: "refunded" },
});

/** Provider report, id door: its own refund id for the whole payment. */
const idReport = (t: Tried, amountIdr: number = BILL_IDR) => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "payment.refunded",
  created_at: new Date().toISOString(),
  data: {
    payment_id: t.code.providerRef,
    refund_id: t.providerRefundId,
    amount: amountIdr,
    status: amountIdr >= BILL_IDR ? "refunded" : "partially_refunded",
  },
});

type Door = "status" | "id";
const report = (door: Door, t: Tried) =>
  door === "status" ? statusReport(t) : idReport(t);

/** The report arrives; whatever it answers (200 or a 5xx retry), it was received. */
async function receive(body: object) {
  const answer = await deliver(body);
  expect(answer.status, "the signed report is not rejected").not.toBe(401);
  expect(answer.status, "the signed report is not rejected").not.toBe(403);
  return answer;
}

/** R is declined by the provider (lookup answer), before any replay. */
async function failTried(t: Tried) {
  fake.setStatus(`refund:${t.refundId}`, {
    status: "failed",
    providerRef: `PR-DECLINED-${unique()}`,
    code: "declined",
  });
  return retryRefund(t.refundId);
}

/** R is completed by the provider (lookup answer). */
async function completeTried(t: Tried) {
  fake.setStatus(`refund:${t.refundId}`, {
    status: "succeeded",
    providerRef: `PR-DONE-${unique()}`,
  });
  return retryRefund(t.refundId);
}

async function expectRFailed(t: Tried) {
  const answer = await failTried(t);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect((await refundRow(t.refundId)).status, "R failed").toBe("failed");
  expect(fake.calls, "failing R sent nothing").toHaveLength(t.callsBefore);
}

/**
 * New refunds are refused (409 / 422) and nothing is paid out. A refund that is
 * wrongly accepted is approved too, to show the payout it would cause.
 */
async function expectNewRefundsRefused(
  t: Tried,
  why: string,
  amounts: number[] = [BILL_IDR, 1_000],
) {
  for (const amount of amounts) {
    const attempt = await manualRefund(t.code.id, amount);
    let probe = "";
    if (attempt.status === 201) {
      const newId = attempt.body.data.id as string;
      const approved = await approveRefund(newId);
      probe = ` | probe: approve -> HTTP ${approved.status}, refund ${(await refundRow(newId)).status}, provider calls +${fake.calls.length - t.callsBefore}`;
    }
    expect(
      [409, 422],
      `${why}: new refund of ${amount}: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}${probe}`,
    ).toContain(attempt.status);
  }
  expect(fake.calls, `${why}: nothing sent to the guest`).toHaveLength(
    t.callsBefore,
  );
}

/** Real money never counted twice: our live refunds + provider facts <= paid. */
async function expectMoneyNotDoubled(t: Tried) {
  expect(
    (await ourRefundedIdr(t.code.id)) + (await factTotal(t.code.id)),
    "refunded (ours not failed + provider facts) never exceeds what was paid",
  ).toBeLessThanOrEqual(BILL_IDR);
}

/** The worker, the poller and a repeated delivery run again. */
async function replay(t: Tried, door: Door, rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    await receive(report(door, t));
    await pollLater().catch(() => null);
    await runWorker();
  }
}

/**
 * End state after R failed and the report was replayed: the provider's refund is
 * ONE fact of the real amount, ONE journal event, the hold closed by itself, the
 * intent blocked (PROVIDER_REFUNDED), no payout.
 */
async function expectRecordedOnceAndClosed(t: Tried, holdId: string | null) {
  expect(await factAmounts(t.code.id), "ONE fact, the real amount").toEqual([
    BILL_IDR,
  ]);
  expect(await refundEventsOfIntent(t.code.id), "ONE journal event").toBe(1);
  expect(await openHolds(t.code.id), "the hold closed by itself").toEqual([]);
  if (holdId) {
    const closed = await closedHolds(t.code.id);
    expect(closed.map((hold) => hold.id)).toContain(holdId);
    expect(
      closed.find((hold) => hold.id === holdId)?.resolution,
      "closed as counted against the intent",
    ).toBe("counted_against_intent");
  }
  const blocked = await manualRefund(t.code.id, BILL_IDR);
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
  expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
  expect(fake.calls, "no second payout").toHaveLength(t.callsBefore);
  await expectMoneyNotDoubled(t);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("legend-d7im9 a retry without a hold leaves a double-refund window", () => {
  it("1045-b-01 second opinion scenario 2: R tried without ref, the signed full `refunded` status arrives (retry), R fails BEFORE the worker: a new refund is refused and nothing is paid out", async () => {
    const t = await triedRefund();
    await receive(statusReport(t));

    // The report was accepted: it is remembered as a hold at once (while R is live).
    const holds = await openHolds(t.code.id);
    expect.soft(holds, "ONE hold from the received report").toHaveLength(1);
    expect.soft(Number(holds[0]?.amount_idr)).toBe(BILL_IDR);
    expect(await factTotal(t.code.id), "no fact while R is live").toBe(0);
    await expectNewRefundsRefused(t, "R live, report received");

    await expectRFailed(t);
    // The window: the worker has not replayed the event yet.
    await expectNewRefundsRefused(t, "R failed, before the worker replays");
    expect
      .soft(await openHolds(t.code.id), "the hold stays open")
      .toHaveLength(1);
    await expectMoneyNotDoubled(t);
  });

  it("1045-b-02 variant refund id: R tried without ref, the provider reports its own refund id for the whole payment, R fails before any replay: a new refund is refused and nothing is paid out", async () => {
    const t = await triedRefund();
    await receive(idReport(t));

    expect.soft(await openHolds(t.code.id), "ONE hold").toHaveLength(1);
    expect(await factTotal(t.code.id)).toBeLessThanOrEqual(BILL_IDR);
    await expectNewRefundsRefused(t, "R live, refund id received");

    await expectRFailed(t);
    await expectNewRefundsRefused(t, "R failed, before the worker replays");
    expect(
      (await openHolds(t.code.id)).length > 0 ||
        (await factTotal(t.code.id)) === BILL_IDR,
      "the provider's refund is neither held nor recorded",
    ).toBe(true);
    await expectMoneyNotDoubled(t);
  });

  it.each(["status", "id"] as const)(
    "1045-b-03 mustWait (%s door): our live refund Rp60.000 is smaller than the provider's Rp100.000 refund; R fails before the replay: refused, no payout, then one fact of Rp100.000",
    async (door) => {
      const t = await triedRefund(60_000);
      await receive(report(door, t));

      const holds = await openHolds(t.code.id);
      expect.soft(holds, "ONE hold from the received report").toHaveLength(1);
      // Hold holds the provider report amount (Rp100.000), not our live 60k:
      // a counted resolve after R fails must book the whole 100k.
      expect.soft(Number(holds[0]?.amount_idr)).toBe(BILL_IDR);
      await expectNewRefundsRefused(t, "R live, bigger provider refund", [
        BILL_IDR,
        40_000,
        1_000,
      ]);

      await expectRFailed(t);
      await expectNewRefundsRefused(t, "R failed, before the replay", [
        BILL_IDR,
        60_000,
        40_000,
      ]);
      await expectMoneyNotDoubled(t);

      await replay(t, door);
      await expectRecordedOnceAndClosed(t, holds[0]?.id ?? null);
    },
  );

  it.each(["status", "id"] as const)(
    "1045-b-04 replay after R failed (%s door): the provider's refund is recorded ONCE, the hold closes by itself as counted against the intent, more replays add nothing, the intent stays blocked",
    async (door) => {
      const t = await triedRefund();
      await receive(report(door, t));
      const holds = await openHolds(t.code.id);
      expect.soft(holds).toHaveLength(1);
      await expectRFailed(t);

      await replay(t, door, 1);
      await expectRecordedOnceAndClosed(t, holds[0]?.id ?? null);
      await replay(t, door, 2);
      await expectRecordedOnceAndClosed(t, holds[0]?.id ?? null);
    },
  );

  it("1045-b-05 R COMPLETES instead: the replay adds no fact and no journal event, the hold stays open for finance, the intent stays blocked, nothing is sent again", async () => {
    const t = await triedRefund();
    await receive(statusReport(t));
    const holds = await openHolds(t.code.id);
    expect.soft(holds, "ONE hold while R is live").toHaveLength(1);

    const done = await completeTried(t);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await refundRow(t.refundId)).status).toBe("completed");

    await replay(t, "status", 2);
    expect(
      await factAmounts(t.code.id),
      "ours is the money out: no fact",
    ).toEqual([]);
    expect(await refundEventsOfIntent(t.code.id), "no journal event").toBe(0);
    expect(
      await openHolds(t.code.id),
      "the hold stays open for finance (own never closes it)",
    ).toHaveLength(1);
    expect(await ourRefundedIdr(t.code.id)).toBe(BILL_IDR);
    await expectNewRefundsRefused(t, "R completed");
    expect(fake.calls, "no second payout").toHaveLength(t.callsBefore);
  });

  describe("race: the worker replays the stored report while R fails", () => {
    it.each([
      ["worker starts first", true],
      ["R's failure starts first", false],
    ] as const)(
      "1045-b-06 %s: never lost, never twice; a new refund is refused; replays end with ONE fact and the hold closed",
      async (_label, workerFirst) => {
        const t = await triedRefund();
        await receive(statusReport(t));

        const run = workerFirst
          ? () => Promise.all([runWorker(), failTried(t)])
          : () => Promise.all([failTried(t), runWorker()]);
        await run();
        if ((await refundRow(t.refundId)).status !== "failed")
          await expectRFailed(t);

        // Either the hold is open or the provider's refund is recorded.
        const holds = await openHolds(t.code.id);
        const recorded = await factTotal(t.code.id);
        expect(
          holds.length === 1 || recorded === BILL_IDR,
          `neither held nor recorded (holds ${holds.length}, recorded ${recorded})`,
        ).toBe(true);
        expect(holds.length).toBeLessThanOrEqual(1);
        expect(recorded).toBeLessThanOrEqual(BILL_IDR);
        await expectNewRefundsRefused(t, "after the race");
        await expectMoneyNotDoubled(t);

        await replay(t, "status", 2);
        await expectRecordedOnceAndClosed(t, null);
      },
    );
  });

  it.each(["status", "id"] as const)(
    "1045-b-07 duplicate events (%s door): the same event twice, new event ids and the worker, all at once, while R is live: ONE hold, no fact; then ONE fact after R failed",
    async (door) => {
      const t = await triedRefund();
      const same = report(door, t);
      await Promise.all([
        deliver(same),
        deliver(same),
        deliver(report(door, t)),
        deliver(report(door, t)),
        runWorker(),
      ]);
      await runWorker();
      await runWorker();

      // Status door: the report waits as ONE hold, no fact. Id door: the real
      // refund id may be recorded at once (as 1035-a -11); then at most ONE fact
      // and at most one hold. Duplicates never multiply either.
      const holds = await openHolds(t.code.id);
      const facts = await factAmounts(t.code.id);
      expect(
        holds.length,
        "duplicates keep at most ONE hold",
      ).toBeLessThanOrEqual(1);
      if (door === "status") {
        expect(holds, "duplicates keep ONE hold").toHaveLength(1);
        expect(facts, "no fact while R is live").toEqual([]);
        expect(await refundEventsOfIntent(t.code.id)).toBe(0);
      } else {
        expect(
          holds.length === 1 || facts.length === 1,
          "held or recorded, never neither",
        ).toBe(true);
        expect(
          facts.length,
          "duplicates add at most ONE fact",
        ).toBeLessThanOrEqual(1);
        expect(await refundEventsOfIntent(t.code.id)).toBe(facts.length);
      }
      await expectNewRefundsRefused(t, "R live, duplicates");

      await expectRFailed(t);
      await replay(t, door, 2);
      await expectRecordedOnceAndClosed(t, null);
    },
  );

  it("1045-b-08 another bill of the same tenant is not touched by this bill's report", async () => {
    const bystander = await triedRefund();
    const t = await triedRefund();
    await receive(statusReport(t));
    await expectRFailed(t);
    await replay(t, "status", 1);

    expect((await refundRow(bystander.refundId)).status).toBe("approved");
    expect(await providerRows(bystander.code.id)).toEqual([]);
    expect(await openHolds(bystander.code.id)).toEqual([]);
    expect(await refundEventsOfIntent(bystander.code.id)).toBe(0);
  });
});

// ===========================================================================
// Another tenant with the very same provider payment id
// ===========================================================================

async function ensureTenantB() {
  if (tenantB) return tenantB;
  const scopeB = paymentTestScope();
  await scopeB.seed(owner);
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: scopeB.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  // Same key and webhook secret as tenant A: the signature of each webhook is
  // checked against the tenant of its URL, the secrets are equal on purpose.
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
  tenantB = { scope: scopeB, integrationId: created.id, linkIds: [] };
  clearDoitWebhookSecretCache();
  return tenantB;
}

/** A paid bill of tenant B whose provider payment id is exactly `ref`. */
async function paidBillOfB(ref: string) {
  const other = await ensureTenantB();
  const theOutlet = outletIdSchema.parse(other.scope.outletId);
  const opened = await createPaymentLink(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: other.scope.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [theOutlet] },
    ),
    {
      outletId: theOutlet,
      reference: `R1045BT-${unique()}`,
      tableLabel: "A08",
      pax: 2,
      subtotalIdr: BILL_IDR,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: BILL_IDR,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  other.linkIds.push(opened.linkId);
  doit.nextId = ref;
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  doit.nextId = null;
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  // The fake keeps ONE object per id: take this tenant's copy right away.
  const payment = structuredClone(doit.payments.get(ref)!) as DoitPayment;
  const path = `/api/webhooks/payments/doit/${other.scope.tenantId}`;
  const answered = await deliverTo(path, {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.paid",
    created_at: new Date().toISOString(),
    data: { ...payment, status: "paid", amount: BILL_IDR },
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return {
    tenantId: other.scope.tenantId,
    intentId: created.body.data.id as string,
    payment,
    path,
  };
}

describe("legend-d7im9 another tenant", () => {
  it("1045-b-09 tenant A holds a retried report (R tried, no ref); tenant B has the very same provider payment id: B has no hold, is not blocked, its own report is recorded once; A's hold, failure and replay do not touch B", async () => {
    const ref = `dp_1045b_${randomBytes(8).toString("hex")}`;
    const t = await triedRefund(BILL_IDR, ref);
    const sideB = await paidBillOfB(ref);
    const bReport = () => ({
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "payment.refunded",
      created_at: new Date().toISOString(),
      data: {
        ...sideB.payment,
        status: "refunded",
        amount: BILL_IDR,
        total_amount: BILL_IDR,
      },
    });
    const bLedger = async () => ({
      holds: await anyHoldRows(sideB.tenantId),
      facts: (await providerRowsOf(sideB.tenantId, sideB.intentId)).map(
        (row) => row.amount_idr,
      ),
      events: await refundEventsOf(sideB.tenantId, sideB.intentId),
    });

    // A receives the report: its hold must not appear on B.
    await receive(statusReport(t));
    expect.soft(await openHolds(t.code.id), "A holds").toHaveLength(1);
    expect(await bLedger(), "B untouched by A's report").toEqual({
      holds: 0,
      facts: [],
      events: 0,
    });

    // B receives its own report (no refund of ours in B): recorded once, not a
    // duplicate of A's, not held because of A's live refund.
    for (let round = 0; round < 2; round += 1) {
      const answer = await deliverTo(sideB.path, bReport());
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    }
    expect(await bLedger(), "B books its own refund once").toEqual({
      holds: 0,
      facts: [BILL_IDR],
      events: 1,
    });
    expect(await factTotal(t.code.id), "A booked nothing from B's report").toBe(
      0,
    );

    // A: R fails before the replay: still refused; then one fact; B unchanged.
    await expectRFailed(t);
    await expectNewRefundsRefused(t, "A: R failed, before the replay");
    await replay(t, "status", 2);
    await expectRecordedOnceAndClosed(t, null);
    expect(await bLedger(), "B unchanged by A's replay").toEqual({
      holds: 0,
      facts: [BILL_IDR],
      events: 1,
    });
  });
});
