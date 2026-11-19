// legend-2ol8g (tier K, money): a refund webhook whose refund amount or
// payment_id is PRESENT but unreadable (`"3999.0"`, null, -1, "") used to lose
// that fact in the parser, so the event matched by refund_id and settled the
// refund with no amount check and no payment check. Now the facts carry
// `invalid`, the worker never settles, audits
// `payment.webhook.refund_facts_invalid` and ignores the event as
// REFUND_FACTS_INVALID. Setup copied from payment-refund-manual-settle-webhook.test.ts.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
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
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  doitRefundWebhookEventSchema,
  readDoitRefundFacts,
} from "../services/payment-doit-refund-webhook";
import { createApp } from "../app";
import { env } from "../config/env";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { createDoitGateway } from "../services/payment-doit";
import { setPaymentGateway } from "../services/payment-gateway";
import {
  setPaymentRefundGateway,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();
const PAID_IDR = 100_000;
const REFUND_IDR = 4_000;
const INVALID_ACTION = "payment.webhook.refund_facts_invalid";
const CONFLICT_ACTION = "payment.refund_provider_conflict";
const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";
const webhookPath = `/api/webhooks/payments/doit/${tenantId}`;

const apiKey = `doit-key-${randomBytes(12).toString("hex")}`;
const webhookSecret = `whsec-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

const webhookContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "webhook" }),
  { kind: "tenant" },
);

// These suites exercise the active provider-refund path: DOIT refunds are off
// by default, so switch them on here and restore the value afterwards.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const integrationIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const eventIds: string[] = [];
let integrationId = "";
let doitServer: Server;
let doitBaseUrl = "";

const hex = (bytes = 6) => randomBytes(bytes).toString("hex");

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The webhook path never calls DOIT for these events; the integration only
  // needs a reachable base URL.
  doitServer = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
  });
  await new Promise<void>((accept) =>
    doitServer.listen(0, "127.0.0.1", accept),
  );
  doitBaseUrl = `http://127.0.0.1:${(doitServer.address() as AddressInfo).port}`;

  const created = await upsertIntegration(
    tenantWide,
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doitBaseUrl },
      credentials: { apiKey, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    tenantWide,
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  integrationIds.push(created.id);

  const adapter = createDoitGateway({
    loadCredentials: async () => ({
      integration: {
        id: integrationId,
        outletId: null,
        config: { baseUrl: doitBaseUrl },
      },
      credentials: { apiKey, webhookSecret },
    }),
  });
  setPaymentGateway(adapter);
  setPaymentRefundGateway(adapter as unknown as PaymentRefundPort);
});

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  await cleanupRows();
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  await owner.end();
  await new Promise<void>((accept) => doitServer.close(() => accept()));
});

async function cleanupRows() {
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND (event_id = ANY($2::text[]) OR NOT signature_valid)",
    [tenantId, eventIds],
  );
  eventIds.length = 0;
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});
afterEach(async () => {
  await cleanupRows();
  clearDoitWebhookSecretCache();
});

/** A settled DOIT bill minted by the integration. */
async function seedPaidIntent() {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const paymentId = `dp_${hex(8)}`;
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [linkId, tenantId, outletA, hex(32), `MSW-${hex(4)}`, PAID_IDR, actor],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref, gateway_integration_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'partially_refunded', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      PAID_IDR,
      `msw-${intentId}`,
      paymentId,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, paymentId, PAID_IDR],
  );
  return { intentId, paymentId };
}

/** An approved Rp4.000 refund that already holds its provider ref (the send stored it). */
async function seedApprovedRefund() {
  const { intentId, paymentId } = await seedPaidIntent();
  const refundId = randomUUID();
  const providerRef = `rf_${hex(6)}`;
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'approved', 'system:reservation', $6, now(), $7, 1, now())`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      REFUND_IDR,
      randomUUID(),
      providerRef,
    ],
  );
  return { refundId, intentId, paymentId, providerRef };
}

/** A refund finance settled by hand: completed, marker, no provider reference. */
async function seedSettledByHandRefund() {
  const { intentId, paymentId } = await seedPaidIntent();
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts,
                                  last_payout_error, completed_at, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian dibayar manual', 'completed', 'system:reservation', $5, now(),
             NULL, 8, $6, now(), now())`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      randomUUID(),
      SETTLED_OUTSIDE_PROVIDER,
    ],
  );
  return { refundId, intentId, paymentId };
}

const backdate = (eventId: string, minutes: number) =>
  owner.query(
    `UPDATE gateway_webhook_events
       SET received_at = now() - make_interval(mins => $3),
           updated_at = now() - make_interval(mins => $3)
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId, minutes],
  );

const reprocess = () =>
  reprocessStoredWebhookEvents(webhookContext, new Date(), 100);

async function conflictAudits(refundId: string) {
  const { rows } = await owner.query(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, refundId, CONFLICT_ACTION],
  );
  return rows;
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    last_payout_error: string | null;
    completed_at: Date | null;
  }>(
    `SELECT status, provider_ref, last_payout_error, completed_at
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!;
}

async function invalidAudits(eventId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2
       AND event->'maskedChanges'->'after'->>'eventId' = $3`,
    [tenantId, INVALID_ACTION, eventId],
  );
  return rows;
}

async function eventRows(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code FROM gateway_webhook_events
     WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows;
}

/** Deliver one signed refund event; `data` is the DOIT payload. */
function deliver(type: string, data: Record<string, unknown>) {
  const id = `evt_${hex(8)}`;
  eventIds.push(id);
  const raw = JSON.stringify({
    id,
    type,
    created_at: new Date().toISOString(),
    data,
  });
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", webhookSecret)
    .update(`${t}.${raw}`)
    .digest("hex");
  return {
    eventId: id,
    response: request(app)
      .post(webhookPath)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", `t=${t},v1=${mac}`)
      .send(raw),
  };
}

const PAYMENT = "pay_3N-1K5igG03DWXKD";

describe("legend-2ol8g PAY-04 a refund event with an unreadable amount or payment_id never settles", () => {
  const unsettled = async (
    refundId: string,
    sent: ReturnType<typeof deliver>,
    invalid: string[],
  ) => {
    const response = await sent.response;
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_FACTS_INVALID",
      }),
    ]);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      completed_at: null,
    });
    const audits = await invalidAudits(sent.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toMatchObject({
      objectType: "gateway_webhook_event",
      maskedChanges: { after: { refundId, invalid } },
    });
    // Ids only: the payload (amount, payment id) is not in the audit row.
    expect(JSON.stringify(audits[0]!.event)).not.toContain(PAYMENT);
  };

  it.each([
    ["a decimal string", "3999.0"],
    ["null", null],
    ["a negative number", -1],
  ])(
    "PAY-04 a flat refund.succeeded with amount %s is ignored",
    async (_n, amount) => {
      const { refundId, providerRef, paymentId } = await seedApprovedRefund();
      const sent = deliver("refund.succeeded", {
        refund_id: providerRef,
        amount,
        payment_id: paymentId,
      });
      await unsettled(refundId, sent, ["amount"]);
    },
  );

  it("PAY-04 a flat refund.succeeded with payment_id null is ignored", async () => {
    const { refundId, providerRef } = await seedApprovedRefund();
    const sent = deliver("refund.succeeded", {
      refund_id: providerRef,
      amount: REFUND_IDR,
      payment_id: null,
    });
    await unsettled(refundId, sent, ["payment_id"]);
  });

  it("PAY-04 a flat refund.succeeded with no amount at all is ignored", async () => {
    const { refundId, providerRef, paymentId } = await seedApprovedRefund();
    const sent = deliver("refund.succeeded", {
      refund_id: providerRef,
      payment_id: paymentId,
    });
    await unsettled(refundId, sent, ["amount"]);
  });

  it("PAY-04 a flat refund.succeeded with no payment_id at all is ignored", async () => {
    const { refundId, providerRef } = await seedApprovedRefund();
    const sent = deliver("refund.succeeded", {
      refund_id: providerRef,
      amount: REFUND_IDR,
    });
    await unsettled(refundId, sent, ["payment_id"]);
  });

  it("PAY-04 a valid amount that is not the refund amount is not settled and leaves an audit", async () => {
    const { refundId, providerRef, paymentId } = await seedApprovedRefund();
    const sent = deliver("refund.succeeded", {
      refund_id: providerRef,
      amount: 3_999,
      payment_id: paymentId,
    });
    const response = await sent.response;
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REJECTED_CONFLICT",
      }),
    ]);
    expect(await refundRow(refundId)).toMatchObject({ status: "approved" });
    const audits = await invalidAudits(sent.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toMatchObject({
      maskedChanges: { after: { refundId, invalid: ["amount_mismatch"] } },
    });
  });

  it("PAY-04 a flat refund.succeeded with a valid amount and payment_id still settles", async () => {
    const { refundId, providerRef, paymentId } = await seedApprovedRefund();
    const sent = deliver("refund.succeeded", {
      refund_id: providerRef,
      amount: REFUND_IDR,
      payment_id: paymentId,
    });
    expect((await sent.response).body.status).toBe("processed");
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
    expect(await invalidAudits(sent.eventId)).toHaveLength(0);
  });
});

describe("legend-2ol8g PAY-04 a keyed or refund-object event without amount or payment id never settles", () => {
  const unsettled = async (
    refundId: string,
    sent: ReturnType<typeof deliver>,
    invalid: string[],
  ) => {
    const response = await sent.response;
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_FACTS_INVALID",
      }),
    ]);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      completed_at: null,
    });
    const audits = await invalidAudits(sent.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toMatchObject({
      maskedChanges: { after: { refundId, invalid } },
    });
  };

  describe.each(["refund.succeeded", "refund.failed"])("%s", (type) => {
    it("PAY-04 a keyed refund object without an amount is not settled", async () => {
      const { refundId, providerRef, paymentId } = await seedApprovedRefund();
      const sent = deliver(type, {
        object: "refund",
        id: providerRef,
        idempotency_key: `refund:${refundId}`,
        payment_id: paymentId,
      });
      await unsettled(refundId, sent, ["amount"]);
    });

    it("PAY-04 a refund object matched by refund id without an amount is not settled", async () => {
      const { refundId, providerRef, paymentId } = await seedApprovedRefund();
      const sent = deliver(type, {
        refund: { id: providerRef, payment_id: paymentId },
      });
      await unsettled(refundId, sent, ["amount"]);
    });

    it("PAY-04 a keyed refund object with an amount but no payment id is not settled", async () => {
      const { refundId, providerRef } = await seedApprovedRefund();
      const sent = deliver(type, {
        object: "refund",
        id: providerRef,
        idempotency_key: `refund:${refundId}`,
        amount: REFUND_IDR,
      });
      await unsettled(refundId, sent, ["payment_id"]);
    });

    it("PAY-04 a keyed refund object with neither is not settled", async () => {
      const { refundId, providerRef } = await seedApprovedRefund();
      const sent = deliver(type, {
        object: "refund",
        id: providerRef,
        idempotency_key: `refund:${refundId}`,
      });
      await unsettled(refundId, sent, ["amount", "payment_id"]);
    });

    it("PAY-04 a keyed refund object with a valid amount and payment id settles", async () => {
      const { refundId, providerRef, paymentId } = await seedApprovedRefund();
      const sent = deliver(type, {
        object: "refund",
        id: providerRef,
        idempotency_key: `refund:${refundId}`,
        amount: REFUND_IDR,
        payment_id: paymentId,
        ...(type === "refund.failed" ? { failure_code: "declined" } : {}),
      });
      expect((await sent.response).body.status).toBe("processed");
      expect(await refundRow(refundId)).toMatchObject({
        status: type === "refund.succeeded" ? "completed" : "failed",
      });
      expect(await invalidAudits(sent.eventId)).toHaveLength(0);
    });
  });

  it("PAY-04 a refund object without an amount, for a refund settled by hand, is parked and audits the conflict", async () => {
    const { refundId, paymentId } = await seedSettledByHandRefund();
    const before = await refundRow(refundId);
    const sent = deliver("refund.succeeded", {
      object: "refund",
      id: `rf_${hex(6)}`,
      idempotency_key: `refund:${refundId}`,
      payment_id: paymentId,
    });
    const response = await sent.response;
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_FACTS_INVALID",
      }),
    ]);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });
});

describe("legend-2ol8g PAY-04 the parser marks present-but-invalid facts", () => {
  const flat = { refund_id: "rf_abc", amount: 4000, payment_id: PAYMENT };

  it("PAY-04 a valid flat event has no invalid marker", () => {
    expect(readDoitRefundFacts(flat).invalid).toBeUndefined();
  });

  it.each(["3999.0", null, -1, 1.5, true, {}])(
    "PAY-04 refund.amount %j is marked invalid amount",
    (amount) => {
      expect(
        readDoitRefundFacts({
          refund: { id: "rf_abc", amount },
          payment_id: PAYMENT,
        }),
      ).toEqual({
        refundId: "rf_abc",
        paymentId: PAYMENT,
        invalid: ["amount"],
      });
    },
  );

  it.each([null, "", 5, {}, "x".repeat(101)])(
    "PAY-04 payment_id %j is marked invalid payment_id",
    (payment_id) => {
      expect(readDoitRefundFacts({ ...flat, payment_id })).toEqual({
        refundId: "rf_abc",
        amountIdr: 4000,
        invalid: ["payment_id"],
      });
    },
  );

  it("PAY-04 both invalid gives a sorted list", () => {
    expect(
      readDoitRefundFacts({
        refund_id: "rf_abc",
        amount: "x",
        payment_id: null,
      }).invalid,
    ).toEqual(["amount", "payment_id"]);
  });

  it("PAY-04 the flat shape requires amount and payment_id", () => {
    expect(readDoitRefundFacts({ refund_id: "rf_abc" }).invalid).toEqual([
      "amount",
      "payment_id",
    ]);
  });

  it("PAY-04 a refund object or keyed event requires amount and payment_id", () => {
    const both = ["amount", "payment_id"];
    expect(readDoitRefundFacts({ refund: { id: "rf_abc" } }).invalid).toEqual(
      both,
    );
    expect(
      readDoitRefundFacts({
        refund_id: "rf_abc",
        idempotency_key: "refund:3875dc37-0d8e-4f4e-9a8e-5c2b1f6d7e90",
      }).invalid,
    ).toEqual(both);
    expect(
      readDoitRefundFacts({
        idempotency_key: "refund:3875dc37-0d8e-4f4e-9a8e-5c2b1f6d7e90",
      }).invalid,
    ).toEqual(both);
    expect(
      readDoitRefundFacts({ object: "refund", id: "rf_abc" }).invalid,
    ).toEqual(both);
  });

  it("PAY-04 a keyed or refund-object event with amount and a payment id is valid", () => {
    expect(
      readDoitRefundFacts({
        object: "refund",
        id: "rf_abc",
        amount: 4000,
        payment_id: PAYMENT,
      }).invalid,
    ).toBeUndefined();
    expect(
      readDoitRefundFacts({
        refund: { id: "rf_abc", amount: 4000, payment_id: PAYMENT },
      }).invalid,
    ).toBeUndefined();
    // A valid payment object's id also names the payment.
    expect(
      readDoitRefundFacts({
        object: "refund",
        id: "rf_abc",
        amount: 4000,
        payment: {
          id: PAYMENT,
          reference: "r",
          status: "refunded",
          amount: 10_000,
        },
      }).invalid,
    ).toBeUndefined();
  });

  it("PAY-04 a pure payment-object event (no key, no refund id) is unchanged", () => {
    expect(
      readDoitRefundFacts({
        id: PAYMENT,
        reference: "0b0f8f8e-6a3e-4c1e-9c55-2f1d1f0c1a01",
        status: "refunded",
        amount: 10_000,
      }).invalid,
    ).toBeUndefined();
  });

  it("PAY-04 a payment-shaped data never reads its payment_id as invalid", () => {
    expect(
      readDoitRefundFacts({
        id: PAYMENT,
        reference: "0b0f8f8e-6a3e-4c1e-9c55-2f1d1f0c1a01",
        status: "refunded",
        amount: 10_000,
        payment_id: null,
      }).invalid,
    ).toBeUndefined();
  });

  it("PAY-04 the stored event keeps invalid and re-parses to identical facts", () => {
    const raw = {
      id: "evt_1",
      type: "refund.succeeded",
      created_at: "2026-11-09T06:49:05.541Z",
      data: { refund_id: "rf_abc", amount: "3999.0", payment_id: null },
    };
    const stored = doitRefundWebhookEventSchema.parse(raw);
    expect(stored.data).toMatchObject({ invalid: ["amount", "payment_id"] });
    expect(readDoitRefundFacts(stored.data)).toEqual(
      readDoitRefundFacts(raw.data),
    );
    expect(doitRefundWebhookEventSchema.parse(stored)).toEqual(stored);
  });

  it("PAY-04 a stored data.invalid keeps only the two known values", () => {
    expect(
      readDoitRefundFacts({
        refund: { id: "rf_abc", amount: 1 },
        invalid: ["payment_id", "bogus", "amount", "amount"],
      }).invalid,
    ).toEqual(["amount", "payment_id"]);
  });
});

describe("legend-2ol8g PAY-04 an unreadable fact on a success for a refund finance settled by hand", () => {
  it('PAY-04 a keyed refund.succeeded with amount "4000.0" is ignored as REFUND_FACTS_INVALID and still audits the provider conflict', async () => {
    const { refundId } = await seedSettledByHandRefund();
    const before = await refundRow(refundId);
    expect(before).toMatchObject({
      status: "completed",
      provider_ref: null,
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
    });

    const sent = deliver("refund.succeeded", {
      object: "refund",
      id: `rf_${hex(6)}`,
      idempotency_key: `refund:${refundId}`,
      amount: "4000.0",
      status: "succeeded",
    });
    const response = await sent.response;

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ignored");
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_FACTS_INVALID",
      }),
    ]);
    expect(await invalidAudits(sent.eventId)).toHaveLength(1);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });

  it("PAY-04 a flat refund.succeeded with a valid payment_id and an invalid amount reaches the conflict after 15 minutes, still REFUND_FACTS_INVALID", async () => {
    const { refundId, paymentId } = await seedSettledByHandRefund();
    const before = await refundRow(refundId);

    const sent = deliver("refund.succeeded", {
      refund_id: `rf_${hex(6)}`,
      amount: "30000.0",
      payment_id: paymentId,
    });
    await sent.response;

    // Fresh: the refund id may still be storing, so DOIT keeps resending.
    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error_code: "REFUND_UNMATCHED",
      }),
    ]);
    expect(await conflictAudits(refundId)).toHaveLength(0);

    await backdate(sent.eventId, 16);
    await reprocess();

    expect(await eventRows(sent.eventId)).toEqual([
      expect.objectContaining({
        status: "ignored",
        last_error_code: "REFUND_FACTS_INVALID",
      }),
    ]);
    expect(await invalidAudits(sent.eventId)).toHaveLength(1);
    expect((await conflictAudits(refundId)).length).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toEqual(before);
  });
});
