// legend-yn1of + legend-uvjqq (brief 1035, finding B, tier K "jangan sampai
// rugi"): the id under which a provider refund is stored must not share one
// namespace between three different things:
//   (1) the synthetic id of a FULL refund status of a transaction the provider
//       reported as `refunded` (`payment:<ref>`, or `payment:h:<sha256(ref)>`
//       for a payment id of 93-100 chars);
//   (2) a short, valid payment id that merely LOOKS like the hashed form
//       (`h:<64 hex>`, 66 chars, accepted by the webhook);
//   (3) the id of a REAL provider refund (free string of 1-100 chars, so
//       `payment:foo` or even `payment:<some payment id>` is valid).
// At base the recorder picks the "whole transaction" branch by a string prefix
// and keys uniqueness on the string, so a collision either stores a real
// partial refund as a full refund (guest/outlet booked wrong), or treats a
// second transaction's refunded status as a duplicate of the first: no fact,
// no journal event, and its parked fund stays payable again (paid twice).
//
// Written from the SO report (docs/qa/second-opinion-refund-ronde2-1034.md,
// findings 2 and 3), the brief, and the 1025d-b / 1025-C fixtures; not from
// the implementation. Fail-first.
//
// Scenarios:
// 1035b-S1 extra transaction P (93 chars) and extra transaction `h:<sha256(P)>`
//          on ONE intent, both refunded (status refunded), in both orders and
//          concurrently: each gets its own fact + journal event, each fund is
//          stamped and cannot be paid again, replays add nothing.
// 1035b-S2 the same pair on TWO intents of the same tenant.
// 1035b-R1 a real provider refund whose id starts with `payment:` is recorded
//          at its real amount (not as the whole transaction), a second real
//          refund and a replay add exactly one fact each.
// 1035b-R2 a real refund whose id equals the synthetic id of another
//          transaction (`payment:<ref of extra Z>`) and Z's refunded status:
//          both recorded, in both orders and concurrently; Z's fund blocked.
// 1035b-T1 a SECOND tenant with the same payment ids and the same real refund
//          id (both orders): neither books, blocks nor duplicates the other.
// 1035b-H1 a recon hold on a real refund id shaped like the hashed synthetic id
//          is resolved as the real amount of the hold, not as a whole
//          transaction.
//
// Assumptions (the brief does not fix them):
//  - Expected values follow the real money: a refunded extra transaction is one
//    fact of its evidence amount (as in 1025d-b); a real partial refund is one
//    fact of its own amount. Facts are found by `provider_payment_ref`
//    (the raw payment id) and by amount, NOT by the stored refund id string:
//    the target design may store ids differently, only no-collision and the
//    right amounts are asserted.
//  - The real refund of R1/R2 is the 967 payment-door shape (`payment.refunded`
//    with `refund_id`, status partially_refunded) on the intent's main payment.
//  - H1 files the hold through the public door (a signed refund.succeeded whose
//    reference names another intent, as in 1025-C) instead of seeding rows, so
//    the test does not depend on how the hold stores its discriminator.
//  - T1 creates a real second tenant (paymentTestScope, own DOIT integration
//    with the same webhook secret), forces the same provider payment ids in
//    the fake DOIT and drives each tenant through its own webhook URL.
//  - A real refund and the main transaction's own full-status refund are not
//    mixed in one scenario (what remainder the status adds is not pinned here).
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/refund-1035-b-synthetic-id-namespace.test.ts" heavy pnpm test

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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

vi.setConfig({ testTimeout: 180_000 });

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletId = outletIdSchema.parse(scope.outletId);
const actor = randomUUID();
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
const ADMIN = "/api/payments/admin";
const BILL_TOTAL = 144_375;
const NOTE = "Dicocokkan dengan mutasi bank provider";
const MINUTE = 60_000;

const apiKey = `doit-key-1035b-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1035b-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
/** Second tenant of the tenant-isolation scenario (created on first use). */
let tenantB: {
  scope: ReturnType<typeof paymentTestScope>;
  integrationId: string;
  linkIds: string[];
} | null = null;
let staff: ReturnType<typeof agent>;
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

/** A provider payment id of exactly `length` characters (never a prefix twin). */
const makeRef = (length: number) =>
  `dp_${randomBytes(64).toString("hex")}`.slice(0, length);

// ---------------------------------------------------------------------------
// Fake DOIT server (same contract as the 958 / 967 / 1025 files). The id of the
// next created payment can be forced to a length (valid ids reach 100 chars).
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
  /** Length of the id of the next created payment (null = the usual short id). */
  nextIdLength: number | null = null;
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

  settle(id: string, amount: number = BILL_TOTAL): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  refund(id: string): void {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    payment.status = "refunded";
  }

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
      const id =
        this.nextId ??
        (this.nextIdLength === null
          ? `dp_${randomBytes(8).toString("hex")}`
          : makeRef(this.nextIdLength));
      this.nextIdLength = null;
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
// Setup
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

  // Back-office owner: files refunds, resolves parked funds and holds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1035b owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Refund approvals need a policy (same as the 967 / 1020 files).
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
  // Tenant B's rows go first (its intents reference its own integration).
  if (tenantB) {
    const other = tenantB.scope.tenantId;
    const linkIds = tenantB.linkIds;
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_unallocated_funds",
      "payment_evidence",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [other, linkIds],
      );
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [other],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [other, linkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [other, linkIds],
    );
    await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      tenantB.integrationId,
    ]);
  }
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
      "payment_unallocated_funds",
      "payment_evidence",
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

/** A fresh bill with one pending QRIS code (its payment id `idLength` long). */
async function newCode(idLength: number | null = null): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1035B-${unique()}`,
      tableLabel: "A08",
      pax: 2,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: BILL_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  doit.nextIdLength = idLength;
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  doit.nextIdLength = null;
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [id],
  );
  if (!rows[0]?.provider_ref) throw new Error("Intent has no DOIT payment id");
  if (idLength !== null)
    expect(
      rows[0].provider_ref,
      "the provider's id is kept whole",
    ).toHaveLength(idLength);
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

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

const runWorker = () =>
  reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
    () => null,
  );

/**
 * The poller at several virtual clocks (minutes after now), so a lease or a
 * back-off between two runs cannot make a test depend on real time. A run that
 * throws is ignored: the assertions read the result, not the run.
 */
async function pollSeries(minutes: readonly number[]) {
  for (const offset of minutes)
    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + offset * MINUTE),
      100,
    ).catch(() => null);
}
const FIRST_POLLS = [2, 10, 20] as const;
const LATER_POLLS = [30, 45, 60] as const;

async function paid(code: Code, amount: number = BILL_TOTAL) {
  doit.settle(code.providerRef, amount);
  const answered = await deliver(doit.eventFor(code.providerRef, "paid"));
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
}

/**
 * `payment.refunded` naming ANOTHER transaction of the intent: the code's own
 * payment object with only the id (and amount) replaced, as in the 967 file.
 */
function extraRefundedEvent(code: Code, providerId: string, amountIdr: number) {
  const base = doit.payments.get(code.providerRef);
  if (!base) throw new Error(`No fake DOIT payment ${code.providerRef}`);
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.refunded",
    created_at: new Date().toISOString(),
    data: {
      ...base,
      id: providerId,
      status: "refunded",
      amount: amountIdr,
      total_amount: amountIdr,
      paid_at: null,
    },
  };
}

/** A partial refund the provider made on its own (brief 967, payment door). */
async function partialRefund(code: Code, refundId: string, amount: number) {
  const answer = await deliver({
    id: `evt_${randomBytes(8).toString("hex")}`,
    created_at: new Date().toISOString(),
    type: "payment.refunded",
    data: {
      payment_id: code.providerRef,
      refund_id: refundId,
      amount,
      status: "partially_refunded",
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
}

// ---------------------------------------------------------------------------
// Extra transactions (evidence + parked fund of the intent)
// ---------------------------------------------------------------------------

type Extra = { providerRef: string; evidenceId: string; amountIdr: number };

async function addExtraTxn(
  intentId: string,
  providerRef: string,
  amountIdr: number,
): Promise<Extra> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletId, intentId, providerRef, amountIdr],
  );
  return { providerRef, evidenceId: rows[0]!.id, amountIdr };
}

/** The extra transaction's money, parked as an unallocated fund. */
async function parkExtra(intentId: string, extra: Extra): Promise<string> {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, intentId, extra.evidenceId, extra.amountIdr],
  );
  return fundId;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

type ProviderRow = {
  provider_refund_id: string;
  provider_payment_ref: string | null;
  amount_idr: number;
};

async function providerRows(intentId: string): Promise<ProviderRow[]> {
  const { rows } = await owner.query<
    Omit<ProviderRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT provider_refund_id, provider_payment_ref, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, provider_refund_id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

/** Distinct journal-feeding events emitted for the intent. */
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

async function fundStamp(fundId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_at AS stamp FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [tenantId, fundId],
  );
  return rows[0]!.stamp;
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

async function expectFundBlocked(fundId: string) {
  for (const resolution of ["refund", "credit"] as const) {
    const attempt = await resolveFund(fundId, resolution);
    expect(
      attempt.status,
      `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
    ).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
  }
  expect(await refundRowsOfFund(fundId), "no refund filed").toBe(0);
  expect(fake.calls, "no provider call").toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Fact of one raw provider payment id (rows are read by that id, see header). */
const factsOfRef = async (intentId: string, ref: string) =>
  (await providerRows(intentId))
    .filter((row) => row.provider_payment_ref === ref)
    .map((row) => row.amount_idr);

const totalOf = async (intentId: string) =>
  (await providerRows(intentId)).reduce((sum, row) => sum + row.amount_idr, 0);

async function replayEverything(
  bodies: object[],
  intentIds: readonly string[],
): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const body of bodies) {
      const again = await deliver(body);
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
    }
    await runWorker();
    await pollSeries(LATER_POLLS);
  }
  expect(intentIds.length).toBeGreaterThan(0);
}

type Order = "first then second" | "second then first" | "concurrent";
const ORDERS: Order[] = [
  "first then second",
  "second then first",
  "concurrent",
];

async function deliverInOrder(order: Order, first: object, second: object) {
  const answers: Awaited<ReturnType<typeof deliver>>[] = [];
  if (order === "concurrent")
    answers.push(...(await Promise.all([deliver(first), deliver(second)])));
  else if (order === "first then second")
    answers.push(await deliver(first), await deliver(second));
  else answers.push(await deliver(second), await deliver(first));
  for (const answer of answers)
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
}

// ===========================================================================
// S: two extra transactions whose synthetic ids used to be the same string
// ===========================================================================

describe("1035b-S two different transactions never share a refund identity", () => {
  it.each(ORDERS)(
    "1035b-S1 one intent: extra P (93 chars) and extra `h:<sha256(P)>` both refunded, %s: two facts, two events, both funds stamped and blocked, replays add nothing",
    async (order) => {
      const code = await newCode();
      await paid(code);
      const longRef = makeRef(93);
      const shortRef = `h:${sha256(longRef)}`;
      expect(shortRef).toHaveLength(66);
      const longExtra = await addExtraTxn(code.id, longRef, 30_000);
      const shortExtra = await addExtraTxn(code.id, shortRef, 20_000);
      const longFund = await parkExtra(code.id, longExtra);
      const shortFund = await parkExtra(code.id, shortExtra);
      const sibling = await addExtraTxn(code.id, makeRef(40), 25_000);
      const siblingFund = await parkExtra(code.id, sibling);

      const longEvent = extraRefundedEvent(code, longRef, 30_000);
      const shortEvent = extraRefundedEvent(code, shortRef, 20_000);
      await deliverInOrder(order, longEvent, shortEvent);
      await runWorker();
      await pollSeries(FIRST_POLLS);

      expect(await factsOfRef(code.id, longRef), "fact of P").toEqual([30_000]);
      expect(await factsOfRef(code.id, shortRef), "fact of h:<hash>").toEqual([
        20_000,
      ]);
      expect(await providerRows(code.id), "nothing else recorded").toHaveLength(
        2,
      );
      expect(await refundEventsOfIntent(code.id), "one event each").toBe(2);
      expect(await fundStamp(longFund), "P's fund stamped").not.toBeNull();
      expect(
        await fundStamp(shortFund),
        "h:<hash> fund stamped",
      ).not.toBeNull();
      expect(await fundStamp(siblingFund), "sibling untouched").toBeNull();

      await replayEverything([longEvent, shortEvent], [code.id]);
      expect(await totalOf(code.id), "replays add no money").toBe(50_000);
      expect(await refundEventsOfIntent(code.id)).toBe(2);

      // Money: neither fund can be paid out again, the sibling still can.
      await expectFundBlocked(longFund);
      await expectFundBlocked(shortFund);
      const allowed = await resolveFund(siblingFund, "refund");
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    },
  );

  it.each(ORDERS)(
    "1035b-S2 two intents of one tenant: P (93 chars) on one, `h:<sha256(P)>` on the other, %s: each intent gets its own fact, event and blocked fund",
    async (order) => {
      const codeA = await newCode();
      const codeB = await newCode();
      await paid(codeA);
      await paid(codeB);
      const longRef = makeRef(93);
      const shortRef = `h:${sha256(longRef)}`;
      const extraA = await addExtraTxn(codeA.id, longRef, 30_000);
      const extraB = await addExtraTxn(codeB.id, shortRef, 20_000);
      const fundA = await parkExtra(codeA.id, extraA);
      const fundB = await parkExtra(codeB.id, extraB);

      const eventA = extraRefundedEvent(codeA, longRef, 30_000);
      const eventB = extraRefundedEvent(codeB, shortRef, 20_000);
      await deliverInOrder(order, eventA, eventB);
      await runWorker();
      await pollSeries(FIRST_POLLS);

      expect(await factsOfRef(codeA.id, longRef)).toEqual([30_000]);
      expect(await factsOfRef(codeB.id, shortRef)).toEqual([20_000]);
      expect(await refundEventsOfIntent(codeA.id)).toBe(1);
      expect(await refundEventsOfIntent(codeB.id)).toBe(1);
      expect(await fundStamp(fundA)).not.toBeNull();
      expect(await fundStamp(fundB)).not.toBeNull();

      await replayEverything([eventA, eventB], [codeA.id, codeB.id]);
      expect(await totalOf(codeA.id)).toBe(30_000);
      expect(await totalOf(codeB.id)).toBe(20_000);

      await expectFundBlocked(fundA);
      await expectFundBlocked(fundB);
    },
  );
});

// ===========================================================================
// R: a REAL provider refund id that starts with `payment:`
// ===========================================================================

describe("1035b-R a real provider refund id is never mistaken for a transaction status", () => {
  const REAL_IDS: [string, (code: Code) => string][] = [
    ["payment:<word>", () => `payment:foo-${unique()}`],
    [
      "payment:<hashed form of the main payment id>",
      (code) => `payment:h:${sha256(code.providerRef)}`,
    ],
    ["hold:<uuid>", () => `hold:${randomUUID()}`],
  ];

  it.each(REAL_IDS)(
    "1035b-R1 real refund id %s of 40.000 on a 144.375 payment: one fact of 40.000 (not the whole transaction), one event; a second real refund and replays add one fact each",
    async (_label, makeId) => {
      const code = await newCode();
      await paid(code);
      const firstId = makeId(code);
      const secondId = `payment:bar-${unique()}`;

      await partialRefund(code, firstId, 40_000);
      expect(await totalOf(code.id), "booked at the real amount").toBe(40_000);
      expect(await providerRows(code.id)).toHaveLength(1);
      expect(await refundEventsOfIntent(code.id), "one event").toBe(1);

      await partialRefund(code, secondId, 20_000);
      expect(
        (await providerRows(code.id)).map((r) => r.amount_idr).sort(),
      ).toEqual([20_000, 40_000]);
      expect(await refundEventsOfIntent(code.id)).toBe(2);

      // Replays of both real refunds (webhook, worker, poller): nothing new.
      await partialRefund(code, firstId, 40_000);
      await partialRefund(code, secondId, 20_000);
      await runWorker();
      await pollSeries(LATER_POLLS);
      expect(await totalOf(code.id), "never more than the real money").toBe(
        60_000,
      );
      expect(await providerRows(code.id)).toHaveLength(2);
      expect(await refundEventsOfIntent(code.id)).toBe(2);
      expect(fake.calls, "no provider call").toHaveLength(0);
    },
  );

  it.each(ORDERS)(
    "1035b-R2 a real refund of 40.000 with id `payment:<ref of extra Z>` and Z's own refunded status (30.000), %s: both recorded, Z's fund blocked",
    async (order) => {
      const code = await newCode();
      await paid(code);
      const zRef = makeRef(40);
      const z = await addExtraTxn(code.id, zRef, 30_000);
      const zFund = await parkExtra(code.id, z);
      const realId = `payment:${zRef}`;
      const zEvent = extraRefundedEvent(code, zRef, 30_000);
      const realEvent = {
        id: `evt_${randomBytes(8).toString("hex")}`,
        created_at: new Date().toISOString(),
        type: "payment.refunded",
        data: {
          payment_id: code.providerRef,
          refund_id: realId,
          amount: 40_000,
          status: "partially_refunded",
        },
      };

      await deliverInOrder(order, realEvent, zEvent);
      await runWorker();
      await pollSeries(FIRST_POLLS);

      expect(
        (await providerRows(code.id)).map((row) => row.amount_idr).sort(),
        "the real 40.000 and Z's 30.000, each once",
      ).toEqual([30_000, 40_000]);
      expect(await factsOfRef(code.id, zRef), "Z has its own fact").toEqual([
        30_000,
      ]);
      expect(await refundEventsOfIntent(code.id)).toBe(2);
      expect(await fundStamp(zFund), "Z's fund stamped").not.toBeNull();

      await replayEverything([realEvent, zEvent], [code.id]);
      expect(await totalOf(code.id)).toBe(70_000);
      expect(await refundEventsOfIntent(code.id)).toBe(2);
      await expectFundBlocked(zFund);
    },
  );
});

// ===========================================================================
// H: resolving a hold on a real refund id shaped like a synthetic id
// ===========================================================================

const ADMIN_HOLD = `${ADMIN}/refund-recon-holds`;

const resolveHold = (holdId: string) =>
  staff
    .post(`${ADMIN_HOLD}/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution: "counted_against_intent",
      note: NOTE,
    });

/** Age the stored events past the retry window and run the worker twice. */
async function settleEvents(eventIds: string[]) {
  for (let round = 0; round < 2; round += 1) {
    await owner.query(
      `UPDATE gateway_webhook_events
          SET received_at = now() - interval '20 minutes',
              updated_at = now() - interval '20 minutes'
        WHERE tenant_id = $1 AND event_id = ANY($2::text[])`,
      [tenantId, eventIds],
    );
    await runWorker();
  }
}

describe("1035b-H a hold on a real refund id is resolved as that real refund", () => {
  it.each([
    ["rf_<hex> (control)", () => `rf_${randomBytes(6).toString("hex")}`],
    ["payment:foo", () => `payment:foo-${unique()}`],
    ["hold:<uuid>", () => `hold:${randomUUID()}`],
    [
      "payment:h:<64 hex>",
      () => `payment:h:${randomBytes(32).toString("hex")}`,
    ],
  ])(
    "1035b-H1 refund.succeeded %s of 20.000 naming another intent's reference leaves an open hold; resolving it books 20.000 once, never the 50.000 of the whole transaction",
    async (_label, makeId) => {
      const codeA = await newCode();
      const codeB = await newCode();
      await paid(codeA);
      await paid(codeB);
      const x = await addExtraTxn(codeB.id, makeRef(60), 50_000);
      const xFund = await parkExtra(codeB.id, x);
      const aReference = doit.payments.get(codeA.providerRef)!.reference;
      const realId = makeId();
      const body = {
        id: `evt_${randomBytes(8).toString("hex")}`,
        type: "refund.succeeded",
        created_at: new Date().toISOString(),
        data: {
          refund: { id: realId, amount: 20_000, reference: aReference },
          payment: {
            id: x.providerRef,
            reference: aReference,
            status: "refunded",
            amount: 20_000,
          },
        },
      };

      // The first delivery may answer 500 (retry window, see xmtih): the hold
      // is filed by the worker, so the status is not asserted (as in 1025-C).
      await deliver(body);
      await settleEvents([body.id]);

      const { rows: holds } = await owner.query<{
        id: string;
        resolved_at: Date | null;
        amount_idr: string;
      }>(
        `SELECT id, resolved_at, amount_idr::text AS amount_idr
           FROM refund_recon_holds
          WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])`,
        [tenantId, [codeA.id, codeB.id]],
      );
      expect(holds, "premise: one open hold").toHaveLength(1);
      expect(holds[0]!.resolved_at).toBeNull();
      expect(Number(holds[0]!.amount_idr)).toBe(20_000);
      expect(await totalOf(codeB.id), "nothing booked before").toBe(0);

      const response = await resolveHold(holds[0]!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect(
        await totalOf(codeB.id),
        "the real 20.000 is booked, not the whole 50.000 transaction",
      ).toBe(20_000);
      expect(await providerRows(codeB.id)).toHaveLength(1);
      expect(await refundEventsOfIntent(codeB.id), "one journal event").toBe(1);
      expect(await totalOf(codeA.id), "the other intent is unaffected").toBe(0);

      // Resolving again books nothing more (replay).
      await resolveHold(holds[0]!.id);
      expect(await totalOf(codeB.id)).toBe(20_000);
      expect(await refundEventsOfIntent(codeB.id)).toBe(1);
      expect(xFund).toBeTruthy();
    },
  );
});

// ===========================================================================
// T: a second tenant with the very same payment ids and refund ids
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

type Side = {
  tenantId: string;
  intentId: string;
  mainRef: string;
  /** Snapshot of the provider payment object this tenant's intent was made with. */
  payment: DoitPayment;
  path: string;
};

/** A paid bill of tenant `which` whose provider payment id is exactly `ref`. */
async function paidBill(which: "A" | "B", ref: string): Promise<Side> {
  const other = which === "B" ? await ensureTenantB() : null;
  const theScope = other ? other.scope : scope;
  const theTenant = theScope.tenantId;
  const theOutlet = outletIdSchema.parse(theScope.outletId);
  const opened = await createPaymentLink(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: theTenant,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [theOutlet] },
    ),
    {
      outletId: theOutlet,
      reference: `R1035BT-${unique()}`,
      tableLabel: "A08",
      pax: 2,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: BILL_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  (other ? other.linkIds : createdLinkIds).push(opened.linkId);
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
  const side: Side = {
    tenantId: theTenant,
    intentId: created.body.data.id as string,
    mainRef: ref,
    payment,
    path: `/api/webhooks/payments/doit/${theTenant}`,
  };
  const answered = await deliverTo(side, {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.paid",
    created_at: new Date().toISOString(),
    data: { ...payment, status: "paid", amount: BILL_TOTAL },
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return side;
}

async function deliverTo(side: Side, body: object) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(side.path)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

/** The extra transaction `ref` of the side's intent: evidence plus parked fund. */
async function extraOf(side: Side, ref: string, amountIdr: number) {
  const theOutlet =
    side.tenantId === tenantId ? outletId : tenantB!.scope.outletId;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [side.tenantId, theOutlet, side.intentId, ref, amountIdr],
  );
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [
      fundId,
      side.tenantId,
      theOutlet,
      side.intentId,
      evidence.rows[0]!.id,
      amountIdr,
    ],
  );
  return fundId;
}

/** What the tenant has booked for its intent: facts (amounts), events, stamp. */
async function ledgerOf(side: Side, fundId: string) {
  const facts = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr::text FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [side.tenantId, side.intentId],
  );
  const events = await owner.query<{ n: string }>(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [side.tenantId, side.intentId],
  );
  const stamp = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_at AS stamp FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [side.tenantId, fundId],
  );
  return {
    amounts: facts.rows
      .map((row) => Number(row.amount_idr))
      .sort((a, b) => a - b),
    events: Number(events.rows[0]!.n),
    stamped: stamp.rows[0]!.stamp !== null,
  };
}

describe("1035b-T another tenant with the same payment ids and refund ids is neither booked, blocked nor treated as duplicate", () => {
  it.each([
    ["A", "B"],
    ["B", "A"],
  ] as const)(
    "1035b-T1 tenant %s's extra status and real refund (same ids) first, then tenant %s's: each tenant books its own two facts once; nothing leaks either way",
    async (firstName, secondName) => {
      const mainRef = `dp_1035bt_${randomBytes(8).toString("hex")}`;
      const extraRef = makeRef(93);
      const realId = `payment:real-${unique()}`;
      const sideA = await paidBill("A", mainRef);
      const sideB = await paidBill("B", mainRef);
      const fundA = await extraOf(sideA, extraRef, 30_000);
      const fundB = await extraOf(sideB, extraRef, 30_000);
      const sides = { A: sideA, B: sideB };
      const funds = { A: fundA, B: fundB };

      const events = (side: Side) => [
        {
          id: `evt_${randomBytes(8).toString("hex")}`,
          type: "payment.refunded",
          created_at: new Date().toISOString(),
          data: {
            ...side.payment,
            id: extraRef,
            status: "refunded",
            amount: 30_000,
            total_amount: 30_000,
            paid_at: null,
          },
        },
        {
          id: `evt_${randomBytes(8).toString("hex")}`,
          created_at: new Date().toISOString(),
          type: "payment.refunded",
          data: {
            payment_id: side.mainRef,
            refund_id: realId,
            amount: 40_000,
            status: "partially_refunded",
          },
        },
      ];
      const bookedOnce = {
        amounts: [30_000, 40_000],
        events: 2,
        stamped: true,
      };
      const untouched = { amounts: [], events: 0, stamped: false };

      const first = sides[firstName];
      const second = sides[secondName];
      const firstEvents = events(first);
      // Delivered twice and concurrently: replays and races never add facts.
      for (const answer of await Promise.all(
        [...firstEvents, ...firstEvents].map((body) => deliverTo(first, body)),
      ))
        expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
      expect(await ledgerOf(first, funds[firstName]), "first tenant").toEqual(
        bookedOnce,
      );
      expect(
        await ledgerOf(second, funds[secondName]),
        "the other tenant is untouched, its fund is not blocked",
      ).toEqual(untouched);

      // Now the other tenant's identical events: not a duplicate of the first's.
      const secondEvents = events(second);
      for (const body of [...secondEvents, ...secondEvents]) {
        const answer = await deliverTo(second, body);
        expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
      }
      expect(
        await ledgerOf(second, funds[secondName]),
        "second tenant",
      ).toEqual(bookedOnce);
      expect(
        await ledgerOf(first, funds[firstName]),
        "the first tenant is unchanged",
      ).toEqual(bookedOnce);
    },
  );
});
