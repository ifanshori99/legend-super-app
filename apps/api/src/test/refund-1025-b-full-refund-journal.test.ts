// legend-gjt5q (brief 1025, card B, tier K "jangan sampai rugi"): when the
// payment provider (DOIT) refunds a WHOLE payment on its own (brief 958, the
// `payment.refunded` webhook with status refunded, or the poller seeing the
// payment as refunded), we flag the intent and block payouts, but nothing is
// written to `payment_provider_refunds` and nothing reaches the books: the
// gateway clearing account keeps money the gateway gave back. Partial refunds
// (brief 967) already write a row and, since brief 1013, journal once through
// the event `payment.provider_refunded`. Written from the brief
// (docs/briefs/1025-refund-provider-celah.md) and the 958 / 967 / 1013 test
// fixtures, failing first; not from the implementation.
//
// Design asserted (brief 1025 card B):
//  - The full provider refund writes ONE payment_provider_refunds row, whose
//    provider_refund_id is `payment:<providerRef>` (the unique key makes it
//    idempotent), amount = what the provider received minus the partial
//    refunds already recorded for the payment. The 1013 event
//    `payment.provider_refunded` is emitted once for that row and journals
//    once: Dr customer_deposit / Cr gateway_clearing.
//  - Webhook + poller + replays never add a second row, event or journal.
//  - The 958 behavior is unchanged: intent flagged, no payout possible
//    (manual refund 409 PROVIDER_REFUNDED, parked fund 409, no provider call),
//    exactly one supervisor alert.
//
// 1025-B-01 full refund of a paid payment: one row, one event, replays add none
// 1025-B-02 pending code refunded: poller and webhook (either order) write once
// 1025-B-03 the event journals exactly once and the books end at zero
// 1025-B-04 after an earlier partial refund only the remainder is written
// 1025-B-05 a parked (short-paid) fund the provider refunds writes one row
// 1025-B-06 another tenant is never touched
// 1025-B-07 control: 958 flags, alert and payout block are unchanged
//
// Assumptions (the brief does not fix them):
//  - "Row once" is read from payment_provider_refunds by tenant + intent; the
//    unique key text `payment:<providerRef>` is taken literally from the brief.
//  - The full refund's amount is the money the provider received: the bill
//    total for a paid/pending code, the short amount for a parked fund.
//  - The journal path is driven like the 1013 test: the outbox event of the
//    recorder is delivered to deliverAutoJournalEvent; the payment.paid
//    receipt is journaled first and its outbox row marked delivered.
//  - Not covered here: the release-recon caller in pos-qris-release-recon (it
//    needs a POS release flow); it shares markProviderRefunded with the above.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025-b-full-refund-journal.test.ts" heavy pnpm test
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
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
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
const ADMIN = "/api/payments/admin";
const BILL_TOTAL = 144_375;
const SHORT_BY = 1_000;
const PARTIAL = 40_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1025b-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1025b-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
let staff: ReturnType<typeof agent>;
let supervisorUserId = "";
let fake: FakeRefundGateway;
let legalEntityId = "";

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
// Fake DOIT server (same contract as the 958 / 967 files)
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
// Accounting world for the payment tenant (so the journal path can be driven)
// ---------------------------------------------------------------------------

type Role = "gateway_clearing" | "customer_deposit";
const CHART: [string, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  ["bank", "1103", "Bank Operasional", "asset", "current_asset"],
  [
    "gateway_fee_expense",
    "6109",
    "Biaya Gateway (MDR)",
    "expense",
    "operating_expense",
  ],
];
const accounts: Record<string, string> = {};

async function seedAccountingWorld(): Promise<void> {
  const { rows } = await owner.query<{ legal_entity_id: string }>(
    "SELECT legal_entity_id FROM outlets WHERE id = $1",
    [outletId],
  );
  legalEntityId = rows[0]!.legal_entity_id;
  // The accounting module on, whatever the copied plan already had.
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(
              feature_flags, '{modules}',
              coalesce(feature_flags->'modules', '[]'::jsonb) || '"accounting"'::jsonb)
      WHERE id = $1 AND NOT coalesce(feature_flags->'modules', '[]'::jsonb) ? 'accounting'`,
    [tenantId],
  );
  for (const [role, code, name, type, group] of CHART) {
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, legalEntityId, code, name, type, group],
    );
    accounts[role] = inserted.rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, legalEntityId, role, accounts[role]],
    );
  }
  // Open periods around "today" (the refund is booked at its real time).
  const now = Date.now();
  const months = new Set(
    [-40, -1, 0, 1, 40].map((days) =>
      new Date(now + days * 86_400_000).toISOString().slice(0, 7),
    ),
  );
  for (const period of months)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, legalEntityId, period],
    );
}

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
  setAuditWriter(coreAuditWriter);
  await scope.seed(owner);
  await seedAccountingWorld();

  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1025b owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // The outlet supervisor who must hear about the refunded report (958).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1025b supervisor");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;
  userIds.push(supervisorUserId);
  await assign(supervisorUserId, "supervisor", "outlet");

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
  setAuditWriter(null);
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM refund_recon_holds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      `DELETE FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
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
  await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
    integrationId,
  ]);
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
async function newCode(): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1025B-${unique()}`,
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

/** A paid code whose receipt is already in the books. */
async function paidCode(): Promise<Code> {
  const code = await newCode();
  const answered = await paid(code);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await journalReceipt(code);
  return code;
}

/** DOIT reports the whole payment refunded through every door at once. */
async function providerRefundsEverywhere(code: Code) {
  doit.refund(code.providerRef);
  const [first, second] = await Promise.all([
    deliver(doit.eventFor(code.providerRef, "refunded")),
    deliver(doit.eventFor(code.providerRef, "refunded")),
    pollSoon().catch(() => null),
  ]);
  expect(first.status).toBeLessThan(500);
  expect(second.status).toBeLessThan(500);
}

async function providerRetriesLater(code: Code) {
  const again = await deliver(doit.eventFor(code.providerRef, "refunded"));
  expect(again.status).toBeLessThan(500);
  await pollLater().catch(() => null);
}

/** A partial refund the provider made on its own (brief 967, payment door). */
async function partialRefund(code: Code, amount: number) {
  const answer = await deliver({
    id: `evt_${randomBytes(8).toString("hex")}`,
    created_at: new Date().toISOString(),
    type: "payment.refunded",
    data: {
      payment_id: code.providerRef,
      refund_id: `rf_${randomBytes(6).toString("hex")}`,
      amount,
      status: "partially_refunded",
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

type ProviderRefundRow = {
  id: string;
  provider_refund_id: string;
  amount_idr: number;
};

/** Provider refund rows of an intent, oldest first. */
async function providerRows(intentId: string): Promise<ProviderRefundRow[]> {
  const { rows } = await owner.query<{
    id: string;
    provider_refund_id: string;
    amount_idr: string;
  }>(
    `SELECT id, provider_refund_id, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

/** The row the full refund wrote (1035: kind `synthetic_full`, id = the raw
 * providerRef). */
const fullRowOf = async (code: Code) =>
  (await providerRows(code.id)).filter(
    (row) => row.provider_refund_id === code.providerRef,
  );

/** Distinct provider-refund events emitted for a row. */
async function refundEventIds(rowId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT DISTINCT event->>'id' AS id FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'providerRefundId' = $2`,
    [tenantId, rowId],
  );
  return rows.map((row) => row.id);
}

const refundEventsOfIntent = (intentId: string) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [tenantId, intentId],
  );

const supervisorAlerts = () =>
  count(
    "SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, supervisorUserId],
  );

const refundRowsOfIntent = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

async function fundsOf(intentId: string) {
  const { rows } = await owner.query<{ id: string; amount_idr: string }>(
    `SELECT id, amount_idr::text AS amount_idr
       FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at`,
    [tenantId, intentId],
  );
  return rows;
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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

// ---------------------------------------------------------------------------
// Journal helpers (the consumer of the outbox events, like the 1013 file)
// ---------------------------------------------------------------------------

async function outboxEnvelopes(
  name: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT DISTINCT ON (event->>'id') event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND (event->'payload'->>'intentId' = $3
          OR event->'payload'->>'paymentIntentId' = $3)
      ORDER BY event->>'id'`,
    [tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

function deliverEvent(event: EventEnvelope) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

/** Journals the receipt (payment.paid) of the code and marks it consumed. */
async function journalReceipt(code: Code): Promise<void> {
  const receipts = await outboxEnvelopes("payment.paid", code.id);
  expect(receipts, "payment.paid emitted").toHaveLength(1);
  const result = await deliverEvent(receipts[0]!);
  expect(result.status, "receipt posts").toBe("posted");
  await owner.query(
    `UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now()
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2`,
    [tenantId, code.id],
  );
}

async function journalsByKey(rowId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenantId, `aj:provider-refund:${rowId}`],
  );
  return rows.map((row) => row.id);
}

async function balanceOf(role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

/** Journal lines of an entry as role/debit/credit (sorted by role). */
async function linesOf(entryId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [tenantId, entryId],
  );
  const roleOf = new Map(Object.entries(accounts).map(([r, id]) => [id, r]));
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

const refundLines = (amountIdr: number) => [
  { role: "customer_deposit", debit: amountIdr, credit: 0 },
  { role: "gateway_clearing", debit: 0, credit: amountIdr },
];

// ===========================================================================

describe("1025-B a full provider refund is recorded once and reaches the books once", () => {
  it("1025-B-01 full refund of a paid payment (webhook x2 + poller + later retries): exactly one provider refund row of the whole amount and one journal event", async () => {
    const code = await paidCode();
    expect(await providerRows(code.id), "nothing recorded before").toEqual([]);

    await providerRefundsEverywhere(code);

    const rows = await fullRowOf(code);
    expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe(BILL_TOTAL);
    expect(await providerRows(code.id)).toHaveLength(1);
    expect(
      await refundEventIds(rows[0]!.id),
      "one event for the row",
    ).toHaveLength(1);

    // The provider retries, the poller runs again: nothing is added.
    await providerRetriesLater(code);
    await providerRetriesLater(code);
    expect(await providerRows(code.id)).toEqual(rows);
    expect(await refundEventsOfIntent(code.id)).toBe(1);
  });

  it.each(["poller", "webhook"] as const)(
    "1025-B-02 a pending code the provider already refunded, noticed first by the %s, then by the other door: one row, one event",
    async (first) => {
      const code = await newCode();
      doit.refund(code.providerRef);

      const viaPoller = async () => {
        await pollSoon().catch(() => null);
      };
      const viaWebhook = async () => {
        const answered = await deliver(
          doit.eventFor(code.providerRef, "refunded"),
        );
        expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(
          500,
        );
      };
      if (first === "poller") {
        await viaPoller();
        await viaWebhook();
      } else {
        await viaWebhook();
        await viaPoller();
      }
      await providerRetriesLater(code);

      const rows = await fullRowOf(code);
      expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
      expect(rows[0]!.amount_idr).toBe(BILL_TOTAL);
      expect(await providerRows(code.id)).toHaveLength(1);
      expect(await refundEventIds(rows[0]!.id)).toHaveLength(1);
      expect(await refundEventsOfIntent(code.id)).toBe(1);
    },
  );

  it("1025-B-03 the event journals exactly once (replay, webhook + poller): Dr customer_deposit / Cr gateway_clearing of the whole amount, the books end at zero", async () => {
    const code = await paidCode();
    expect(await balanceOf("gateway_clearing")).toBeGreaterThanOrEqual(
      BILL_TOTAL,
    );
    const clearingBefore = await balanceOf("gateway_clearing");
    const depositBefore = await balanceOf("customer_deposit");

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const rows = await fullRowOf(code);
    expect(rows).toHaveLength(1);
    const events = await outboxEnvelopes("payment.provider_refunded", code.id);
    expect(events, "one event to journal").toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      providerRefundId: rows[0]!.id,
      paymentIntentId: code.id,
      amountIdr: BILL_TOTAL,
    });

    // The same event delivered again and again (outbox redelivery).
    const first = await deliverEvent(events[0]!);
    expect(first.status).toBe("posted");
    for (let replay = 0; replay < 3; replay += 1)
      expect((await deliverEvent(events[0]!)).status).toBe("already_posted");

    const entries = await journalsByKey(rows[0]!.id);
    expect(entries, "exactly one journal").toHaveLength(1);
    expect(await linesOf(entries[0]!)).toEqual(refundLines(BILL_TOTAL));
    expect(await balanceOf("gateway_clearing")).toBe(
      clearingBefore - BILL_TOTAL,
    );
    expect(await balanceOf("customer_deposit")).toBe(
      depositBefore + BILL_TOTAL,
    );
  });

  it("1025-B-04 after an earlier partial refund only the remainder is written: partial + remainder = the whole payment, each journaled once", async () => {
    const code = await paidCode();
    await partialRefund(code, PARTIAL);
    const afterPartial = await providerRows(code.id);
    expect(afterPartial, "the partial is recorded (brief 967)").toHaveLength(1);
    expect(afterPartial[0]!.amount_idr).toBe(PARTIAL);

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const rows = await providerRows(code.id);
    expect(rows, "partial + one full row").toHaveLength(2);
    const full = await fullRowOf(code);
    expect(full, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(full[0]!.amount_idr, "only the remainder").toBe(
      BILL_TOTAL - PARTIAL,
    );
    expect(rows.reduce((sum, row) => sum + row.amount_idr, 0)).toBe(BILL_TOTAL);

    // Both reach the books once; the gateway holds nothing of this payment.
    const clearingBefore = await balanceOf("gateway_clearing");
    for (const row of rows) {
      const events = await outboxEnvelopes(
        "payment.provider_refunded",
        code.id,
      );
      const event = events.find(
        (item) =>
          (item.payload as { providerRefundId: string }).providerRefundId ===
          row.id,
      );
      expect(event, `event of ${row.provider_refund_id}`).toBeDefined();
      expect((await deliverEvent(event!)).status).toBe("posted");
      expect((await deliverEvent(event!)).status).toBe("already_posted");
      expect(await journalsByKey(row.id)).toHaveLength(1);
    }
    expect(await balanceOf("gateway_clearing")).toBe(
      clearingBefore - BILL_TOTAL,
    );
  });

  it("1025-B-05 a short payment parked as unallocated fund that the provider then refunds: one row of the money received, one event", async () => {
    const code = await newCode();
    const received = BILL_TOTAL - SHORT_BY;
    expect((await paid(code, received)).status).toBeLessThan(500);
    const funds = await fundsOf(code.id);
    expect(funds, "short payment parked").toHaveLength(1);
    expect(Number(funds[0]!.amount_idr)).toBe(received);

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const rows = await fullRowOf(code);
    expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe(received);
    expect(await providerRows(code.id)).toHaveLength(1);
    expect(await refundEventIds(rows[0]!.id)).toHaveLength(1);
  });

  it("1025-B-06 another tenant is never touched: its rows, events and journals stay, and a webhook naming its payment writes nothing", async () => {
    // A second tenant with a paid intent of its own.
    const otherTenant = randomUUID();
    const otherOutlet = randomUUID();
    const otherEntity = randomUUID();
    const brandId = randomUUID();
    const otherRef = `dp_other_${randomBytes(6).toString("hex")}`;
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Uji 1025 B other', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `uji-1025b-${otherTenant.slice(0, 8)}`, tenantId],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
      [brandId, otherTenant],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Uji', false)",
      [otherEntity, otherTenant],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, 'Uji', 'Test', '{}')`,
      [
        otherOutlet,
        otherTenant,
        brandId,
        otherEntity,
        `O-${otherTenant.slice(0, 6)}`.toUpperCase(),
      ],
    );
    const linkId = randomUUID();
    const otherIntent = randomUUID();
    await owner.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        otherTenant,
        otherOutlet,
        randomBytes(32).toString("hex"),
        `PR-${linkId.slice(0, 8)}`,
        BILL_TOTAL,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, 'paid', now(),
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        otherIntent,
        otherTenant,
        otherOutlet,
        linkId,
        otherRef,
        BILL_TOTAL,
        `pr-${otherIntent}`,
      ],
    );
    const snapshot = async () => ({
      rows: await count(
        "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE tenant_id = $1",
        [otherTenant],
      ),
      events: await count(
        "SELECT count(*)::text AS n FROM domain_event_outbox WHERE tenant_id = $1",
        [otherTenant],
      ),
      journals: await count(
        "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
        [otherTenant],
      ),
      status: (
        await owner.query<{ status: string }>(
          "SELECT status FROM payment_intents WHERE id = $1",
          [otherIntent],
        )
      ).rows[0]!.status,
    });
    const before = await snapshot();

    // Our own full refund books for us only.
    const code = await paidCode();
    await providerRefundsEverywhere(code);
    expect(await fullRowOf(code)).toHaveLength(1);

    // A refunded webhook on OUR endpoint that names the OTHER tenant's payment.
    const forged = await deliver({
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "payment.refunded",
      created_at: new Date().toISOString(),
      data: {
        id: otherRef,
        status: "refunded",
        amount: BILL_TOTAL,
        total_amount: BILL_TOTAL,
        reference: `PR-${linkId.slice(0, 8)}`,
        provider: "pjp",
        fee_amount: 0,
        fee_payer: "merchant",
        created_at: new Date().toISOString(),
      },
    });
    expect(forged.status).toBeLessThan(500);

    expect(await snapshot()).toEqual(before);
    expect(
      await count(
        "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
        [tenantId, otherIntent],
      ),
    ).toBe(0);
  });

  it("1025-B-07 control (958 unchanged): flagged once with one supervisor alert, no manual refund, no fund payout, no provider call, no automatic reversal", async () => {
    const code = await paidCode();
    const alertsBefore = await supervisorAlerts();

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    const attempt = await manualRefund(code.id, BILL_TOTAL);
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowsOfIntent(code.id), "no payout filed").toBe(0);
    expect(fake.calls, "no provider call").toHaveLength(0);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [code.id],
    );
    expect(rows[0]!.status).toBe("paid");

    // A parked fund of another code, refunded by the provider, cannot be paid
    // out a second time either.
    const parked = await newCode();
    expect((await paid(parked, BILL_TOTAL - SHORT_BY)).status).toBeLessThan(
      500,
    );
    const [fund] = await fundsOf(parked.id);
    expect(fund).toBeDefined();
    await providerRefundsEverywhere(parked);
    for (const resolution of ["refund", "credit"] as const) {
      const resolved = await resolveFund(fund!.id, resolution);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(409);
      expect(resolved.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(await refundRowsOfIntent(parked.id)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

// ===========================================================================
// Architect follow-ups: what the full refund's remainder may subtract, and the
// refund of ours that is still in flight (brief 1025 card B, F1a / F1b / F1c /
// F2). Assumptions: the remainder = what the provider received minus our own
// COMPLETED refunds of the main transaction, counted once even when the same
// money is also recorded as an echo provider row, minus earlier provider rows;
// a refund of a parked fund of ANOTHER provider transaction is not part of it.
// A live refund of ours (approved, attempts > 0, not final) makes the webhook
// end `failed` (retryable) with no row; the retry after it resolves writes once.
// ===========================================================================

const OURS = 30_000;

async function asTenantTx<T>(
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A refund of OUR side on the intent (optionally for a parked fund). */
async function seedOurRefund(
  code: Code,
  amountIdr: number,
  opts: {
    status: "completed" | "approved" | "failed";
    providerRef: string | null;
    attempts?: number;
    fundId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref,
        payout_attempts, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', $6, 'requester', 'approver', now(),
             $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      outletId,
      code.id,
      amountIdr,
      opts.status,
      opts.status === "completed" ? new Date() : null,
      opts.providerRef,
      opts.attempts ?? 0,
      opts.fundId ?? null,
    ],
  );
  return id;
}

/** The recorder's echo row of a refund of ours (forced), as the webhook writes it. */
async function seedEchoRow(
  code: Code,
  providerRefundId: string,
  amountIdr: number,
): Promise<void> {
  await asTenantTx((client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (id, tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
      [
        randomUUID(),
        tenantId,
        outletId,
        code.id,
        providerRefundId,
        code.providerRef,
        amountIdr,
      ],
    ),
  );
}

async function storedStatus(eventId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
    [tenantId, eventId],
  );
  return rows.map((row) => row.status);
}

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

/** The provider resends the same event and the worker retries it later. */
async function retryStored(code: Code, body: { id: string }) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - interval '20 minutes',
            updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, body.id],
  );
  await reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
    () => null,
  );
  const again = await deliver(body);
  expect(again.status).toBeLessThan(600);
  await pollLater().catch(() => null);
}

describe("1025-B the remainder of a full refund and a refund of ours in flight", () => {
  it("1025-B-F1a our refund of 30 completed AND recorded as an echo row is counted once: the full refund writes the remainder (not minus 30 twice)", async () => {
    const code = await paidCode();
    await seedOurRefund(code, OURS, {
      status: "completed",
      providerRef: "rf_ours_f1a",
      attempts: 1,
    });
    await seedEchoRow(code, "rf_ours_f1a", OURS);

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const full = await fullRowOf(code);
    expect(full, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(full[0]!.amount_idr, "remainder counts our 30 once").toBe(
      BILL_TOTAL - OURS,
    );
  });

  it("1025-B-F1b our refund of a parked fund of a DIFFERENT transaction does not reduce the remainder of the main transaction", async () => {
    const code = await paidCode();
    const extraRef = `dp_extra_${randomBytes(6).toString("hex")}`;
    const evidence = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now()) RETURNING id`,
      [tenantId, outletId, code.id, extraRef, OURS],
    );
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
      [fundId, tenantId, outletId, code.id, evidence.rows[0]!.id, OURS],
    );
    await seedOurRefund(code, OURS, {
      status: "completed",
      providerRef: "rf_fund_f1b",
      attempts: 1,
      fundId,
    });

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const full = await fullRowOf(code);
    expect(full, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(
      full[0]!.amount_idr,
      "the other transaction's refund is not netted",
    ).toBe(BILL_TOTAL);
  });

  it.each([
    {
      label:
        "F1c sent (has a provider ref) then failed: the provider returned everything",
      live: { providerRef: "rf_live_f1c", attempts: 1 },
      resolve: "failed" as const,
      expected: BILL_TOTAL,
    },
    {
      label:
        "F2 in flight with no provider ref yet, then completed: remainder after it",
      live: { providerRef: null, attempts: 1 },
      resolve: "completed" as const,
      expected: BILL_TOTAL - OURS,
    },
  ])("1025-B-$label", async ({ live, resolve, expected }) => {
    const code = await paidCode();
    const refundId = await seedOurRefund(code, OURS, {
      status: "approved",
      providerRef: live.providerRef,
      attempts: live.attempts,
    });
    doit.refund(code.providerRef);
    const body = doit.eventFor(code.providerRef, "refunded");

    const first = await deliver(body);
    expect(first.status).toBeLessThan(600);

    // While our refund is live nothing is written and the event is not
    // silently dropped: it stays retryable.
    expect(await fullRowOf(code), "no row while our refund is live").toEqual(
      [],
    );
    expect(await storedStatus(body.id)).toEqual(["failed"]);

    // Our refund resolves.
    await owner.query(
      `UPDATE payment_refunds SET status = $2::text, provider_ref = coalesce(provider_ref, 'rf_res_' || id::text),
                completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE NULL END
          WHERE id = $1`,
      [refundId, resolve],
    );
    await retryStored(code, body);

    const full = await fullRowOf(code);
    expect(full, "the retry wrote the row once").toHaveLength(1);
    expect(full[0]!.amount_idr).toBe(expected);
    expect(await providerRows(code.id)).toHaveLength(1);
    expect(await refundEventsOfIntent(code.id)).toBe(1);
  });
});

// ===========================================================================
// Architect round 2: when the full-refund write is FORCED after the retry
// window while our refund R is still in flight, the books may end short if R
// later fails. A recon hold (provider_refund_id `payment:<providerRef>`) and
// one extra alert to finance must be filed in the same transaction as the row.
// Assumptions: forced = the stored event aged past the 15 minute window and
// reprocessed by the worker (same clock trick as the 967 refund door); the
// alert goes to the outlet supervisor like the 958 alert, counted as "one more
// than a plain full refund raises"; table refund_recon_holds as in the 1025-C
// file (tenant_id, payment_intent_id, provider_refund_id, resolved_at).
// ===========================================================================

describe("1025-B a forced full-refund write with our refund still in flight files a recon hold", () => {
  async function holdsFor(code: Code) {
    const { rows } = await owner.query<{
      provider_refund_id: string | null;
      resolved_at: Date | null;
    }>(
      `SELECT provider_refund_id::text AS provider_refund_id, resolved_at
         FROM refund_recon_holds
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenantId, code.id],
    );
    return rows;
  }

  it("1025-B-F3 R in flight, the retry window passes, the worker forces the write: the row, one open hold and one extra alert exist together; a replay adds none", async () => {
    // Control: what a plain full refund alerts.
    const plain = await paidCode();
    const plainBefore = await supervisorAlerts();
    await providerRefundsEverywhere(plain);
    const plainAlerts = (await supervisorAlerts()) - plainBefore;

    const code = await paidCode();
    await seedOurRefund(code, OURS, {
      status: "approved",
      providerRef: null,
      attempts: 1,
    });
    doit.refund(code.providerRef);
    const body = doit.eventFor(code.providerRef, "refunded");
    const alertsBefore = await supervisorAlerts();
    await deliver(body);
    expect(await storedStatus(body.id)).toEqual(["failed"]);
    // legend-d7im9 / 1045-F2 (intended change): a retry caused by our own
    // refund still being in flight now files the "live own" hold at once, so a
    // new refund is refused during the whole window. It is the same hold (same
    // provider refund id, dedup per report) the forced write below keeps open:
    // one open hold from the first delivery on, never a second one.
    const early = await holdsFor(code);
    expect(early, "one open hold already while retrying").toHaveLength(1);
    expect(early[0]!.provider_refund_id).toBe(code.providerRef);
    expect(early[0]!.resolved_at, "open").toBeNull();

    // The window passes with R unresolved: the worker forces the write.
    await owner.query(
      `UPDATE gateway_webhook_events
          SET received_at = now() - interval '20 minutes',
              updated_at = now() - interval '20 minutes'
        WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, body.id],
    );
    await reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
      () => null,
    );

    expect(await fullRowOf(code), "the forced write happened").toHaveLength(1);
    const holds = await holdsFor(code);
    expect(holds, "one hold for the forced write").toHaveLength(1);
    expect(holds[0]!.provider_refund_id).toBe(code.providerRef);
    expect(holds[0]!.resolved_at, "open").toBeNull();
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "a plain full refund alerts, finance gets one more",
    ).toBeGreaterThanOrEqual(plainAlerts + 1);

    // Replays add no second hold and no second row.
    await reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
      () => null,
    );
    await deliver(body);
    expect(await holdsFor(code)).toHaveLength(1);
    expect(await fullRowOf(code)).toHaveLength(1);

    // R failing later changes nothing silently: the hold is still open.
    await owner.query(
      "UPDATE payment_refunds SET status = 'failed' WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, code.id],
    );
    expect((await holdsFor(code))[0]!.resolved_at).toBeNull();
  });
});

// ===========================================================================
// Architect round 3 (1025-B-F4 / F5). Assumptions: the hold's webhook_event_id
// is not asserted (only that a replay keeps ONE hold and ONE alert); "finance
// alert" = a supervisor notification, as in F3; the remainder of an intent
// without an evidence row subtracts the provider rows already recorded, like
// the evidence branch does.
// ===========================================================================

describe("1025-B our refund of the FULL amount in flight, and an intent without an evidence row", () => {
  async function holdsOfIntent(code: Code) {
    const { rows } = await owner.query<{
      provider_refund_id: string | null;
      resolved_at: Date | null;
    }>(
      `SELECT provider_refund_id::text AS provider_refund_id, resolved_at
         FROM refund_recon_holds
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenantId, code.id],
    );
    return rows;
  }

  const runWorker = () =>
    reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
      () => null,
    );

  it("1025-B-F4 R = the whole amount in flight, provider refunded, window passes: one hold, one alert, replay-safe, and after R fails a new refund of the same amount is still 409 PROVIDER_REFUNDED", async () => {
    const code = await paidCode();
    const refundId = await seedOurRefund(code, BILL_TOTAL, {
      status: "approved",
      providerRef: null,
      attempts: 1,
    });
    doit.refund(code.providerRef);
    const body = doit.eventFor(code.providerRef, "refunded");
    const alertsBefore = await supervisorAlerts();
    await deliver(body);

    // The retry window passes with R unresolved: the write is forced.
    await owner.query(
      `UPDATE gateway_webhook_events
          SET received_at = now() - interval '20 minutes',
              updated_at = now() - interval '20 minutes'
        WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, body.id],
    );
    await runWorker();

    const holds = await holdsOfIntent(code);
    expect(holds, "one hold for the forced full refund").toHaveLength(1);
    expect(holds[0]!.provider_refund_id).toBe(code.providerRef);
    expect(holds[0]!.resolved_at, "open").toBeNull();
    const alerts = (await supervisorAlerts()) - alertsBefore;
    expect(alerts, "finance is alerted").toBeGreaterThanOrEqual(1);

    // Replays: the worker twice more, the provider resends the event.
    await runWorker();
    await runWorker();
    await deliver(body);
    expect(await holdsOfIntent(code), "still one hold").toHaveLength(1);
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "no second alert on replay",
    ).toBe(alerts);

    // R then fails: the guest was refunded by the provider already, so staff
    // must not be able to refund the same money again.
    await owner.query(
      "UPDATE payment_refunds SET status = 'failed' WHERE id = $1",
      [refundId],
    );
    const again = await manualRefund(code.id, BILL_TOTAL);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowsOfIntent(code.id), "no second refund filed").toBe(1);
  });

  it("1025-B-F5 no evidence row, a provider partial of 30.000 already recorded, then the full refund: the new row is the remainder and the journal totals the payment once", async () => {
    const code = await paidCode();
    await owner.query(
      "DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, code.id],
    );
    await seedEchoRow(code, "rf_partial_f5", PARTIAL);

    await providerRefundsEverywhere(code);
    await providerRetriesLater(code);

    const full = await fullRowOf(code);
    expect(full, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(full[0]!.amount_idr, "only the remainder").toBe(
      BILL_TOTAL - PARTIAL,
    );
    const rows = await providerRows(code.id);
    expect(rows.reduce((sum, row) => sum + row.amount_idr, 0)).toBe(BILL_TOTAL);

    // The full refund's journal books the remainder, not the whole payment.
    const events = (
      await outboxEnvelopes("payment.provider_refunded", code.id)
    ).filter(
      (event) =>
        (event.payload as { providerRefundId: string }).providerRefundId ===
        full[0]!.id,
    );
    expect(events, "one event for the full row").toHaveLength(1);
    expect((events[0]!.payload as { amountIdr: number }).amountIdr).toBe(
      BILL_TOTAL - PARTIAL,
    );
    expect((await deliverEvent(events[0]!)).status).toBe("posted");
    const entries = await journalsByKey(full[0]!.id);
    expect(entries).toHaveLength(1);
    expect(await linesOf(entries[0]!)).toEqual(
      refundLines(BILL_TOTAL - PARTIAL),
    );
  });
});
