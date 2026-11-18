// legend-1045 race matrix M2 (CTO Retro 46, tier K "jangan sampai rugi"):
// resolving a refund-recon hold x DP credit apply x a new refund.
// Written from docs/briefs/sub-1045-refund-so3.md ("Matriks race" M2-01..07)
// and the fixtures of refund-1045-a/-b, refund-1025c-b, refund-1033-xmtih, not
// from the implementation.
//
// Invariant of every test (asserted explicitly, numbers are printed as
// `[M2-xx] ...` lines): MONEY OUT <= PAID, where
//   money out = payouts of OUR refunds that completed (payment_refunds
//               status completed) + what the provider refunded on its own
//               + DP credit that another session used from the same intent;
//   paid      = the amount of the paid transaction (DP: the deposit).
// Plus: provider facts in total <= paid, and a new refund after the provider's
// report is refused (409/422) or at least pays out nothing.
//
// Assumptions (the brief does not fix them):
//  - "live_own hold" = the hold a received provider report files while our
//    refund R is in flight without a reference (the F2 window, as 1045-b).
//  - "R fails" = the lookup the retry route uses answers `failed`
//    (fake.setStatus(refund:<id>) + POST /refunds/:id/retry, as 1045-b).
//    R failing after a payout attempt also files the own_refund_failed_unverified
//    hold (F1); that hold is finance's and is NOT what "live hold" means below.
//  - "Two orders" = Promise.all with the first / second call listed first.
//    Promise.all cannot force the database order, so each race ends in a
//    settle phase (rejected steps are retried once by finance, replays run) and
//    only the END STATE is asserted. An in-flight resolve answering 409/422 is
//    legal (counted_against_intent with our refund live is refused, 1025c-C2).
//  - M2-03: the late `refunded` webhook after our new refund R2 completed is
//    the provider's echo of R2: the real 100.000 must be on the books exactly
//    once (ours + provider facts == paid), never zero, never twice.
//  - M2-04/05/06 (DP): DP 100.000, session A consumed 60.000, 40.000 is
//    customer credit. The refund is seeded (the API refuses to refund a DP that
//    was applied to a seated bill, as 1025c-B / xmtih). "Credit used" =
//    depositCreditForSession of the target session after everything settled.
//    Rule asserted (1033 + 1025c): credit <= max(0, DP - consumed - provider
//    refund - open hold), unless an open credit-overuse hold covers the surplus;
//    and credit + provider refund <= DP unless a hold covers the excess.
//  - M2-05 after `counted_against_intent` of the failed-refund hold the guest
//    can take NO credit: the provider is taken to have refunded that money.
//  - M2-07: two or three concurrent resolve requests (one repeating an
//    idempotency key) end with exactly ONE provider fact of the hold amount.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1045-e-race-resolve-credit.test.ts" heavy pnpm test

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
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { createRefund } from "../services/payment-admin.service.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
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
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner as floorOwner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
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
const OWN_FAILED = "own_refund_failed_unverified";

const apiKey = `doit-key-1045e-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045e-${randomBytes(16).toString("hex")}`;

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
const say = (line: string) => console.log(`[M2] ${line}`);
async function dump(label: string, intentId: string) {
  const { rows } = await owner.query(
    `SELECT reason, amount_idr::text AS amt, resolved_at IS NOT NULL AS closed, resolution, provider_refund_id
       FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY flagged_at, id`,
    [tenantId, intentId],
  );
  const facts = await owner.query(
    `SELECT provider_refund_id, refund_id_kind, amount_idr::text AS amt FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  say(
    `DUMP ${label}: holds ${JSON.stringify(rows)} facts ${JSON.stringify(facts.rows)}`,
  );
}

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
// Fake DOIT server (same contract as refund-1045-b)
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

  private need(id: string): DoitPayment {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return payment;
  }

  settle(id: string, amount: number = BILL_IDR): void {
    const payment = this.need(id);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** The provider gave the money back (as a fact of the provider's world). */
  refund(id: string): void {
    this.need(id).status = "refunded";
  }

  /** A `payment.<status>` webhook body for the payment. */
  eventFor(id: string, status: "paid" | "refunded" | "expired") {
    const payment = this.need(id);
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
// Fixtures (gateway world)
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

  // Back-office owner: files refunds, resolves holds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1045e owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves and retries refunds.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1045e approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

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

/** A fresh bill with one pending QRIS code. */
async function newCode(amountIdr: number = BILL_IDR): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1045E-${unique()}`,
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
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

const paid = (code: Code, amount: number = BILL_IDR) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

const pollAt = (at: Date) =>
  pollPendingGatewayIntents(tenantContext(), at, 100).catch(() => null);
/** The poller, soon and far in the future: no schedule window hides anything. */
async function pollRounds() {
  await pollAt(new Date(Date.now() + 3 * 60 * MINUTE));
  await pollAt(new Date(Date.now() + 400 * 24 * 60 * MINUTE));
}

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

// ---------------------------------------------------------------------------
// Observations (gateway world)
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

const resolveHold = (
  holdId: string,
  resolution: "not_this_intent" | "counted_against_intent",
  idempotencyKey: string = key("hold"),
) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey,
      resolution,
      note: "Dicek di dashboard provider.",
    });

async function factRows(intentId: string) {
  const { rows } = await owner.query<{
    provider_refund_id: string;
    amount_idr: string;
  }>(
    `SELECT provider_refund_id, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.provider_refund_id,
    amount: Number(row.amount_idr),
  }));
}
const factAmounts = async (intentId: string) =>
  (await factRows(intentId)).map((row) => row.amount);
const factTotal = async (intentId: string) =>
  (await factAmounts(intentId)).reduce((sum, amount) => sum + amount, 0);

const refundEventsOfIntent = (intentId: string) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [tenantId, intentId],
  );

/** Payouts of OUR refunds that completed: money really out through us. */
async function ourCompletedIdr(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

async function refundRow(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    payout_attempts: number;
  }>(
    `SELECT status, provider_ref, payout_attempts
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId],
  );
  return rows[0]!;
}

type HoldRow = {
  id: string;
  reason: string;
  amount_idr: number;
  resolved_at: Date | null;
  resolution: string | null;
};

async function holdsOf(intentId: string): Promise<HoldRow[]> {
  const { rows } = await owner.query<
    Omit<HoldRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, reason, amount_idr::text AS amount_idr, resolved_at, resolution
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY flagged_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}
/** Open holds of the report window (F2); not the failed-refund holds of F1. */
const liveHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter(
    (hold) => hold.resolved_at === null && hold.reason !== OWN_FAILED,
  );
const closedLiveHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter(
    (hold) => hold.resolved_at !== null && hold.reason !== OWN_FAILED,
  );
const ownFailedHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((hold) => hold.reason === OWN_FAILED);

// ---------------------------------------------------------------------------
// Scenario building blocks (gateway world)
// ---------------------------------------------------------------------------

type Tried = {
  code: Code;
  refundId: string;
  /** What the provider refunded on its own for this bill (its own world). */
  providerSelfIdr: number;
  /** Provider (refund) calls made so far: nothing may add to it afterwards. */
  callsBefore: number;
};

/**
 * Bill A paid; our refund R of the whole bill was TRIED (the provider call
 * timed out): R is `approved`, payout attempted, no provider reference. When
 * `providerRefunds`, the provider itself refunds A (its own world).
 */
async function tried(providerRefunds: boolean): Promise<Tried> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, BILL_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.status, "premise: R is in flight").toBe("approved");
  expect(row.provider_ref, "premise: R has no provider ref").toBeNull();
  expect(row.payout_attempts, "premise: R was tried").toBeGreaterThan(0);
  if (providerRefunds) doit.refund(code.providerRef);
  return {
    code,
    refundId,
    providerSelfIdr: providerRefunds ? BILL_IDR : 0,
    callsBefore: fake.calls.length,
  };
}

/** Provider report, status door: the full `refunded` status of the bill. */
const statusReport = (t: Tried) =>
  doit.eventFor(t.code.providerRef, "refunded");

async function receive(body: object) {
  const answer = await deliver(body);
  expect(answer.status, "the signed report is not rejected").not.toBe(401);
  expect(answer.status, "the signed report is not rejected").not.toBe(403);
  return answer;
}

/** R is declined by the provider (lookup answer), via the retry route. */
async function failTried(t: Tried) {
  fake.setStatus(`refund:${t.refundId}`, {
    status: "failed",
    providerRef: `PR-DECLINED-${unique()}`,
    code: "declined",
  });
  return retryRefund(t.refundId);
}

/** R is completed by the provider (lookup answer): our payout really went out. */
async function completeTried(t: Tried) {
  fake.setStatus(`refund:${t.refundId}`, {
    status: "succeeded",
    providerRef: `PR-DONE-${unique()}`,
  });
  return retryRefund(t.refundId);
}

/** The report, the worker and the poller run again. */
async function replay(t: Tried, rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    await receive(statusReport(t));
    await pollRounds();
    await runWorker();
  }
}

/** A new refund is refused (409/422) and nothing is paid out. */
async function expectNewRefundsRefused(
  t: Tried | { code: Code; callsBefore: number },
  why: string,
) {
  for (const amount of [BILL_IDR, 1_000]) {
    const attempt = await manualRefund(t.code.id, amount);
    let probe = "";
    if (attempt.status === 201) {
      const approved = await approveRefund(attempt.body.data.id as string);
      probe = ` | probe: approve -> HTTP ${approved.status}, gateway calls +${fake.calls.length - t.callsBefore}`;
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

/** MONEY OUT <= PAID, the explicit invariant of the matrix. */
async function expectMoneyOutWithinPaid(
  id: string,
  providerSelfIdr: number,
  label: string,
) {
  const ours = await ourCompletedIdr(id);
  const facts = await factTotal(id);
  const out = ours + providerSelfIdr;
  say(
    `${label}: money out ${out} (our completed payouts ${ours} + provider's own refund ${providerSelfIdr}) vs paid ${BILL_IDR}; provider facts on the books ${facts}`,
  );
  expect(out, `${label}: money out (${out}) exceeds paid`).toBeLessThanOrEqual(
    BILL_IDR,
  );
  expect(
    facts,
    `${label}: provider facts exceed what was paid`,
  ).toBeLessThanOrEqual(BILL_IDR);
}

// ---------------------------------------------------------------------------
// M2-01 .. M2-03, M2-07 (gateway world)
// ---------------------------------------------------------------------------

describe("M2 hold resolve x our refund x a new refund (gateway world)", () => {
  it.each([
    ["resolve is started first", true],
    ["R's failure is started first", false],
  ] as const)(
    "M2-01 live_own hold open, finance resolves counted_against_intent at the same time as R fails (%s): the provider's Rp100.000 is booked ONCE, a new refund is refused, no payout",
    async (_label, resolveFirst) => {
      const t = await tried(true);
      await receive(statusReport(t));
      const live = await liveHolds(t.code.id);
      expect(
        live,
        "premise: ONE live hold from the received report",
      ).toHaveLength(1);
      const hold = live[0]!;
      await expectNewRefundsRefused(t, "R live, hold open");

      const [first, second] = resolveFirst
        ? await Promise.all([
            resolveHold(hold.id, "counted_against_intent"),
            failTried(t),
          ])
        : await Promise.all([
            failTried(t),
            resolveHold(hold.id, "counted_against_intent"),
          ]);
      const resolved = resolveFirst ? first : second;
      expect(
        [200, 409, 422],
        `the concurrent resolve answers a clean 200 or a refusal: ${JSON.stringify(resolved.body)}`,
      ).toContain(resolved.status);

      await dump(
        `M2-01 ${_label} after race (resolve ${resolved.status} ${JSON.stringify(resolved.body)})`,
        t.code.id,
      );
      // Settle: R failed; finance repeats a refused resolve.
      if ((await refundRow(t.refundId)).status !== "failed") {
        const again = await failTried(t);
        expect(again.status, JSON.stringify(again.body)).toBe(200);
      }
      expect((await refundRow(t.refundId)).status, "R failed").toBe("failed");
      if ((await liveHolds(t.code.id)).length > 0) {
        const again = await resolveHold(hold.id, "counted_against_intent");
        // Soft: finance must be able to close the open hold once R failed
        // (1035-a); the money assertions below still run when it cannot.
        expect
          .soft(
            again.status,
            `finance's resolve of the still open hold after R failed: ${JSON.stringify(again.body)}`,
          )
          .toBe(200);
      }
      await replay(t, 2);

      expect(await liveHolds(t.code.id), "the live hold is closed").toEqual([]);
      const closed = (await closedLiveHolds(t.code.id)).find(
        (item) => item.id === hold.id,
      );
      expect(closed?.resolution).toBe("counted_against_intent");
      expect(
        await factAmounts(t.code.id),
        "the provider's refund is on the books exactly once",
      ).toEqual([BILL_IDR]);
      expect(await refundEventsOfIntent(t.code.id), "one journal event").toBe(
        1,
      );
      const blocked = await manualRefund(t.code.id, BILL_IDR);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
      expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
      await expectNewRefundsRefused(t, "after the race");
      await expectMoneyOutWithinPaid(
        t.code.id,
        t.providerSelfIdr,
        `M2-01 (${_label})`,
      );
    },
  );

  it.each([
    ["resolve is started first", true],
    ["R's completion is started first", false],
  ] as const)(
    "M2-02 mismatch hold open, finance resolves not_this_intent at the same time as R completes (%s): the guest gets Rp100.000 once, a new refund is refused, no second payout",
    async (_label, resolveFirst) => {
      // A hold that names ANOTHER intent's refund is open on the bill (a live_own
      // hold only accepts counted_against_intent: 422, observed). The provider
      // did NOT refund the bill: R is the only money out.
      const t = await tried(false);
      const holdId = randomUUID();
      await owner.query(
        `INSERT INTO refund_recon_holds
           (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, provider_refund_id_kind, amount_idr, reason, provider_payment_ref)
         VALUES ($1, $2, $3, $4, $5, 'provider', $6, 'Reference names another intent', $7)`,
        [
          holdId,
          tenantId,
          t.code.id,
          randomUUID(),
          `rf_${randomBytes(6).toString("hex")}`,
          BILL_IDR,
          t.code.providerRef,
        ],
      );
      expect(
        (await liveHolds(t.code.id)).map((hold) => hold.id),
        "premise: the mismatch hold is open",
      ).toEqual([holdId]);
      await expectNewRefundsRefused(t, "R live, mismatch hold open");

      const [first, second] = resolveFirst
        ? await Promise.all([
            resolveHold(holdId, "not_this_intent"),
            completeTried(t),
          ])
        : await Promise.all([
            completeTried(t),
            resolveHold(holdId, "not_this_intent"),
          ]);
      const resolved = resolveFirst ? first : second;
      const completed = resolveFirst ? second : first;
      expect(
        [200, 409, 422],
        `resolve: ${JSON.stringify(resolved.body)}`,
      ).toContain(resolved.status);
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      if ((await liveHolds(t.code.id)).length > 0) {
        const again = await resolveHold(holdId, "not_this_intent");
        expect(again.status, JSON.stringify(again.body)).toBe(200);
      }
      expect((await refundRow(t.refundId)).status, "R completed").toBe(
        "completed",
      );
      await replay(t, 2);

      expect(
        (await closedLiveHolds(t.code.id)).find((item) => item.id === holdId)
          ?.resolution,
      ).toBe("not_this_intent");
      expect(fake.calls, "completing R sent nothing more").toHaveLength(
        t.callsBefore,
      );
      expect(await ourCompletedIdr(t.code.id), "R is the money out").toBe(
        BILL_IDR,
      );
      await dump(`M2-02 ${_label} end`, t.code.id);
      await expectNewRefundsRefused(t, "R completed, hold resolved");
      await expectMoneyOutWithinPaid(
        t.code.id,
        t.providerSelfIdr,
        `M2-02 (${_label})`,
      );
    },
  );

  it("M2-03 own_refund_failed_unverified hold (R failed), finance resolves not_this_intent, a new refund runs ONCE; the late provider `refunded` webhook then adds no payout and the money is on the books once", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_IDR);
    const refundId = filed.body.data.id as string;
    fake.enqueue("pending");
    expect((await approveRefund(refundId)).status).toBe(200);
    const ref = (await refundRow(refundId)).provider_ref;
    expect(ref, "premise: R sent (ref stored)").toBeTruthy();
    const failed = await applyRefundProviderUpdate(tenantContext(), {
      providerRef: ref!,
      status: "failed",
      code: "declined",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed, "R fails").toBeNull();
    expect((await refundRow(refundId)).status).toBe("failed");
    const afterFailure = fake.calls.length;

    const held = await ownFailedHolds(code.id);
    expect(held, "premise: ONE failed-refund hold").toHaveLength(1);
    await expectNewRefundsRefused(
      { code, callsBefore: afterFailure },
      "failed-refund hold open",
    );

    // Finance checked the provider dashboard: not refunded.
    const resolved = await resolveHold(held[0]!.id, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    // A new refund runs, once.
    const again = await manualRefund(code.id, BILL_IDR);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const againId = again.body.data.id as string;
    const approved = await approveRefund(againId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "the new refund is sent once").toHaveLength(
      afterFailure + 1,
    );
    expect((await refundRow(againId)).status).toBe("completed");

    // The provider's late webhook: the bill is refunded (the echo of R2).
    doit.refund(code.providerRef);
    for (let round = 0; round < 2; round += 1) {
      await receive(doit.eventFor(code.providerRef, "refunded"));
      await pollRounds();
      await runWorker();
    }

    expect(fake.calls, "the late webhook pays out nothing").toHaveLength(
      afterFailure + 1,
    );
    const ours = await ourCompletedIdr(code.id);
    const facts = await factTotal(code.id);
    say(
      `M2-03: our completed payouts ${ours}, provider facts ${facts}, paid ${BILL_IDR}`,
    );
    expect(ours, "one payout of the bill").toBe(BILL_IDR);
    expect(
      ours + facts,
      "the real Rp100.000 is on the books exactly once (ours or a fact), never twice",
    ).toBe(BILL_IDR);
    expect(await refundEventsOfIntent(code.id)).toBeLessThanOrEqual(1);
    await expectNewRefundsRefused(
      { code, callsBefore: afterFailure + 1 },
      "after the late webhook",
    );
    await expectMoneyOutWithinPaid(code.id, 0, "M2-03");
  });

  it("M2-07 two concurrent resolve requests (plus one repeating an idempotency key) of the same hold book ONE provider fact", async () => {
    const t = await tried(true);
    await receive(statusReport(t));
    const live = await liveHolds(t.code.id);
    expect(live, "premise: ONE live hold").toHaveLength(1);
    const hold = live[0]!;
    // R fails first so that counted_against_intent is allowed.
    const failedAnswer = await failTried(t);
    expect(failedAnswer.status, JSON.stringify(failedAnswer.body)).toBe(200);
    expect((await refundRow(t.refundId)).status).toBe("failed");

    await dump("M2-07 before resolves", t.code.id);
    const sameKey = key("hold");
    const answers = await Promise.all([
      resolveHold(hold.id, "counted_against_intent", sameKey),
      resolveHold(hold.id, "counted_against_intent"),
      resolveHold(hold.id, "counted_against_intent", sameKey),
    ]);
    say(
      `M2-07 answers ${JSON.stringify(answers.map((a) => [a.status, a.body]))}`,
    );
    await dump("M2-07 after resolves", t.code.id);
    for (const answer of answers)
      expect(
        [200, 409, 422],
        `no server error from a duplicate resolve: ${answer.status} ${JSON.stringify(answer.body)}`,
      ).toContain(answer.status);
    expect
      .soft(
        answers.some((answer) => answer.status === 200),
        "one of them resolved the open hold (R failed)",
      )
      .toBe(true);
    // Money first: whatever the answers, replays close what finance could not.
    await replay(t, 1);

    expect(
      await factAmounts(t.code.id),
      "ONE fact of the hold amount, however many requests",
    ).toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(t.code.id), "one journal event").toBe(1);
    expect(await liveHolds(t.code.id)).toEqual([]);

    // A later replay or another resolve adds nothing.
    await replay(t, 1);
    await resolveHold(hold.id, "counted_against_intent");
    expect(await factAmounts(t.code.id)).toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(t.code.id)).toBe(1);
    await expectNewRefundsRefused(t, "after the duplicate resolves");
    await expectMoneyOutWithinPaid(t.code.id, t.providerSelfIdr, "M2-07");
  });
});

// ===========================================================================
// DP world: resolve hold x credit apply x a new refund (M2-04 .. M2-06)
// Fixtures follow refund-1025c-b-credit-vs-provider-refund and
// refund-1033-xmtih-hold-lock (seeded tenant, floor helpers).
// ===========================================================================

const dpOutlet = outletIdSchema.parse(seededOutletA);
const dpScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const CREDIT_HOLD = "credit_used_before_provider_refund";
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const intentIds: string[] = [];
const dpLinkIds: string[] = [];
const profileIds: string[] = [];
const orderIds: string[] = [];
const sessionIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let dpStaff: Staff;
let receiptEntity: string;
let receiptPeriod: string;
const receiptAccounts = [randomUUID(), randomUUID()];
const receiptEntries: string[] = [];
let dpMfaDone = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedOriginalReceipt(intentId: string, amount: number) {
  const journalId = randomUUID();
  receiptEntries.push(journalId);
  const c = await floorOwner.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1045-E',$8,$9)`,
      [
        journalId,
        seededTenantId,
        receiptEntity,
        dpOutlet,
        new Date().toISOString().slice(0, 10),
        receiptPeriod,
        intentId,
        `aj:receipt:${intentId}`,
        "0".repeat(64),
      ],
    );
    await c.query(
      `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id) VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
      [
        seededTenantId,
        journalId,
        receiptAccounts[0],
        receiptAccounts[1],
        amount,
        dpOutlet,
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await floorOwner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, '1045-E Customer', 'active', now())`,
    [id, seededTenantId],
  );
  return id;
}

async function newSession() {
  const zone = await createZone(dpStaff.client);
  zoneIds.push(zone.id);
  const table = await createTable(dpStaff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(dpStaff.client, table.id);
  const opened = await openOrJoinTableSession(dpScope(), {
    qrToken: qr.token,
    pax: 2,
    deviceHash: `t1045e-${randomUUID()}`,
  });
  sessionIds.push(opened.session.id);
  return { sessionId: opened.session.id, zoneId: zone.id as string };
}

async function addOrder(
  sessionId: string,
  total: number,
  deposit: number,
  profileId: string | null,
) {
  const id = randomUUID();
  orderIds.push(id);
  await floorOwner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $6, 'sent', '2026-11-12', now(), $7, $8)`,
    [
      id,
      seededTenantId,
      dpOutlet,
      `T1045E-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

type Deposit = Awaited<ReturnType<typeof paidDeposit>>;

/** Paid DP 100.000 seated on session A whose bill is 60.000 (DP covers it). */
async function paidDeposit() {
  const profileId = await newProfile();
  const total = 60_000;
  const deposit = 100_000;
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const providerRef = `t1045e-evidence-${intentId}`;
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  dpLinkIds.push(linkId);
  await floorOwner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1045-E Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      dpOutlet,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1045e",
        depositRequirement: "required",
        depositAmountIdr: deposit,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      session.sessionId,
    ],
  );
  await floorOwner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1045e-test')`,
    [
      linkId,
      seededTenantId,
      dpOutlet,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1045E-${linkId.slice(0, 8)}`,
      deposit,
    ],
  );
  await floorOwner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        provider_ref, amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, $8, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now())`,
    [
      intentId,
      seededTenantId,
      dpOutlet,
      linkId,
      reservationId,
      providerRef,
      deposit,
      `t1045e-pay-${intentId}`,
    ],
  );
  await floorOwner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, dpOutlet, intentId, providerRef, deposit],
  );
  await floorOwner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, intentId, linkId],
  );
  await floorOwner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  await floorOwner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      seededTenantId,
      dpOutlet,
      reservationId,
      session.sessionId,
      intentId,
      deposit,
    ],
  );
  await addOrder(session.sessionId, total, Math.min(deposit, total), profileId);
  settlements.set(session.sessionId, { total, paid: deposit });
  await seedOriginalReceipt(intentId, deposit);
  return {
    ...session,
    reservationId,
    intentId,
    profileId,
    providerRef,
    deposit,
    total,
  };
}

const closeSession = (sessionId: string) =>
  closeTableSession(
    dpScope(),
    sessionId,
    closeTableSessionInputSchema.parse({
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    dpStaff.userId,
  );

async function remainders(reservationId: string) {
  const { rows } = await floorOwner.query<{
    kind: string;
    amount_idr: string;
    remaining_idr: string;
  }>(
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1 ORDER BY kind, amount_idr, remaining_idr",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

async function creditUses(sessionId: string) {
  const { rows } = await floorOwner.query<{ row: string }>(
    `SELECT to_jsonb(u)::text AS row FROM reservation_customer_credit_uses u
      WHERE tenant_id = $1 AND table_session_id = $2 ORDER BY 1`,
    [seededTenantId, sessionId],
  );
  return rows.map((r) => r.row);
}

const applyCredit = (
  profileId: string,
  sessionId: string,
  amount: number,
  idempotencyKey: string = randomUUID(),
) =>
  applyReservationCustomerCredit(
    dpScope(),
    dpStaff.userId,
    dpOutlet,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    idempotencyKey,
  );

type Applied = { ok: true } | { ok: false; code?: string; status?: number };
/** An apply that may be refused: a 4xx refusal is the answer, never a crash. */
async function tryApply(
  profileId: string,
  sessionId: string,
  amount: number,
): Promise<Applied> {
  try {
    await applyCredit(profileId, sessionId, amount);
    return { ok: true };
  } catch (error) {
    const known = error as { code?: string; status?: number };
    expect(
      known.status === undefined || (known.status >= 400 && known.status < 500),
      `the apply is refused cleanly, not a crash: ${String(error)}`,
    ).toBe(true);
    return { ok: false, code: known.code, status: known.status };
  }
}

/** A second visit of the same customer with an open bill of `total`, covered. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  settlements.set(target.sessionId, { total, paid: total });
  return target.sessionId;
}

const effectiveCredit = (sessionId: string) =>
  withTenant(db, dpScope(), (tx) =>
    depositCreditForSession(
      tx,
      tenantIdSchema.parse(seededTenantId),
      sessionId,
    ),
  );

/** DP 100k, A consumed 60k and closed: 40k credit exists for the customer. */
async function closedSourceWithCredit() {
  const d = await paidDeposit();
  await closeSession(d.sessionId);
  expect(await remainders(d.reservationId)).toEqual([
    { kind: "customer_credit", amount: 40_000, remaining: 40_000 },
  ]);
  return d;
}

type DpHold = {
  id: string;
  amount: number;
  reason: string;
  resolvedAt: Date | null;
};
async function dpHolds(intentId: string): Promise<DpHold[]> {
  const { rows } = await floorOwner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    resolved_at: Date | null;
  }>(
    `SELECT id, amount_idr::text, reason, resolved_at
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY flagged_at, id`,
    [seededTenantId, intentId],
  );
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount_idr),
    reason: r.reason,
    resolvedAt: r.resolved_at,
  }));
}
const openCreditHoldIdr = async (intentId: string) =>
  (await dpHolds(intentId))
    .filter((h) => h.resolvedAt === null && h.reason.startsWith(CREDIT_HOLD))
    .reduce((sum, h) => sum + h.amount, 0);

async function dpFacts(intentId: string) {
  const { rows } = await floorOwner.query<{ n: string; idr: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(amount_idr), 0)::text AS idr
       FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [seededTenantId, intentId],
  );
  return { rows: Number(rows[0]!.n), idr: Number(rows[0]!.idr) };
}

async function ourRefundRows(intentId: string) {
  const { rows } = await floorOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [seededTenantId, intentId],
  );
  return Number(rows[0]!.n);
}

/** The provider refunds `amountIdr` of the DP payment (recorder, force). */
function recordRefund(
  d: Pick<Deposit, "intentId" | "providerRef">,
  amountIdr: number,
  opts: { whole?: boolean } = {},
) {
  const context = dpScope();
  const whole = opts.whole ?? false;
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: whole
          ? d.providerRef
          : `rf_${randomUUID().slice(0, 12)}`,
        refundIdKind: whole ? "synthetic_full" : "provider",
        providerPaymentRef: d.providerRef,
        amountIdr,
        source: whole ? "refund_webhook" : "payment_webhook",
        expectedIntentId: d.intentId,
        force: true,
      },
      new Date(),
    ),
  );
}

/**
 * Our refund of the DP sent to the provider (approved, ref stored, payout
 * attempted), seeded: the API refuses to refund a DP applied to a seated bill.
 */
async function seedSentRefund(d: Deposit, amountIdr: number) {
  const providerRef = `FAKE-RF-${randomBytes(6).toString("hex")}`;
  await floorOwner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, '1045-E refund sent', 'approved',
             $6, $8, now(), NULL, $7, 1)`,
    [
      randomUUID(),
      seededTenantId,
      dpOutlet,
      d.intentId,
      amountIdr,
      dpStaff.userId,
      providerRef,
      randomUUID(),
    ],
  );
  return providerRef;
}

/** Our DP refund of `amountIdr` was sent, then fails: the F1 hold appears. */
async function failedOwnDpRefund(d: Deposit, amountIdr: number) {
  const ref = await seedSentRefund(d, amountIdr);
  const failed = await applyRefundProviderUpdate(dpScope(), {
    providerRef: ref,
    status: "failed",
    code: "declined",
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failed, "R of the DP fails").toBeNull();
  const holds = (await dpHolds(d.intentId)).filter(
    (h) => h.resolvedAt === null && h.reason === OWN_FAILED,
  );
  expect(
    holds,
    "premise: ONE open failed-refund hold on the DP intent",
  ).toHaveLength(1);
  expect(holds[0]!.amount).toBe(amountIdr);
  return holds[0]!;
}

const requestRefund = (intentId: string, amount: number) => {
  const idempotencyKey = randomUUID();
  return createRefund(
    dpScope(),
    dpStaff.userId,
    {
      idempotencyKey,
      paymentIntentId: intentId,
      amountIdr: idr(amount),
      reason: "1045-E new DP refund",
    },
    idempotencyKey,
  );
};

async function resolveHoldHttp(
  holdId: string,
  resolution: "not_this_intent" | "counted_against_intent",
) {
  if (!dpMfaDone) {
    await verifySessionMfa(dpStaff.email);
    dpMfaDone = true;
  }
  return dpStaff.client
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: `hold-${randomUUID()}`,
      resolution,
      note: "Dicocokkan dengan mutasi bank provider",
    });
}

/**
 * Credit rule: the credit the guest can use stays within the net DP
 * (DP - consumed - provider refund), or an open credit-overuse hold covers the
 * surplus; and credit + provider refund never exceed the DP unless a hold
 * covers the excess.
 */
async function expectCreditWithinNet(
  d: Deposit,
  credit: number,
  refund: number,
  label: string,
) {
  const hold = await openCreditHoldIdr(d.intentId);
  const net = Math.max(0, d.deposit - d.total - refund);
  const surplus = Math.max(0, credit - net);
  const excess = Math.max(0, credit + refund - d.deposit);
  say(
    `${label}: DP ${d.deposit}, consumed ${d.total}, provider refund ${refund}, credit used by the guest ${credit}, net DP left ${net}, credit hold ${hold}; credit + refund = ${credit + refund}`,
  );
  expect(
    hold,
    `${label}: credit ${credit} above net ${net} must be held (surplus ${surplus})`,
  ).toBeGreaterThanOrEqual(surplus);
  expect(
    hold,
    `${label}: credit + provider refund (${credit + refund}) above the DP (${d.deposit}) must be held`,
  ).toBeGreaterThanOrEqual(excess);
}

// --- barrier: a credit apply stalled after it took its advisory locks --------

async function whileApplyStalled<T>(
  d: Deposit,
  target: string,
  amount: number,
  body: (keys: string[]) => Promise<T>,
): Promise<T> {
  const gate = await floorOwner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await gate.query("ROLLBACK");
    gate.release();
  };
  let applying: Promise<unknown> = Promise.resolve();
  try {
    // SHARE mode blocks the apply's writes only; its reads and locks pass.
    await gate.query("BEGIN");
    await gate.query(
      "LOCK TABLE reservation_customer_credit_uses, reservation_deposit_remainders IN SHARE MODE",
    );
    applying = applyCredit(d.profileId, target, amount);
    applying.catch(() => undefined);
    let keys: string[] = [];
    const deadline = Date.now() + 15_000;
    while (keys.length === 0) {
      if (Date.now() > deadline)
        throw new Error(
          "premise: the credit apply never stalled holding advisory locks",
        );
      const { rows } = await floorOwner.query<{ key: string }>(
        `SELECT l.classid::text || ':' || l.objid::text || ':' || l.objsubid::text AS key
           FROM pg_stat_activity a
           JOIN pg_locks l ON l.pid = a.pid
          WHERE a.datname = current_database()
            AND a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock' AND a.wait_event = 'relation'
            AND l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock'`,
      );
      keys = rows.map((r) => r.key);
      if (keys.length === 0) await sleep(50);
    }
    return await body(keys);
  } finally {
    await release();
    await Promise.allSettled([applying]);
  }
}

async function queuedOn(keys: string[]) {
  const { rows } = await floorOwner.query<{ key: string }>(
    `SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
       FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return rows.some((r) => keys.includes(r.key));
}

describe("M2 DP credit x provider report x a new refund (DP world)", () => {
  beforeAll(async () => {
    dpStaff = await staffWithRole(app, {
      template: "owner",
      label: "1045-E DP Owner",
    });
    const entity = await floorOwner.query(
      "SELECT legal_entity_id FROM outlets WHERE id=$1",
      [dpOutlet],
    );
    receiptEntity = entity.rows[0].legal_entity_id;
    for (const [i, type, group] of [
      [0, "asset", "current_asset"],
      [1, "liability", "current_liability"],
    ] as const)
      await floorOwner.query(
        `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1045-E DP receipt',$5,$6)`,
        [
          receiptAccounts[i],
          seededTenantId,
          receiptEntity,
          `987.${i + 1}`,
          type,
          group,
        ],
      );
    await floorOwner.query(
      `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
    );
    receiptPeriod = (
      await floorOwner.query(
        "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
        [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
      )
    ).rows[0].id;
    setTableSessionSettlementLookup(async ({ sessionId }) => {
      const s = settlements.get(sessionId);
      return s ? { billTotalIdr: idr(s.total), paidIdr: idr(s.paid) } : null;
    });
  });

  afterAll(async () => {
    setTableSessionSettlementLookup(null);
    const client = await floorOwner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM journal_lines WHERE entry_id=ANY($1::uuid[]) OR entry_id IN(SELECT id FROM journal_entries WHERE reversal_of=ANY($1::uuid[]))",
        [receiptEntries],
      );
      await client.query(
        "DELETE FROM journal_entries WHERE id=ANY($1::uuid[]) OR reversal_of=ANY($1::uuid[])",
        [receiptEntries],
      );
      await client.query(
        "DELETE FROM chart_of_accounts WHERE id=ANY($1::uuid[])",
        [receiptAccounts],
      );
      for (const table of ["pos_deposit_refunds", "pos_order_refunds"])
        await client.query(
          `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
          [orderIds],
        );
      for (const table of [
        "reservation_credit_recon_flags",
        "reservation_customer_credit_uses",
        "reservation_deposit_remainders",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND table_session_id = ANY($2::uuid[])`,
          [seededTenantId, sessionIds],
        );
      await client.query(
        "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id IN (SELECT id::text FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[]))",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
        orderIds,
      ]);
      await client.query(
        "DELETE FROM reservation_deposit_allocations WHERE reservation_id = ANY($1::uuid[])",
        [reservationIds],
      );
      await client.query(
        "DELETE FROM reservations WHERE id = ANY($1::uuid[])",
        [reservationIds],
      );
      await client.query(
        "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_links WHERE id = ANY($1::uuid[])",
        [dpLinkIds],
      );
      await client.query(
        "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
        [profileIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
    await floorOwner.end();
  });

  it("M2-04a the provider's full `refunded` report and a credit apply of 40.000 race (apply holds the deposit-intent lock first, the recorder queues behind it): credit + provider refund stay within the DP, or the surplus is held", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);

    let recording: Promise<unknown> = Promise.resolve();
    let recorded = false;
    await whileApplyStalled(d, b, 40_000, async (keys) => {
      recording = recordRefund(d, d.deposit, { whole: true }).then((out) => {
        recorded = true;
        return out;
      });
      recording.catch(() => undefined);
      // Wait until the recorder is queued behind the apply (or already done).
      const deadline = Date.now() + 15_000;
      while (!recorded && !(await queuedOn(keys))) {
        if (Date.now() > deadline)
          throw new Error("premise: the recorder neither queued nor finished");
        await sleep(50);
      }
    });
    await recording;

    const credit = await effectiveCredit(b);
    await expectCreditWithinNet(d, credit, d.deposit, "M2-04a");
    expect(await dpFacts(d.intentId)).toEqual({ rows: 1, idr: d.deposit });
  });

  it("M2-04b the provider's full `refunded` report is booked first, then the guest applies 40.000: the credit is refused and no credit is used", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    const remaindersBefore = await remainders(d.reservationId);

    await recordRefund(d, d.deposit, { whole: true });
    const applied = await tryApply(d.profileId, b, 40_000);

    expect(
      applied.ok,
      "no credit from money the provider already refunded",
    ).toBe(false);
    expect(await effectiveCredit(b)).toBe(0);
    expect(await creditUses(b)).toEqual([]);
    expect(await remainders(d.reservationId)).toEqual(remaindersBefore);
    await expectCreditWithinNet(d, 0, d.deposit, "M2-04b");
  });

  it.each([
    ["apply is started first", true],
    ["the report is started first", false],
  ] as const)(
    "M2-04c unforced race (%s): whatever the database order, credit + provider refund stay within the DP, or the surplus is held",
    async (_label, applyFirst) => {
      const d = await closedSourceWithCredit();
      const b = await targetSession(d.profileId, 40_000);

      const results = applyFirst
        ? await Promise.allSettled([
            tryApply(d.profileId, b, 40_000),
            recordRefund(d, d.deposit, { whole: true }),
          ])
        : await Promise.allSettled([
            recordRefund(d, d.deposit, { whole: true }),
            tryApply(d.profileId, b, 40_000),
          ]);
      for (const result of results)
        expect(
          result.status,
          `no step crashes: ${JSON.stringify(result)}`,
        ).toBe("fulfilled");

      const credit = await effectiveCredit(b);
      await expectCreditWithinNet(d, credit, d.deposit, `M2-04c ${_label}`);
      expect(await dpFacts(d.intentId)).toEqual({ rows: 1, idr: d.deposit });
    },
  );

  it("M2-05 our DP refund R of 40.000 was sent and FAILS: the failed-refund hold limits the credit (apply refused before finance resolves); after finance resolves counted_against_intent the guest still gets no credit from money the provider refunded", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    const remaindersBefore = await remainders(d.reservationId);
    const hold = await failedOwnDpRefund(d, 40_000);

    // Before finance decides: the open hold takes the whole 40.000 credit.
    const before = await tryApply(d.profileId, b, 40_000);
    expect(
      before.ok,
      "credit refused while the failed-refund hold is open",
    ).toBe(false);
    expect(await effectiveCredit(b)).toBe(0);
    expect(await creditUses(b)).toEqual([]);
    expect(await remainders(d.reservationId)).toEqual(remaindersBefore);

    // Finance: the provider did refund it (counted against the intent).
    const resolved = await resolveHoldHttp(hold.id, "counted_against_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const facts = await dpFacts(d.intentId);

    const after = await tryApply(d.profileId, b, 40_000);
    const probe = await tryApply(
      d.profileId,
      await targetSession(d.profileId, 1_000),
      1_000,
    );
    const credit = await effectiveCredit(b);
    say(
      `M2-05: after counted_against_intent: provider facts ${facts.idr} (${facts.rows} rows), apply of 40000 -> ${after.ok ? "accepted" : "refused"}, probe of 1000 -> ${probe.ok ? "accepted" : "refused"}, credit on B ${credit}`,
    );
    expect(
      after.ok,
      "no credit of 40.000 from money the provider refunded",
    ).toBe(false);
    expect(probe.ok, "not even 1.000 of credit is left").toBe(false);
    expect(credit).toBe(0);
    await expectCreditWithinNet(d, credit, 40_000, "M2-05");
  });

  it.each([
    ["new refund started first", true],
    ["credit apply started first", false],
  ] as const)(
    "M2-06 failed-refund hold open on the DP: a new DP refund and a credit apply at the same time (%s) are both held, nothing is paid or credited",
    async (_label, refundFirst) => {
      const d = await closedSourceWithCredit();
      const b = await targetSession(d.profileId, 40_000);
      await failedOwnDpRefund(d, 40_000);
      const remaindersBefore = await remainders(d.reservationId);
      const refundRowsBefore = await ourRefundRows(d.intentId);

      const refund = () =>
        requestRefund(d.intentId, 1_000).then(
          () => ({ ok: true as const }),
          (error: { status?: number; code?: string }) => ({
            ok: false as const,
            status: error.status,
            code: error.code,
          }),
        );
      const apply = () => tryApply(d.profileId, b, 40_000);
      const [first, second] = refundFirst
        ? await Promise.all([refund(), apply()])
        : await Promise.all([apply(), refund()]);
      const refundOutcome = refundFirst ? first : second;
      const applyOutcome = refundFirst ? second : first;

      say(
        `M2-06 (${_label}): new DP refund -> ${JSON.stringify(refundOutcome)}, credit apply -> ${JSON.stringify(applyOutcome)}`,
      );
      expect(refundOutcome.ok, "the new DP refund is held").toBe(false);
      expect(
        [409, 422],
        `new DP refund refusal: ${JSON.stringify(refundOutcome)}`,
      ).toContain((refundOutcome as { status?: number }).status);
      expect(applyOutcome.ok, "the credit apply is held").toBe(false);
      expect(await ourRefundRows(d.intentId), "no new refund row").toBe(
        refundRowsBefore,
      );
      expect(await creditUses(b)).toEqual([]);
      expect(await remainders(d.reservationId)).toEqual(remaindersBefore);
      expect(await effectiveCredit(b)).toBe(0);
      expect(
        (await dpFacts(d.intentId)).idr,
        "no fact is guessed",
      ).toBeLessThanOrEqual(d.deposit);
    },
  );
});
