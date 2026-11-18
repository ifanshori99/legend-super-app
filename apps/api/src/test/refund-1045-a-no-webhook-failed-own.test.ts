// legend-w2td5 (brief 1045, finding F1, tier K "jangan sampai rugi"): second
// opinion 1044, finding 1. Bill A (Rp100.000) is paid. Our refund R of A is sent
// to the provider; the provider ALSO returns A on its own, but its webhook never
// arrives (lost); then R fails. Today nothing remembers anything: no fact, no
// hold, the reservation is released, and a new refund of Rp100.000 can be filed,
// approved and paid out (guest gets Rp200.000 for a Rp100.000 payment).
// Written from the brief (docs/briefs/sub-1045-refund-so3.md), the CTO rule
// "without certainty about the provider status: hold and refuse new refunds",
// and the 1035 fixtures, not from the implementation, and failing first.
//
// Rules asserted:
//  - Our refund that WAS SENT to the provider (it holds a provider reference,
//    whether pending-then-failed or declined at once) and then fails leaves ONE
//    open refund-recon hold (reason `own_refund_failed_unverified`, amount = the
//    refund, payment ref = the refunded transaction). A new refund of the intent
//    is refused (409/422) and nothing is paid out a second time, whatever the
//    provider does or does not answer.
//  - The poller verifies the hold of the MAIN transaction of the intent:
//      * provider answers `refunded`  -> the provider fact is recorded once
//        (one journal event), the hold STAYS open for finance (anomaly), the
//        intent stays blocked (409 PROVIDER_REFUNDED);
//      * provider answers a plain `paid` -> the hold STAYS open (DOIT has no
//        partial status, so `paid` does not prove the provider did not refund
//        part of it; "F1 revisi" of the brief). Finance resolves it through the
//        route (`not_this_intent`), and a new refund then runs exactly once;
//      * the provider errors / is unavailable / answers any other status ->
//        the hold stays, new refunds stay refused; a later clear answer decides.
//  - A refund of a parked FUND (extra transaction B) that failed after being
//    sent is NOT verified by the poller; no hold of this kind is ever closed by
//    the system, only by finance.
//  - failRefund repeated or concurrent (webhook + poller + worker) -> ONE hold.
//  - Another tenant's holds and intents are neither closed, recorded nor blocked.
//
// Assumptions (the brief does not fix them):
//  - "R sent then failed": FakeRefundGateway answers `pending` on approve (row
//    keeps provider_ref R) and R is declined through the public service the
//    provider webhook / poller feed: applyRefundProviderUpdate(..., failed). The
//    "declined at once" variant scripts the fake gateway to answer `failed`.
//  - "getStatus unavailable" = the fake DOIT answers HTTP 500 to GET payment.
//    "Other status" = the fake DOIT answers `partially_refunded` for A.
//  - "Blocked" = a new refund of the intent / a fund resolve answers 409 or 422
//    (code not pinned, except PROVIDER_REFUNDED once the provider fact exists).
//  - The poller is run both soon and much later (`pollSoon`, `pollLater`) so a
//    schedule window cannot hide the intent; polls are repeated on purpose.
//  - Tenant isolation: the other tenant's hold is seeded directly with the
//    reason of the brief (its own refund flow needs a second staff roster).
//  - The hold reason column is `refund_recon_holds.reason` and is asserted only
//    in the first tests; alerts are not asserted.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1045-a-no-webhook-failed-own.test.ts" heavy pnpm test

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
const MINUTE = 60_000;
const OWN_FAILED = "own_refund_failed_unverified";

const apiKey = `doit-key-1045a-${randomBytes(12).toString("hex")}`;
const secret = `whsec-1045a-${randomBytes(16).toString("hex")}`;

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

type TenantB = {
  scope: ReturnType<typeof paymentTestScope>;
  integrationId: string;
  linkIds: string[];
};
let tenantB: TenantB | null = null;

const unique = () => randomBytes(4).toString("hex");
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

function contextOf(
  id: string,
  scopeOf: { kind: "tenant" } | { kind: "outlets"; outletIds: OutletId[] },
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: id as never,
      brandId: null,
      source: "session",
    }),
    scopeOf,
  );
}
const tenantContext = () => contextOf(tenantId, { kind: "tenant" });
const outletContext = (outletIds: readonly OutletId[]) =>
  contextOf(tenantId, { kind: "outlets", outletIds: [...outletIds] });

// ---------------------------------------------------------------------------
// Fake DOIT server (same contract as refund-1035-a-pending-ref-own.test.ts, plus
// switches that make the status lookup fail or answer another status)
// ---------------------------------------------------------------------------

type DoitPayment = {
  id: string;
  status: string;
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
  /** When set, `GET /v1/payments/:id` answers this HTTP status (provider down). */
  getFailsWith: number | null = null;
  /** Number of `GET /v1/payments/:id` calls (the poller's status lookups). */
  getCalls = 0;

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

  settle(id: string, amount: number = BILL_IDR): void {
    const payment = this.need(id);
    payment.status = "paid";
    payment.amount = amount;
    payment.total_amount = amount;
  }

  /** The provider gave the money back on its own (no webhook is delivered). */
  refund(id: string): void {
    this.need(id).status = "refunded";
  }

  /** The provider reports another status for the payment. */
  setStatus(id: string, status: string): void {
    this.need(id).status = status;
  }

  private need(id: string): DoitPayment {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`No fake DOIT payment ${id}`);
    return payment;
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
      this.getCalls += 1;
      if (this.getFailsWith !== null)
        return send(this.getFailsWith, {
          error: { code: "unavailable", message: "Provider unavailable" },
        });
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

  // Back-office owner: files refunds, resolves parked funds and holds.
  staff = agent(app).set("Host", scope.hostname);
  const email = await signUp(staff, "Refund1045a owner");
  const session = await staff.get("/api/auth/get-session");
  const staffId = session.body.user.id as string;
  userIds.push(staffId);
  await verifySessionMfa(email);
  await assign(staffId, "owner", "tenant");

  // Finance + supervisor: approves refunds the owner files.
  approver = agent(app).set("Host", scope.hostname);
  const approverEmail = await signUp(approver, "Refund1045a approver");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  userIds.push(approverId);
  await verifySessionMfa(approverEmail);
  await assign(approverId, "finance", "tenant");
  await assign(approverId, "supervisor", "outlet");

  // Refund approvals need a policy (same as the 1035 suites).
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
      loadCredentials: async (loadContext: {
        tenant: { tenantId: string };
      }) => ({
        integration: {
          id:
            tenantB && loadContext.tenant.tenantId === tenantB.scope.tenantId
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
  doit.getFailsWith = null;
  const cleanup = async (tenant: string, linkIds: string[]) => {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    if (linkIds.length > 0) {
      await owner.query(
        `DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund'
           AND object_id IN (SELECT id::text FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents}))`,
        [tenant, linkIds],
      );
      for (const table of [
        "payment_refunds",
        "refund_recon_holds",
        "payment_provider_refunds",
        "payment_evidence",
        "payment_unallocated_funds",
      ])
        await owner.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
          [tenant, linkIds],
        );
    }
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [tenant],
    );
    if (linkIds.length > 0) {
      await owner.query(
        "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
        [tenant, linkIds],
      );
      await owner.query(
        "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant, linkIds],
      );
    }
  };
  if (tenantB) {
    await cleanup(tenantB.scope.tenantId, tenantB.linkIds);
    await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      tenantB.integrationId,
    ]);
  }
  await cleanup(tenantId, createdLinkIds);
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
  doit.getFailsWith = null;
  fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  doit.getFailsWith = null;
  setPaymentRefundGateway(null);
});

type Code = { id: string; providerRef: string; linkId: string };

/** A fresh bill with one pending QRIS code (tenant A). */
async function newCode(amountIdr: number = BILL_IDR): Promise<Code> {
  const opened = await createPaymentLink(
    outletContext([outletId]),
    {
      outletId,
      reference: `R1045A-${unique()}`,
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

async function deliverTo(path: string, body: object) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
}

function paidEvent(ref: string) {
  const payment = doit.payments.get(ref);
  if (!payment) throw new Error(`No fake DOIT payment ${ref}`);
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.paid",
    created_at: new Date().toISOString(),
    data: { ...payment, status: "paid" },
  };
}

const paid = (code: Code, amount: number = BILL_IDR) => {
  doit.settle(code.providerRef, amount);
  return deliverTo(
    `/api/webhooks/payments/doit/${tenantId}`,
    paidEvent(code.providerRef),
  );
};

const pollAs = (context: ScopedTenantContext, at: Date) =>
  pollPendingGatewayIntents(context, at, 100).catch(() => null);
/** The poller, soon and much later, twice: a schedule window hides nothing. */
async function pollRounds(context: ScopedTenantContext = tenantContext()) {
  for (let round = 0; round < 2; round += 1) {
    await pollAs(context, new Date(Date.now() + 2 * MINUTE));
    await pollAs(context, new Date(Date.now() + 3 * 60 * MINUTE));
    // A poll that already looked at the intent may have pushed its next look
    // out (back-off after an error or an unchanged answer): a far-future clock
    // makes every intent due, so no test depends on the schedule.
    await pollAs(context, new Date(Date.now() + 400 * 24 * 60 * MINUTE));
  }
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
// Observations
// ---------------------------------------------------------------------------

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
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

async function providerRows(
  intentId: string,
  tenant: string = tenantId,
): Promise<ProviderRow[]> {
  const { rows } = await owner.query<
    Omit<ProviderRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, provider_refund_id, provider_payment_ref, amount_idr::text AS amount_idr
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenant, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}

const providerTotal = async (intentId: string) =>
  (await providerRows(intentId)).reduce((sum, row) => sum + row.amount_idr, 0);

/** Distinct `payment.provider_refunded` events of the whole intent. */
const refundEventsOfIntent = (intentId: string, tenant: string = tenantId) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [tenant, intentId],
  );

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
  }>(
    `SELECT status, provider_ref, amount_idr::text AS amount_idr
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId],
  );
  return rows[0]!;
}

async function fundRefundId(fundId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );
  if (!rows[0]) throw new Error("no refund filed for the fund");
  return rows[0].id;
}

type HoldRow = {
  id: string;
  reason: string;
  amount_idr: number;
  provider_payment_ref: string | null;
  provider_refund_id: string | null;
  resolved_at: Date | null;
  resolution: string | null;
};

/** Every hold of the intent, open or resolved. */
async function holdsOf(
  intentId: string,
  tenant: string = tenantId,
): Promise<HoldRow[]> {
  const { rows } = await owner.query<
    Omit<HoldRow, "amount_idr"> & { amount_idr: string }
  >(
    `SELECT id, reason, amount_idr::text AS amount_idr, provider_payment_ref,
            provider_refund_id, resolved_at, resolution
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY flagged_at, id`,
    [tenant, intentId],
  );
  return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
}
const openHolds = async (intentId: string, tenant: string = tenantId) =>
  (await holdsOf(intentId, tenant)).filter((hold) => hold.resolved_at === null);
const ownFailedHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((hold) => hold.reason === OWN_FAILED);

async function listedOpenHoldIds(): Promise<string[]> {
  const listed = await staff.get(`${ADMIN}/refund-recon-holds?status=open`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as { id: string }[]).map((item) => item.id);
}

const resolveHold = (
  holdId: string,
  resolution: "not_this_intent" | "counted_against_intent",
) =>
  staff
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("hold"),
      resolution,
      note: "Dicek di dashboard provider: pembayaran tidak dikembalikan.",
    });

/** The provider declines our refund (webhook / poll result of the refund). */
const failOwn = (providerRef: string) =>
  applyRefundProviderUpdate(tenantContext(), {
    providerRef,
    status: "failed",
    code: "declined",
  }).then(
    () => null,
    (error: unknown) => error,
  );

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Own = { code: Code; refundId: string; ownRef: string };

/**
 * The SO scenario up to the failure: bill A paid; our full refund R is sent and
 * pending at the provider (ref R); the provider refunds A on its own (NO webhook
 * is delivered); R then fails. `how`: R declined later (`pending`, the default)
 * or at once on approve (`declined`).
 */
async function ownRefundFailedWhileProviderRefunded(
  how: "pending" | "declined" = "pending",
): Promise<Own> {
  const code = await newCode(BILL_IDR);
  expect((await paid(code, BILL_IDR)).status).toBe(200);
  const filed = await manualRefund(code.id, BILL_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  fake.enqueue(how === "pending" ? "pending" : "failed");
  const approved = await approveRefund(refundId);
  expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(500);
  const row = await refundRow(refundId);
  expect(
    row.provider_ref,
    "premise: the refund was sent (R stored)",
  ).toBeTruthy();
  expect(fake.calls, "premise: R was sent once").toHaveLength(1);
  // The provider returns A on its own; the webhook is lost (never delivered).
  doit.refund(code.providerRef);
  if (how === "pending") {
    expect(row.status, "premise: R still in flight").not.toBe("failed");
    expect(await failOwn(row.provider_ref!), "R fails").toBeNull();
  }
  expect((await refundRow(refundId)).status, "premise: R failed").toBe(
    "failed",
  );
  return { code, refundId, ownRef: row.provider_ref! };
}

/** A new refund of the intent is refused (409/422) and nothing is sent. */
async function expectNewRefundRefused(
  code: Code,
  callsBefore: number,
  why: string,
) {
  for (const amount of [BILL_IDR, 1_000]) {
    const attempt = await manualRefund(code.id, amount);
    let probe = "";
    if (attempt.status === 201) {
      const approved = await approveRefund(attempt.body.data.id as string);
      probe = ` | probe: approve -> HTTP ${approved.status}, gateway calls +${fake.calls.length - callsBefore}`;
    }
    expect(
      [409, 422],
      `${why}: new refund of ${amount}: HTTP ${attempt.status} ${JSON.stringify(attempt.body)}${probe}`,
    ).toContain(attempt.status);
  }
  expect(fake.calls, `${why}: no second payout`).toHaveLength(callsBefore);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("legend-w2td5 our refund sent then failed, provider refunded the bill without a webhook", () => {
  it("1045-F1-01 SO scenario: R sent (pending, ref R), provider refunds A with NO webhook, R fails: ONE hold, a new refund is refused, no second payout, no fact yet", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("pending");
    const callsBefore = fake.calls.length;

    const holds = await openHolds(own.code.id);
    expect(holds, "ONE open hold after R failed").toHaveLength(1);
    expect(holds[0]!.reason).toBe(OWN_FAILED);
    expect(holds[0]!.amount_idr, "the hold carries the refund amount").toBe(
      BILL_IDR,
    );
    expect(holds[0]!.provider_payment_ref, "it names the refunded bill").toBe(
      own.code.providerRef,
    );
    expect(
      await listedOpenHoldIds(),
      "finance sees the hold on its list",
    ).toContain(holds[0]!.id);

    // The guest must not be paid twice: refused, nothing sent.
    await expectNewRefundRefused(own.code, callsBefore, "R failed, no webhook");
    expect(
      await ourRefundedIdr(own.code.id),
      "none of our refunds counts",
    ).toBe(0);
    expect(
      await providerTotal(own.code.id),
      "no fact before verification",
    ).toBe(0);
    expect(await refundEventsOfIntent(own.code.id)).toBe(0);
    expect(await openHolds(own.code.id)).toHaveLength(1);
  });

  it("1045-F1-02 R declined at once on approve (sent, answered failed): ONE hold, a new refund is refused, no second payout", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("declined");
    const callsBefore = fake.calls.length;

    const holds = await openHolds(own.code.id);
    expect(holds, "ONE open hold").toHaveLength(1);
    expect(holds[0]!.reason).toBe(OWN_FAILED);
    expect(holds[0]!.amount_idr).toBe(BILL_IDR);
    await expectNewRefundRefused(
      own.code,
      callsBefore,
      "R declined on approve",
    );
  });

  it("1045-F1-03 poller: the provider answers `refunded`: the provider's refund is ONE fact (one journal event), the hold STAYS open, the intent stays blocked (PROVIDER_REFUNDED), no second payout", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("pending");
    const callsBefore = fake.calls.length;

    await pollRounds();
    await runWorker();
    await pollRounds();

    const rows = await providerRows(own.code.id);
    expect(
      rows.map((row) => row.amount_idr),
      "the provider's refund is recorded once, the real amount",
    ).toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(own.code.id), "one journal event").toBe(
      1,
    );
    const holds = await openHolds(own.code.id);
    expect(holds, "the hold stays open for finance (anomaly)").toHaveLength(1);
    expect(holds[0]!.reason).toBe(OWN_FAILED);
    expect(await listedOpenHoldIds()).toContain(holds[0]!.id);

    const blocked = await manualRefund(own.code.id, BILL_IDR);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.error.code).toBe("PROVIDER_REFUNDED");
    await expectNewRefundRefused(own.code, callsBefore, "provider refunded");
    expect(
      (await ourRefundedIdr(own.code.id)) + (await providerTotal(own.code.id)),
      "the guest got back what was paid, once",
    ).toBe(BILL_IDR);
  });

  it("1045-F1-04 poller cannot reach the provider (HTTP 500): the hold stays, new refunds stay refused, no payout; when the provider answers `refunded` later it is ONE fact and the hold stays", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("pending");
    const callsBefore = fake.calls.length;
    doit.getFailsWith = 500;
    const lookupsBefore = doit.getCalls;

    // ONE outage cycle (a poller may back off after repeated errors; this test
    // is about "tried again in a later cycle", not about the retry budget).
    await pollAs(tenantContext(), new Date(Date.now() + 3 * 60 * MINUTE));
    await runWorker();

    expect(
      doit.getCalls,
      "premise: the poller really asked the provider (unavailable)",
    ).toBeGreaterThan(lookupsBefore);
    expect(
      await openHolds(own.code.id),
      "no answer: hold stays open",
    ).toHaveLength(1);
    expect(await providerTotal(own.code.id), "no guess, no fact").toBe(0);
    await expectNewRefundRefused(own.code, callsBefore, "provider unavailable");

    // The provider is back and says refunded.
    doit.getFailsWith = null;
    const lookupsAtRecovery = doit.getCalls;
    await pollRounds();
    expect(
      doit.getCalls,
      "the poller asked the provider again once it was back",
    ).toBeGreaterThan(lookupsAtRecovery);
    expect(
      (await providerRows(own.code.id)).map((row) => row.amount_idr),
    ).toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(own.code.id)).toBe(1);
    expect(await openHolds(own.code.id), "hold stays for finance").toHaveLength(
      1,
    );
    await expectNewRefundRefused(own.code, callsBefore, "provider back");
  });

  it("1045-F1-05 poller gets a status that is not a plain `paid` (partially refunded): the hold stays, new refunds stay refused, no payout, the guest is never over-refunded", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("pending");
    const callsBefore = fake.calls.length;
    doit.setStatus(own.code.providerRef, "partially_refunded");

    await pollRounds();
    await runWorker();
    await pollRounds();

    const holds = await openHolds(own.code.id);
    expect(holds, "an unclear answer never closes the hold").toHaveLength(1);
    expect(holds[0]!.resolution).toBeNull();
    expect(
      (await ourRefundedIdr(own.code.id)) + (await providerTotal(own.code.id)),
      "never more than was paid",
    ).toBeLessThanOrEqual(BILL_IDR);
    await expectNewRefundRefused(own.code, callsBefore, "unclear status");
  });

  it("1045-F1-06 control: the provider still says plain `paid` after R failed: the hold STAYS (paid proves nothing); finance resolves it not_this_intent through the route, then a new refund runs exactly ONCE (one payout)", async () => {
    // R really failed and the provider never refunded A.
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    fake.enqueue("pending");
    expect((await approveRefund(refundId)).status).toBe(200);
    const row = await refundRow(refundId);
    expect(row.provider_ref, "premise: R sent").toBeTruthy();
    expect(await failOwn(row.provider_ref!)).toBeNull();
    expect((await refundRow(refundId)).status).toBe("failed");
    const afterFailure = fake.calls.length;
    const held = await openHolds(code.id);
    expect(held, "held until finance decides").toHaveLength(1);

    await pollRounds();
    await runWorker();
    await pollRounds();

    // A plain `paid` answer does not close the hold and records no fact.
    const holds = await holdsOf(code.id);
    expect(holds, "still one hold in total").toHaveLength(1);
    expect(holds[0]!.resolved_at, "the system never closes it").toBeNull();
    expect(await providerTotal(code.id), "no fact: nothing was refunded").toBe(
      0,
    );
    expect(await refundEventsOfIntent(code.id)).toBe(0);
    expect(await listedOpenHoldIds()).toContain(held[0]!.id);
    await expectNewRefundRefused(code, afterFailure, "paid answer, hold open");

    // Finance checked the provider dashboard: not refunded. It closes the hold.
    const resolved = await resolveHold(held[0]!.id, "not_this_intent");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const closed = (await holdsOf(code.id))[0]!;
    expect(closed.resolved_at).not.toBeNull();
    expect(closed.resolution).toBe("not_this_intent");
    expect(await providerTotal(code.id), "resolving adds no fact").toBe(0);
    expect(await refundEventsOfIntent(code.id)).toBe(0);
    expect(await listedOpenHoldIds()).not.toContain(held[0]!.id);

    // A new refund now runs, once.
    const again = await manualRefund(code.id, BILL_IDR);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const approved = await approveRefund(again.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "the new refund is sent once").toHaveLength(
      afterFailure + 1,
    );
    expect((await refundRow(again.body.data.id as string)).status).toBe(
      "completed",
    );

    // Replays send nothing more, and the bill cannot be refunded a third time.
    await pollRounds();
    await runWorker();
    expect(fake.calls, "no payout from replays").toHaveLength(afterFailure + 1);
    expect(await ourRefundedIdr(code.id)).toBe(BILL_IDR);
    expect(await holdsOf(code.id), "no new hold").toHaveLength(1);
    const third = await manualRefund(code.id, BILL_IDR);
    expect([409, 422], JSON.stringify(third.body)).toContain(third.status);
    expect(fake.calls).toHaveLength(afterFailure + 1);
  });

  it("1045-F1-07 a failed refund reported twice or at the same time by webhook, poller and worker makes ONE hold", async () => {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const filed = await manualRefund(code.id, BILL_IDR);
    const refundId = filed.body.data.id as string;
    fake.enqueue("pending");
    expect((await approveRefund(refundId)).status).toBe(200);
    const ref = (await refundRow(refundId)).provider_ref!;
    expect(ref).toBeTruthy();
    doit.refund(code.providerRef);

    await Promise.all([
      failOwn(ref),
      failOwn(ref),
      failOwn(ref),
      pollAs(tenantContext(), new Date(Date.now() + 3 * 60 * MINUTE)),
      runWorker(),
    ]);
    await failOwn(ref);
    await runWorker();

    expect(
      await ownFailedHolds(code.id),
      "ONE hold for ONE failed refund",
    ).toHaveLength(1);
    expect(await holdsOf(code.id), "and no other hold").toHaveLength(1);
    expect((await refundRow(refundId)).status).toBe("failed");
    expect(
      await providerTotal(code.id),
      "at most the real amount is recorded",
    ).toBeLessThanOrEqual(BILL_IDR);
    expect(await refundEventsOfIntent(code.id)).toBeLessThanOrEqual(1);
    const callsBefore = fake.calls.length;
    await expectNewRefundRefused(code, callsBefore, "refund failed twice");
  });

  it("1045-F1-08 another bill of the same tenant is not blocked: it can be refunded once while this bill is held", async () => {
    const held = await ownRefundFailedWhileProviderRefunded("pending");
    const bystander = await newCode(BILL_IDR);
    expect((await paid(bystander, BILL_IDR)).status).toBe(200);
    const callsBefore = fake.calls.length;

    await pollRounds();
    expect(await openHolds(bystander.id), "no hold on the other bill").toEqual(
      [],
    );
    const filed = await manualRefund(bystander.id, BILL_IDR);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const approved = await approveRefund(filed.body.data.id as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(fake.calls, "the other bill's refund runs once").toHaveLength(
      callsBefore + 1,
    );
    expect(await openHolds(held.code.id), "this bill stays held").toHaveLength(
      1,
    );
  });
});

describe("legend-w2td5 our refund of a parked FUND (extra transaction B) failed after being sent", () => {
  type Extra = { providerRef: string; evidenceId: string; amountIdr: number };

  async function addExtraTxn(code: Code, amountIdr: number): Promise<Extra> {
    const providerRef = `dp_extra_${randomBytes(8).toString("hex")}`;
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
       RETURNING id`,
      [tenantId, outletId, code.id, providerRef, amountIdr],
    );
    return { providerRef, evidenceId: rows[0]!.id, amountIdr };
  }

  async function parkExtra(code: Code, extra: Extra): Promise<string> {
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
      [fundId, tenantId, outletId, code.id, extra.evidenceId, extra.amountIdr],
    );
    return fundId;
  }

  /** A paid; B parked; the fund's refund of B is sent and pending (ref R). */
  async function fundRefundPending() {
    const code = await newCode(BILL_IDR);
    expect((await paid(code, BILL_IDR)).status).toBe(200);
    const extra = await addExtraTxn(code, BILL_IDR);
    const fundId = await parkExtra(code, extra);
    const filed = await resolveFund(fundId, "refund");
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const refundId = await fundRefundId(fundId);
    fake.enqueue("pending");
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await refundRow(refundId);
    expect(row.provider_ref, "premise: R of B stored").toBeTruthy();
    expect(["completed", "failed"]).not.toContain(row.status);
    return { code, extra, fundId, refundId, ownRef: row.provider_ref! };
  }

  async function expectFundBlocked(fundId: string, why: string) {
    for (const resolution of ["refund", "credit"] as const) {
      const attempt = await resolveFund(fundId, resolution);
      expect(
        [409, 422],
        `${why}: fund B by ${resolution}: ${JSON.stringify(attempt.body)}`,
      ).toContain(attempt.status);
    }
  }

  it("1045-F1-09 R of B fails: ONE hold naming B; the poller (which only checks the main transaction) never closes it; fund B and the intent stay blocked; no payout", async () => {
    const p = await fundRefundPending();
    expect(await failOwn(p.ownRef), "R of B fails").toBeNull();
    expect((await refundRow(p.refundId)).status).toBe("failed");
    const callsBefore = fake.calls.length;

    const holds = await openHolds(p.code.id);
    expect(holds, "ONE open hold for the failed fund refund").toHaveLength(1);
    expect(holds[0]!.reason).toBe(OWN_FAILED);
    expect(holds[0]!.amount_idr).toBe(BILL_IDR);
    expect(holds[0]!.provider_payment_ref, "it names transaction B").toBe(
      p.extra.providerRef,
    );
    const holdId = holds[0]!.id;

    // A is plain `paid` at the provider: that says nothing about B.
    await pollRounds();
    await runWorker();
    await pollRounds();

    const after = await holdsOf(p.code.id);
    expect(after, "no new hold, none closed").toHaveLength(1);
    expect(after[0]!.id).toBe(holdId);
    expect(
      after[0]!.resolved_at,
      "the system never closes a fund refund hold by itself",
    ).toBeNull();
    expect(await listedOpenHoldIds()).toContain(holdId);
    await expectFundBlocked(p.fundId, "hold of B open");
    await expectNewRefundRefused(p.code, callsBefore, "hold of B open");
    expect(await providerTotal(p.code.id), "no fact is guessed").toBe(0);
  });

  it("1045-F1-10 R of B reported failed twice or concurrently: ONE hold", async () => {
    const p = await fundRefundPending();
    await Promise.all([
      failOwn(p.ownRef),
      failOwn(p.ownRef),
      failOwn(p.ownRef),
      runWorker(),
    ]);
    await failOwn(p.ownRef);
    await pollRounds();

    expect(await ownFailedHolds(p.code.id)).toHaveLength(1);
    expect(await holdsOf(p.code.id), "and no other hold").toHaveLength(1);
    expect((await openHolds(p.code.id)).length, "still open").toBe(1);
  });
});

describe("legend-w2td5 another tenant", () => {
  async function ensureTenantB(): Promise<TenantB> {
    if (tenantB) return tenantB;
    const scopeB = paymentTestScope();
    await scopeB.seed(owner);
    const context = contextOf(scopeB.tenantId, { kind: "tenant" });
    // Same key and webhook secret as tenant A: signatures are checked against
    // the tenant of the URL.
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
    tenantB = { scope: scopeB, integrationId: created.id, linkIds: [] };
    clearDoitWebhookSecretCache();
    return tenantB;
  }

  /** A paid bill of tenant B with an open own-refund hold (seeded). */
  async function heldBillOfB() {
    const other = await ensureTenantB();
    const outletB = outletIdSchema.parse(other.scope.outletId);
    const opened = await createPaymentLink(
      contextOf(other.scope.tenantId, {
        kind: "outlets",
        outletIds: [outletB],
      }),
      {
        outletId: outletB,
        reference: `R1045AB-${unique()}`,
        tableLabel: "B01",
        pax: 2,
        subtotalIdr: BILL_IDR,
        discountIdr: 0,
        serviceChargeIdr: 0,
        taxIdr: 0,
        roundingIdr: 0,
        totalIdr: BILL_IDR,
        returnPath: "/t/v1.abc",
      },
      "00000000-0000-4000-8000-000000000001",
    );
    other.linkIds.push(opened.linkId);
    const created = await agent(app)
      .post(`/api/payments/links/${opened.token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const { rows } = await owner.query<{ provider_ref: string }>(
      "SELECT provider_ref FROM payment_intents WHERE id = $1",
      [intentId],
    );
    const providerRef = rows[0]!.provider_ref;
    doit.settle(providerRef, BILL_IDR);
    const answered = await deliverTo(
      `/api/webhooks/payments/doit/${other.scope.tenantId}`,
      paidEvent(providerRef),
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const holdId = randomUUID();
    await owner.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, amount_idr, reason, provider_payment_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        holdId,
        other.scope.tenantId,
        intentId,
        randomUUID(),
        BILL_IDR,
        OWN_FAILED,
        providerRef,
      ],
    );
    return { tenant: other.scope.tenantId, intentId, providerRef, holdId };
  }

  it("1045-F1-11 tenant A's poll records A's refund and never touches tenant B's hold; B's own poll records only B's refund and leaves B's hold open", async () => {
    const own = await ownRefundFailedWhileProviderRefunded("pending");
    const other = await heldBillOfB();
    expect(
      (await holdsOf(own.code.id, other.tenant)).length,
      "A's failure made no hold in B",
    ).toBe(0);
    const aHold = (await openHolds(own.code.id))[0]!;

    // Tenant A's poller: A's bill is refunded at the provider, B's is paid.
    await pollRounds(tenantContext());
    expect(
      (await providerRows(own.code.id)).map((row) => row.amount_idr),
    ).toEqual([BILL_IDR]);
    const bHold = (await holdsOf(other.intentId, other.tenant))[0]!;
    expect(bHold.id).toBe(other.holdId);
    expect(bHold.resolved_at, "B's hold untouched by A's poll").toBeNull();
    expect(await providerRows(other.intentId, other.tenant)).toEqual([]);

    // Tenant B's provider refunded B on its own (no webhook): B's poller finds
    // it. Nothing of this touches A.
    doit.refund(other.providerRef);
    const lookupsBeforeB = doit.getCalls;
    await pollRounds(contextOf(other.tenant, { kind: "tenant" }));
    expect(
      doit.getCalls,
      "B's poller asked the provider again about the held bill",
    ).toBeGreaterThan(lookupsBeforeB);
    expect(
      (await providerRows(other.intentId, other.tenant)).map(
        (row) => row.amount_idr,
      ),
    ).toEqual([BILL_IDR]);
    expect(await refundEventsOfIntent(other.intentId, other.tenant)).toBe(1);
    expect(
      (await holdsOf(other.intentId, other.tenant))[0]!.resolved_at,
      "B's hold stays for finance",
    ).toBeNull();
    const aAfter = (await holdsOf(own.code.id))[0]!;
    expect(aAfter.id).toBe(aHold.id);
    expect(aAfter.resolved_at, "A's hold stays for finance").toBeNull();
    expect(await providerRows(own.code.id)).toHaveLength(1);
    expect(await refundEventsOfIntent(own.code.id)).toBe(1);

    // A's finance list never shows B's hold.
    expect(await listedOpenHoldIds()).toContain(aHold.id);
    expect(await listedOpenHoldIds()).not.toContain(other.holdId);
  });
});
