// legend-hpwpt (brief 1025d, finding 4, tier K "jangan sampai rugi"): a valid
// DOIT payment id may be up to 100 characters long. The recorder keys a full
// provider refund of a transaction with a synthetic provider refund id
// (`payment:<ref>`) and its column holds 100 characters, so a payment id of 93
// to 100 characters used to be refused ("unbound"): the event was ignored, the
// fund of an extra transaction was not stamped (and could be paid out again)
// and, for the main transaction, the poller treated the refusal as success so
// the provider-refund fact and its journal event were lost.
//
// Written from the brief (docs/briefs/1025d-temuan-second-opinion.md, the
// decided design) and the 1025-B / 1025-C / 1025-D fixtures; not from the
// implementation.
//
// Design asserted (decided in the brief):
//  - synthetic id = `payment:<ref>` when 8 + ref.length <= 100, otherwise
//    `payment:h:` + sha256 hex of the raw ref, truncated to 64 characters.
//    The ref is never truncated and the id always fits 100 characters.
//  - the raw payment id is kept in payment_provider_refunds.provider_payment_ref.
//  - one fact (payment_provider_refunds row) and one journal event
//    (`payment.provider_refunded` in the outbox) per refunded transaction, over
//    every door (webhook twice, poller, worker, replays).
//  - the fund of a fully refunded extra transaction cannot be paid again
//    (409 PROVIDER_REFUNDED for refund and credit, no refund row, no provider
//    call); the main transaction cannot be refunded again either.
//  - a finance hold keyed by a hashed id is resolved against the raw ref
//    (counted_against_intent books on provider_payment_ref, not on a slice of
//    the id).
//
// 1025d-b-P1 main transaction (92/93/100 chars), paid then refunded by the
//            provider via webhooks + poller + replays: one fact, one event
// 1025d-b-P2 main transaction noticed ONLY by the poller (pending code), then
//            replayed through the other doors: one fact, one event
// 1025d-b-S1 extra (parked fund) transaction (92/93/100 chars), status
//            refunded: one fact, one event, fund stamped and blocked, a
//            sibling fund stays refundable
// 1025d-b-U1 ids are unique: refs sharing a long prefix never share an id, ids
//            are never a truncation of the ref, and real refund ids differ
// 1025d-b-U2 control: an unknown 100-char extra id is still ignored
// 1025d-b-H1 resolving a hold on the main transaction's (hashed) id
// 1025d-b-H2 resolving a hold on an extra transaction's (hashed) id
//
// Assumptions (the brief does not fix them):
//  - A refunded extra transaction is recorded as one row of the amount of the
//    event (= its evidence amount); here the extra's whole money, so no
//    remainder is left. Rows are read by provider_payment_ref = raw ref.
//  - The poller only reads PENDING intents, so P2 uses a pending code the
//    provider already shows as refunded (as 1025C-C-P1). The extra transaction
//    has no poller door; replays use webhook + worker + poller anyway.
//  - The 92-char case (8 + 92 = 100) keeps the plain `payment:<ref>` id and is
//    a control that passes at base; 93 and 100 fail at base.
//  - Not covered: "a remaining unbound outcome files one finance alert and
//    keeps the stamp". After the id fix no input reachable through the public
//    doors still yields `unbound`, and forcing it needs a test seam on the
//    recorder (implementation detail); flagged in the report instead.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/refund-1025d-b-long-payment-id.test.ts" heavy pnpm test

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
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
const HOLD_BILL = 100_000;
const EXTRA_IDR = 30_000;
const NOTE = "Dicocokkan dengan mutasi bank provider";
const MINUTE = 60_000;
const LENGTHS = [92, 93, 100] as const;

const apiKey = `doit-key-1025db-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1025db-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const userIds: string[] = [];
let integrationId = "";
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

/** The synthetic provider refund id of the decided design (brief 1025d). */
const syntheticId = (ref: string) =>
  8 + ref.length <= 100
    ? `payment:${ref}`
    : `payment:h:${createHash("sha256").update(ref).digest("hex").slice(0, 64)}`;

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
        this.nextIdLength === null
          ? `dp_${randomBytes(8).toString("hex")}`
          : makeRef(this.nextIdLength);
      this.nextIdLength = null;
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

/** Run statements with the tenant RLS context set (as the services do). */
async function asTenantTx<T>(
  run: (client: PoolClient) => Promise<T>,
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await scope.seed(owner);

  // Back-office owner: files refunds, resolves parked funds and holds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1025db owner");
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
      reference: `R1025DB-${unique()}`,
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

/** `payment.refunded` of the code's OWN payment (status object, as DOIT sends). */
const mainRefundedEvent = (code: Code) =>
  doit.eventFor(code.providerRef, "refunded");

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

const refundRowsOfIntent = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
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

async function intentStamp(intentId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
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

// ===========================================================================
// P: the MAIN transaction of the intent has a long payment id
// ===========================================================================

describe("1025d-b-P the main transaction's refund is recorded once whatever the payment id length", () => {
  it.each(LENGTHS)(
    "1025d-b-P1 paid, then the provider refunds a %i-char payment (webhook x2 + poller, then replays): one fact, one event, the payment cannot be refunded again",
    async (length) => {
      const code = await newCode(length);
      await paid(code);
      doit.refund(code.providerRef);

      const [first, second] = await Promise.all([
        deliver(mainRefundedEvent(code)),
        deliver(mainRefundedEvent(code)),
        pollSeries(FIRST_POLLS),
      ]);
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(500);
      expect(second.status, JSON.stringify(second.body)).toBeLessThan(500);

      const expected = [
        {
          provider_refund_id: syntheticId(code.providerRef),
          provider_payment_ref: code.providerRef,
          amount_idr: BILL_TOTAL,
        },
      ];
      expect(syntheticId(code.providerRef).length).toBeLessThanOrEqual(100);
      expect(
        await providerRows(code.id),
        "one fact of the whole amount",
      ).toEqual(expected);
      expect(await refundEventsOfIntent(code.id), "one journal event").toBe(1);
      expect(await intentStamp(code.id), "flagged").not.toBeNull();

      // Replays: the provider resends, the worker and the poller run again.
      for (let round = 0; round < 2; round += 1) {
        const again = await deliver(mainRefundedEvent(code));
        expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
        await runWorker();
        await pollSeries(LATER_POLLS);
      }
      expect(await providerRows(code.id), "replays add no fact").toEqual(
        expected,
      );
      expect(await refundEventsOfIntent(code.id), "replays add no event").toBe(
        1,
      );

      // The guest is not paid a second time.
      const again = await manualRefund(code.id, 10_000);
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(again.body.error.code).toBe("PROVIDER_REFUNDED");
      expect(await refundRowsOfIntent(code.id), "no refund filed").toBe(0);
      expect(fake.calls, "no provider call").toHaveLength(0);
    },
  );

  it.each(LENGTHS)(
    "1025d-b-P2 a pending code with a %i-char payment id that the provider refunded, noticed ONLY by the poller: one fact and one event, later webhooks and polls add none",
    async (length) => {
      const code = await newCode(length);
      doit.refund(code.providerRef);
      expect(await providerRows(code.id), "nothing recorded before").toEqual(
        [],
      );

      await pollSeries(FIRST_POLLS);

      const expected = [
        {
          provider_refund_id: syntheticId(code.providerRef),
          provider_payment_ref: code.providerRef,
          amount_idr: BILL_TOTAL,
        },
      ];
      expect(await providerRows(code.id), "the poller wrote one fact").toEqual(
        expected,
      );
      expect(await refundEventsOfIntent(code.id), "one journal event").toBe(1);

      const answered = await deliver(mainRefundedEvent(code));
      expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(500);
      await runWorker();
      await pollSeries(LATER_POLLS);
      expect(await providerRows(code.id)).toEqual(expected);
      expect(await refundEventsOfIntent(code.id)).toBe(1);
      expect(fake.calls, "no provider call").toHaveLength(0);
    },
  );
});

// ===========================================================================
// S: an EXTRA transaction (parked fund) has a long payment id
// ===========================================================================

describe("1025d-b-S the refund of an extra transaction is recorded once whatever the payment id length", () => {
  it.each(LENGTHS)(
    "1025d-b-S1 a %i-char extra transaction whose parked fund the provider refunded (status refunded): one fact, one event, the fund is stamped and cannot be paid again, a sibling fund stays refundable",
    async (length) => {
      const code = await newCode();
      await paid(code);
      const extra = await addExtraTxn(code.id, makeRef(length), EXTRA_IDR);
      const fundId = await parkExtra(code.id, extra);
      const sibling = await addExtraTxn(code.id, makeRef(40), 25_000);
      const siblingFund = await parkExtra(code.id, sibling);
      expect(await fundStamp(fundId), "not refunded yet").toBeNull();

      const [first, second] = await Promise.all([
        deliver(extraRefundedEvent(code, extra.providerRef, EXTRA_IDR)),
        deliver(extraRefundedEvent(code, extra.providerRef, EXTRA_IDR)),
        pollSeries(FIRST_POLLS),
      ]);
      expect(first.status, JSON.stringify(first.body)).toBeLessThan(500);
      expect(second.status, JSON.stringify(second.body)).toBeLessThan(500);

      const expected = [
        {
          provider_refund_id: syntheticId(extra.providerRef),
          provider_payment_ref: extra.providerRef,
          amount_idr: EXTRA_IDR,
        },
      ];
      expect(await providerRows(code.id), "one fact of the extra").toEqual(
        expected,
      );
      expect(await refundEventsOfIntent(code.id), "one journal event").toBe(1);
      expect(await fundStamp(fundId), "the fund is stamped").not.toBeNull();
      expect(await fundStamp(siblingFund), "the sibling is not").toBeNull();

      // Replays add nothing.
      for (let round = 0; round < 2; round += 1) {
        const again = await deliver(
          extraRefundedEvent(code, extra.providerRef, EXTRA_IDR),
        );
        expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
        await runWorker();
        await pollSeries(LATER_POLLS);
      }
      expect(await providerRows(code.id)).toEqual(expected);
      expect(await refundEventsOfIntent(code.id)).toBe(1);

      // The refunded fund cannot be paid or credited again.
      await expectFundBlocked(fundId);

      // Control: the sibling's fund is untouched and can still be refunded.
      const allowed = await resolveFund(siblingFund, "refund");
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(await refundRowsOfFund(siblingFund)).toBe(1);
    },
  );
});

// ===========================================================================
// U: the synthetic id is unique and never a truncation of the payment id
// ===========================================================================

describe("1025d-b-U the synthetic id never collides", () => {
  it("1025d-b-U1 payment ids sharing a long prefix (and a 92/93 char pair) get distinct ids, none is a truncation of its ref, and a real refund id differs", async () => {
    const code = await newCode();
    await paid(code);
    const r93 = makeRef(93);
    const r92 = r93.slice(0, 92); // the plain id of r92 is a prefix of r93's ref
    const r100 = makeRef(100);
    const r100b = `${r100.slice(0, 99)}${r100.endsWith("a") ? "b" : "a"}`;
    const refs = [r93, r92, r100, r100b];
    const amounts = [10_000, 11_000, 12_000, 13_000];
    for (const [index, ref] of refs.entries())
      await addExtraTxn(code.id, ref, amounts[index]!);

    for (const [index, ref] of refs.entries()) {
      const answered = await deliver(
        extraRefundedEvent(code, ref, amounts[index]!),
      );
      expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(500);
    }
    // A real provider refund of the main payment, recorded under its own id.
    const realId = `rf_real_${randomBytes(6).toString("hex")}`;
    await partialRefund(code, realId, 5_000);

    const rows = await providerRows(code.id);
    const ids = rows.map((row) => row.provider_refund_id);
    expect(new Set(ids).size, "every fact has its own id").toBe(5);
    expect(ids).toContain(realId);
    for (const [index, ref] of refs.entries()) {
      const mine = rows.filter((row) => row.provider_payment_ref === ref);
      expect(mine, `one fact for the ${ref.length}-char ref`).toEqual([
        {
          provider_refund_id: syntheticId(ref),
          provider_payment_ref: ref,
          amount_idr: amounts[index],
        },
      ]);
      const id = mine[0]!.provider_refund_id;
      expect(id.length).toBeLessThanOrEqual(100);
      expect(id, "never the ref cut short").not.toBe(
        `payment:${ref.slice(0, 92)}`,
      );
      if (ref.length > 92) expect(id).toMatch(/^payment:h:[0-9a-f]{64}$/);
    }
    expect(await refundEventsOfIntent(code.id), "one event per fact").toBe(5);
  });

  it("1025d-b-U2 control: a 100-char payment id that is not a transaction of the intent is still ignored (REFERENCE_MISMATCH) and records nothing", async () => {
    const code = await newCode();
    await paid(code);
    const body = extraRefundedEvent(code, makeRef(100), EXTRA_IDR);

    const answered = await deliver(body);
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(500);

    const { rows } = await owner.query<{
      status: string;
      last_error_code: string | null;
    }>(
      "SELECT status, last_error_code FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
      [tenantId, body.id],
    );
    expect(rows).toEqual([
      { status: "ignored", last_error_code: "REFERENCE_MISMATCH" },
    ]);
    expect(await providerRows(code.id)).toEqual([]);
    expect(await refundEventsOfIntent(code.id)).toBe(0);
  });
});

// ===========================================================================
// H: finance resolves a hold keyed by the synthetic id
// ===========================================================================

type Seeded = { id: string; providerRef: string };

/** A settled 100.000 bill with evidence of its own payment (as the 1025-d file). */
async function seedIntent(providerRef: string): Promise<Seeded> {
  const linkId = randomUUID();
  const id = randomUUID();
  createdLinkIds.push(linkId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'refund-1025db-test')`,
    [
      linkId,
      tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `H1025DB-${linkId.slice(0, 8)}`,
      HOLD_BILL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour', $7)`,
    [id, tenantId, outletId, linkId, HOLD_BILL, `h1025db-${id}`, providerRef],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletId, id, providerRef, HOLD_BILL],
  );
  return { id, providerRef };
}

/** An open hold of the synthetic id naming provider payment `paymentRef`. */
async function seedHold(
  intent: Seeded,
  refundId: string,
  paymentRef: string,
  amountIdr: number,
): Promise<string> {
  const holdId = randomUUID();
  await asTenantTx((client) =>
    client.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason, provider_payment_ref)
       VALUES ($1, $2, $3, $4, $5, $6, 'Our refund was in flight', $7)`,
      [
        holdId,
        tenantId,
        intent.id,
        randomUUID(),
        refundId,
        amountIdr,
        paymentRef,
      ],
    ),
  );
  return holdId;
}

const resolveHold = (holdId: string) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution: "counted_against_intent",
      note: NOTE,
    });

async function holdState(holdId: string) {
  const { rows } = await owner.query<{
    resolved_at: Date | null;
    resolution: string | null;
  }>("SELECT resolved_at, resolution FROM refund_recon_holds WHERE id = $1", [
    holdId,
  ]);
  return rows[0]!;
}

describe("1025d-b-H a hold on the synthetic id of a long payment id is resolved against the raw payment id", () => {
  it.each(LENGTHS)(
    "1025d-b-H1 hold of the main transaction (%i-char id): counted_against_intent books the whole transaction on the raw ref, once, and nothing is refundable after",
    async (length) => {
      const intent = await seedIntent(makeRef(length));
      const syntheticHoldId = syntheticId(intent.providerRef);
      const holdId = await seedHold(
        intent,
        syntheticHoldId,
        intent.providerRef,
        HOLD_BILL,
      );

      const response = await resolveHold(holdId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const state = await holdState(holdId);
      expect(state.resolution).toBe("counted_against_intent");
      expect(state.resolved_at).not.toBeNull();
      expect(await providerRows(intent.id)).toEqual([
        {
          provider_refund_id: syntheticHoldId,
          provider_payment_ref: intent.providerRef,
          amount_idr: HOLD_BILL,
        },
      ]);
      expect(await refundEventsOfIntent(intent.id), "one journal event").toBe(
        1,
      );

      const refused = await manualRefund(intent.id, 1_000);
      expect([409, 422], JSON.stringify(refused.body)).toContain(
        refused.status,
      );
      expect(await refundRowsOfIntent(intent.id)).toBe(0);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each(LENGTHS)(
    "1025d-b-H2 hold of an extra transaction (%i-char id): counted_against_intent books on the extra's raw ref, and its fund cannot be paid again",
    async (length) => {
      const intent = await seedIntent(
        `dp_1025db_${randomBytes(8).toString("hex")}`,
      );
      const extra = await addExtraTxn(intent.id, makeRef(length), EXTRA_IDR);
      const fundId = await parkExtra(intent.id, extra);
      const syntheticHoldId = syntheticId(extra.providerRef);
      const holdId = await seedHold(
        intent,
        syntheticHoldId,
        extra.providerRef,
        EXTRA_IDR,
      );

      const response = await resolveHold(holdId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect((await holdState(holdId)).resolution).toBe(
        "counted_against_intent",
      );
      const rows = await providerRows(intent.id);
      expect(rows, "one fact, against the extra and not the main").toEqual([
        {
          provider_refund_id: syntheticHoldId,
          provider_payment_ref: extra.providerRef,
          amount_idr: EXTRA_IDR,
        },
      ]);
      expect(await refundEventsOfIntent(intent.id)).toBe(1);

      await expectFundBlocked(fundId);
    },
  );
});
