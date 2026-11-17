// legend-9s33i (brief 1025 card C, money): a signed DOIT `refund.succeeded`
// whose reference names ANOTHER intent than the one owning the payment id
// (1020 F3 REFERENCE_MISMATCH) used to be dropped without a trace. Money may
// have left the provider while nobody knows. It is now recorded as an open
// recon hold, finance is alerted once, and the intent that owns the payment id
// cannot pay anything out until finance matches it. Still NO automatic
// refund/stamp: no payment_provider_refunds row, no stamp, no journal.
//
// Written from the brief and the 1020/958 fixtures, not from the
// implementation, and failing first. Fixtures (FakeDoit, extra transaction X
// of intent B, mismatch event shapes) follow
// payment-refund-succeeded-reference-mismatch-1020.test.ts.
//
// Assumptions (the brief does not fix them):
//  - Table `refund_recon_holds` (tenant_id, payment_intent_id, webhook_event_id,
//    provider_refund_id, amount_idr, reason, flagged_at, resolved_at). An open
//    hold has resolved_at NULL. `webhook_event_id` may hold the provider event
//    id ("evt_...") or the stored gateway_webhook_events row id; both accepted.
//  - The hold sits on the intent that OWNS the payment id of the event (B for
//    the extra transaction X, A for the reverse shape), the intent that
//    received the money movement. The referenced (other) intent is not
//    asserted either way.
//  - "Blocked" = what a provider refund already does (958): a new manual
//    refund and a fund refund answer 409 PROVIDER_REFUNDED; an approved but
//    unsent refund is not paid out (no provider call, no journal, not
//    completed).
//  - The stored event stays `ignored` / REFERENCE_MISMATCH (1020 behaviour);
//    the alert goes to the outlet supervisor, exactly one for the event no
//    matter how often it is replayed or the worker retries.
//  - Replay = the same event id delivered again (also concurrently). A resend
//    under a NEW event id is not asserted.
//  - Controls that need the table tolerate its absence (they pass at base).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025-c-reference-mismatch-hold.test.ts" heavy pnpm test

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

const apiKey = `doit-key-1025c-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1025c-${randomBytes(16).toString("hex")}`;

// A second tenant, seeded lazily: its intents must stay untouched.
const otherScope = paymentTestScope();
let otherSeeded = false;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
let staff: ReturnType<typeof agent>;
let approver: ReturnType<typeof agent>;
let approverId = "";
let supervisorUserId = "";
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
  const email = await signUp(staff, "Refund1025c owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1025c approver");
  const approverSession = await approver.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // The outlet supervisor who must hear about the recon hold.
  const supervisorClient = agent(app).set("Host", scope.hostname);
  await signUp(supervisorClient, "Refund1025c supervisor");
  const supervisorSession = await supervisorClient.get("/api/auth/get-session");
  supervisorUserId = supervisorSession.body.user.id as string;
  userIds.push(supervisorUserId);
  await assign(supervisorUserId, "supervisor", "outlet");

  // Refund approvals need a policy.
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

/** Open and closed recon holds of the tenant, tolerant of a missing table. */
async function dropHolds(tenant: string) {
  await owner.query(
    `DO $$ BEGIN
       IF to_regclass('refund_recon_holds') IS NOT NULL THEN
         EXECUTE format('DELETE FROM refund_recon_holds WHERE tenant_id = %L', '${tenant}');
       END IF;
     END $$`,
  );
}

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await dropHolds(tenantId);
  await owner.query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
    tenantId,
  ]);
  for (const id of [tenantId, ...(otherSeeded ? [otherScope.tenantId] : [])]) {
    const linkIds = id === tenantId ? createdLinkIds : otherLinkIds;
    if (linkIds.length === 0) continue;
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    for (const table of [
      "payment_refunds",
      "payment_provider_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [id, linkIds],
      );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [id, linkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [id, linkIds],
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

const otherLinkIds: string[] = [];

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
// Helpers of this card
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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

const retryRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

/** Approved by a third person but not yet sent: 0 attempts, no provider ref. */
async function approveWithoutSending(refundId: string) {
  await owner.query(
    `UPDATE payment_refunds
        SET status = 'approved', approved_by = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId, approverId],
  );
}

async function refundStatuses(intentId: string): Promise<string[]> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return rows.map((row) => row.status);
}

const refundRowsOfFund = (fundId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );

/** The refund was not paid out: no provider call, no journal, not completed. */
async function expectNotPaidOut(intentId: string, journalsBefore: number) {
  expect(fake.calls, "no provider refund call").toHaveLength(0);
  expect(fake.executionCount).toBe(0);
  expect(await journals(), "no payout journal").toBe(journalsBefore);
  for (const status of await refundStatuses(intentId))
    expect(["completed", "processing", "paid"]).not.toContain(status);
}

type Hold = {
  payment_intent_id: string;
  webhook_event_id: string;
  provider_refund_id: string | null;
  amount_idr: string;
  reason: string | null;
  flagged_at: Date | null;
  resolved_at: Date | null;
};

/** Recon holds of the tenant on the given intents. Fails when the table is missing. */
async function holdsOf(intentIds: string[]): Promise<Hold[]> {
  const { rows } = await owner.query<Hold>(
    `SELECT payment_intent_id::text AS payment_intent_id,
            webhook_event_id::text AS webhook_event_id,
            provider_refund_id::text AS provider_refund_id,
            amount_idr::text AS amount_idr, reason, flagged_at, resolved_at
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])`,
    [tenantId, intentIds],
  );
  return rows;
}

/** Same, for controls: a missing table simply means no holds. */
async function holdsOfIfTable(intentIds: string[]): Promise<Hold[]> {
  const { rows } = await owner.query<{ t: string | null }>(
    "SELECT to_regclass('refund_recon_holds')::text AS t",
  );
  return rows[0]?.t ? holdsOf(intentIds) : [];
}

/** The id of the stored gateway_webhook_events row (webhook_event_id may be it). */
async function storedRowId(eventId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string | null }>(
    `SELECT to_jsonb(g)->>'id' AS id FROM gateway_webhook_events g
      WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows[0]?.id ?? "";
}

/** The provider refund id the event carries (nested or flat shape). */
function refundIdOf(body: ReturnType<typeof envelope>): string {
  const data = body.data as { id?: string; refund?: { id?: string } };
  return String(data.refund?.id ?? data.id);
}

/** The intent that owns the event's payment id and must be held. */
const heldIntentOf = (shape: MismatchShape, s: Scene): Code =>
  shape.startsWith("reverse") ? s.a : s.b;

async function expectNothingMoved(
  s: Scene,
  before: Awaited<ReturnType<typeof moneyState>>,
) {
  const after = await moneyState(s);
  expect(after.providerRefunds, "no provider refund row").toEqual({
    rows: 0,
    idr: 0,
  });
  for (const stamp of [...after.stamps.intents, ...after.stamps.funds])
    expect(stamp, "no provider-refund stamp").toBeNull();
  expect(after.books, "books unchanged").toEqual(before.books);
  expect(fake.calls, "no provider payout call").toHaveLength(0);
}

async function moneyState(s: Scene) {
  return {
    providerRefunds: await providerRefunds([s.a.id, s.b.id]),
    stamps: await stamps([s.a.id, s.b.id]),
    books: [await books(s.a), await books(s.b)],
  };
}

// ---------------------------------------------------------------------------
// (1) the mismatch is flagged, once, with an alert
// ---------------------------------------------------------------------------

describe("legend-9s33i refund.succeeded naming another intent leaves a recon hold and an alert", () => {
  it.each(MISMATCH_SHAPES)(
    "1025-9s33i %s: one open hold on the intent owning the payment id, one supervisor alert, nothing refunded or stamped (also after replay and worker retries)",
    async (shape) => {
      const s = await scene();
      const before = await moneyState(s);
      const alertsBefore = await supervisorAlerts();

      const body = mismatchedRefund(shape, s);
      await deliver(body);
      await settleEvents([body.id]);
      // Replay of the very same event, then the worker again.
      await deliver(body);
      await settleEvents([body.id]);

      const holds = await holdsOf([s.a.id, s.b.id]);
      expect(holds, "exactly one hold, not one per replay").toHaveLength(1);
      const hold = holds[0]!;
      expect(hold.payment_intent_id).toBe(heldIntentOf(shape, s).id);
      expect([body.id, await storedRowId(body.id)]).toContain(
        hold.webhook_event_id,
      );
      expect(hold.provider_refund_id).toBe(refundIdOf(body));
      expect(Number(hold.amount_idr)).toBe(s.x.amountIdr);
      expect(hold.reason, "a reason finance can read").toBeTruthy();
      expect(hold.flagged_at).not.toBeNull();
      expect(hold.resolved_at, "open").toBeNull();

      expect(
        (await supervisorAlerts()) - alertsBefore,
        "one alert for the event",
      ).toBe(1);
      await expectIgnoredMismatch(body.id);
      await expectNothingMoved(s, before);
      expect((await fundsOfScene(s)).map((f) => f.resolution)).toEqual([null]);
    },
  );

  it("1025-9s33i the same event delivered concurrently and retried by the worker: still one hold and one alert", async () => {
    const s = await scene();
    const before = await moneyState(s);
    const alertsBefore = await supervisorAlerts();

    const body = mismatchedRefund("both references", s);
    await Promise.all([
      deliver(body),
      deliver(body),
      deliver(body),
      deliver(body),
    ]);
    await settleEvents([body.id]);
    await settleEvents([body.id]);

    expect(await holdsOf([s.a.id, s.b.id])).toHaveLength(1);
    expect((await supervisorAlerts()) - alertsBefore).toBe(1);
    await expectNothingMoved(s, before);
  });
});

const fundsOfScene = (s: Scene) => fundsOf(s.b.id);

// ---------------------------------------------------------------------------
// (2) the held intent cannot pay out; the guest is not refunded twice
// ---------------------------------------------------------------------------

describe("legend-9s33i an open hold blocks every refund and payout of the held intent", () => {
  it("1025-9s33i control: without any hold, a refund of the intent and of its parked fund is accepted (the blocks below are not vacuous)", async () => {
    const s = await scene();
    const filed = await manualRefund(s.b.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const fund = await resolveFund(s.fundId, "refund");
    expect(fund.status, JSON.stringify(fund.body)).toBe(200);
    expect(await refundRowsOfFund(s.fundId)).toBe(1);
    expect(await holdsOfIfTable([s.a.id, s.b.id])).toHaveLength(0);
  });

  it("1025-9s33i held intent: a new refund is 409 PROVIDER_REFUNDED, the parked fund cannot be refunded, an approved unsent refund is not paid out", async () => {
    const s = await scene();
    // A refund approved but never sent, filed before the mismatch arrives.
    const filed = await manualRefund(s.b.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    await approveWithoutSending(refundId);

    const body = mismatchedRefund("both references", s);
    await deliver(body);
    await settleEvents([body.id]);

    const second = await manualRefund(s.b.id, 5_000);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("PROVIDER_REFUNDED");

    const fundTry = await resolveFund(s.fundId, "refund");
    expect(fundTry.status, JSON.stringify(fundTry.body)).toBe(409);
    expect(fundTry.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowsOfFund(s.fundId)).toBe(0);

    const journalsBefore = await journals();
    const attempt = await retryRefund(refundId);
    expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(500);
    await expectNotPaidOut(s.b.id, journalsBefore);
    expect(
      (await refundStatuses(s.b.id)).length,
      "no extra refund row appeared",
    ).toBe(1);

    expect(await holdsOf([s.a.id, s.b.id])).toHaveLength(1);
  });

  it("1025-9s33i reverse shape: the intent owning the payment id (A) is held and cannot pay out", async () => {
    const s = await scene();
    const body = mismatchedRefund(
      "reverse: A's own payment id, B's reference",
      s,
    );
    await deliver(body);
    await settleEvents([body.id]);

    const attempt = await manualRefund(s.a.id, 5_000);
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    expect(attempt.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(fake.calls).toHaveLength(0);
    expect(await holdsOf([s.a.id, s.b.id])).toHaveLength(1);
  });

  it("1025-9s33i an unrelated intent of the same tenant and the intents of another tenant are not affected", async () => {
    const s = await scene();
    const c = await newCode();
    expect((await paid(c)).status).toBeLessThan(500);

    if (!otherSeeded) {
      await otherScope.seed(owner);
      otherSeeded = true;
    }
    const linkId = randomUUID();
    const foreignIntentId = randomUUID();
    otherLinkIds.push(linkId);
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 50000, 50000, 50000, 'refund-1025c-test')`,
      [
        linkId,
        otherScope.tenantId,
        otherScope.outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `X1025-${linkId.slice(0, 8)}`,
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
        `x1025-${foreignIntentId}`,
        newExtraId(),
      ],
    );

    const body = mismatchedRefund("both references", s);
    await deliver(body);
    await settleEvents([body.id]);

    // Same tenant, other bill: refunds stay open.
    const cRefund = await manualRefund(c.id, 10_000);
    expect(cRefund.status, JSON.stringify(cRefund.body)).toBe(201);

    // The hold exists for the mismatching pair only.
    expect(await holdsOf([s.a.id, s.b.id])).toHaveLength(1);
    expect(await holdsOf([c.id])).toHaveLength(0);
    const elsewhere = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM refund_recon_holds
        WHERE tenant_id = $1 OR payment_intent_id = $2`,
      [otherScope.tenantId, foreignIntentId],
    );
    expect(Number(elsewhere.rows[0]!.n), "no hold in another tenant").toBe(0);
    const foreign = await owner.query<{ stamp: Date | null }>(
      "SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents WHERE id = $1",
      [foreignIntentId],
    );
    expect(foreign.rows[0]!.stamp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (3) control: a matching reference is recorded as before, with no hold
// ---------------------------------------------------------------------------

describe("legend-9s33i control: a refund naming the intent that owns the payment id", () => {
  it("1025-9s33i control: recorded on that intent as a provider refund, no recon hold", async () => {
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
    expect(await holdsOfIfTable([s.a.id, s.b.id])).toHaveLength(0);
    const rows = await eventRow(body.id);
    expect(rows[0]!.last_error_code).not.toBe("REFERENCE_MISMATCH");
  });
});
