// legend 903 (SO-896 second opinion, P1-2): a provider answer "paid" with no
// positive amount is NOT proof of anything. It must never make a code final
// (`payment_intents.provider_final_at`), never write evidence / parked funds /
// a payment event, and never take the code or its webhook event out of the
// retry path. When the provider later answers "paid" with a positive amount
// (no new webhook), the poll / the retry worker records or parks the money
// exactly once and only then the code becomes final.
//
// Written from docs/briefs/903-so896-p1-fix.md (P1-2), the patterns of
// qris-hold-so896-p2-parking.test.ts, qris-hold-so896-poll-failed.test.ts and
// payment-duitku-webhook.test.ts. Not from the implementation.
//
// Assumptions:
// - "Final" = `payment_intents.provider_final_at IS NOT NULL`.
// - The webhook intake answers 200 for a verified callback whose status read
//   is paid with amount 0 (like every other verified-but-unsettled callback).
// - "Event still retryable" = its row is not `processed` and stays in
//   `received` / `failed` (the states the retry worker picks up), and the retry
//   worker asks Duitku again on the next run. Both are asserted.
// - "Recovered" uses: the full bill (a late payment settles the open bill once:
//   one evidence row, one payment.paid event, no parked funds) in the Duitku
//   webhook group; Rp 10.000 (an underpayment, parked once: one evidence row,
//   one parked fund row, no payment.paid event) wherever the test checks
//   "parked exactly once", so parking is deterministic.
// - A code of the hold group counts as live (replacement refused with 409)
//   until final or until its money is parked (then FUNDS_UNRESOLVED).
// - The Duitku group seeds its integration on the hold fixture's own tenant, so
//   it cannot collide with payment-duitku-webhook.test.ts in a parallel run.
// - The "local expired" test of the hold group is a guard on the same rule for
//   the other caller of the reconcile mark; it may already pass.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so896-p1-zero-paid.test.ts" heavy pnpm test
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes.ts";
import { createDuitkuGateway } from "../services/payment-duitku.ts";
import { reprocessDuitkuWebhookEvents } from "../services/payment-duitku-webhook.service.ts";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  setPaymentGateway,
} from "../services/payment-gateway.ts";
import {
  applyGatewayFailure,
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import { runPaymentGatewayPollJob } from "../worker/payment-gateway-poll.job.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import { evidenceRows, outboxCountOf } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const HOUR_MS = 3_600_000;
const MARGIN_MS = 60_000;
const BILL_IDR = 144_375;
const UNDERPAID_IDR = 10_000;

afterAll(async () => {
  await owner.end();
});

// ===========================================================================
// Group 1: Duitku webhook + retry worker + poll job (expired code, callback)
// ===========================================================================

describe("so-896 P1-2 duitku: a paid answer with amount 0 is not final and stays retryable", () => {
  const MERCHANT = "DS9031";
  const apiKey = `duitku-key-p1zero-${randomBytes(12).toString("hex")}`;
  let fx: HoldFixture;
  let integrationId = "";
  let originalProviders: unknown;
  const realFetch = globalThis.fetch;

  type StatusAnswer = {
    statusCode: "00" | "01" | "02";
    reference: string | null;
    amount: string;
  };
  const statusAnswers = new Map<string, StatusAnswer>();
  const statusAsks: string[] = [];

  const contextFor = (source: "session" | "webhook"): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        brandId: null,
        source,
      }),
      { kind: "tenant" },
    );

  function stubDuitku() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.endsWith("/transactionStatus"))
          return realFetch(input as string, init);
        const body = JSON.parse(String(init?.body)) as {
          merchantOrderId: string;
        };
        statusAsks.push(body.merchantOrderId);
        const answer = statusAnswers.get(body.merchantOrderId);
        if (!answer) return new Response("nope", { status: 404 });
        return new Response(
          JSON.stringify({ merchantOrderId: body.merchantOrderId, ...answer }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
  }

  beforeAll(async () => {
    fx = await holdFixture("qris-hold-so896-p1-zero-paid-duitku");
    // The scripted port of the fixture would answer for every provider.
    setPaymentGateway(null);
    const flags = await owner.query<{ providers: unknown }>(
      "SELECT feature_flags->'integrationProviders' AS providers FROM tenants WHERE id = $1",
      [fx.tenant.tenantId],
    );
    originalProviders = flags.rows[0]?.providers ?? [];
    await owner.query(
      `UPDATE tenants
          SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
                coalesce(feature_flags->'integrationProviders', '[]'::jsonb) || '"duitku"'::jsonb)
        WHERE id = $1
          AND NOT coalesce(feature_flags->'integrationProviders', '[]'::jsonb) ? 'duitku'`,
      [fx.tenant.tenantId],
    );
    const created = await upsertIntegration(
      fx.context,
      {
        outletId: null,
        provider: "duitku",
        config: {
          environment: "sandbox",
          notificationEmail: "owner@example.test",
        },
        credentials: { merchantCode: MERCHANT, apiKey },
      },
      fx.staff.userId,
    );
    await setIntegrationStatus(
      fx.context,
      created.id,
      { status: "active" },
      fx.staff.userId,
    );
    integrationId = created.id;
  });

  afterAll(async () => {
    resetPaymentGateways();
    await owner.query(
      "UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1",
      [fx.tenant.tenantId, JSON.stringify(originalProviders)],
    );
    resetHoldPorts();
  });

  beforeEach(() => {
    resetPaymentWebhookRateLimits();
    statusAnswers.clear();
    statusAsks.length = 0;
    stubDuitku();
    registerPaymentGateway(
      createDuitkuGateway({
        fetch: globalThis.fetch,
        callbackBaseUrl: "https://api.example.test",
        returnUrl: "https://app.example.test/paid",
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentGateways();
  });

  type Bill = { linkId: string; intentId: string; reference: string };

  /** An expired Duitku code (lapsed more than the 60 s margin ago, closed
   * before it lapsed so the poll reconsiders it), as the adapter leaves it. */
  async function openExpiredCode(): Promise<Bill> {
    const opened = await createPaymentLink(
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
          brandId: null,
          source: "session",
        }),
        { kind: "outlets", outletIds: [fx.tenant.outletId as OutletId] },
      ),
      {
        outletId: fx.tenant.outletId,
        reference: `R-${randomBytes(4).toString("hex")}`,
        tableLabel: "A03",
        pax: 3,
        subtotalIdr: 125_000,
        discountIdr: 0,
        serviceChargeIdr: 6_250,
        taxIdr: 13_125,
        roundingIdr: 0,
        totalIdr: BILL_IDR,
        returnPath: "/t/v1.abc",
      },
      fx.staff.userId,
    );
    const intentId = randomUUID();
    const reference = `DSREF${randomBytes(4).toString("hex")}`;
    const expiresAt = new Date(Date.now() - 10 * 60_000);
    const created = new Date(Date.now() - 30 * 60_000);
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, provider_ref, gateway_integration_id, status,
          instructions, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'qris', 'duitku', $5, $6, $7, $8, 'expired',
               $9::jsonb, $10, $11, $12)`,
      [
        intentId,
        fx.tenant.tenantId,
        fx.tenant.outletId,
        opened.linkId,
        BILL_IDR,
        `k-${randomBytes(4).toString("hex")}`,
        reference,
        integrationId,
        JSON.stringify({
          method: "qris",
          qrString: "00020101021226DUITKU",
          expiresAt: expiresAt.toISOString(),
        }),
        expiresAt,
        created,
        new Date(expiresAt.getTime() - 60_000),
      ],
    );
    return { linkId: opened.linkId, intentId, reference };
  }

  const answer = (bill: Bill, amount: number) =>
    statusAnswers.set(bill.intentId, {
      statusCode: "00",
      reference: bill.reference,
      amount: String(amount),
    });

  function callback(bill: Bill) {
    const amount = String(BILL_IDR);
    const signature = createHmac("sha256", apiKey)
      .update(`${MERCHANT}${amount}${bill.intentId}`)
      .digest("hex");
    const form = new URLSearchParams({
      merchantCode: MERCHANT,
      amount,
      merchantOrderId: bill.intentId,
      resultCode: "00",
      signature,
      reference: bill.reference,
    });
    return request(fx.app)
      .post(`/api/webhooks/payments/duitku/${fx.tenant.tenantId}`)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(form.toString());
  }

  const retryWorker = (hoursFromNow: number) =>
    reprocessDuitkuWebhookEvents(
      contextFor("webhook"),
      new Date(Date.now() + hoursFromNow * HOUR_MS),
    );
  const pollJob = (hoursFromNow: number) =>
    runPaymentGatewayPollJob(
      contextFor("webhook"),
      new Date(Date.now() + hoursFromNow * HOUR_MS),
      {
        force: true,
      },
    );

  const count = async (table: string, intentId: string) => {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!.n;
  };
  const finalAt = async (intentId: string) => {
    const { rows } = await owner.query<{
      provider_final_at: Date | null;
      status: string;
    }>(
      "SELECT provider_final_at, status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!;
  };
  const linkPaid = async (linkId: string) => {
    const { rows } = await owner.query<{ paid: string }>(
      "SELECT paid_idr::text AS paid FROM payment_links WHERE id = $1",
      [linkId],
    );
    return Number(rows[0]!.paid);
  };
  const events = async (intentId: string) => {
    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM gateway_webhook_events
        WHERE tenant_id=$1 AND provider='duitku' AND payment_intent_id=$2 ORDER BY created_at`,
      [fx.tenant.tenantId, intentId],
    );
    return rows;
  };
  const paymentPaidEvents = (intentId: string) =>
    outboxCountOf(fx, "payment.paid", intentId);

  /** Nothing recorded, nothing final, bill untouched. */
  async function expectNothingRecorded(bill: Bill, why: string) {
    const row = await finalAt(bill.intentId);
    expect(row.provider_final_at, `${why}: no final mark`).toBeNull();
    expect(row.status, `${why}: not paid`).not.toBe("paid");
    expect(
      await count("payment_evidence", bill.intentId),
      `${why}: evidence`,
    ).toBe(0);
    expect(
      await count("payment_unallocated_funds", bill.intentId),
      `${why}: parked funds`,
    ).toBe(0);
    expect(await paymentPaidEvents(bill.intentId), `${why}: payment.paid`).toBe(
      0,
    );
    expect(await linkPaid(bill.linkId), `${why}: bill paid`).toBe(0);
  }

  async function expectEventRetryable(bill: Bill, why: string) {
    const rows = await events(bill.intentId);
    expect(rows, `${why}: one stored event`).toHaveLength(1);
    expect(
      ["received", "failed"],
      `${why}: event state ${rows[0]!.status}`,
    ).toContain(rows[0]!.status);
  }

  it("1: expired code + signed callback + status read paid 0 -> not final, nothing recorded, event retryable; the later full payment is recorded exactly once without a new webhook", async () => {
    const bill = await openExpiredCode();
    answer(bill, 0);

    const delivered = await callback(bill);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    await expectNothingRecorded(bill, "after the callback");
    await expectEventRetryable(bill, "after the callback");

    // The retry worker keeps asking while the provider says 0.
    for (const hours of [1, 2]) {
      const asks = statusAsks.length;
      await retryWorker(hours);
      expect(
        statusAsks.length,
        `retry ${hours}h asks Duitku again`,
      ).toBeGreaterThan(asks);
      await expectNothingRecorded(bill, `retry ${hours}h`);
      await expectEventRetryable(bill, `retry ${hours}h`);
    }

    // The status recovers to the full bill. No new webhook is sent.
    answer(bill, BILL_IDR);
    await retryWorker(3);
    await retryWorker(4);
    await pollJob(5);
    await retryWorker(6);

    const row = await finalAt(bill.intentId);
    expect(row.status).toBe("paid");
    expect(
      await count("payment_evidence", bill.intentId),
      "one evidence row",
    ).toBe(1);
    expect(await paymentPaidEvents(bill.intentId), "one payment.paid").toBe(1);
    expect(
      await count("payment_unallocated_funds", bill.intentId),
      "nothing parked",
    ).toBe(0);
    expect(await linkPaid(bill.linkId)).toBe(BILL_IDR);
    expect((await events(bill.intentId)).map((e) => e.status)).toEqual([
      "processed",
    ]);
  });

  it("2: the poll keeps picking the code while the provider says paid 0 (not final), then parks an underpayment exactly once and marks it final", async () => {
    const bill = await openExpiredCode();
    answer(bill, 0);
    expect((await callback(bill)).status).toBe(200);
    await expectNothingRecorded(bill, "after the callback");

    for (const hours of [1, 3]) {
      const asks = statusAsks.length;
      await pollJob(hours);
      expect(
        statusAsks.length,
        `poll ${hours}h reads the code again`,
      ).toBeGreaterThan(asks);
      await expectNothingRecorded(bill, `poll ${hours}h`);
    }
    await expectEventRetryable(bill, "after the polls");

    answer(bill, UNDERPAID_IDR);
    await pollJob(5);
    await pollJob(7);
    await retryWorker(9);
    expect((await callback(bill)).status).toBe(200);

    expect(
      await count("payment_evidence", bill.intentId),
      "one evidence row",
    ).toBe(1);
    expect(
      await count("payment_unallocated_funds", bill.intentId),
      "one parked fund",
    ).toBe(1);
    expect(
      await paymentPaidEvents(bill.intentId),
      "an underpayment is no payment.paid",
    ).toBe(0);
    expect(await linkPaid(bill.linkId)).toBe(0);
    expect(
      (await finalAt(bill.intentId)).provider_final_at,
      "parked money is final",
    ).not.toBeNull();
  });

  it("3 (regression): a positive underpayment parked from a verified callback marks the code final, once", async () => {
    const bill = await openExpiredCode();
    answer(bill, UNDERPAID_IDR);

    expect((await callback(bill)).status).toBe(200);
    expect((await callback(bill)).status).toBe(200);
    await retryWorker(1);

    expect(await count("payment_evidence", bill.intentId)).toBe(1);
    expect(await count("payment_unallocated_funds", bill.intentId)).toBe(1);
    expect(await linkPaid(bill.linkId)).toBe(0);
    expect((await finalAt(bill.intentId)).provider_final_at).not.toBeNull();
  });
});

// ===========================================================================
// Group 2: poll path for failed / expired codes (scripted provider)
// ===========================================================================

describe.each([
  { provider: "doit", raw: undefined as string | undefined },
  { provider: "duitku", raw: "02" as string | undefined },
])("so-896 P1-2 $provider poll: paid 0 never finalises a code", (cfg) => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture(`qris-hold-so896-p1-zero-paid-${cfg.provider}`, {
      provider: cfg.provider,
    });
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  });
  afterAll(() => {
    resetHoldPorts();
  });

  type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

  async function openVa() {
    const guest: Guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const res = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { guest, order, intentId: res.body.data.id as string };
  }

  const replace = (guest: Guest, orderId: string) =>
    fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });

  async function intentRow(intentId: string) {
    const { rows } = await owner.query<{
      status: string;
      provider_final_at: Date | null;
    }>(
      "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!;
  }

  async function pastMargin(intentId: string) {
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 millisecond'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId, MARGIN_MS + 1_000],
    );
  }

  // Each run is later than the last: past the poll's grace and its back-off.
  let pollClock = Date.now();
  function poll() {
    pollClock += 2 * HOUR_MS;
    return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
  }

  async function expectNothingRecorded(intentId: string, why: string) {
    expect(
      (await intentRow(intentId)).provider_final_at,
      `${why}: no final mark`,
    ).toBeNull();
    expect(await evidenceRows(fx, intentId), `${why}: evidence`).toEqual([]);
    expect(
      await unallocatedFunds(fx, intentId),
      `${why}: parked funds`,
    ).toEqual([]);
    expect(
      await outboxCountOf(fx, "payment.paid", intentId),
      `${why}: payment.paid`,
    ).toBe(0);
  }

  async function zeroPaidPolls(intentId: string, times: number) {
    fx.gateway.script(intentId, { status: "paid", amountIdr: 0 });
    for (let i = 1; i <= times; i += 1) {
      const reads = fx.gateway.readsOf(intentId).length;
      await poll();
      expect(
        fx.gateway.readsOf(intentId).length,
        `poll ${i} reads the code`,
      ).toBeGreaterThan(reads);
      await expectNothingRecorded(intentId, `poll ${i} with paid 0`);
    }
  }

  async function expectParkedOnce(intentId: string) {
    // The money is later seen at its real amount; repeated polls add nothing.
    fx.gateway.script(intentId, { status: "paid", amountIdr: UNDERPAID_IDR });
    await poll();
    await poll();
    await poll();
    expect(
      (await evidenceRows(fx, intentId)).map((e) => e.amount),
      "one evidence row",
    ).toEqual([UNDERPAID_IDR]);
    expect(
      (await unallocatedFunds(fx, intentId)).map((f) => [
        f.amountIdr,
        f.resolution,
      ]),
      "one parked fund",
    ).toEqual([[UNDERPAID_IDR, null]]);
    expect(await outboxCountOf(fx, "payment.paid", intentId)).toBe(0);
    expect(
      (await intentRow(intentId)).provider_final_at,
      "parked money is final",
    ).not.toBeNull();
  }

  it("4: a failed non-final code answered paid 0 stays non-final and live; the later positive payment is parked exactly once", async () => {
    const a = await openVa();
    await applyGatewayFailure(
      fx.context,
      a.intentId,
      "failed",
      new Date(),
      cfg.raw,
    );
    const early = await intentRow(a.intentId);
    expect(early.status).toBe("failed");
    expect(early.provider_final_at, "an early failed is not final").toBeNull();
    await pastMargin(a.intentId);

    await zeroPaidPolls(a.intentId, 2);
    const row = await intentRow(a.intentId);
    expect(row.status).toBe("failed");
    // Still collectible: the guest is not given a second code yet.
    expect((await replace(a.guest, a.order.id)).status).toBe(409);

    await expectParkedOnce(a.intentId);
    const refused = await replace(a.guest, a.order.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("FUNDS_UNRESOLVED");
  });

  it("5 (guard): a locally expired code answered paid 0 stays non-final too; the later positive payment is parked exactly once", async () => {
    const a = await openVa();
    await owner.query(
      "UPDATE payment_intents SET status='expired', updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, a.intentId],
    );
    await pastMargin(a.intentId);

    await zeroPaidPolls(a.intentId, 2);
    expect((await replace(a.guest, a.order.id)).status).toBe(409);

    await expectParkedOnce(a.intentId);
  });
});

// ===========================================================================
// Group 3: poll path for a STILL PENDING code past its local expiresAt
// ===========================================================================
//
// Assumptions (group 3):
// - The intent is a plain VA code (no QRIS hold): a plain poll, not the hold
//   check. It keeps `status = 'pending'`; only `expires_at` is moved to
//   61 s in the past (the poll still reconsiders it).
// - A provider answer "paid" with amount 0 is not proof: the intent stays
//   `pending` (not failed / expired), `provider_final_at` stays NULL, no
//   evidence / parked fund / `payment.paid` / `payment.amount_mismatch_held`
//   audit row is written, and every poll run still reads the code.
// - Duitku answers with its raw code "00" (paid) and amount 0; DOIT with the
//   mapped status only.
// - "Settled" for a full-amount answer = intent `paid`, one evidence row of the
//   bill amount, one `payment.paid`, nothing parked. "Parked" for the Rp 10.000
//   underpayment = one evidence row, one unresolved parked fund, no
//   `payment.paid`, the code final. The mismatch audit row is written at most
//   once for it (the spec fixes "zero before", not "after").
describe.each([{ provider: "doit" }, { provider: "duitku" }])(
  "so-896 P1-2 $provider poll: a pending code past expiresAt answered paid 0",
  (cfg) => {
    let fx: HoldFixture;
    beforeAll(async () => {
      fx = await holdFixture(
        `qris-hold-so896-p1-zero-pending-${cfg.provider}`,
        {
          provider: cfg.provider,
        },
      );
      enableVaBank(fx.gateway);
      setPaymentGateway(fx.gateway);
    });
    afterAll(() => {
      resetHoldPorts();
    });

    type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

    const paidAnswer = (amountIdr?: number): ProviderAnswer =>
      cfg.provider === "duitku"
        ? {
            rawStatus: "00",
            ...(amountIdr === undefined ? {} : { amountIdr }),
          }
        : {
            status: "paid",
            ...(amountIdr === undefined ? {} : { amountIdr }),
          };

    async function openPendingPastExpiry() {
      const guest: Guest = await fx.newGuest();
      const order = await fx.qrOrder(guest);
      const res = await fx.guestPost(guest, "/payments", {
        target: { kind: "order", orderId: order.id },
        method: "va",
        bankCode: "bmri",
        idempotencyKey: randomUUID(),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const intentId = res.body.data.id as string;
      await owner.query(
        `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 millisecond'
        WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, intentId, MARGIN_MS + 1_000],
      );
      const row = await intentRow(intentId);
      expect(row.status, "starts pending").toBe("pending");
      expect(row.provider_final_at).toBeNull();
      return { guest, order, intentId };
    }

    async function intentRow(intentId: string) {
      const { rows } = await owner.query<{
        status: string;
        provider_final_at: Date | null;
      }>(
        "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
        [fx.tenant.tenantId, intentId],
      );
      return rows[0]!;
    }

    async function heldAudit(intentId: string) {
      const { rows } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'payment.amount_mismatch_held'
          AND event::text LIKE $2`,
        [fx.tenant.tenantId, `%${intentId}%`],
      );
      return rows[0]!.n;
    }

    let pollClock = Date.now();
    function poll() {
      pollClock += 2 * HOUR_MS;
      return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
    }

    async function expectNothingRecorded(intentId: string, why: string) {
      const row = await intentRow(intentId);
      expect(row.provider_final_at, `${why}: no final mark`).toBeNull();
      expect(row.status, `${why}: status unchanged`).toBe("pending");
      expect(await evidenceRows(fx, intentId), `${why}: evidence`).toEqual([]);
      expect(
        await unallocatedFunds(fx, intentId),
        `${why}: parked funds`,
      ).toEqual([]);
      expect(
        await outboxCountOf(fx, "payment.paid", intentId),
        `${why}: payment.paid`,
      ).toBe(0);
      expect(await heldAudit(intentId), `${why}: mismatch audit`).toBe(0);
    }

    async function zeroPaidPolls(intentId: string, times: number) {
      fx.gateway.script(intentId, paidAnswer(0));
      for (let i = 1; i <= times; i += 1) {
        const reads = fx.gateway.readsOf(intentId).length;
        await poll();
        expect(
          fx.gateway.readsOf(intentId).length,
          `poll ${i} still selects and reads the code`,
        ).toBeGreaterThan(reads);
        await expectNothingRecorded(intentId, `poll ${i} with paid 0`);
      }
    }

    it("6: paid 0 on a pending code past expiresAt changes nothing and is read again every poll; the later full payment settles the bill exactly once", async () => {
      const a = await openPendingPastExpiry();
      await zeroPaidPolls(a.intentId, 3);

      // The provider now reports the full bill. Repeated polls add nothing.
      fx.gateway.script(a.intentId, paidAnswer());
      await poll();
      await poll();
      await poll();

      expect((await intentRow(a.intentId)).status).toBe("paid");
      expect(
        (await evidenceRows(fx, a.intentId)).map((e) => e.amount),
        "one evidence row of the bill amount",
      ).toEqual([fx.gateway.amountOf(a.intentId)]);
      expect(await unallocatedFunds(fx, a.intentId), "nothing parked").toEqual(
        [],
      );
      expect(
        await outboxCountOf(fx, "payment.paid", a.intentId),
        "one payment.paid",
      ).toBe(1);
    });

    it("7: paid 0 on a pending code past expiresAt changes nothing; the later underpayment is parked exactly once and the code becomes final", async () => {
      const a = await openPendingPastExpiry();
      await zeroPaidPolls(a.intentId, 2);

      fx.gateway.script(a.intentId, paidAnswer(UNDERPAID_IDR));
      await poll();
      await poll();
      await poll();

      expect(
        (await evidenceRows(fx, a.intentId)).map((e) => e.amount),
        "one evidence row",
      ).toEqual([UNDERPAID_IDR]);
      expect(
        (await unallocatedFunds(fx, a.intentId)).map((f) => [
          f.amountIdr,
          f.resolution,
        ]),
        "one parked fund",
      ).toEqual([[UNDERPAID_IDR, null]]);
      expect(
        await outboxCountOf(fx, "payment.paid", a.intentId),
        "an underpayment is no payment.paid",
      ).toBe(0);
      expect(
        (await intentRow(a.intentId)).provider_final_at,
        "parked money is final",
      ).not.toBeNull();
      expect(await heldAudit(a.intentId)).toBeLessThanOrEqual(1);
    });
  },
);
