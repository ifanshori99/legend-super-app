// (brief 1063, legend-9uz9n, tier K "jangan sampai rugi"): red-first tests,
// written from docs/briefs/1063-9uz9n.md and docs/briefs/1063-shared-context.md,
// with the 1063-a / 1063-d fixtures as the pattern, not from the implementation.
//
// Rule under test: our refund r echoes a provider fact p only when the provider
// refund id is the same AND the intent is the same AND the source transaction
// is the same (intent-level refund or fund without evidence: the intent's own
// payment; fund with evidence: that evidence's transaction) AND the fact's
// amount is not more than r's. Anything else is foreign money and stays
// counted (restrictive: when in doubt the provider fact counts).
//
// Scenario (brief): R of T1 in flight WITHOUT ref; the report X/T2 waits, then
// `force` books the fact X/T2; R finishes with ref X. The fact X/T2 must not be
// dropped as an echo of R.
//
// Observed through the shared money readers: `providerRefundedForeignIdrSql`
// ("foreign money"), `refundableBalance` (cap, reserved, providerRefunded), the
// fact rows, the fund guard over HTTP, and our own refund rows.
//
// Assumptions (the brief does not fix them):
//  - `transactionLeftIdr` and `ownCompletedIdrSql` of the hold service are not
//    exported: their effect is read through refundableBalance / foreign money
//    and the refund guards, not called directly.
//  - "force books the fact" = recordProviderRefundInTx(..., force: true), as in
//    refund-1025c-b / 1063-b; a premise assert fails loudly if it holds instead.
//  - "R completes with ref X" while a provider fact exists is written straight
//    into payment_refunds (status completed, provider_ref X, completed_at): the
//    retry door may refuse once a fact exists, and the SQL readers only look at
//    the row.
//  - T2 is evidence of Rp100.000 on the same intent. Parked WHOLE (fund
//    Rp100.000) the provider's refund of T2 is left out of foreign money by
//    design (the fund is blocked instead), so the "counted" amounts are read on
//    a SPLIT T2 (fund Rp20.000, fact Rp50.000 > the parked excess: counted in
//    full, legend-g6ept). The whole-fund case checks the fund guard instead.
//  - In 1063-e-05 and 1063-e-07 the recorder would (rightly) file a
//    HOLD_TRANSACTION_CONFLICT instead of a fact when X is already the ref of a
//    completed refund of ours elsewhere; the fact is written as the recorder
//    left it before R carried X (seeded row), so the SQL readers are what is
//    tested, not the hold door (that one is 1063-a / 1063-d).
//  - After the state is built a refund above what is left is refused (>= 400)
//    and creates no new refund of ours; the exact code is not asserted.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-e-source-echo-sql.test.ts" heavy pnpm test

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
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
import { createApp } from "../app";
import { db } from "../db";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { refundableBalance } from "../services/payment-admin.service.ts";
import { providerRefundedForeignIdrSql } from "../services/payment-provider-refunded-foreign-sql.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { createPaymentLink } from "../services/payment.service";
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
const ADMIN = "/api/payments/admin";
const BILL_IDR = 100_000;

const apiKey = `doit-key-1063e-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1063e-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1063e owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files and retries them.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1063e approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who hears about alerts (alerts are counted).
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1063e supervisor");
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
      reference: `R1063E-${unique()}`,
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

const paid = (code: Code, amount: number = BILL_IDR) => {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
};

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

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

// ---------------------------------------------------------------------------
// Building blocks for 1063-e
// ---------------------------------------------------------------------------

const R_IDR = 30_000;
const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;

/** Observed through the shared SQL helpers, as the refund guards read them. */
async function balanceOf(intentId: string) {
  const context = tenantContext();
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantIdSchema.parse(tenantId)),
          eq(paymentIntents.id, intentId),
        ),
      );
    const balance = await refundableBalance(tx, intent!);
    const foreign = await tx.execute(
      sql`SELECT ${providerRefundedForeignIdrSql(sql`${intent!.tenantId}`, sql`${intent!.id}::uuid`)}::text AS n`,
    );
    return {
      cap: Number(balance.cap),
      reserved: Number(balance.reserved),
      providerRefunded: Number(balance.providerRefunded),
      foreign: Number(foreign.rows[0]!.n),
    };
  });
}

/** The signed provider report X/`paymentRef` is recorded (the `force` door). */
function forceFact(
  intentId: string,
  paymentRef: string,
  x: string,
  amountIdr: number,
) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: x,
        refundIdKind: "provider",
        providerPaymentRef: paymentRef,
        amountIdr: idr(amountIdr),
        source: "payment_webhook",
        expectedIntentId: intentId,
        force: true,
      },
      new Date(),
    ),
  );
}

/**
 * A provider fact X/`paymentRef` written as the recorder leaves it (the report
 * reached the books before our refund carried X). Linked to the evidence row of
 * the transaction it refunds, when there is one.
 */
async function seedFact(
  intentId: string,
  paymentRef: string,
  x: string,
  amountIdr: number,
) {
  const evidence = await owner.query<{ id: string }>(
    "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
    [tenantId, intentId, paymentRef],
  );
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
    [
      tenantId,
      outletId,
      intentId,
      evidence.rows[0]?.id ?? null,
      x,
      paymentRef,
      amountIdr,
    ],
  );
}

/** Intent with T1 (Rp100.000, paid) and T2 (evidence of Rp100.000, `fundIdr` of it parked). */
async function withSecondTransaction(fundIdr: number = BILL_IDR) {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const providerRef = `dp_extra_${randomBytes(8).toString("hex")}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletId, code.id, providerRef, BILL_IDR],
  );
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, code.id, evidence.rows[0]!.id, fundIdr],
  );
  return { code, t2: providerRef, fundId };
}

/** Our refund R of `amountIdr` at the intent level, approved, but the answer is lost: in flight, NO ref. */
async function ownRefundInFlightWithoutRef(code: Code, amountIdr: number) {
  const filed = await manualRefund(code.id, amountIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue("throw");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const row = await refundRow(refundId);
  expect(row.provider_ref, "premise: R has no ref yet").toBeNull();
  expect(
    ["completed", "failed"],
    "premise: R is still in flight",
  ).not.toContain(row.status);
  return refundId;
}

/**
 * R finishes at the provider with ref X. Assumption: the retry door may refuse
 * once a provider fact exists, so the completion is written as the poller or
 * webhook would leave it: status completed, provider_ref X.
 */
async function completeOwnRefund(refundId: string, x: string) {
  await owner.query(
    `UPDATE payment_refunds
        SET status = 'completed', provider_ref = $3, completed_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId, x],
  );
  const row = await refundRow(refundId);
  expect(row.status, "premise: R completed").toBe("completed");
  expect(row.provider_ref, "premise: R carries X").toBe(x);
}

/** Our refund R (intent level, Rp30.000) completed through the API with ref X. */
async function ownCompleted(code: Code, amountIdr: number = R_IDR) {
  const own = await ownIntentRefund(code, amountIdr, "completed");
  return own;
}

/** A fund refund of the parked T2 fund, completed through the API with ref X. */
async function completedFundRefund(fundId: string) {
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
  expect(row.provider_ref, "premise: fund refund carries X").toBeTruthy();
  return { refundId, x: row.provider_ref! };
}

const factOf = async (intentId: string, ref: string, x: string) =>
  (await factsOfRef(intentId, ref)).filter(
    (row) => row.provider_refund_id === x,
  );

/**
 * Money out must stay within what was refundable: after the state is built a
 * new intent-level refund above what is left (at least Rp1.000) is refused, and
 * no new refund of ours exists.
 */
async function expectNoOverRefund(code: Code, label: string) {
  const before = await ourRefundedIdr(code.id);
  const balance = await balanceOf(code.id);
  const left = Math.max(0, balance.cap - balance.reserved);
  const attempt = await manualRefund(code.id, left + 1_000);
  expect(
    attempt.status,
    `${label}: a refund of ${left + 1_000} (left ${left}) is refused: ${JSON.stringify(attempt.body)}`,
  ).toBeGreaterThanOrEqual(400);
  expect(await ourRefundedIdr(code.id), `${label}: no new refund of ours`).toBe(
    before,
  );
}

// ---------------------------------------------------------------------------
// 9uz9n: our refund is an echo only for the same intent, transaction and up to
// the amount we sent
// ---------------------------------------------------------------------------

describe("9uz9n R without ref, then fact X/T2 (force), then R completes with ref X: the fact of the other transaction stays counted", () => {
  it("1063-e-01 T2 parked WHOLE as a fund: the fact X/T2 stays booked and its fund stays blocked (no fund refund, nothing sent), money out stays within what both transactions paid", async () => {
    const t = await withSecondTransaction(BILL_IDR);
    const refundId = await ownRefundInFlightWithoutRef(t.code, R_IDR);
    const x = newRefundId();
    await forceFact(t.code.id, t.t2, x, BILL_IDR);
    expect(
      await factOf(t.code.id, t.t2, x),
      `premise: force booked the fact X/T2 (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
    ).toHaveLength(1);
    await completeOwnRefund(refundId, x);
    const callsBefore = fake.calls.length;

    expect
      .soft(await factOf(t.code.id, t.t2, x), "the fact X/T2 is still booked")
      .toHaveLength(1);
    const filed = await resolveFund(t.fundId, "refund");
    if (filed.status === 200) {
      const { rows } = await owner.query<{ id: string }>(
        "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
        [tenantId, t.fundId],
      );
      const approved = await approveRefund(rows[0]!.id);
      expect
        .soft(
          approved.status,
          `T2's money was already refunded by the provider: payout refused (${JSON.stringify(approved.body)})`,
        )
        .toBe(409);
    } else {
      expect.soft(filed.status, JSON.stringify(filed.body)).toBe(409);
    }
    expect.soft(fake.calls, "nothing is sent for T2").toHaveLength(callsBefore);
    // Paid: T1 100.000 + T2 100.000. Out: R (30.000 of T1) + provider fact on
    // T2 (100.000) + any fund refund of ours for T2 (all in our refund rows).
    const out =
      (await ourRefundedIdr(t.code.id)) + (await factTotal(t.code.id));
    expect(out, "money out within what was paid (T1 + T2)").toBeLessThanOrEqual(
      2 * BILL_IDR,
    );
  });

  it("1063-e-02 T2 split (Rp20.000 parked): the fact X/T2 of Rp50.000 is counted as foreign money, the net balance is Rp20.000, a larger refund is refused", async () => {
    const t = await withSecondTransaction(20_000);
    const refundId = await ownRefundInFlightWithoutRef(t.code, R_IDR);
    const x = newRefundId();
    await forceFact(t.code.id, t.t2, x, 50_000);
    expect(
      await factOf(t.code.id, t.t2, x),
      `premise: force booked the fact X/T2 (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
    ).toHaveLength(1);
    await completeOwnRefund(refundId, x);

    const balance = await balanceOf(t.code.id);
    expect
      .soft(balance.foreign, "foreign money: the Rp50.000 fact of T2 counts")
      .toBe(50_000);
    expect
      .soft(balance.providerRefunded, "refundableBalance agrees")
      .toBe(50_000);
    expect.soft(balance.reserved, "R counts in T1").toBe(R_IDR);
    expect
      .soft(balance.cap - balance.reserved, "left = 100.000 - 50.000 - 30.000")
      .toBe(20_000);
    await expectNoOverRefund(t.code, "e-02");
  });

  it("1063-e-03 fact X/T1 of Rp80.000 (more than R Rp30.000): not an echo, counted in full as foreign money, nothing is left to refund", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const refundId = await ownRefundInFlightWithoutRef(code, R_IDR);
    const x = newRefundId();
    await forceFact(code.id, code.providerRef, x, 80_000);
    expect(
      await factOf(code.id, code.providerRef, x),
      `premise: force booked the fact X/T1 (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(1);
    await completeOwnRefund(refundId, x);

    const balance = await balanceOf(code.id);
    expect
      .soft(balance.foreign, "foreign money: the Rp80.000 fact counts")
      .toBe(80_000);
    expect.soft(balance.providerRefunded).toBe(80_000);
    expect.soft(balance.cap, "refundable cap = 100.000 - 80.000").toBe(20_000);
    expect(
      balance.cap - balance.reserved,
      "R (30.000) already exceeds the cap: nothing is left",
    ).toBeLessThanOrEqual(0);
    await expectNoOverRefund(code, "e-03");
  });

  it.each([30_000, 10_000])(
    "1063-e-04 control, a true echo: fact X/T1 of Rp%i (not more than R Rp30.000) is not counted twice: foreign money Rp0, balance Rp70.000",
    async (amountIdr) => {
      const code = await newCode(BILL_IDR);
      expect((await paid(code, BILL_IDR)).status).toBe(200);
      const refundId = await ownRefundInFlightWithoutRef(code, R_IDR);
      const x = newRefundId();
      await forceFact(code.id, code.providerRef, x, amountIdr);
      await completeOwnRefund(refundId, x);

      const balance = await balanceOf(code.id);
      expect.soft(balance.foreign, "echo of R: not foreign money").toBe(0);
      expect.soft(balance.providerRefunded).toBe(0);
      expect.soft(balance.cap, "paid in full").toBe(BILL_IDR);
      expect
        .soft(
          balance.cap - balance.reserved,
          "only R is taken: 100.000 - 30.000",
        )
        .toBe(BILL_IDR - R_IDR);
      const out = (await ourRefundedIdr(code.id)) + balance.foreign;
      expect(out, "R counted once, within what was paid").toBeLessThanOrEqual(
        BILL_IDR,
      );
    },
  );

  it("1063-e-05 X is the ref of our refund in ANOTHER intent J: the fact X/T1 (Rp20.000, within R) in this intent is not an echo, it counts", async () => {
    const other = await newCode(BILL_IDR);
    expect((await paid(other, BILL_IDR)).status).toBe(200);
    const own = await ownCompleted(other);
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    await seedFact(code.id, code.providerRef, own.x, 20_000);
    expect(
      await factOf(code.id, code.providerRef, own.x),
      `premise: the fact is booked (holds: ${JSON.stringify(await allHolds(code.id))})`,
    ).toHaveLength(1);

    const balance = await balanceOf(code.id);
    expect
      .soft(balance.foreign, "another intent's refund does not echo this fact")
      .toBe(20_000);
    expect.soft(balance.cap, "100.000 - 20.000").toBe(80_000);
    expect
      .soft((await balanceOf(other.id)).foreign, "intent J is untouched")
      .toBe(0);
    await expectNoOverRefund(code, "e-05");
  });
});

describe("9uz9n fund refund with evidence: echo only for the evidence's own transaction", () => {
  it("1063-e-06 control: fund refund of T2 (evidence T2) completed with ref X, fact X/T2 of the same Rp100.000 is its echo: not counted twice", async () => {
    const t = await withSecondTransaction(BILL_IDR);
    const fundRefund = await completedFundRefund(t.fundId);
    await forceFact(t.code.id, t.t2, fundRefund.x, BILL_IDR);

    const balance = await balanceOf(t.code.id);
    expect
      .soft(balance.foreign, "echo of our fund refund: not foreign money")
      .toBe(0);
    expect.soft(balance.providerRefunded).toBe(0);
    expect.soft(balance.cap, "T1 stays whole").toBe(BILL_IDR);
    const out = (await ourRefundedIdr(t.code.id)) + balance.foreign;
    expect(
      out,
      "T2's money went out once: Rp100.000, within what T2 paid",
    ).toBeLessThanOrEqual(BILL_IDR);
  });

  it("1063-e-07 fund refund of T2 completed with ref X; fact X/T1 of Rp40.000 (source T1, not the fund's evidence T2): not an echo, counted as foreign money", async () => {
    const t = await withSecondTransaction(BILL_IDR);
    const fundRefund = await completedFundRefund(t.fundId);
    await seedFact(t.code.id, t.code.providerRef, fundRefund.x, 40_000);
    expect(
      await factOf(t.code.id, t.code.providerRef, fundRefund.x),
      `premise: the fact X/T1 is booked (holds: ${JSON.stringify(await allHolds(t.code.id))})`,
    ).toHaveLength(1);

    const balance = await balanceOf(t.code.id);
    expect
      .soft(balance.foreign, "the fact of T1 is a different transaction")
      .toBe(40_000);
    expect.soft(balance.providerRefunded).toBe(40_000);
    expect.soft(balance.cap, "100.000 - 40.000").toBe(60_000);
    await expectNoOverRefund(t.code, "e-07");
  });
});
