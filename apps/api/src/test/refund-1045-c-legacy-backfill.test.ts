// legend-0656 / F3 (brief 1045, tier K "jangan sampai rugi"): the backfill of
// migration 0656 (`refund_id_kind`) must NOT guess. A provider's real refund id
// may legitimately look like `payment:foo`, `payment:h:<64 hex>` or
// `hold:<uuid>`, so rows written before the kind column existed keep the id as
// sent and are all kind `provider`; the same for old holds that carry a refund
// id. Why this is money-safe: a `provider` fact is subtracted from the
// remainder when the transaction's own `refunded` status arrives (no double
// count); a `provider` hold is resolved at its own amount, never at the whole
// transaction's remainder; and old ids stay unique exactly as under the former
// 3-column key.
//
// Written from the brief and the public doors (webhook, hold resolve,
// 1035-b fixtures); not from the implementation. "Legacy shaped" rows are what
// the migration leaves behind: kind `provider` with an id of the old
// synthetic shape. Facts are written straight into the table (kind column
// default); holds are filed through the public door (so their stored event is
// real) and then rewritten to the legacy shape.
//
// Scenarios:
// 1045c-H1 hold `payment:foo` / `payment:h:<sha256(foo)>` of 30.000 on a
//          transaction foo of 100.000 resolved `counted_against_intent` books
//          the hold's 30.000 (not the 100.000 remainder), once; replays add
//          nothing. 1045c-H2 `not_this_intent` is accepted and books nothing.
// 1045c-H3 a legacy hold with no stored payment id can still be resolved
//          (counted: its own 30.000 once; not_this_intent: nothing).
// 1045c-R1 replay of the legacy refund id with a new event id (refund.succeeded
//          and payment.refunded doors; legacy fact or legacy hold): no second
//          fact, no second hold.
// 1045c-S1 foo's `refunded` status after a legacy 30.000 refund (a legacy fact
//          row, or a legacy hold counted): the status books only the 70.000
//          rest, total = 100.000, fund stamped and blocked, replay adds nothing.
//          1045c-S2 status first, legacy hold counted later: never more than
//          the real 100.000 in total.
// 1045c-U1 the two old ids `payment:foo` and `payment:h:<sha256(foo)>` live
//          side by side; the same id is still unique per tenant but not
//          across tenants.
// 1045c-T1 a second tenant with the same legacy ids: neither tenant's status or
//          refund touches the other.
// 1045c-G1 regression guard: the SQL of 0656 has no UPDATE that guesses
//          `synthetic_full` / `synthetic_hold` or rewrites a refund id.
//
// Assumptions (the brief does not fix them):
//  - "transaction foo of 100.000" is an extra transaction (evidence + parked
//    fund) of a paid bill; the bill's own main payment is the 144.375 one.
//  - A legacy fact row is a `refund_webhook` row on foo's evidence.
//  - Replays use refund.succeeded whose reference names the intent owning the
//    payment id (a normal refund, not a hold), status `partially_refunded`.
//  - Resolving a hold that has no stored payment id: only the total is pinned
//    (the hold's own amount, one fact, one journal event), not which of the
//    intent's transactions carries the fact.
//  - A hold with no stored payment id can only be counted when the bill has a
//    single transaction (the service refuses to guess among several, 422);
//    H3 uses a single-transaction bill, H4 pins the refusal (4xx, nothing booked).
//  - Status-first then hold counted (S2): the resolve may be accepted or
//    refused; only "no 5xx" and "total <= 100.000" are pinned.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/refund-1045-c-legacy-backfill.test.ts" heavy pnpm test

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const apiKey = `doit-key-1045c-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045c-${randomBytes(16).toString("hex")}`;

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
  const email = await signUp(staff, "Refund1045c owner");
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
      reference: `R1045C-${unique()}`,
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

// ===========================================================================
// H: resolving a hold on a real refund id shaped like a synthetic id
// ===========================================================================

const ADMIN_HOLD = `${ADMIN}/refund-recon-holds`;

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
      reference: `R1045CT-${unique()}`,
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

// ===========================================================================
// Legacy-shaped rows and the world of the scenarios
// ===========================================================================

const FOO_AMOUNT = 100_000;
const PART = 30_000;
const REST = FOO_AMOUNT - PART;

/** A bill B (paid) with an extra transaction foo of 100.000 and its parked fund. */
type World = {
  codeA: Code;
  codeB: Code;
  foo: Extra;
  fundId: string;
};

async function newWorld(): Promise<World> {
  const codeA = await newCode();
  const codeB = await newCode();
  await paid(codeA);
  await paid(codeB);
  const foo = await addExtraTxn(
    codeB.id,
    `foo-${randomBytes(6).toString("hex")}`,
    FOO_AMOUNT,
  );
  const fundId = await parkExtra(codeB.id, foo);
  return { codeA, codeB, foo, fundId };
}

/**
 * Bill B with ONE transaction only (its main payment, 144.375). `foo` is that
 * main payment, so a hold that names no payment id has exactly one candidate.
 */
async function newSingleWorld(): Promise<World> {
  const codeA = await newCode();
  const codeB = await newCode();
  await paid(codeA);
  await paid(codeB);
  return {
    codeA,
    codeB,
    foo: {
      providerRef: codeB.providerRef,
      evidenceId: "",
      amountIdr: BILL_TOTAL,
    },
    fundId: "",
  };
}

/** What the migration leaves behind for an old row: kind `provider`, id as is. */
async function seedLegacyFact(
  world: World,
  refundId: string,
  amount: number,
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id, provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'refund_webhook')`,
    [
      tenantId,
      outletId,
      world.codeB.id,
      world.foo.evidenceId,
      refundId,
      world.foo.providerRef,
      amount,
    ],
  );
}

/** Legacy ids of the old synthetic shapes, named after foo. */
const legacyIds = {
  plain: (ref: string) => `payment:${ref}`,
  hashed: (ref: string) => `payment:h:${sha256(ref)}`,
};

/**
 * An open hold on bill B for a refund of `PART` the provider sent for foo while
 * naming bill A's reference (filed through the public door, as in 1025-C /
 * 1035-b), then rewritten to the legacy shape: kind `provider`, the given
 * refund id, and (optionally) no stored payment id.
 */
async function legacyHold(
  world: World,
  refundId: string,
  options: { withPaymentRef: boolean } = { withPaymentRef: true },
): Promise<string> {
  const aReference = doit.payments.get(world.codeA.providerRef)!.reference;
  const body = {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      refund: { id: refundId, amount: PART, reference: aReference },
      payment: {
        id: world.foo.providerRef,
        reference: aReference,
        status: "refunded",
        amount: PART,
      },
    },
  };
  // The first delivery may answer 500 (retry window): the hold is filed by the
  // worker, so the status is not asserted (as in 1025-C / 1035-b).
  await deliver(body);
  await settleEvents([body.id]);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[]) AND resolved_at IS NULL`,
    [tenantId, [world.codeA.id, world.codeB.id]],
  );
  expect(rows, "premise: one open hold").toHaveLength(1);
  const holdId = rows[0]!.id;
  await owner.query(
    `UPDATE refund_recon_holds
        SET provider_refund_id = $3,
            provider_refund_id_kind = 'provider',
            provider_payment_ref = $4
      WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId,
      holdId,
      refundId,
      options.withPaymentRef ? world.foo.providerRef : null,
    ],
  );
  return holdId;
}

const resolveHoldAs = (
  holdId: string,
  resolution: "counted_against_intent" | "not_this_intent",
) =>
  staff
    .post(`${ADMIN_HOLD}/${holdId}/resolve`)
    .set(originHeader)
    .send({ idempotencyKey: key("hold"), resolution, note: NOTE });

const openHolds = (world: World) =>
  count(
    `SELECT count(*)::text AS n FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = ANY($2::uuid[])`,
    [tenantId, [world.codeA.id, world.codeB.id]],
  );

/** The provider says foo is refunded (the whole transaction). */
const fooRefundedStatus = (world: World) =>
  extraRefundedEvent(world.codeB, world.foo.providerRef, FOO_AMOUNT);

/** A new event for a refund the provider already told us about. */
function replayOf(world: World, refundId: string) {
  const bReference = doit.payments.get(world.codeB.providerRef)!.reference;
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      refund: { id: refundId, amount: PART, reference: bReference },
      payment: {
        id: world.foo.providerRef,
        reference: bReference,
        status: "partially_refunded",
        amount: FOO_AMOUNT,
      },
    },
  };
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

type IdForm = "plain" | "hashed";
const ID_FORMS: IdForm[] = ["plain", "hashed"];
const legacyId = (form: IdForm, ref: string) => legacyIds[form](ref);

// ===========================================================================
// H: legacy holds are resolved at their own amount
// ===========================================================================

describe("1045c-H a legacy hold carrying a refund id is resolved as that refund", () => {
  it.each(ID_FORMS)(
    "1045c-H1 hold `payment:...` (%s form) of 30.000 on a 100.000 transaction, counted: books 30.000 once, never the 100.000 remainder; resolving again adds nothing; the other bill is untouched",
    async (form) => {
      const world = await newWorld();
      const holdId = await legacyHold(
        world,
        legacyId(form, world.foo.providerRef),
      );
      expect(await totalOf(world.codeB.id), "nothing booked before").toBe(0);

      const response = await resolveHoldAs(holdId, "counted_against_intent");
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect(await factsOfRef(world.codeB.id, world.foo.providerRef)).toEqual([
        PART,
      ]);
      expect(await providerRows(world.codeB.id)).toHaveLength(1);
      expect(await totalOf(world.codeB.id)).toBe(PART);
      expect(await refundEventsOfIntent(world.codeB.id), "one event").toBe(1);
      expect(await totalOf(world.codeA.id), "bill A untouched").toBe(0);

      const again = await resolveHoldAs(holdId, "counted_against_intent");
      expect(again.status).toBeLessThan(500);
      expect(await totalOf(world.codeB.id), "replay books nothing").toBe(PART);
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(1);
    },
  );

  it.each(ID_FORMS)(
    "1045c-H2 the same hold (%s form) resolved `not_this_intent` is accepted and books nothing; the transaction's fund stays unstamped",
    async (form) => {
      const world = await newWorld();
      const holdId = await legacyHold(
        world,
        legacyId(form, world.foo.providerRef),
      );
      const response = await resolveHoldAs(holdId, "not_this_intent");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await totalOf(world.codeB.id)).toBe(0);
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(0);
      expect(await fundStamp(world.fundId)).toBeNull();
    },
  );

  it.each([
    ["plain payment:<ref>", (ref: string) => `payment:${ref}`],
    ["hashed payment:h:<sha256>", (ref: string) => `payment:h:${sha256(ref)}`],
    ["hold:<uuid>", () => `hold:${randomUUID()}`],
  ] as const)(
    "1045c-H3 a legacy hold %s with NO stored payment id, on a bill with ONE transaction can still be resolved: counted books its own 30.000 once, not_this_intent books nothing",
    async (_label, makeId) => {
      const world = await newSingleWorld();
      const countedHold = await legacyHold(
        world,
        makeId(world.foo.providerRef),
        { withPaymentRef: false },
      );
      const counted = await resolveHoldAs(
        countedHold,
        "counted_against_intent",
      );
      expect(counted.status, JSON.stringify(counted.body)).toBe(200);
      expect(await providerRows(world.codeB.id)).toHaveLength(1);
      expect(await totalOf(world.codeB.id), "the hold's own amount").toBe(PART);
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(1);
      await resolveHoldAs(countedHold, "counted_against_intent");
      expect(await totalOf(world.codeB.id), "replay").toBe(PART);

      const other = await newSingleWorld();
      const rejectedHold = await legacyHold(
        other,
        makeId(other.foo.providerRef),
        { withPaymentRef: false },
      );
      const rejected = await resolveHoldAs(rejectedHold, "not_this_intent");
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
      expect(await totalOf(other.codeB.id)).toBe(0);
      expect(await refundEventsOfIntent(other.codeB.id)).toBe(0);
    },
  );

  it("1045c-H4 a legacy hold with NO stored payment id on a bill with several transactions: counting it is refused (4xx, never a 5xx) and books nothing; not_this_intent still closes it", async () => {
    const world = await newWorld();
    const holdId = await legacyHold(
      world,
      legacyIds.plain(world.foo.providerRef),
      { withPaymentRef: false },
    );
    const counted = await resolveHoldAs(holdId, "counted_against_intent");
    expect(counted.status, JSON.stringify(counted.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(counted.status).toBeLessThan(500);
    expect(await totalOf(world.codeB.id), "nothing guessed").toBe(0);
    expect(await refundEventsOfIntent(world.codeB.id)).toBe(0);

    const closed = await resolveHoldAs(holdId, "not_this_intent");
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await totalOf(world.codeB.id)).toBe(0);
  });
});

// ===========================================================================
// R: replay of a legacy refund id
// ===========================================================================

describe("1045c-R a legacy refund id sent again under a new event id adds nothing", () => {
  it.each(ID_FORMS)(
    "1045c-R1 legacy fact `payment:...` (%s form) of 30.000, replayed by refund.succeeded and by payment.refunded, also after worker and poller: still one fact, no hold, no new event",
    async (form) => {
      const world = await newWorld();
      const refundId = legacyId(form, world.foo.providerRef);
      await seedLegacyFact(world, refundId, PART);

      for (let round = 0; round < 2; round += 1) {
        // refund.succeeded may answer 500 on first delivery (retry window,
        // as in 1025-C / 1035-b): the worker finishes it, status not asserted.
        const body = replayOf(world, refundId);
        await deliver(body);
        await settleEvents([body.id]);
        await partialRefund(world.codeB, refundId, PART);
        await runWorker();
        await pollSeries(FIRST_POLLS);
      }

      expect(await providerRows(world.codeB.id)).toHaveLength(1);
      expect(await totalOf(world.codeB.id)).toBe(PART);
      // 1055 AP2-2: `payment.refunded` names bill B's own transaction while the
      // legacy fact of this id is on foo: whose refund it is is in doubt, so
      // exactly one conflict hold waits for finance (both rounds, not two).
      expect(await openHolds(world), "only the conflict hold").toBe(1);
      expect(
        await count(
          `SELECT count(*)::text AS n FROM refund_recon_holds
            WHERE tenant_id = $1 AND payment_intent_id = $2::uuid
              AND resolved_at IS NULL
              AND reason LIKE '%HOLD_TRANSACTION_CONFLICT%'
              AND provider_refund_id = $3`,
          [tenantId, world.codeB.id, refundId],
        ),
        "one open HOLD_TRANSACTION_CONFLICT hold",
      ).toBe(1);
      expect(await refundEventsOfIntent(world.codeB.id), "no new event").toBe(
        0,
      );
    },
  );

  it.each(ID_FORMS)(
    "1045c-R2 legacy hold `payment:...` (%s form) open: the same refund naming another bill's reference under a new event id adds no second hold and no fact",
    async (form) => {
      const world = await newWorld();
      const refundId = legacyId(form, world.foo.providerRef);
      await legacyHold(world, refundId);
      const aReference = doit.payments.get(world.codeA.providerRef)!.reference;
      for (let round = 0; round < 2; round += 1) {
        const body = {
          id: `evt_${randomBytes(8).toString("hex")}`,
          type: "refund.succeeded",
          created_at: new Date().toISOString(),
          data: {
            refund: { id: refundId, amount: PART, reference: aReference },
            payment: {
              id: world.foo.providerRef,
              reference: aReference,
              status: "refunded",
              amount: PART,
            },
          },
        };
        await deliver(body);
        await settleEvents([body.id]);
      }
      expect(await openHolds(world), "still exactly one hold").toBe(1);
      expect(await totalOf(world.codeB.id), "no fact").toBe(0);
    },
  );
});

// ===========================================================================
// S: the transaction's own refunded status after a legacy refund
// ===========================================================================

describe("1045c-S the refunded status books only what is left after a legacy refund", () => {
  it.each(ID_FORMS)(
    "1045c-S1a legacy fact (%s form) 30.000, then foo `refunded`: only the 70.000 rest is added, total 100.000, fund stamped and blocked, replays add nothing",
    async (form) => {
      const world = await newWorld();
      await seedLegacyFact(world, legacyId(form, world.foo.providerRef), PART);
      const status = fooRefundedStatus(world);
      await deliver(status);
      await runWorker();
      await pollSeries(FIRST_POLLS);

      expect(
        sorted(await factsOfRef(world.codeB.id, world.foo.providerRef)),
      ).toEqual([PART, REST]);
      expect(await totalOf(world.codeB.id), "never above the real money").toBe(
        FOO_AMOUNT,
      );
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(1);
      expect(await fundStamp(world.fundId)).not.toBeNull();
      await expectFundBlocked(world.fundId);

      await deliver(status);
      await deliver(fooRefundedStatus(world));
      await runWorker();
      await pollSeries(LATER_POLLS);
      expect(await totalOf(world.codeB.id), "replay").toBe(FOO_AMOUNT);
      expect(await providerRows(world.codeB.id)).toHaveLength(2);
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(1);
    },
  );

  it.each(ID_FORMS)(
    "1045c-S1b legacy hold (%s form) of 30.000 counted, then foo `refunded`: facts 30.000 and 70.000, total 100.000, two events, fund stamped",
    async (form) => {
      const world = await newWorld();
      const holdId = await legacyHold(
        world,
        legacyId(form, world.foo.providerRef),
      );
      const counted = await resolveHoldAs(holdId, "counted_against_intent");
      expect(counted.status, JSON.stringify(counted.body)).toBe(200);
      await deliver(fooRefundedStatus(world));
      await runWorker();
      await pollSeries(FIRST_POLLS);

      expect(
        sorted(await factsOfRef(world.codeB.id, world.foo.providerRef)),
      ).toEqual([PART, REST]);
      expect(await totalOf(world.codeB.id)).toBe(FOO_AMOUNT);
      expect(await refundEventsOfIntent(world.codeB.id)).toBe(2);
      expect(await fundStamp(world.fundId)).not.toBeNull();
      await expectFundBlocked(world.fundId);
    },
  );

  it.each(ID_FORMS)(
    "1045c-S2 foo `refunded` first, then the legacy hold (%s form) counted: the books never exceed the real 100.000",
    async (form) => {
      const world = await newWorld();
      const holdId = await legacyHold(
        world,
        legacyId(form, world.foo.providerRef),
      );
      await deliver(fooRefundedStatus(world));
      await runWorker();
      await pollSeries(FIRST_POLLS);
      expect(await totalOf(world.codeB.id)).toBe(FOO_AMOUNT);

      const response = await resolveHoldAs(holdId, "counted_against_intent");
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
      await runWorker();
      expect(
        await totalOf(world.codeB.id),
        "guest is not refunded more than the transaction",
      ).toBeLessThanOrEqual(FOO_AMOUNT);
      await expectFundBlocked(world.fundId);
    },
  );
});

// ===========================================================================
// U: old ids stay unique, per tenant
// ===========================================================================

describe("1045c-U old ids stay unique", () => {
  it("1045c-U1 `payment:foo` and `payment:h:<sha256(foo)>` live side by side; replays of both add nothing; foo `refunded` then adds only the 50.000 rest", async () => {
    const world = await newWorld();
    const plain = legacyIds.plain(world.foo.providerRef);
    const hashed = legacyIds.hashed(world.foo.providerRef);
    await seedLegacyFact(world, plain, PART);
    await seedLegacyFact(world, hashed, 20_000);
    expect(await providerRows(world.codeB.id)).toHaveLength(2);

    for (const id of [plain, hashed]) {
      // First delivery may answer 500 (retry window); the worker finishes it.
      const body = replayOf(world, id);
      await deliver(body);
      await settleEvents([body.id]);
    }
    await runWorker();
    await pollSeries(FIRST_POLLS);
    expect(await providerRows(world.codeB.id)).toHaveLength(2);
    expect(await totalOf(world.codeB.id)).toBe(50_000);

    await deliver(fooRefundedStatus(world));
    await runWorker();
    await pollSeries(FIRST_POLLS);
    expect(await totalOf(world.codeB.id)).toBe(FOO_AMOUNT);
    expect(await providerRows(world.codeB.id)).toHaveLength(3);
    await expectFundBlocked(world.fundId);
  });

  it("1045c-U2 the same old id cannot be stored twice in one tenant, but another tenant may hold the same id", async () => {
    const world = await newWorld();
    const plain = legacyIds.plain(world.foo.providerRef);
    await seedLegacyFact(world, plain, PART);
    await expect(seedLegacyFact(world, plain, PART)).rejects.toMatchObject({
      code: "23505",
    });
    expect(await providerRows(world.codeB.id)).toHaveLength(1);

    const side = await paidBill(
      "B",
      `dp_1045cu_${randomBytes(8).toString("hex")}`,
    );
    const fundOfB = await extraOf(side, world.foo.providerRef, FOO_AMOUNT);
    const evidence = await owner.query<{ id: string }>(
      "SELECT evidence_id AS id FROM payment_unallocated_funds WHERE id = $1",
      [fundOfB],
    );
    await owner.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id, provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'refund_webhook')`,
      [
        side.tenantId,
        tenantB!.scope.outletId,
        side.intentId,
        evidence.rows[0]!.id,
        plain,
        world.foo.providerRef,
        PART,
      ],
    );
    expect(
      (await ledgerOf(side, fundOfB)).amounts,
      "other tenant has its own row",
    ).toEqual([PART]);
    expect(
      await providerRows(world.codeB.id),
      "first tenant unchanged",
    ).toHaveLength(1);
  });
});

// ===========================================================================
// T: another tenant with the same legacy ids
// ===========================================================================

describe("1045c-T another tenant with the same old refund ids is not affected", () => {
  it("1045c-T1 both tenants hold a legacy `payment:foo` of 30.000 on foo of 100.000: foo `refunded` for tenant A adds A's 70.000 only; tenant B's books and fund stay as they were until its own status arrives", async () => {
    const mainRef = `dp_1045ct_${randomBytes(8).toString("hex")}`;
    const fooRef = `foo-${randomBytes(6).toString("hex")}`;
    const sideA = await paidBill("A", mainRef);
    const sideB = await paidBill("B", mainRef);
    const fundA = await extraOf(sideA, fooRef, FOO_AMOUNT);
    const fundB = await extraOf(sideB, fooRef, FOO_AMOUNT);
    const legacy = legacyIds.plain(fooRef);
    for (const [side, fundId] of [
      [sideA, fundA],
      [sideB, fundB],
    ] as const) {
      const evidence = await owner.query<{ id: string }>(
        "SELECT evidence_id AS id FROM payment_unallocated_funds WHERE id = $1",
        [fundId],
      );
      const theOutlet =
        side.tenantId === tenantId ? outletId : tenantB!.scope.outletId;
      await owner.query(
        `INSERT INTO payment_provider_refunds
           (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id, provider_payment_ref, amount_idr, source)
         VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'refund_webhook')`,
        [
          side.tenantId,
          theOutlet,
          side.intentId,
          evidence.rows[0]!.id,
          legacy,
          fooRef,
          PART,
        ],
      );
    }
    const statusFor = (side: Side) => ({
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "payment.refunded",
      created_at: new Date().toISOString(),
      data: {
        ...side.payment,
        id: fooRef,
        status: "refunded",
        amount: FOO_AMOUNT,
        total_amount: FOO_AMOUNT,
        paid_at: null,
      },
    });

    const first = statusFor(sideA);
    for (const body of [first, first]) {
      const answer = await deliverTo(sideA, body);
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    }
    expect(await ledgerOf(sideA, fundA), "tenant A").toEqual({
      amounts: [PART, REST],
      events: 1,
      stamped: true,
    });
    expect(await ledgerOf(sideB, fundB), "tenant B untouched").toEqual({
      amounts: [PART],
      events: 0,
      stamped: false,
    });

    const second = statusFor(sideB);
    for (const body of [second, second]) {
      const answer = await deliverTo(sideB, body);
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
    }
    expect(await ledgerOf(sideB, fundB), "tenant B").toEqual({
      amounts: [PART, REST],
      events: 1,
      stamped: true,
    });
    expect(await ledgerOf(sideA, fundA), "tenant A unchanged").toEqual({
      amounts: [PART, REST],
      events: 1,
      stamped: true,
    });
  });
});

// ===========================================================================
// G: regression guard on the migration file
// ===========================================================================

describe("1045c-G migration 0656 does not guess the kind of old rows", () => {
  const sqlPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/0656_provider_refund_id_kind.sql",
  );
  const statements = readFileSync(sqlPath, "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
  const updates = statements.filter((statement) =>
    /^UPDATE\b/i.test(statement),
  );

  it("1045c-G1 no UPDATE sets `synthetic_full` or `synthetic_hold`", () => {
    const guessing = updates.filter((statement) =>
      /synthetic_(full|hold)/i.test(statement),
    );
    expect(guessing, guessing.join("\n---\n")).toEqual([]);
  });

  it("1045c-G2 no UPDATE rewrites a refund id or a stored payment id", () => {
    const rewriting = updates.filter((statement) =>
      /\bSET\b[\s\S]*"(provider_refund_id|provider_payment_ref)"\s*=/i.test(
        statement,
      ),
    );
    expect(rewriting, rewriting.join("\n---\n")).toEqual([]);
  });

  it("1045c-G3 the kind columns still exist: rows default to `provider`, old holds with a refund id are set to `provider`", () => {
    const joined = statements.join("\n");
    expect(joined).toMatch(
      /ADD COLUMN "refund_id_kind" varchar\(20\) DEFAULT 'provider' NOT NULL/i,
    );
    expect(joined).toMatch(/ADD COLUMN "provider_refund_id_kind"/i);
    expect(
      updates.some(
        (statement) =>
          /UPDATE "refund_recon_holds"/i.test(statement) &&
          /"provider_refund_id_kind" = 'provider'/i.test(statement) &&
          /"provider_refund_id" IS NOT NULL/i.test(statement),
      ),
      "old holds with a refund id get kind provider",
    ).toBe(true);
  });
});
