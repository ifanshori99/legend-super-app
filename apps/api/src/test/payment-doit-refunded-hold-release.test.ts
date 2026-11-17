// legend-3wpf / 952 round 2 (architect P1 + P2 + P3 #5): a code the provider
// answered `refunded` must never be booked by a LATE verified `paid` webhook,
// also when the code's QRIS hold already closed on the provider's proof, or
// when staff released the code first. The provider gave the money back, so the
// outlet must neither credit the bill nor park the money as "unallocated"
// (which would make the outlet refund the payer a second time).
//
// Written from the money rules in the brief, not from the implementation.
//
// Rules asserted:
//  (a) POS QRIS code, hold closed on provider `refunded`, then a late verified
//      paid webhook (same provider reference): no evidence, no unallocated
//      funds, no `payment.funds_unallocated` event, no `payment.paid` event,
//      nothing captured, bill paid_idr stays 0.
//  (b) VA code released by staff, then the provider reports `refunded`, then a
//      late paid webhook: same as (a).
//  (c) A verified DOIT `refunded` WEBHOOK, then a retried `paid` webhook before
//      any poll: nothing is settled, parked or published.
//  (d) Control: an EXTRA payment with a DIFFERENT provider reference on a
//      refunded code is still parked (one evidence row, one unallocated row,
//      one funds event) and never settles the bill.
//  (e) A `paid` intent that the provider later reads as `refunded` (poll or
//      webhook) is not marked refunded: status stays paid, the replay of the
//      paid webhook is still a replay (nothing doubled).
//
// Assumptions (the spec does not fix them):
//  - A late webhook for the ignored payment answers anything below 500 (the
//    provider only needs a non-5xx to stop retrying). Calls that run through
//    the service directly may reject; the rejection is swallowed, the stored
//    result is what is asserted.
//  - A DOIT `refunded` read maps to {status: "failed", rawStatus: "refunded"}
//    on the gateway port (how the real DOIT adapter reports it); the scripted
//    gateway of the hold tests is wrapped to answer that for chosen refs.
//  - The hold is closed through the existing cancel + hold-check path (QH-08).
//  - The DOIT `refunded` webhook event type is `payment.refunded`.
//  - After a `refunded` answer the local status is `expired` or `failed`.
//  - (e) the "poll" of a paid intent may not even select it; the test proves
//    the end state (paid, `provider_refunded_at` null, replay is a replay).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-doit-refunded-hold-release.test.ts" heavy pnpm test
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import {
  dueVaReleaseReconciliations,
  reconcileReleasedVa,
} from "../services/payment-va-release-recon";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  confirmPayment,
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
import { agent } from "./helpers";
import { owner } from "./floor-test-helpers";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  readHold,
  resetHoldPorts,
  runHoldCheck,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
  type ManagerApproval,
} from "./pos-qris-hold-test-helpers";
import {
  evidenceRows,
  outboxCountOf,
  releaseKit,
} from "./qris-hold-so885-d-helpers";
import { enableVaBank } from "./qris-hold-so879-va-gateway";

vi.setConfig({ testTimeout: 180_000 });

const REFUNDED_STATUSES = ["expired", "failed"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

afterAll(async () => {
  // Top level: runs after the describe blocks' own cleanup.
  await owner.end();
});

/** The late webhook is acknowledged or refused, never a server error. */
function expectNotServerError(status: number) {
  expect(status).toBeLessThan(500);
}

// ===========================================================================
// Part 1: POS QRIS hold and VA release (scripted gateway), scenarios (a)(b)(d)
// ===========================================================================

describe("legend-3wpf/952 r2 refunded code with a closed hold or a staff release", () => {
  const BILL_IDR = 33_000;
  const RELEASE_AFTER_MIN = 30;
  const REASON = "Bank tidak menjawab status VA lebih dari sehari";
  let fx: HoldFixture;
  let kit: ReturnType<typeof releaseKit>;
  /** Provider references the provider now reports as `refunded`. */
  const refundedRefs = new Set<string>();

  beforeAll(async () => {
    fx = await holdFixture("doit-refunded-hold-release");
    enableVaBank(fx.gateway);
    const read = fx.gateway.getStatus.bind(fx.gateway);
    fx.gateway.getStatus = async (input) =>
      refundedRefs.has(input.providerRef)
        ? {
            status: "failed",
            rawStatus: "refunded",
            providerRef: input.providerRef,
            amountIdr: null,
          }
        : read(input);
    setPaymentGateway(fx.gateway);
    kit = releaseKit(fx);
  });
  afterAll(() => {
    refundedRefs.clear();
    resetHoldPorts();
  });

  const at = (qr: IssuedQris, seconds: number) =>
    new Date(qr.expiresAt.getTime() + seconds * 1000);

  async function intentRow(intentId: string) {
    const { rows } = await owner.query<{
      status: string;
      link_id: string;
      provider_ref: string | null;
    }>(
      `SELECT status, payment_link_id::text AS link_id, provider_ref
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!;
  }

  async function linkPaidIdr(linkId: string) {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, linkId],
    );
    return rows[0]!.paid;
  }

  /** Nothing credited, published, parked or recorded for the code. */
  async function expectNothingBooked(intentId: string, orderId?: string) {
    const row = await intentRow(intentId);
    expect(row.status).not.toBe("paid");
    expect(await linkPaidIdr(row.link_id), "bill paid_idr").toBe(0);
    expect(await evidenceRows(fx, intentId), "no evidence").toEqual([]);
    expect(
      await unallocatedFunds(fx, intentId),
      "no unallocated funds",
    ).toEqual([]);
    expect(
      await outboxCountOf(fx, "payment.funds_unallocated", intentId),
      "no payment.funds_unallocated event",
    ).toBe(0);
    expect(
      await outboxCountOf(fx, "payment.paid", intentId),
      "no payment.paid event",
    ).toBe(0);
    if (orderId) expect(await capturedIdr(fx, orderId)).toBe(0);
  }

  /** POS QRIS code whose hold closed because the provider said `refunded`. */
  async function qrisWithHoldClosedOnRefunded() {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.providerRef).toBeTruthy();
    refundedRefs.add(qr.providerRef!);
    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    await runHoldCheck(fx, at(qr, 61));
    const hold = await readHold(fx, order.id);
    expect(hold?.state, "hold closed on the provider's proof").toBe("closed");
    expect(REFUNDED_STATUSES).toContain((await intentRow(qr.intentId)).status);
    await expectNothingBooked(qr.intentId, order.id);
    return { order, qr };
  }

  it("952r2-a QRIS hold closed on provider refunded, then a late verified paid webhook: no evidence, no unallocated funds, no funds event, paid_idr 0", async () => {
    const { order, qr } = await qrisWithHoldClosedOnRefunded();

    // The genuine paid webhook: same provider reference, whole bill.
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      at(qr, 120),
      qr.providerRef!,
    ).catch(() => null);
    await expectNothingBooked(qr.intentId, order.id);

    // The provider retries: same reference again, nothing appears.
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      at(qr, 180),
      qr.providerRef!,
    ).catch(() => null);
    await expectNothingBooked(qr.intentId, order.id);
  });

  // ---- VA released by staff ------------------------------------------------

  async function openVaCode() {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const res = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const intentId = res.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    return {
      order,
      intentId,
      amount: rows[0]!.amount,
      providerRef: rows[0]!.provider_ref,
    };
  }

  it("952r2-b VA code released by staff, then provider refunded, then a late verified paid webhook: nothing is booked or parked", async () => {
    const code = await openVaCode();
    // Eligible for staff release: still pending locally, 30+ minutes past
    // expiry, provider answers pending (not paid).
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents
          SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, code.intentId, RELEASE_AFTER_MIN + 1],
    );
    const approval: ManagerApproval = await kit.managerApproval(
      code.order.id,
      code.amount,
    );
    const released = await fx.post(`${fx.base}/${code.order.id}/va/release`, {
      paymentIntentId: code.intentId,
      ...approval,
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const { rows: releases } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
      [fx.tenant.tenantId, code.intentId],
    );
    expect(releases[0]!.n, "the staff release is recorded").toBe(1);

    // The provider now reports the payment as refunded. A released VA code is
    // not read by the payment poller; its own release queue asks the provider.
    refundedRefs.add(code.providerRef);
    const due = await dueVaReleaseReconciliations(fx.context, new Date(), {
      force: true,
      limit: 100,
    });
    expect(due.length, "the release queue has the code").toBeGreaterThan(0);
    for (const id of due) await reconcileReleasedVa(fx.context, id, new Date());
    const refundedRow = await owner.query<{ refunded: boolean }>(
      `SELECT provider_refunded_at IS NOT NULL AS refunded
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, code.intentId],
    );
    expect(refundedRow.rows[0]!.refunded, "refund recorded").toBe(true);
    await expectNothingBooked(code.intentId, code.order.id);

    // Late genuine paid webhook (same provider reference), then a retry.
    for (let attempt = 0; attempt < 2; attempt += 1)
      await confirmPayment(
        fx.context,
        code.intentId,
        {
          source: "verified_webhook",
          method: "va",
          amountIdr: code.amount,
          providerRef: code.providerRef,
          at: new Date().toISOString(),
        },
        { type: "system" },
        new Date(),
      ).catch(() => null);
    await expectNothingBooked(code.intentId, code.order.id);
  });

  it("952r2-d control: an extra payment with a DIFFERENT provider reference on a refunded code is still parked, and never settles the bill", async () => {
    const { order, qr } = await qrisWithHoldClosedOnRefunded();

    const otherRef = `HOLD-EXTRA-${randomUUID()}`;
    expect(otherRef).not.toBe(qr.providerRef);
    await payNotice(fx, qr.intentId, BILL_IDR, at(qr, 120), otherRef).catch(
      () => null,
    );

    // Parked for the outlet to resolve, exactly once.
    expect(await evidenceRows(fx, qr.intentId)).toHaveLength(1);
    const funds = await unallocatedFunds(fx, qr.intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]!.amountIdr).toBe(BILL_IDR);
    expect(
      await outboxCountOf(fx, "payment.funds_unallocated", qr.intentId),
    ).toBe(1);
    // ...and it never settles the bill or the order.
    const row = await intentRow(qr.intentId);
    expect(row.status).not.toBe("paid");
    expect(await linkPaidIdr(row.link_id)).toBe(0);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(await outboxCountOf(fx, "payment.paid", qr.intentId)).toBe(0);
  });
});

// ===========================================================================
// Part 2: payment link + real DOIT webhooks (fake DOIT), scenarios (c)(e)
// ===========================================================================

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const webhookPath = `/api/webhooks/payments/doit/${tenantA}`;
const BILL_TOTAL = 144_375;
const apiKey = `doit-key-h-${randomBytes(12).toString("hex")}`;
const secret = `whsec-h-${randomBytes(16).toString("hex")}`;
const createdLinkIds: string[] = [];
let integrationId = "";
const unique = () => randomBytes(4).toString("hex");

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function outletContext(outletIds: readonly OutletId[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [...outletIds] },
  );
}

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

  /** A `payment.<status>` webhook body for the payment. */
  eventFor(id: string, status: "paid" | "refunded") {
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
      const key = String(req.headers["idempotency-key"] ?? "");
      const known = this.byIdempotencyKey.get(key);
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
      if (key) this.byIdempotencyKey.set(key, payment);
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

describe("legend-3wpf/952 r2 verified DOIT refunded and paid webhooks", () => {
  const doit = new FakeDoit();

  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
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
    await owner.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1",
      [tenantA],
    );
    if (createdLinkIds.length > 0) {
      const intents =
        "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
      await owner.query(
        `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [tenantA, createdLinkIds],
      );
      await owner.query(
        `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [tenantA, createdLinkIds],
      );
      await owner.query(
        "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await owner.query(
        "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
    }
    await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId,
    ]);
    await doit.stop();
  });

  beforeEach(() => {
    resetPaymentWebhookRateLimits();
    clearDoitWebhookSecretCache();
  });

  type Code = { id: string; providerRef: string; linkId: string };

  async function newCode(): Promise<Code> {
    const opened = await createPaymentLink(
      outletContext([outletA]),
      {
        outletId: outletA,
        reference: `H-${unique()}`,
        tableLabel: "A05",
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
    expect(created.status).toBe(201);
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

  async function deliver(body: object) {
    const raw = JSON.stringify(body);
    return request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", signatureHeader(raw))
      .send(raw);
  }

  const send = (code: Code, status: "paid" | "refunded") =>
    deliver(doit.eventFor(code.providerRef, status));

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n);
  }

  async function intentState(intentId: string) {
    const { rows } = await owner.query<{
      status: string;
      refunded_at: Date | null;
    }>(
      "SELECT status, provider_refunded_at AS refunded_at FROM payment_intents WHERE id = $1",
      [intentId],
    );
    return rows[0]!;
  }

  const evidence = (id: string) =>
    count(
      "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantA, id],
    );
  const unallocated = (id: string) =>
    count(
      "SELECT count(*)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantA, id],
    );
  const events = (name: string, id: string) =>
    count(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2
          AND event->'payload'->>'intentId' = $3`,
      [tenantA, name, id],
    );
  async function paidIdr(linkId: string): Promise<number> {
    const { rows } = await owner.query<{ paid_idr: string }>(
      "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
      [linkId],
    );
    return Number(rows[0]?.paid_idr);
  }

  async function expectNothingBooked(code: Code) {
    expect((await intentState(code.id)).status).not.toBe("paid");
    expect(await paidIdr(code.linkId), "bill paid_idr").toBe(0);
    expect(await evidence(code.id), "no evidence").toBe(0);
    expect(await unallocated(code.id), "no unallocated funds").toBe(0);
    expect(await events("payment.paid", code.id)).toBe(0);
    expect(await events("payment.funds_unallocated", code.id)).toBe(0);
  }

  async function expectPaidOnce(code: Code) {
    expect((await intentState(code.id)).status).toBe("paid");
    expect(await paidIdr(code.linkId)).toBe(BILL_TOTAL);
    expect(await evidence(code.id)).toBe(1);
    expect(await unallocated(code.id)).toBe(0);
    expect(await events("payment.paid", code.id)).toBe(1);
  }

  const pollAt = (at: Date) =>
    pollPendingGatewayIntents(tenantContext(), at, 100);

  it("952r2-c verified DOIT refunded webhook, then a retried paid webhook before any poll: nothing is settled, parked or published", async () => {
    const code = await newCode();

    // The provider's own refunded webhook (verified, signed).
    expectNotServerError((await send(code, "refunded")).status);
    await expectNothingBooked(code);

    // Retried genuine paid webhook arrives before the poller ran: same body,
    // then a fresh event id.
    const late = doit.eventFor(code.providerRef, "paid");
    expectNotServerError((await deliver(late)).status);
    await expectNothingBooked(code);
    expectNotServerError((await deliver(late)).status);
    expectNotServerError((await send(code, "paid")).status);
    await expectNothingBooked(code);
  });

  it("952r2-e a paid intent later read as refunded (webhook and poll) is not marked refunded: stays paid, the paid webhook replay is still a replay", async () => {
    const code = await newCode();
    expect((await send(code, "paid")).status).toBe(200);
    await expectPaidOnce(code);
    expect((await intentState(code.id)).refunded_at).toBeNull();

    // The provider reports refunded: by webhook, then by the poller.
    doit.payments.get(code.providerRef)!.status = "refunded";
    expectNotServerError((await send(code, "refunded")).status);
    await pollAt(new Date(Date.now() + 2 * MINUTE));
    await pollAt(new Date(Date.now() + 3 * HOUR));

    const after = await intentState(code.id);
    expect(after.status, "status stays paid").toBe("paid");
    expect(
      after.refunded_at,
      "paid intent never gets providerRefundedAt",
    ).toBeNull();
    await expectPaidOnce(code);

    // Replay of the paid webhook: still a replay, nothing doubled or parked.
    expectNotServerError((await send(code, "paid")).status);
    const replayed = await intentState(code.id);
    expect(replayed.status).toBe("paid");
    expect(replayed.refunded_at).toBeNull();
    await expectPaidOnce(code);
  });
});
