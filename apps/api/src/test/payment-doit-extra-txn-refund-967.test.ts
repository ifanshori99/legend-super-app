// legend-wourt (P2), brief 967: DOIT reports `payment.refunded` for an
// ADDITIONAL transaction of an intent: a provider payment id that differs from
// the intent's own `provider_ref` but is recorded as verified evidence of that
// same intent (payment_evidence, source verified_webhook / gateway_status).
// Today such an event is dropped as REFERENCE_MISMATCH and the refunded money
// stays spendable. Written from the brief's design (D2/D4), the shared payment
// contract and the 958 fixtures, not from the implementation, and failing
// first.
//
// Rules asserted (money rules: "jangan sampai rugi"):
//  (1) a refunded event for an extra transaction that is evidence of the
//      intent is bound and recorded: exactly ONE audit row
//      `payment.provider_refunded_partial` about the intent and ONE in-app
//      alert to the outlet supervisor, even when two webhooks (different event
//      ids) and the poller arrive at once and after the provider's retries.
//      Two different extra transactions are two refunds (two audits, two
//      alerts). Evidence source `gateway_status` binds like `verified_webhook`.
//  (2) when the extra transaction's money is a parked unallocated fund, that
//      fund can no longer be resolved by refund or credit: 409
//      PROVIDER_REFUNDED, no refund row, fund stays unresolved. A fund of
//      another, not refunded, extra transaction stays resolvable (control).
//  (3) everything else stays `ignored` with REFERENCE_MISMATCH and moves
//      nothing: evidence of ANOTHER intent (same tenant), a provider id that
//      only exists as evidence of ANOTHER tenant's intent (same provider_ref
//      string), an unknown id, and a non-refunded status (`paid`, `expired`)
//      for a real extra transaction. No intent of this or another tenant is
//      stamped, no audit row, no alert.
//
// Assumptions (the brief does not fix them):
//  - Event shape: `payment.refunded` whose `data` is the intent's own DOIT
//    payment object (same reference) with `id` replaced by the extra
//    transaction id and `amount` = the extra evidence amount.
//  - The extra transaction is simulated with direct DB rows (evidence, and for
//    (2) a parked fund), since the provider flow that creates them is not
//    reachable from outside.
//  - Signed by another outlet's integration: the same tenant has an active DOIT
//    integration scoped to the OTHER outlet with its own webhook secret; an
//    extra-transaction refunded event signed with that secret does not bind to
//    an intent of this outlet and is stored `ignored` (any error code), the
//    request answers below 500.
//  - "Ignored" = gateway_webhook_events.status `ignored` with
//    last_error_code REFERENCE_MISMATCH, and the webhook answers below 500.
//  - A bound refunded event is stored with a status other than
//    ignored/failed/rejected (exact name not pinned).
//  - "Audit row" / "alert" are counted as deltas, as in the 958 file. The
//    audit action name is pinned by the brief: payment.provider_refunded_partial.
//  - Extra amounts are below the intent's paid amount, so no full-refund stamp
//    is expected (and none is asserted).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-doit-extra-txn-refund-967.test.ts" heavy pnpm test
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
const BILL_TOTAL = 144_375;
const SHORT_BY = 1_000;
const MINUTE = 60_000;

const apiKey = `doit-key-967-${randomBytes(12).toString("hex")}`;
const secret = `whsec-967-${randomBytes(16).toString("hex")}`;

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
  settle(id: string, amount: number = BILL_TOTAL): void {
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

// A second tenant, seeded lazily, for the cross-tenant mismatch test.
const otherScope = paymentTestScope();
let otherSeeded = false;
let otherOutletIntegrationId = "";

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
  const email = await signUp(staff, "Refunded967 owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refunded967 approver");
  const approverSession = await approver.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who must hear about the refunded report.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refunded967 supervisor");
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
    [[integrationId, otherOutletIntegrationId].filter(Boolean)],
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
  for (const table of ["payment_evidence", "payment_intents", "payment_links"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
      otherScope.tenantId,
    ]);
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
async function newCode(): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R967-${unique()}`,
      tableLabel: "A06",
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

const paid = (code: Code, amount: number = BILL_TOTAL) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

// ---------------------------------------------------------------------------
// Observations (what staff and the books show)
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

const evidence = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

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

const events = (name: string, intentId: string) =>
  count(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND event->'payload'->>'intentId' = $3`,
    [tenantId, name, intentId],
  );

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

const refundRowsOfFund = (fundId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
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

/** Snapshot of everything the refunded report must NOT change. */
async function books(code: Code) {
  return {
    paidIdr: await paidIdr(code.linkId),
    evidence: await evidence(code.id),
    funds: (await fundsOf(code.id)).map((f) => [f.id, f.amount_idr]),
    journals: await journals(),
    paidEvents: await events("payment.paid", code.id),
    fundsEvents: await events("payment.funds_unallocated", code.id),
  };
}

// ---------------------------------------------------------------------------
// Extra transactions (evidence of the intent with another provider id)
// ---------------------------------------------------------------------------

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

/**
 * A `payment.<status>` webhook body naming `providerId`, carrying the code's
 * own payment object (same reference) so only the transaction id differs.
 */
function extraEvent(
  code: Code,
  providerId: string,
  status: "paid" | "refunded" | "expired",
  amountIdr: number = EXTRA_IDR,
) {
  const base = doit.payments.get(code.providerRef);
  if (!base) throw new Error(`No fake DOIT payment ${code.providerRef}`);
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: `payment.${status}`,
    created_at: new Date().toISOString(),
    data: {
      ...base,
      id: providerId,
      status,
      amount: amountIdr,
      total_amount: amountIdr,
      paid_at: status === "paid" ? new Date().toISOString() : null,
    },
  };
}

/** Two webhooks (different event ids) and a poll at once. Returns event ids. */
async function refundedEverywhere(
  code: Code,
  providerId: string,
  amountIdr: number = EXTRA_IDR,
): Promise<string[]> {
  const bodies = [
    extraEvent(code, providerId, "refunded", amountIdr),
    extraEvent(code, providerId, "refunded", amountIdr),
  ];
  const [first, second] = await Promise.all([
    deliver(bodies[0]!),
    deliver(bodies[1]!),
    pollSoon().catch(() => null),
  ]);
  expect(first.status).toBeLessThan(500);
  expect(second.status).toBeLessThan(500);
  return bodies.map((body) => body.id);
}

async function eventRow(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code
       FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows;
}

async function expectIgnoredMismatch(eventId: string) {
  const rows = await eventRow(eventId);
  expect(rows, "event stored once").toHaveLength(1);
  expect(rows[0]).toEqual({
    status: "ignored",
    last_error_code: "REFERENCE_MISMATCH",
  });
}

async function expectBound(eventIds: string[]) {
  for (const eventId of eventIds) {
    const rows = await eventRow(eventId);
    expect(rows, "event stored once").toHaveLength(1);
    expect(["ignored", "failed", "rejected"]).not.toContain(rows[0]!.status);
    expect(rows[0]!.last_error_code).not.toBe("REFERENCE_MISMATCH");
  }
}

/** Provider-refunded stamps of intents and of the funds of those intents. */
async function stamps(intentIds: string[]) {
  const intents = await owner.query<{ stamp: Date | null }>(
    `SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, intentIds],
  );
  const funds = await owner.query<{ stamp: Date | null }>(
    `SELECT provider_refunded_at AS stamp FROM payment_unallocated_funds
      WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])`,
    [tenantId, intentIds],
  );
  return {
    intents: intents.rows.map((row) => row.stamp),
    funds: funds.rows.map((row) => row.stamp),
  };
}

const PARTIAL_ACTION = "payment.provider_refunded_partial";

describe("legend-wourt refunded event for an additional transaction of the intent", () => {
  it("967-wourt a refunded extra transaction is recorded once: one audit row, one supervisor alert, via webhooks + poller + later retries", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const extra = await addExtraTxn(code);
    const before = await books(code);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    const eventIds = await refundedEverywhere(code, extra.providerRef);

    const newAudit = (await auditActions(code.id)).slice(auditBefore.length);
    expect(newAudit, "exactly one new audit row about the intent").toEqual([
      PARTIAL_ACTION,
    ]);
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "exactly one alert to the outlet supervisor",
    ).toBe(1);
    await expectBound(eventIds);
    // Recording is not a correction: nothing credited, journalled or re-parked.
    expect(await books(code)).toEqual(before);

    // The provider retries later (new event ids) and polls again: nothing new.
    const audit = await auditActions(code.id);
    const alerts = await supervisorAlerts();
    for (let round = 0; round < 2; round += 1) {
      const again = await deliver(
        extraEvent(code, extra.providerRef, "refunded"),
      );
      expect(again.status).toBeLessThan(500);
      await pollLater().catch(() => null);
    }
    expect(await auditActions(code.id)).toEqual(audit);
    expect(await supervisorAlerts()).toBe(alerts);
    expect(await books(code)).toEqual(before);
  });

  it("967-wourt an extra transaction recorded from the gateway status (not only a webhook) binds the same way", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const extra = await addExtraTxn(code, { source: "gateway_status" });
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    const body = extraEvent(code, extra.providerRef, "refunded");
    const answered = await deliver(body);
    expect(answered.status).toBeLessThan(500);

    expect((await auditActions(code.id)).slice(auditBefore.length)).toEqual([
      PARTIAL_ACTION,
    ]);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    await expectBound([body.id]);
  });

  it("967-wourt two different extra transactions refunded are two refunds: two audit rows, two alerts", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const first = await addExtraTxn(code, { amountIdr: 20_000 });
    const second = await addExtraTxn(code, { amountIdr: 25_000 });
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    await refundedEverywhere(code, first.providerRef, 20_000);
    await refundedEverywhere(code, second.providerRef, 25_000);

    expect(
      (await auditActions(code.id)).slice(auditBefore.length),
      "one audit row per extra transaction",
    ).toEqual([PARTIAL_ACTION, PARTIAL_ACTION]);
    expect((await supervisorAlerts()) - alertsBefore).toBe(2);
  });

  it("967-wourt a refunded extra transaction whose money is a parked fund blocks that fund: 409 PROVIDER_REFUNDED, no refund row, fund stays unresolved", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const extra = await addExtraTxn(code);
    const fundId = await parkExtra(code, extra);
    const auditBefore = await auditActions(code.id);
    const alertsBefore = await supervisorAlerts();

    await refundedEverywhere(code, extra.providerRef);

    expect((await auditActions(code.id)).slice(auditBefore.length)).toEqual([
      PARTIAL_ACTION,
    ]);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    for (const resolution of ["refund", "credit"] as const) {
      const attempt = await resolveFund(fundId, resolution);
      expect(
        attempt.status,
        `resolve by ${resolution}: ${JSON.stringify(attempt.body)}`,
      ).toBe(409);
      expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(await refundRowsOfFund(fundId), "no refund filed").toBe(0);
    const funds = (await fundsOf(code.id)).filter((f) => f.id === fundId);
    expect(funds[0]!.resolution).toBeNull();
    expect(funds[0]!.resolved_at).toBeNull();
  });

  it("967-wourt control: the fund of an extra transaction nobody refunded can still be resolved by refund, while a refunded sibling stays blocked", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const refunded = await addExtraTxn(code, { amountIdr: 20_000 });
    const kept = await addExtraTxn(code, { amountIdr: 25_000 });
    const refundedFund = await parkExtra(code, refunded);
    const keptFund = await parkExtra(code, kept);

    // Only the first extra transaction is reported refunded by the provider.
    await refundedEverywhere(code, refunded.providerRef, 20_000);

    const blocked = await resolveFund(refundedFund, "refund");
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowsOfFund(refundedFund)).toBe(0);

    const allowed = await resolveFund(keptFund, "refund");
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(await refundRowsOfFund(keptFund)).toBe(1);
  });
});

describe("legend-wourt unmatched refunded events stay ignored REFERENCE_MISMATCH and never touch another intent", () => {
  async function snapshot(codes: Code[]) {
    return {
      audits: await Promise.all(codes.map((code) => auditActions(code.id))),
      alerts: await supervisorAlerts(),
      books: await Promise.all(codes.map((code) => books(code))),
      stamps: await stamps(codes.map((code) => code.id)),
    };
  }

  it("967-wourt evidence of ANOTHER intent of the same tenant is not bound: ignored, no intent stamped", async () => {
    const code = await newCode();
    const other = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    expect((await paid(other)).status).toBeLessThan(500);
    const foreign = await addExtraTxn(other);
    await parkExtra(other, foreign);
    const before = await snapshot([code, other]);

    // The event names `code`'s reference but a transaction of `other`.
    const body = extraEvent(code, foreign.providerRef, "refunded");
    const answered = await deliver(body);
    expect(answered.status).toBeLessThan(500);

    await expectIgnoredMismatch(body.id);
    expect(await snapshot([code, other])).toEqual(before);
    for (const stamp of [...before.stamps.intents, ...before.stamps.funds])
      expect(stamp).toBeNull();
  });

  it("967-wourt a provider id that only exists as evidence of ANOTHER tenant's intent (same provider_ref string) is not bound and stamps nothing there", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);

    if (!otherSeeded) {
      await otherScope.seed(owner);
      otherSeeded = true;
    }
    const sharedRef = newExtraId();
    const linkId = randomUUID();
    const foreignIntentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 50000, 50000, 50000, 'extra-txn-967-test')`,
      [
        linkId,
        otherScope.tenantId,
        otherScope.outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `X967-${linkId.slice(0, 8)}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', 50000, $5, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $6)`,
      [
        foreignIntentId,
        otherScope.tenantId,
        otherScope.outletId,
        linkId,
        `x967-${foreignIntentId}`,
        sharedRef,
      ],
    );
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 50000, now())`,
      [otherScope.tenantId, otherScope.outletId, foreignIntentId, sharedRef],
    );
    const before = await snapshot([code]);

    const body = extraEvent(code, sharedRef, "refunded", 50_000);
    const answered = await deliver(body);
    expect(answered.status).toBeLessThan(500);

    await expectIgnoredMismatch(body.id);
    expect(await snapshot([code])).toEqual(before);
    const foreign = await owner.query<{
      stamp: Date | null;
      audits: string;
    }>(
      `SELECT i.provider_refunded_after_paid_at AS stamp,
              (SELECT count(*)::text FROM audit_logs a
                WHERE a.tenant_id = $2 AND a.event::text LIKE '%' || $1::text || '%') AS audits
         FROM payment_intents i WHERE i.id = $1::uuid`,
      [foreignIntentId, otherScope.tenantId],
    );
    expect(
      foreign.rows[0]!.stamp,
      "other tenant's intent not stamped",
    ).toBeNull();
    expect(Number(foreign.rows[0]!.audits), "no audit in other tenant").toBe(0);
  });

  it("967-wourt a refunded extra-transaction event signed by ANOTHER outlet's integration of the same tenant is ignored and not recorded", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    const extra = await addExtraTxn(code);
    await parkExtra(code, extra);

    const otherSecret = `whsec-967-other-${randomBytes(16).toString("hex")}`;
    const context = tenantContext();
    const created = await upsertIntegration(
      context,
      {
        outletId: outletIdSchema.parse(scope.otherOutletId),
        provider: "doit",
        config: { baseUrl: doit.baseUrl },
        credentials: { apiKey, webhookSecret: otherSecret },
      },
      actor,
    );
    await setIntegrationStatus(
      context,
      created.id,
      { status: "active" },
      actor,
    );
    otherOutletIntegrationId = created.id;
    clearDoitWebhookSecretCache();
    const before = await snapshot([code]);

    const body = extraEvent(code, extra.providerRef, "refunded");
    const raw = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", otherSecret)
      .update(`${t}.${raw}`)
      .digest("hex");
    const answered = await request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", `t=${t},v1=${mac}`)
      .send(raw);
    expect(answered.status).toBeLessThan(500);

    const rows = await eventRow(body.id);
    expect(rows, "event stored once").toHaveLength(1);
    expect(rows[0]!.status).toBe("ignored");
    expect(rows[0]!.last_error_code).not.toBeNull();
    expect(await snapshot([code])).toEqual(before);
    const attempt = await resolveFund(
      (await fundsOf(code.id))[0]!.id,
      "refund",
    );
    expect(attempt.status, "fund not blocked by an unrecorded event").toBe(200);
  });

  it("967-wourt an unknown provider id is not bound: ignored, nothing changes", async () => {
    const code = await newCode();
    expect((await paid(code)).status).toBeLessThan(500);
    await addExtraTxn(code);
    const before = await snapshot([code]);

    const body = extraEvent(code, newExtraId(), "refunded");
    const answered = await deliver(body);
    expect(answered.status).toBeLessThan(500);

    await expectIgnoredMismatch(body.id);
    expect(await snapshot([code])).toEqual(before);
  });

  it.each(["paid", "expired"] as const)(
    "967-wourt a %s status for a real extra transaction stays ignored (only refunded is processed), nothing changes",
    async (status) => {
      const code = await newCode();
      expect((await paid(code)).status).toBeLessThan(500);
      const extra = await addExtraTxn(code);
      await parkExtra(code, extra);
      const before = await snapshot([code]);

      const body = extraEvent(code, extra.providerRef, status);
      const answered = await deliver(body);
      expect(answered.status).toBeLessThan(500);

      await expectIgnoredMismatch(body.id);
      expect(await snapshot([code])).toEqual(before);
    },
  );
});
