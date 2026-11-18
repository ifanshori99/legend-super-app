// Shared fixture of the 1072-a{1,3,4} red-first tests (brief 1072 task A). It is
// the 1063-a / 1063-c fixture (fake DOIT server, signed webhook delivery, fake
// refund gateway, observations of facts / holds / refunds) in one reusable
// function, so every test file only holds its scenarios. Written from the
// second-opinion report ronde 6 and the 1063 fixtures, not from the
// implementation. Call `createRefundHarness(tag)` once at module level of a test
// file: it registers the beforeAll / afterAll / beforeEach / afterEach hooks.

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
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
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

export const BILL_IDR = 100_000;
const MINUTE = 60_000;
const ADMIN = "/api/payments/admin";

export type Code = { id: string; providerRef: string; linkId: string };
export type Extra = {
  providerRef: string;
  evidenceId: string;
  amountIdr: number;
};
export type ProviderRow = {
  id: string;
  provider_refund_id: string;
  provider_payment_ref: string;
  amount_idr: number;
};
export type HoldRow = {
  id: string;
  reason: string;
  amount_idr: number;
  provider_refund_id: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  provider_payment_ref: string | null;
  provider_refund_id_kind: string | null;
  matched_fact_id: string | null;
};
export type Identity = "same_as_counted" | "separate";

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

export function createRefundHarness(tag: string) {
  vi.setConfig({ testTimeout: 120_000 });

  const scope = paymentTestScope();
  const app = createApp();
  const tenantId = scope.tenantId;
  const outletId = outletIdSchema.parse(scope.outletId);
  const actor = randomUUID();
  const apiKey = `doit-key-${tag}-${randomBytes(12).toString("hex")}`;
  const secret = `whsec-${tag}-${randomBytes(16).toString("hex")}`;
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 4,
  });
  const createdLinkIds: string[] = [];
  const userIds: string[] = [];
  let integrationId = "";
  let staff: ReturnType<typeof agent>;
  let approver: ReturnType<typeof agent>;
  let supervisorUserId = "";
  let fakeGateway: FakeRefundGateway = new FakeRefundGateway();

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

  // ---- fake DOIT server ----------------------------------------------------
  class FakeDoit {
    readonly payments = new Map<string, DoitPayment>();
    private readonly byIdempotencyKey = new Map<string, DoitPayment>();
    private server: Server | null = null;
    baseUrl = "";
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
    settle(id: string, amount: number = BILL_IDR): void {
      const payment = this.payments.get(id);
      if (!payment) throw new Error(`No fake DOIT payment ${id}`);
      payment.status = "paid";
      payment.amount = amount;
      payment.total_amount = amount;
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

  // ---- hooks ---------------------------------------------------------------
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

    staff = agent(app).set("Host", scope.hostname);
    const email = await signUp(staff, `Refund${tag} owner`);
    const session = await staff.get("/api/auth/get-session");
    const staffId = session.body.user.id as string;
    userIds.push(staffId);
    await verifySessionMfa(email);
    await assign(staffId, "owner", "tenant");

    approver = agent(app).set("Host", scope.hostname);
    const approverEmail = await signUp(approver, `Refund${tag} approver`);
    const approverSession = await approver.get("/api/auth/get-session");
    const approverId = approverSession.body.user.id as string;
    userIds.push(approverId);
    await verifySessionMfa(approverEmail);
    await assign(approverId, "finance", "tenant");
    await assign(approverId, "supervisor", "outlet");

    const supervisorClient = agent(app).set("Host", scope.hostname);
    await signUp(supervisorClient, `Refund${tag} supervisor`);
    const supervisorSession = await supervisorClient.get(
      "/api/auth/get-session",
    );
    supervisorUserId = supervisorSession.body.user.id as string;
    userIds.push(supervisorUserId);
    await assign(supervisorUserId, "supervisor", "outlet");

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
    setPaymentGateway(null);
    setPaymentRefundGateway(null);
    const intentsOf =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [tenantId],
    );
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
    fakeGateway = new FakeRefundGateway();
    setPaymentRefundGateway(fakeGateway);
  });
  afterEach(() => {
    setPaymentRefundGateway(null);
  });

  // ---- building blocks -----------------------------------------------------
  async function newCode(
    amountIdr: number = BILL_IDR,
    exactRef: string | null = null,
  ): Promise<Code> {
    const opened = await createPaymentLink(
      outletContext([outletId]),
      {
        outletId,
        reference: `R${tag.toUpperCase()}-${unique()}`,
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
    if (!rows[0]?.provider_ref)
      throw new Error("Intent has no DOIT payment id");
    return { id, providerRef: rows[0].provider_ref, linkId: opened.linkId };
  }

  function signatureHeader(raw: string): string {
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", secret)
      .update(`${t}.${raw}`)
      .digest("hex");
    return `t=${t},v1=${mac}`;
  }
  const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;
  async function deliver(body: object) {
    const raw = JSON.stringify(body);
    return request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", signatureHeader(raw))
      .send(raw);
  }
  const pollLater = () =>
    pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 3 * 60 * MINUTE),
      100,
    );
  const paid = (code: Code, amount: number = BILL_IDR) => {
    doit.settle(code.providerRef, amount);
    return deliver(doit.eventFor(code.providerRef, "paid"));
  };
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

  /** Rounds of everything that replays: delivery, poller, worker. */
  async function replayAll(body: () => object, rounds = 2) {
    for (let round = 0; round < rounds; round += 1) {
      await deliver(body());
      await pollLater().catch(() => null);
      await runWorker();
    }
  }

  /** `payment.refunded` status object: the recorder door. */
  const refundIdEvent = (
    paymentRef: string,
    providerRefundId: string,
    amountIdr: number,
    total: number = BILL_IDR,
  ) => ({
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "payment.refunded",
    created_at: new Date().toISOString(),
    data: {
      payment_id: paymentRef,
      refund_id: providerRefundId,
      amount: amountIdr,
      status: amountIdr >= total ? "refunded" : "partially_refunded",
    },
  });

  /** Flat `refund.succeeded` event: the door that matches OUR refund by id. */
  const refundSucceededEvent = (
    paymentRef: string,
    providerRefundId: string,
    amountIdr: number,
  ) => ({
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      refund_id: providerRefundId,
      amount: amountIdr,
      payment_id: paymentRef,
    },
  });

  // ---- HTTP actions --------------------------------------------------------
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
  const retryRefund = (refundId: string) =>
    approver
      .post(`${ADMIN}/refunds/${refundId}/retry`)
      .set(originHeader)
      .send({ idempotencyKey: key("retry") });
  const resolveFund = (fundId: string, resolution: "refund" | "credit") =>
    staff
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("fund"),
        resolution,
        note: "Kembalikan dana yang belum teralokasi",
      });
  const resolveHold = (
    holdId: string,
    resolution: "counted_against_intent" | "not_this_intent",
    providerRefundId?: string,
    identity?: Identity,
  ) =>
    staff
      .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("hold"),
        resolution,
        note: "Dicek di dashboard provider.",
        ...(providerRefundId === undefined ? {} : { providerRefundId }),
        ...(identity === undefined ? {} : { identity }),
      });
  const sameAsCounted = (holdId: string) =>
    resolveHold(holdId, "counted_against_intent", undefined, "same_as_counted");

  // ---- observations --------------------------------------------------------
  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n);
  }
  async function providerRows(intentId: string): Promise<ProviderRow[]> {
    const { rows } = await owner.query<
      Omit<ProviderRow, "amount_idr"> & { amount_idr: string }
    >(
      `SELECT id, provider_refund_id, provider_payment_ref, amount_idr::text AS amount_idr
         FROM payment_provider_refunds
        WHERE tenant_id = $1 AND payment_intent_id = $2
        ORDER BY created_at, id`,
      [tenantId, intentId],
    );
    return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
  }
  const factAmounts = async (intentId: string) =>
    (await providerRows(intentId)).map((row) => row.amount_idr);
  const factTotal = async (intentId: string) =>
    (await factAmounts(intentId)).reduce((sum, amount) => sum + amount, 0);
  const refundEventsOfIntent = (intentId: string) =>
    count(
      `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
          AND event->'payload'->>'paymentIntentId' = $2`,
      [tenantId, intentId],
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
      payout_attempts: number;
    }>(
      `SELECT status, provider_ref, amount_idr::text AS amount_idr, payout_attempts
         FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId],
    );
    return rows[0]!;
  }
  const refundRowCount = (intentId: string) =>
    count(
      "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, intentId],
    );
  async function allHolds(intentId: string): Promise<HoldRow[]> {
    const { rows } = await owner.query<
      Omit<HoldRow, "amount_idr"> & { amount_idr: string }
    >(
      `SELECT id, reason, amount_idr::text AS amount_idr, provider_refund_id, resolved_at, resolution,
             provider_payment_ref, provider_refund_id_kind, matched_fact_id
         FROM refund_recon_holds
        WHERE tenant_id = $1 AND payment_intent_id = $2
        ORDER BY flagged_at, id`,
      [tenantId, intentId],
    );
    return rows.map((row) => ({ ...row, amount_idr: Number(row.amount_idr) }));
  }
  const openOf = async (intentId: string) =>
    (await allHolds(intentId)).filter((hold) => hold.resolved_at === null);
  const supervisorAlertRows = async () => {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM notifications WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, supervisorUserId],
    );
    return rows;
  };

  /** A second transaction T2 of the same bill (evidence), parked as a fund. */
  async function addParkedExtra(code: Code, amountIdr: number = BILL_IDR) {
    const providerRef = `dp_extra_${randomBytes(8).toString("hex")}`;
    const evidence = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
       RETURNING id`,
      [tenantId, outletId, code.id, providerRef, amountIdr],
    );
    const extra: Extra = {
      providerRef,
      evidenceId: evidence.rows[0]!.id,
      amountIdr,
    };
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
      [fundId, tenantId, outletId, code.id, extra.evidenceId, amountIdr],
    );
    return { extra, fundId };
  }

  /** Our refund R of the intent, filed, approved and (fake provider) completed. */
  async function ownCompletedRefund(code: Code, amountIdr: number) {
    const filed = await manualRefund(code.id, amountIdr);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await refundRow(refundId);
    expect(row.status, "premise: our refund R completed").toBe("completed");
    expect(
      row.provider_ref,
      "premise: R carries the provider ref X",
    ).toBeTruthy();
    return { refundId, x: row.provider_ref! };
  }

  /** Our refund R in flight: approved, the provider answered "pending" with ref X. */
  async function ownPendingRefund(code: Code, amountIdr: number) {
    const filed = await manualRefund(code.id, amountIdr);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const refundId = filed.body.data.id as string;
    fakeGateway.enqueue("pending");
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await refundRow(refundId);
    expect(
      ["completed", "failed"],
      "premise: our refund R is in flight",
    ).not.toContain(row.status);
    expect(row.provider_ref, "premise: R carries the ref X").toBeTruthy();
    return { refundId, x: row.provider_ref! };
  }

  /** Our refund (intent level) is SENT, times out (no ref), then DECLINED with no ref: one anonymous own-failed hold. */
  async function declineWithoutRef(
    code: Code,
    amountIdr: number,
  ): Promise<string> {
    const known = new Set((await allHolds(code.id)).map((row) => row.id));
    const filed = await manualRefund(code.id, amountIdr);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    return declineFiledWithoutRef(code, known, filed.body.data.id as string);
  }

  /** Same for a refund that is already filed (intent level or a fund's). */
  async function declineFiledWithoutRef(
    code: Code,
    known: Set<string>,
    refundId: string,
  ): Promise<string> {
    fakeGateway.enqueue("throw");
    const approved = await approveRefund(refundId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await refundRow(refundId)).provider_ref,
      "premise: no ref",
    ).toBeNull();
    fakeGateway.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: null,
      code: "declined",
    });
    const retried = await retryRefund(refundId);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await refundRow(refundId)).status, "premise: R failed").toBe(
      "failed",
    );
    const fresh = (await allHolds(code.id)).filter(
      (row) => !known.has(row.id) && row.resolved_at === null,
    );
    expect(
      fresh,
      "premise: the failed refund filed one new open hold",
    ).toHaveLength(1);
    expect(
      fresh[0]!.provider_refund_id,
      "premise: hold is anonymous",
    ).toBeNull();
    return fresh[0]!.id;
  }

  /** The conservative net: paid - our refunds not failed - provider facts. */
  async function expectMoneyWithinPaid(
    code: Code,
    label: string,
    paidIdr: number = BILL_IDR,
  ) {
    const out = (await ourRefundedIdr(code.id)) + (await factTotal(code.id));
    expect(
      out,
      `${label}: our refunds not failed + provider facts (${out}) exceed what was paid (${paidIdr})`,
    ).toBeLessThanOrEqual(paidIdr);
  }

  return {
    app,
    owner,
    tenantId,
    outletId,
    doit,
    get fake() {
      return fakeGateway;
    },
    unique,
    key,
    newCode,
    paid,
    deliver,
    pollLater,
    runWorker,
    replayAll,
    refundIdEvent,
    refundSucceededEvent,
    manualRefund,
    approveRefund,
    retryRefund,
    resolveFund,
    resolveHold,
    sameAsCounted,
    count,
    providerRows,
    factAmounts,
    factTotal,
    refundEventsOfIntent,
    ourRefundedIdr,
    refundRow,
    refundRowCount,
    allHolds,
    openOf,
    supervisorAlertRows,
    addParkedExtra,
    ownCompletedRefund,
    ownPendingRefund,
    declineWithoutRef,
    declineFiledWithoutRef,
    expectMoneyWithinPaid,
  };
}

export type RefundHarness = ReturnType<typeof createRefundHarness>;
