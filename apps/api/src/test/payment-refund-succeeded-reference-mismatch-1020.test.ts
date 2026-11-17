// legend-6jdy1 (P2), brief 1020 F3: a signed DOIT `refund.succeeded` event is
// only recorded on an intent when EVERY reference it carries (`refund.reference`
// and `payment.reference`) names that very intent. Today the webhook hands only
// refund id / payment id / amount to the recorder, so an event whose payment id
// is an extra transaction (evidence) of intent B but whose references name
// intent A is booked on B. The `payment.refunded` door already refuses this
// combination (payment-doit-extra-txn-refund-967.test.ts, "evidence of ANOTHER
// intent"). Written from the brief (F3) and the 967 fixtures, not from the
// implementation, and failing first.
//
// Rules asserted (money rules: "jangan sampai rugi"):
//  (1) intents A and B of one tenant, both paid; X is an extra transaction of B
//      (evidence + a parked unallocated fund). A `refund.succeeded` whose
//      payment id is X (or A's own id) but whose reference(s) name the OTHER
//      intent is not recorded: the stored event ends `ignored` with
//      REFERENCE_MISMATCH and nothing moves. No payment_provider_refunds row,
//      no stamp on an intent or fund, no audit row, no journal, same
//      refundable amounts, no provider payout call (legend-9s33i, 1025 C: one
//      supervisor alert and a recon hold now mark it, see
//      refund-1025-c-reference-mismatch-hold.test.ts). Shapes: both
//      references, flat `object: "refund"`, `refund.reference` only,
//      `payment.reference` only, and the reverse (A's own payment id with
//      B's reference).
//  (2) the retry worker running again after the 15 minute window (and twice)
//      leaves the same result.
//  (3) control: the same event with references that match the intent owning X
//      IS recorded on B (one provider refund row of that amount, none on A), so
//      the checks above are not vacuous.
//
// Assumptions (the brief does not fix them):
//  - "Intent reference" = the `reference` the DOIT payment of that intent
//    carries (the fake DOIT echoes what the app sent); A and B have different
//    references.
//  - Event shapes follow payment-doit-refund-facts-parse.test.ts: nested
//    `{ refund: {id, amount, reference?, payment_id?}, payment?: {id,
//    reference, status, amount} }`, or flat `{ object: "refund", id, amount,
//    reference, payment_id }`.
//  - A `refund.succeeded` matching none of our refunds is answered 500 and
//    retried for 15 minutes (payment-doit-partial-refund-967.test.ts); the
//    result is read after backdating the stored event and running
//    reprocessStoredWebhookEvents, twice. The first answer is not pinned
//    (200 ignored right away, or 500 and retry) and is not asserted.
//  - "Ignored" = gateway_webhook_events.status `ignored` with
//    last_error_code REFERENCE_MISMATCH, after the worker ran.
//  - Control: a matching extra-transaction refund is recorded as one
//    payment_provider_refunds row of the intent owning X (amount = event
//    amount), after the same worker run.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-refund-succeeded-reference-mismatch-1020.test.ts" heavy pnpm test

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
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent, signUp, verifySessionMfa } from "./helpers";
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

const apiKey = `doit-key-1020-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1020-${randomBytes(16).toString("hex")}`;

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

const unique = () => randomBytes(4).toString("hex");

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

  // Back-office owner: reads the refund screen.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1020 owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // The outlet supervisor who must hear about a recorded provider refund.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1020 supervisor");
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
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    for (const table of [
      "payment_refunds",
      "payment_provider_refunds",
      "refund_recon_holds",
      "payment_evidence",
      "payment_unallocated_funds",
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
      reference: `R1020-${unique()}`,
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

const paid = (code: Code, amount: number = BILL_TOTAL) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

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

// ---------------------------------------------------------------------------
// refund.succeeded fixtures
// ---------------------------------------------------------------------------

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

/** Age the stored events past the 15 minute retry window and run the worker. */
async function ageAndRunWorker(eventIds: string[]) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - interval '20 minutes',
            updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND event_id = ANY($2::text[])`,
    [tenantId, eventIds],
  );
  await reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
    () => null,
  );
}

/** The worker retries: it runs twice, the second time after a fresh backdate. */
async function settleEvents(eventIds: string[]) {
  await ageAndRunWorker(eventIds);
  await ageAndRunWorker(eventIds);
}

/** The reference DOIT holds for the code's payment (what the app sent). */
function referenceOf(code: Code): string {
  const payment = doit.payments.get(code.providerRef);
  if (!payment) throw new Error(`No fake DOIT payment ${code.providerRef}`);
  return payment.reference;
}

/** Provider refunds recorded for intents (legend-30hfs): row count and rupiah. */
async function providerRefunds(intentIds: string[]) {
  const { rows } = await owner.query<{ rows: string; idr: string }>(
    `SELECT count(*)::text AS rows, coalesce(sum(amount_idr), 0)::text AS idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])`,
    [tenantId, intentIds],
  );
  return { rows: Number(rows[0]!.rows), idr: Number(rows[0]!.idr) };
}

/** The refund screen's view of a paid intent; absent when nothing is left. */
async function refundView(intentId: string) {
  const response = await staff.get(
    `${ADMIN}/refunds/refundable?outletId=${outletId}`,
  );
  expect(response.status).toBe(200);
  const row = (
    response.body.data.payments as Array<{
      paymentIntentId: string;
      paidAmountIdr: number;
      refundedAmountIdr: number;
      refundableAmountIdr: number;
    }>
  ).find((p) => p.paymentIntentId === intentId);
  return {
    paid: row?.paidAmountIdr ?? BILL_TOTAL,
    refunded: row?.refundedAmountIdr ?? BILL_TOTAL,
    refundable: row?.refundableAmountIdr ?? 0,
  };
}

type Scene = {
  a: Code;
  b: Code;
  /** An extra transaction of B (evidence) whose money is the parked fund. */
  x: Extra;
  fundId: string;
};

/** A and B paid in full; B also holds the extra transaction X, parked. */
async function scene(): Promise<Scene> {
  const a = await newCode();
  const b = await newCode();
  expect((await paid(a)).status).toBeLessThan(500);
  expect((await paid(b)).status).toBeLessThan(500);
  const x = await addExtraTxn(b);
  const fundId = await parkExtra(b, x);
  expect(referenceOf(a)).not.toBe(referenceOf(b));
  return { a, b, x, fundId };
}

/** Everything a mismatched refund event must NOT change. */
async function snapshot({ a, b }: Scene) {
  return {
    audits: [await auditActions(a.id), await auditActions(b.id)],
    alerts: await supervisorAlerts(),
    books: [await books(a), await books(b)],
    stamps: await stamps([a.id, b.id]),
    providerRefunds: await providerRefunds([a.id, b.id]),
    views: [await refundView(a.id), await refundView(b.id)],
    payoutCalls: fake.calls.length,
  };
}

const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;

function envelope(data: Record<string, unknown>) {
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data,
  };
}

const paymentObject = (id: string, reference: string, amountIdr: number) => ({
  id,
  reference,
  status: "refunded",
  amount: amountIdr,
});

type MismatchShape =
  | "both references"
  | "flat object refund, refund.reference"
  | "refund.reference only"
  | "payment.reference only"
  | "reverse: A's own payment id, B's reference";

const MISMATCH_SHAPES: MismatchShape[] = [
  "both references",
  "flat object refund, refund.reference",
  "refund.reference only",
  "payment.reference only",
  "reverse: A's own payment id, B's reference",
];

/**
 * A `refund.succeeded` whose payment id belongs to one intent while a
 * reference names the OTHER intent (A for X, which is evidence of B).
 */
function mismatchedRefund(shape: MismatchShape, { a, b, x }: Scene) {
  const aRef = referenceOf(a);
  const bRef = referenceOf(b);
  const amount = x.amountIdr;
  const id = newRefundId();
  switch (shape) {
    case "both references":
      return envelope({
        refund: { id, amount, reference: aRef },
        payment: paymentObject(x.providerRef, aRef, amount),
      });
    case "flat object refund, refund.reference":
      return envelope({
        object: "refund",
        id,
        amount,
        reference: aRef,
        payment_id: x.providerRef,
      });
    case "refund.reference only":
      return envelope({
        refund: {
          id,
          amount,
          reference: aRef,
          payment_id: x.providerRef,
        },
      });
    case "payment.reference only":
      return envelope({
        refund: { id, amount },
        payment: paymentObject(x.providerRef, aRef, amount),
      });
    case "reverse: A's own payment id, B's reference":
      return envelope({
        refund: { id, amount, reference: bRef },
        payment: paymentObject(a.providerRef, bRef, amount),
      });
  }
}

async function expectIgnoredMismatch(eventId: string) {
  const rows = await eventRow(eventId);
  expect(rows, "event stored once").toHaveLength(1);
  expect(rows[0]).toEqual({
    status: "ignored",
    last_error_code: "REFERENCE_MISMATCH",
  });
}

// ---------------------------------------------------------------------------
// (1) + (2) a reference that names another intent is never recorded
// ---------------------------------------------------------------------------

describe("legend-6jdy1 refund.succeeded with a reference that does not name the intent owning the payment id", () => {
  it.each(MISMATCH_SHAPES)(
    "1020-6jdy1 %s: ignored REFERENCE_MISMATCH, no provider refund row, no stamp, no audit, one alert (legend-9s33i), intents and fund unchanged (also after worker retries)",
    async (shape) => {
      const s = await scene();
      const before = await snapshot(s);
      expect(before.providerRefunds).toEqual({ rows: 0, idr: 0 });

      const body = mismatchedRefund(shape, s);
      await deliver(body);
      await settleEvents([body.id]);
      // The provider also resends the same refund under a new event id.
      const resend = { ...body, id: `evt_${randomBytes(8).toString("hex")}` };
      await deliver(resend);
      await settleEvents([resend.id]);

      await expectIgnoredMismatch(body.id);
      await expectIgnoredMismatch(resend.id);
      // legend-9s33i: the mismatch is now alerted once (the resend names the
      // same provider refund, so it is the same alert); nothing else moves.
      const after = await snapshot(s);
      expect(after.alerts - before.alerts).toBe(1);
      expect({ ...after, alerts: 0 }).toEqual({ ...before, alerts: 0 });
      // Neither intent nor the parked fund of X carries a provider-refund stamp.
      for (const stamp of [...before.stamps.intents, ...before.stamps.funds])
        expect(stamp).toBeNull();
      expect((await fundsOf(s.b.id)).map((f) => f.resolution)).toEqual([null]);
      expect(fake.calls, "no provider payout call").toHaveLength(0);
    },
  );

  it("1020-6jdy1 control: the same refund naming the intent that owns X is recorded on that intent only", async () => {
    const s = await scene();
    const bRef = referenceOf(s.b);
    const body = envelope({
      refund: { id: newRefundId(), amount: s.x.amountIdr, reference: bRef },
      payment: paymentObject(s.x.providerRef, bRef, s.x.amountIdr),
    });

    await deliver(body);
    await settleEvents([body.id]);

    expect(await providerRefunds([s.a.id])).toEqual({ rows: 0, idr: 0 });
    expect(await providerRefunds([s.b.id])).toEqual({
      rows: 1,
      idr: s.x.amountIdr,
    });
    const rows = await eventRow(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_error_code).not.toBe("REFERENCE_MISMATCH");
  });
});
