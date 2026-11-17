// legend-t9g3i + legend-tiyce (brief 1025c, group C, tier K "jangan sampai
// rugi"). Written from docs/briefs/1025c-celah-refund-lanjutan.md and the
// 1025-B fixtures (full refund journal, release recon refund in flight), failing
// first; not from the implementation.
//
// legend-t9g3i: when the provider (DOIT) refunded the WHOLE payment and the
// poller (`pollPendingGatewayIntents`) is the door that notices it, only the
// 958 flag is stamped: no `payment_provider_refunds` row, nothing reaches the
// books. The webhook and the release reconciliation already write the row once
// (`payment:<providerRef>`, then the event `payment.provider_refunded`); the
// poller must do the same, idempotently, and wait (retry) while a refund of OUR
// side is in flight.
//
// legend-tiyce: the provider refunded the whole transaction while the only
// refund of ours still alive is a parked-fund refund without a provider
// reference. That case was treated as "our own echo": no hold, no alert. If our
// fund refund then fails, the guest got the money from the provider and the
// books keep it. A recon hold plus one alert to finance must exist (once).
// Low: the `refund_in_flight` alert of the QRIS release reconciliation repeats
// when the provider's status bounces away and back.
//
// 1025C-C-P1 poller alone writes one row and one event, repeated polls add none
// 1025C-C-P2 poller + later webhook (either order) + repeated polls: still one
// 1025C-C-P3 our refund in flight: poller waits, no row, no duplicate; later one
// 1025C-C-P4 guest not paid more: parked fund stays blocked, one row of the money
// 1025C-C-F1 only a live fund refund of ours, provider refunds all: one hold, one alert
// 1025C-C-F2 our fund refund fails afterwards: still one hold + one alert, books not short
// 1025C-C-L1 refund_in_flight alert with the status bouncing away and back: one alert
//
// Assumptions (the brief does not fix them):
//  - Poller path = a PENDING code the provider already shows as `refunded`
//    (the poller only reads pending intents). "Exactly one row" is read from
//    payment_provider_refunds by tenant + intent with provider_refund_id
//    `payment:<providerRef>`; the event is `payment.provider_refunded` in
//    domain_event_outbox. The poller is run at several virtual `now` values so
//    neither a lease nor a back-off can make a test depend on real time.
//  - "Our refund in flight" = payment_refunds row `approved`, payout_attempts 1,
//    no provider_ref. When it is still live nothing is written and the intent
//    keeps being polled; once it fails the row is the whole amount, once it
//    completes the row is the remainder (as in 1025-B F1c / F2).
//  - tiyce scene: a short-paid code (BILL_TOTAL - SHORT_BY) is parked as ONE
//    unallocated fund of the SAME transaction; the provider's refund of all of
//    it is recorded (nothing left to record, the `left <= 0` branch); our refund
//    of that fund is `approved`, no provider_ref, payout_attempts 1; then the
//    provider's `refunded` arrives (webhook, poller, worker). With something
//    still left to record the webhook just retries (5xx), see 1025-B F2. Expected: tepat 1 open hold in refund_recon_holds
//    (tenant + intent) and, as in 1025-B F3, one alert more than the plain case
//    (the same scene without our fund refund), counted as supervisor
//    notifications. The hold's reason text and provider_refund_id are not pinned.
//  - "Books not short" (F2) = the provider refund rows of the intent add up to
//    the money the provider received once our fund refund failed (the forced
//    write of 1025-B F3 also writes the row together with the hold).
//  - L1: the alert is whatever notification the reconciliation raises when it
//    first sees `refund_in_flight`; its title is not pinned, it is read from
//    the notifications created by that first run. "One alert only" = after the
//    provider status went away (pending) and came back (refunded) no
//    notification of that title was added.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025c-c-poller-and-fund-hold.test.ts" heavy pnpm test
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
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDoitGateway } from "../services/payment-doit";
import {
  setPaymentGateway,
  type GatewayPaymentStatus,
} from "../services/payment-gateway";
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
import { owner as floorOwner } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import {
  hoursAfter,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";
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
const SHORT_BY = 1_000;
const OURS = 30_000;
const MINUTE = 60_000;

const apiKey = `doit-key-1025cc-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1025cc-${randomBytes(16).toString("hex")}`;

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
// Fake DOIT server (same contract as the 958 / 967 / 1025-B files)
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

type Code = { id: string; providerRef: string; linkId: string };

/** A fresh bill with one pending QRIS code. */
async function newCode(): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1025CC-${unique()}`,
      tableLabel: "A07",
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

async function paid(code: Code, amount: number) {
  doit.settle(code.providerRef, amount);
  return deliver(doit.eventFor(code.providerRef, "paid"));
}

async function webhookRefunded(code: Code, strict = true) {
  const answered = await deliver(doit.eventFor(code.providerRef, "refunded"));
  // A webhook that must be retried answers 5xx; only the fund scenes expect it.
  expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(
    strict ? 500 : 600,
  );
  return answered;
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

const fullRowOf = async (code: Code) =>
  (await providerRows(code.id)).filter(
    (row) => row.provider_refund_id === `payment:${code.providerRef}`,
  );

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

async function holdsOf(code: Code) {
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

const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution,
      note: "Kembalikan dana yang belum teralokasi",
    });

/** A refund of OUR side on the intent (optionally for a parked fund). */
async function seedOurRefund(
  code: Code,
  amountIdr: number,
  opts: { status: "approved" | "failed"; fundId?: string },
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref,
        payout_attempts, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', $6, 'requester', 'approver', now(),
             NULL, NULL, 1, $7)`,
    [
      id,
      tenantId,
      outletId,
      code.id,
      amountIdr,
      opts.status,
      opts.fundId ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------

describe("1025C-C legend-t9g3i the poller writes the full provider refund once", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    setAuditWriter(coreAuditWriter);
    await scope.seed(owner);

    staff = agent(app).set("Host", scope.hostname);
    const email = await signUp(staff, "Refund1025cc owner");
    const session = await staff.get("/api/auth/get-session");
    const staffId = session.body.user.id as string;
    userIds.push(staffId);
    await verifySessionMfa(email);
    await assign(staffId, "owner", "tenant");

    // The outlet supervisor who must hear about the refunded report (958).
    const supervisorClient = agent(app).set("Host", scope.hostname);
    await signUp(supervisorClient, "Refund1025cc supervisor");
    const supervisorSession = await supervisorClient.get(
      "/api/auth/get-session",
    );
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
    await setIntegrationStatus(
      context,
      created.id,
      { status: "active" },
      actor,
    );
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
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [tenantId],
    );
    if (createdLinkIds.length > 0) {
      const intents =
        "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
      for (const table of [
        "payment_refunds",
        "refund_recon_holds",
        "payment_provider_refunds",
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

  it("1025C-C-P1 a pending code the provider refunded, noticed ONLY by the poller: one row of the whole amount and one event, repeated polls add none", async () => {
    const code = await newCode();
    doit.refund(code.providerRef);
    expect(await providerRows(code.id), "nothing recorded before").toEqual([]);

    await pollSeries(FIRST_POLLS);

    const rows = await fullRowOf(code);
    expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe(BILL_TOTAL);
    expect(await providerRows(code.id)).toHaveLength(1);
    expect(await refundEventsOfIntent(code.id), "one journal event").toBe(1);

    await pollSeries(LATER_POLLS);
    await runWorker();
    expect(await providerRows(code.id), "repeated polls add none").toEqual(
      rows,
    );
    expect(await refundEventsOfIntent(code.id)).toBe(1);
  });

  it.each(["poller", "webhook"] as const)(
    "1025C-C-P2 noticed first by the %s, then by the other door and by later polls: still one row and one event",
    async (first) => {
      const code = await newCode();
      doit.refund(code.providerRef);

      if (first === "poller") {
        await pollSeries(FIRST_POLLS);
        await webhookRefunded(code);
      } else {
        await webhookRefunded(code);
        await pollSeries(FIRST_POLLS);
      }
      await webhookRefunded(code);
      await pollSeries(LATER_POLLS);

      const rows = await fullRowOf(code);
      expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
      expect(rows[0]!.amount_idr).toBe(BILL_TOTAL);
      expect(await providerRows(code.id)).toHaveLength(1);
      expect(await refundEventsOfIntent(code.id)).toBe(1);
    },
  );

  it.each([
    {
      label: "fails: the provider gave the guest everything",
      resolve: "failed" as const,
      expected: BILL_TOTAL,
    },
    {
      label: "completes: only the remainder is left to record",
      resolve: "completed" as const,
      expected: BILL_TOTAL - OURS,
    },
  ])(
    "1025C-C-P3 a refund of ours in flight when the poller reads `refunded` waits (no row, no duplicate), and once it %s the poller writes one row",
    async ({ resolve, expected }) => {
      const code = await newCode();
      const refundId = await seedOurRefund(code, OURS, { status: "approved" });
      doit.refund(code.providerRef);

      await pollSeries(FIRST_POLLS);

      expect(await fullRowOf(code), "no row while our refund is live").toEqual(
        [],
      );
      expect(await providerRows(code.id)).toEqual([]);
      expect(await refundEventsOfIntent(code.id)).toBe(0);
      expect(await refundRowsOfIntent(code.id), "no duplicate refund").toBe(1);

      // Our refund resolves; the poller keeps asking and now writes once.
      await owner.query(
        `UPDATE payment_refunds SET status = $2::text, provider_ref = 'rf_res_' || id::text,
                completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE NULL END
          WHERE id = $1`,
        [refundId, resolve],
      );
      await pollSeries(LATER_POLLS);

      const rows = await fullRowOf(code);
      expect(rows, "written once after our refund resolved").toHaveLength(1);
      expect(rows[0]!.amount_idr).toBe(expected);
      expect(await providerRows(code.id)).toHaveLength(1);
      expect(await refundEventsOfIntent(code.id)).toBe(1);
      expect(await refundRowsOfIntent(code.id)).toBe(1);
    },
  );

  it("1025C-C-P4 the guest is not paid more: after the poller saw the refund the parked fund cannot be paid out or credited, and the books hold the money received once", async () => {
    const code = await newCode();
    const received = BILL_TOTAL - SHORT_BY;
    expect((await paid(code, received)).status).toBeLessThan(500);
    const [fund] = await fundsOf(code.id);
    expect(fund, "short payment parked").toBeDefined();

    doit.refund(code.providerRef);
    await pollSeries(FIRST_POLLS);
    await pollSeries(LATER_POLLS);

    for (const resolution of ["refund", "credit"] as const) {
      const resolved = await resolveFund(fund!.id, resolution);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(409);
      expect(resolved.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(await refundRowsOfIntent(code.id), "no payout filed").toBe(0);
    expect(fake.calls, "no provider call").toHaveLength(0);
    const rows = await fullRowOf(code);
    expect(rows, "one row keyed payment:<providerRef>").toHaveLength(1);
    expect(rows[0]!.amount_idr).toBe(received);
    expect(await refundEventsOfIntent(code.id)).toBe(1);
  });

  // =========================================================================
  // legend-tiyce: only a live parked-fund refund of ours, provider refunds all
  // =========================================================================

  /**
   * A short-paid code parked as ONE fund whose whole amount the provider
   * already returned (a partial refund row of everything received, so nothing
   * is left to record), then a live refund of ours for the fund. Assumption:
   * with something left to record the webhook simply retries (5xx) while our
   * refund is live (1025-B F2), so the unforced `left <= 0` branch needs the
   * money to be recorded first.
   */
  async function fundRefundScene(withOurRefund: boolean) {
    const code = await newCode();
    const received = BILL_TOTAL - SHORT_BY;
    expect((await paid(code, received)).status).toBeLessThan(500);
    const funds = await fundsOf(code.id);
    expect(funds, "short payment parked").toHaveLength(1);
    expect(Number(funds[0]!.amount_idr)).toBe(received);
    await partialRefund(code, received);
    const recorded = await providerRows(code.id);
    expect(
      recorded,
      "the provider's refund of everything is recorded",
    ).toHaveLength(1);
    expect(recorded[0]!.amount_idr).toBe(received);
    const refundId = withOurRefund
      ? await seedOurRefund(code, received, {
          status: "approved",
          fundId: funds[0]!.id,
        })
      : null;
    return { code, received, fundId: funds[0]!.id, refundId };
  }

  /** The provider reports the whole transaction refunded through every door. */
  async function providerRefundsAll(code: Code) {
    doit.refund(code.providerRef);
    await webhookRefunded(code, false);
    await pollSeries(FIRST_POLLS);
    await runWorker();
  }

  /** What a plain provider refund of this shape alerts (no refund of ours). */
  async function plainAlertCount(): Promise<number> {
    const plain = await fundRefundScene(false);
    const before = await supervisorAlerts();
    await providerRefundsAll(plain.code);
    expect(await holdsOf(plain.code), "control: no hold").toEqual([]);
    return (await supervisorAlerts()) - before;
  }

  it("1025C-C-F1 the provider refunded the whole transaction while only a live parked-fund refund of ours exists (no provider ref): exactly one open hold and one alert more, replay-safe", async () => {
    const plainAlerts = await plainAlertCount();

    const { code } = await fundRefundScene(true);
    const alertsBefore = await supervisorAlerts();
    await providerRefundsAll(code);

    const holds = await holdsOf(code);
    expect(holds, "one hold for the live refund of ours").toHaveLength(1);
    expect(holds[0]!.resolved_at, "open").toBeNull();
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "the plain refund alert plus one for finance",
    ).toBe(plainAlerts + 1);

    // Replays: the provider resends, the worker and the poller run again.
    await webhookRefunded(code, false);
    await runWorker();
    await pollSeries(LATER_POLLS);
    expect(await holdsOf(code), "still one hold").toHaveLength(1);
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "no second alert on replay",
    ).toBe(plainAlerts + 1);
  });

  it("1025C-C-F2 our fund refund fails afterwards: still one hold and one alert, the books are not short, and the guest is not paid again", async () => {
    const plainAlerts = await plainAlertCount();

    const { code, received, fundId, refundId } = await fundRefundScene(true);
    const alertsBefore = await supervisorAlerts();
    await providerRefundsAll(code);

    // Our refund of the fund fails: the provider's refund is the only money back.
    await owner.query(
      "UPDATE payment_refunds SET status = 'failed' WHERE id = $1",
      [refundId],
    );
    await webhookRefunded(code, false);
    await runWorker();
    await pollSeries(LATER_POLLS);

    const holds = await holdsOf(code);
    expect(holds, "exactly one hold").toHaveLength(1);
    expect(holds[0]!.resolved_at, "still open").toBeNull();
    expect(
      (await supervisorAlerts()) - alertsBefore,
      "exactly one alert more than the plain case",
    ).toBe(plainAlerts + 1);

    // Books not short: the provider rows add up to the money received.
    const rows = await providerRows(code.id);
    expect(
      rows.reduce((sum, row) => sum + row.amount_idr, 0),
      "the gateway clearing account is released of what the provider returned",
    ).toBe(received);

    // The guest is not paid a second time.
    for (const resolution of ["refund", "credit"] as const) {
      const resolved = await resolveFund(fundId, resolution);
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(409);
    }
    expect(await refundRowsOfIntent(code.id), "no new payout filed").toBe(1);
    expect(fake.calls, "no provider call").toHaveLength(0);
  });
});

// ===========================================================================
// Low: the refund_in_flight alert of the QRIS release reconciliation
// ===========================================================================

describe("1025C-C legend-tiyce (Low) the refund_in_flight alert is raised once while the provider status bounces", () => {
  let fx: HoldFixture;
  let kit: ReturnType<typeof releaseKit>;
  const refundedRefs = new Set<string>();

  beforeAll(async () => {
    setAuditWriter(coreAuditWriter);
    fx = await holdFixture("refund-1025c-c-recon");
    const read = fx.gateway.getStatus.bind(fx.gateway);
    fx.gateway.getStatus = async (input) =>
      refundedRefs.has(input.providerRef)
        ? ({
            status: "failed",
            rawStatus: "refunded",
            providerRef: input.providerRef,
            amountIdr: null,
          } satisfies GatewayPaymentStatus)
        : read(input);
    setPaymentGateway(fx.gateway);
    kit = releaseKit(fx);
  });
  afterAll(async () => {
    setAuditWriter(null);
    refundedRefs.clear();
    resetHoldPorts();
    await floorOwner.end();
  });

  async function titleCounts(): Promise<Map<string, number>> {
    const { rows } = await floorOwner.query<{ title: string; n: number }>(
      `SELECT title, count(*)::int AS n FROM notifications
        WHERE tenant_id = $1 GROUP BY title`,
      [fx.tenant.tenantId],
    );
    return new Map(rows.map((row) => [row.title, row.n]));
  }

  it("1025C-C-L1 refunded with our refund in flight -> away (pending) -> refunded again: no second alert", async () => {
    const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
    await floorOwner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, provider_ref, payout_attempts)
       VALUES ($1, $2, $3, $4, 10000, 'Pengembalian dana', 'approved', 'requester', 'approver', now(), NULL, 1)`,
      [randomUUID(), fx.tenant.tenantId, fx.tenant.outletId, qr.intentId],
    );

    // 1. The provider says refunded while our refund is in flight: one alert.
    const before = await titleCounts();
    refundedRefs.add(qr.providerRef!);
    await runRecon(fx, hoursAfter(releasedAt, 2));
    const afterFirst = await titleCounts();
    const raised = [...afterFirst].filter(
      ([title, n]) => n > (before.get(title) ?? 0),
    );
    expect(
      raised.length,
      "the refund-in-flight state alerts the first time",
    ).toBeGreaterThan(0);

    // 2. The status goes away (the provider shows the code pending again) ...
    refundedRefs.delete(qr.providerRef!);
    await runRecon(fx, hoursAfter(releasedAt, 3));
    // 3. ... and comes back: the same refund in flight, the same alert.
    refundedRefs.add(qr.providerRef!);
    await runRecon(fx, hoursAfter(releasedAt, 4));
    await runRecon(fx, hoursAfter(releasedAt, 5));

    const afterBounce = await titleCounts();
    for (const [title, n] of raised)
      expect(
        afterBounce.get(title),
        `no second "${title}" alert after the status bounced`,
      ).toBe(n);
  });
});
