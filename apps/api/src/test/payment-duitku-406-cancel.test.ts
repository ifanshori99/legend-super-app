// Duitku sub-brief 406, Codex rerun findings F2 and F3 (legend-s0u8c).
// Fail-first: these tests describe the fixed behaviour and fail on the code
// as of 008cbd93 / 1b301b15.
//
// F2  A POS cancellation can leave the bill's intent `pending` (past its
//     expiry) while the tender is closed. The poller / webhook must still
//     treat the bill as closed: park the money, never settle the bill.
// F3  A reservation cancellation that has not committed yet must be seen by
//     a late settlement (same lock protocol): settlement waits for the
//     cancel, then parks the money. Two real DB transactions, no mocks of
//     the lock: the cancel's UPDATE is held open while the settlement runs.
//
// Assumptions (spec ambiguity, see report):
// - "Parked" means link.paid_idr = 0, one payment_unallocated_funds row for the
//   full amount, intent not `paid`, and for the webhook path the stored event
//   has last_error_code REJECTED_BILL_CLOSED (as for the other closed bills).
// - A settlement that meets a competing uncommitted cancel waits for it and
//   answers 200; it does not fail with a retryable error.
// - A closed POS tender is `failed` or `voided`, and the cancelled link is
//   expired (expires_at in the past), as the POS cancel leaves it.
// Helpers mirror payment-duitku-webhook.test.ts (they are file-local there).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { runPaymentGatewayPollJob } from "../worker/payment-gateway-poll.job";
import {
  registerPaymentGateway,
  resetPaymentGateways,
} from "../services/payment-gateway";
import { createDuitkuGateway } from "../services/payment-duitku";
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
// Integration upserts are keyed by tenant/provider: each file must own its
// tenant so concurrent Duitku suites cannot rotate or delete one another's key.
let isolatedTenant: SecondTenant;
let tenantA: TenantId;
let outletA: OutletId;
const actor = randomUUID();
const BILL_TOTAL = 144_375;
const MERCHANT = "DS4060";
const apiKey = `duitku-key-${randomBytes(12).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
let integrationId = "";

const unique = () => randomBytes(4).toString("hex");

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
    { kind: "tenant" },
  );
}

// ---------------------------------------------------------------------------
// Fake Duitku transactionStatus
// ---------------------------------------------------------------------------

type StatusAnswer = {
  statusCode: "00" | "01" | "02";
  reference: string | null;
  amount: string;
};
const statusAnswers = new Map<string, StatusAnswer>();
const realFetch = globalThis.fetch;

function setAnswer(orderId: string, answer: StatusAnswer) {
  statusAnswers.set(`${MERCHANT}|${orderId}`, answer);
}

function stubDuitku() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/transactionStatus"))
        return realFetch(input as string, init);
      const body = JSON.parse(String(init?.body)) as {
        merchantCode: string;
        merchantOrderId: string;
      };
      const answer = statusAnswers.get(
        `${body.merchantCode}|${body.merchantOrderId}`,
      );
      if (!answer) return new Response("nope", { status: 404 });
      return new Response(
        JSON.stringify({ merchantOrderId: body.merchantOrderId, ...answer }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

function registerDuitku() {
  registerPaymentGateway(
    createDuitkuGateway({
      fetch: globalThis.fetch,
      callbackBaseUrl: "https://api.example.test",
      returnUrl: "https://app.example.test/paid",
    }),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  isolatedTenant = await createSecondTenant(owner, "payment-duitku-406-cancel");
  tenantA = tenantIdSchema.parse(isolatedTenant.tenantId);
  outletA = outletIdSchema.parse(isolatedTenant.outletId);
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
              (feature_flags->'integrationProviders') || '"duitku"'::jsonb)
      WHERE id = $1
        AND NOT (feature_flags->'integrationProviders') ? 'duitku'`,
    [tenantA],
  );
  const created = await upsertIntegration(
    contextFor("session"),
    {
      outletId: null,
      provider: "duitku",
      config: {
        environment: "sandbox",
        notificationEmail: "owner@example.test",
      },
      credentials: { merchantCode: MERCHANT, apiKey },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor("session"),
    created.id,
    { status: "active" },
    actor,
  );
  integrationIds.push(created.id);
  integrationId = created.id;
});

afterAll(async () => {
  resetPaymentGateways();
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id IN (SELECT id FROM payment_intents WHERE payment_link_id = ANY($2::uuid[]))",
    [tenantA, createdLinkIds],
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
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM reservations WHERE tenant_id = $1 AND deposit_payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await client.query(
        "DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
        [tenantA, createdLinkIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantA, createdLinkIds],
    );
  }
  await owner.query(
    "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
    [integrationIds],
  );
  // Owner-only teardown: audit_logs is append-only and references our
  // outlet. Bypass its delete trigger only while removing this file's tenant;
  // fixture creation and every payment operation keep integrity checks active.
  const cleanup = await owner.connect();
  try {
    await cleanup.query("BEGIN");
    await cleanup.query("SET LOCAL session_replication_role = replica");
    await cleanup.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
      tenantA,
    ]);
    await cleanup.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1",
      [tenantA],
    );
    await cleanup.query("COMMIT");
  } catch (error) {
    await cleanup.query("ROLLBACK");
    throw error;
  } finally {
    cleanup.release();
  }
  await removeSecondTenant(owner, isolatedTenant);
  await owner.end();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  statusAnswers.clear();
  stubDuitku();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPaymentGateways();
});

type Bill = { linkId: string; intentId: string; reference: string };

/** A Duitku QRIS intent whose code lapsed 5 minutes ago. `updatedAt` precedes
 * `expiresAt` so the poller picks it up (as in the existing poller tests). */
async function openIntent(
  options: { status?: "pending" | "expired" | "failed" } = {},
): Promise<Bill> {
  const opened = await createPaymentLink(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletA] },
    ),
    {
      outletId: outletA,
      reference: `R-${unique()}`,
      tableLabel: "A03",
      pax: 3,
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
  const intentId = randomUUID();
  const reference = `DSREF${unique()}`;
  const expiresAt = new Date(Date.now() - 5 * 60_000);
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, provider_ref, gateway_integration_id, status,
        instructions, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'qris', 'duitku', $5, $6, $7, $8, $9,
             $10::jsonb, $11, $12, $13)`,
    [
      intentId,
      tenantA,
      outletA,
      opened.linkId,
      BILL_TOTAL,
      `k-${unique()}`,
      reference,
      integrationId,
      options.status ?? "pending",
      JSON.stringify({
        method: "qris",
        qrString: "00020101021226DUITKU",
        expiresAt: expiresAt.toISOString(),
      }),
      expiresAt,
      new Date(Date.now() - 20 * 60_000),
      new Date(expiresAt.getTime() - 60_000),
    ],
  );
  return { linkId: opened.linkId, intentId, reference };
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

function callback(orderId: string, reference: string) {
  const amount = String(BILL_TOTAL);
  const form = new URLSearchParams({
    merchantCode: MERCHANT,
    amount,
    merchantOrderId: orderId,
    resultCode: "00",
    signature: hmac(`${MERCHANT}${amount}${orderId}`, apiKey),
    reference,
  });
  return request(app)
    .post(`/api/webhooks/payments/duitku/${tenantA}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(form.toString());
}

const paid = (reference: string): StatusAnswer => ({
  statusCode: "00",
  reference,
  amount: String(BILL_TOTAL),
});

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.status;
}

async function linkPaidIdr(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ paid_idr: string }>(
    "SELECT paid_idr::text AS paid_idr FROM payment_links WHERE id = $1",
    [linkId],
  );
  return Number(rows[0]?.paid_idr);
}

async function unallocatedIdr(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

async function unallocatedCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]?.n);
}

async function errorCodes(intentId: string): Promise<(string | null)[]> {
  const { rows } = await owner.query<{ last_error_code: string | null }>(
    `SELECT last_error_code FROM gateway_webhook_events
      WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2
      ORDER BY created_at`,
    [tenantA, intentId],
  );
  return rows.map((row) => row.last_error_code);
}

/** Money parked, bill untouched. */
async function expectParked(bill: Bill) {
  expect(await intentStatus(bill.intentId)).not.toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  expect(await unallocatedIdr(bill.intentId)).toBe(BILL_TOTAL);
  expect(await unallocatedCount(bill.intentId)).toBe(1);
}

/** Inserts a row whose parents this suite does not build (reservation,
 * POS order): foreign keys and triggers are skipped for that one statement. */
async function insertWithoutParents(sqlText: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(sqlText, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A POS gateway tender on the bill's link, closed, with the link expired as
 * the POS cancellation leaves it. The intent is NOT touched: it stays as
 * given (F2: `pending`). */
async function seedClosedPosTender(
  bill: Bill,
  status: "failed" | "voided",
): Promise<void> {
  await insertWithoutParents(
    `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
        payment_link_token_sealed, payment_intent_id, amount_idr, status,
        requested_at, resolved_at)
     VALUES ($1, $2, $3, 'qris', 'duitku', $4, 'sealed-test', $5, $6,
             $7, now(), now())`,
    [
      tenantA,
      outletA,
      randomUUID(),
      bill.linkId,
      bill.intentId,
      BILL_TOTAL,
      status,
    ],
  );
  await owner.query(
    "UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1",
    [bill.linkId],
  );
}

async function seedOpenReservation(linkId: string): Promise<string> {
  const id = randomUUID();
  await insertWithoutParents(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes,
        pax, deposit_idr, policy_snapshot, status, source, deposit_payment_link_id)
     VALUES ($1, $2, $3, 'Tamu Uji', now() + interval '1 day', 90, 2, $4,
             '{}'::jsonb, 'pending_deposit', 'staff', $5)`,
    [id, tenantA, outletA, BILL_TOTAL, linkId],
  );
  return id;
}

async function reservationStatus(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM reservations WHERE id = $1",
    [id],
  );
  return rows[0]!.status;
}

// ---------------------------------------------------------------------------
// F2
// ---------------------------------------------------------------------------

describe("F2 a POS cancel that leaves a pending intent does not let a late payment settle the closed bill", () => {
  it("baseline: a lapsed pending intent on an open bill is settled by the poller", async () => {
    // Guards the setup: the failing tests below must be about the closed bill,
    // not about the poller skipping this intent.
    const bill = await openIntent({ status: "pending" });
    setAnswer(bill.intentId, paid(bill.reference));
    registerDuitku();

    await runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
      force: true,
    });

    expect(await intentStatus(bill.intentId)).toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it("baseline: the webhook settles a lapsed pending intent on an open bill", async () => {
    const bill = await openIntent({ status: "pending" });
    setAnswer(bill.intentId, paid(bill.reference));

    const response = await callback(bill.intentId, bill.reference);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await intentStatus(bill.intentId)).toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
  });

  it.each(["failed", "voided"] as const)(
    "the poller parks the money of a pending intent whose POS tender is %s",
    async (tenderStatus) => {
      const bill = await openIntent({ status: "pending" });
      await seedClosedPosTender(bill, tenderStatus);
      setAnswer(bill.intentId, paid(bill.reference));
      registerDuitku();

      await runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
        force: true,
      });

      await expectParked(bill);
    },
  );

  it.each(["failed", "voided"] as const)(
    "the webhook parks the money of a pending intent whose POS tender is %s",
    async (tenderStatus) => {
      const bill = await openIntent({ status: "pending" });
      await seedClosedPosTender(bill, tenderStatus);
      setAnswer(bill.intentId, paid(bill.reference));

      const response = await callback(bill.intentId, bill.reference);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      await expectParked(bill);
      expect(await errorCodes(bill.intentId)).toEqual(["REJECTED_BILL_CLOSED"]);
    },
  );

  it("the poller, then a repeated webhook, park the money once", async () => {
    const bill = await openIntent({ status: "pending" });
    await seedClosedPosTender(bill, "voided");
    setAnswer(bill.intentId, paid(bill.reference));
    registerDuitku();

    await runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
      force: true,
    });
    expect((await callback(bill.intentId, bill.reference)).status).toBe(200);

    await expectParked(bill);
  });
});

// ---------------------------------------------------------------------------
// F3
// ---------------------------------------------------------------------------

/** Holds a reservation cancellation open (UPDATE done, COMMIT not yet), runs
 * `settle` concurrently, waits until it is blocked on the cancel's row lock
 * (or finished: a settlement that does not wait is the bug), then commits. */
async function settleWhileCancelIsUncommitted<T>(
  reservationId: string,
  settle: () => Promise<T>,
): Promise<{ result: T; settledBeforeCommit: boolean }> {
  const cancel = await owner.connect();
  let committed = false;
  try {
    await cancel.query("BEGIN");
    await cancel.query(
      `UPDATE reservations
          SET status = 'cancelled', closed_at = now(), close_reason = 'x',
              refund_status = 'not_required'
        WHERE id = $1 AND status = 'pending_deposit'`,
      [reservationId],
    );
    const xid = (
      await cancel.query<{ xid: string }>(
        "SELECT pg_current_xact_id()::xid::text AS xid",
      )
    ).rows[0]!.xid;

    let done = false;
    const running = Promise.resolve(settle()).finally(() => {
      done = true;
    });
    // Wait on state, not on a fixed delay: the settlement either queues behind
    // the cancel's transaction id or runs to the end.
    for (let i = 0; i < 400 && !done; i += 1) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'transactionid' AND NOT granted
            AND transactionid::text = $1`,
        [xid],
      );
      if (waiting.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const settledBeforeCommit = done;

    await cancel.query("COMMIT");
    committed = true;
    return { result: await running, settledBeforeCommit };
  } finally {
    if (!committed) await cancel.query("ROLLBACK").catch(() => undefined);
    cancel.release();
  }
}

describe("F3 a reservation cancel racing a late settlement of its deposit", () => {
  it("the webhook waits for the uncommitted cancel, then parks the money instead of paying a cancelled booking", async () => {
    const bill = await openIntent({ status: "expired" });
    const reservationId = await seedOpenReservation(bill.linkId);
    setAnswer(bill.intentId, paid(bill.reference));

    const { result, settledBeforeCommit } =
      await settleWhileCancelIsUncommitted(reservationId, () =>
        callback(bill.intentId, bill.reference),
      );

    expect(result.status).toBe(200);
    // The settlement saw an open booking and paid it before the cancel landed.
    expect(settledBeforeCommit).toBe(false);
    expect(await reservationStatus(reservationId)).toBe("cancelled");
    await expectParked(bill);
    expect(await errorCodes(bill.intentId)).toEqual(["REJECTED_BILL_CLOSED"]);
  });

  it("the poller waits for the uncommitted cancel, then parks the money instead of paying a cancelled booking", async () => {
    const bill = await openIntent({ status: "expired" });
    const reservationId = await seedOpenReservation(bill.linkId);
    setAnswer(bill.intentId, paid(bill.reference));
    registerDuitku();

    const { settledBeforeCommit } = await settleWhileCancelIsUncommitted(
      reservationId,
      () =>
        runPaymentGatewayPollJob(contextFor("webhook"), new Date(), {
          force: true,
        }),
    );

    expect(settledBeforeCommit).toBe(false);
    expect(await reservationStatus(reservationId)).toBe("cancelled");
    await expectParked(bill);
  });
});
