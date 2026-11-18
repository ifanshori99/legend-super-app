// legend-s0u8c (sub-brief 406) fail-first tests for Codex findings F1, F4, F5
// on the Duitku webhook/poller path. Helpers and the race pattern follow
// `payment-duitku-webhook.test.ts`.
//
// Decisions under test (docs/briefs/sub-406-duitku.md, docs/DECISIONS.md):
// - D-mismatch: an amount mismatch is held for review: the event row is
//   `failed` (code REJECTED_AMOUNT_MISMATCH), not `ignored`, the audit row
//   `payment.amount_mismatch_held` is written, and a `logger.warn` is emitted
//   without secrets. The hold is decided AFTER the Duitku transactionStatus
//   call, because the status API is the trusted source of the amount (F1):
//   - status amount = bill, callback amount differs: a poller that settled the
//     intent meanwhile keeps its payment (paid once); the callback is held;
//   - status amount differs from the bill: whichever path (webhook or poller)
//     holds first wins, the other is refused, the intent is never paid.
// - D-paidAt: `paidAt` follows the LOCKED intent status, read after the Duitku
//   call: a pending intent keeps min(now, receivedAt); an intent the poller
//   closed (failed/expired) meanwhile is a late payment dated now (F4).
//
// Assumptions where the brief is silent:
// - "Marked failed for review" means the webhook event row status `failed`.
//   When the status amount differs, the intent itself is held as `failed`
//   (DECISIONS.md, s5jup D2); in the other cases the tests only assert "not
//   paid" / "paid once".
// - The audit row is found by tenant, action `payment.amount_mismatch_held`
//   and the intent id anywhere in the event JSON (the exact field is not
//   specified).
// - "No double unallocated funds": the poller paid the whole bill, so the
//   mismatching callback parks nothing (0 rows). When the intent is held, the
//   money is parked once (exactly 1 row), never twice.
// - When the hold race has two possible winners, the webhook's HTTP status
//   and event row code are not asserted (the loser's answer is unspecified).
// - The warn line mentions the intent id or the word "mismatch".
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
import { logger } from "../lib/logger";
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
// Fake Duitku transactionStatus, with a gate that holds ONE order's first ask
// so a second DB transaction can run while the webhook awaits Duitku.
// ---------------------------------------------------------------------------

type StatusAnswer = {
  statusCode: "00" | "01" | "02";
  reference: string | null;
  amount: string;
};
const statusAnswers = new Map<string, StatusAnswer>();
const realFetch = globalThis.fetch;

type Gate = {
  orderId: string;
  taken: boolean;
  arrived: Promise<void>;
  open: () => void;
  markArrived: () => void;
  released: Promise<void>;
};
let gate: Gate | null = null;

function armGate(orderId: string): Gate {
  let markArrived!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((resolve) => (markArrived = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  gate = { orderId, taken: false, arrived, open, markArrived, released };
  return gate;
}

const paid = (
  reference: string,
  amount = String(BILL_TOTAL),
): StatusAnswer => ({
  statusCode: "00",
  reference,
  amount,
});

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
      if (gate && !gate.taken && gate.orderId === body.merchantOrderId) {
        gate.taken = true;
        gate.markArrived();
        await gate.released;
      }
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

function setAnswer(orderId: string, answer: StatusAnswer) {
  statusAnswers.set(`${MERCHANT}|${orderId}`, answer);
}

function registerGateway() {
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
  isolatedTenant = await createSecondTenant(
    owner,
    "payment-duitku-406-webhook",
  );
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
  gate = null;
  stubDuitku();
});

afterEach(() => {
  gate?.open();
  gate = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPaymentGateways();
});

type Bill = { linkId: string; intentId: string; reference: string };

async function openIntent(
  options: {
    status?: "pending" | "expired" | "failed";
    expiresAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
  } = {},
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
  const created = options.createdAt ?? new Date(Date.now() - 10 * 60_000);
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
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      options.expiresAt ?? new Date(Date.now() + 3_600_000),
      created,
      options.updatedAt ?? created,
    ],
  );
  return { linkId: opened.linkId, intentId, reference };
}

/** An intent the poller reconciles: closed before its code lapsed. */
function openExpiredIntent(): Promise<Bill> {
  const expiresAt = new Date(Date.now() - 5 * 60_000);
  return openIntent({
    status: "expired",
    expiresAt,
    createdAt: new Date(Date.now() - 20 * 60_000),
    updatedAt: new Date(expiresAt.getTime() - 60_000),
  });
}

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

function signatureFor(orderId: string, amount: string) {
  return hmac(`${MERCHANT}${amount}${orderId}`, apiKey);
}

function callback(orderId: string, reference: string, amount: string) {
  const form = new URLSearchParams({
    merchantCode: MERCHANT,
    amount,
    merchantOrderId: orderId,
    resultCode: "00",
    signature: signatureFor(orderId, amount),
    reference,
  });
  return request(app)
    .post(`/api/webhooks/payments/duitku/${tenantA}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(form.toString());
}

const runPoller = () =>
  runPaymentGatewayPollJob(contextFor("webhook"), new Date(), { force: true });

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.status;
}

async function scalar(sqlText: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sqlText, params);
  return Number(rows[0]?.n);
}

const linkPaidIdr = (linkId: string) =>
  scalar("SELECT paid_idr::text AS n FROM payment_links WHERE id = $1", [
    linkId,
  ]);

const evidenceCount = (intentId: string) =>
  scalar(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );

async function eventRows(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code FROM gateway_webhook_events
      WHERE tenant_id = $1 AND provider = 'duitku' AND payment_intent_id = $2
      ORDER BY created_at`,
    [tenantA, intentId],
  );
  return rows;
}

const unallocatedCount = (intentId: string) =>
  scalar(
    "SELECT count(*)::text AS n FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );

const HELD_ACTION = "payment.amount_mismatch_held";

const heldAuditCount = (intentId: string) =>
  scalar(
    `SELECT count(*)::text AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event::text LIKE $3`,
    [tenantA, HELD_ACTION, `%${intentId}%`],
  );

/** True while some DB backend waits on a lock (a transaction blocked behind
 * the webhook's own). Polled, never slept on. */
async function someBackendWaitsOnLock(): Promise<boolean> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid() LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * Runs `work` while the webhook is parked on its Duitku call, then lets the
 * webhook finish. `work` may itself block behind a lock the webhook holds
 * (then it is not awaited before the release, which would deadlock the test:
 * the wait ends as soon as `work` is done or a backend waits on a lock).
 */
async function whileWebhookHeld(
  held: Gate,
  webhook: Promise<unknown>,
  work: () => Promise<unknown>,
): Promise<void> {
  await Promise.race([held.arrived, webhook]);
  let workDone = false;
  const working = work().finally(() => {
    workDone = true;
  });
  const deadline = Date.now() + 10_000;
  while (!workDone && Date.now() < deadline) {
    if (await someBackendWaitsOnLock()) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  held.open();
  await Promise.all([webhook, working]);
}

async function expectNothingPaid(bill: Bill, expectedEvidence: number) {
  expect(await intentStatus(bill.intentId)).not.toBe("paid");
  expect(await linkPaidIdr(bill.linkId)).toBe(0);
  // Held money is kept as evidence parked as unallocated funds, exactly the
  // expected number of times; no evidence ever settles the bill.
  expect(await evidenceCount(bill.intentId)).toBe(expectedEvidence);
  expect(await unallocatedCount(bill.intentId)).toBe(expectedEvidence);
}

// ---------------------------------------------------------------------------

describe("legend-s0u8c F1 the amount hold follows the Duitku status call; poller and webhook never both settle or both park", () => {
  it("the poller paying while the webhook awaits Duitku keeps its payment once; the mismatching callback is held and parks nothing", async () => {
    registerGateway();
    const bill = await openExpiredIntent();
    // Duitku says the full bill is paid; the signed callback says 1000.
    setAnswer(bill.intentId, paid(bill.reference));
    const held = armGate(bill.intentId);

    const webhook = callback(bill.intentId, bill.reference, "1000").then(
      (response) => response,
    );
    // The webhook is parked on its transactionStatus call while the poller
    // runs (or it already finished, which the assertions below still judge).
    await whileWebhookHeld(held, webhook, runPoller);
    const response = await webhook;

    expect(response.status).toBe(200);
    // Paid exactly once, by the poller.
    expect(await intentStatus(bill.intentId)).toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    // The callback is held for review, not ignored and not settled.
    expect(await eventRows(bill.intentId)).toMatchObject([
      { status: "failed", last_error_code: "REJECTED_AMOUNT_MISMATCH" },
    ]);
    expect(await heldAuditCount(bill.intentId)).toBeGreaterThanOrEqual(1);
    // No second amount parked on top of the paid bill.
    expect(await unallocatedCount(bill.intentId)).toBe(0);
  });

  it("when Duitku itself reports another amount, whichever of webhook and poller holds first wins, the other is refused, and the intent is never paid", async () => {
    registerGateway();
    const bill = await openExpiredIntent();
    // The callback matches the bill, but the trusted status call says 1000.
    setAnswer(bill.intentId, paid(bill.reference, "1000"));
    const held = armGate(bill.intentId);

    const webhook = callback(
      bill.intentId,
      bill.reference,
      String(BILL_TOTAL),
    ).then((response) => response);
    await whileWebhookHeld(held, webhook, runPoller);
    await webhook;

    await expectNothingPaid(bill, 1);
    // Held once (audit row), the money parked once, whoever was first.
    expect(await intentStatus(bill.intentId)).toBe("failed");
    expect(await heldAuditCount(bill.intentId)).toBe(1);
    expect(await unallocatedCount(bill.intentId)).toBe(1);

    // A later poller run and a repeated callback are refused too.
    await runPoller();
    expect(
      (await callback(bill.intentId, bill.reference, String(BILL_TOTAL)))
        .status,
    ).toBeLessThan(500);
    await expectNothingPaid(bill, 1);
    expect(await heldAuditCount(bill.intentId)).toBe(1);
    expect(await unallocatedCount(bill.intentId)).toBe(1);
  });

  it("a poller run after the mismatch callback was held does not pay the intent either", async () => {
    registerGateway();
    const bill = await openExpiredIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference, "1000")).status).toBe(
      200,
    );
    await expectNothingPaid(bill, 1);
    expect(await heldAuditCount(bill.intentId)).toBe(1);

    await runPoller();

    // Both paths honour the hold: held for review, never settled by polling.
    await expectNothingPaid(bill, 1);
    expect(await heldAuditCount(bill.intentId)).toBe(1);
  });
});

describe("legend-s0u8c F4 paidAt follows the intent status locked after the Duitku call", () => {
  it("a pending intent that the poller closed while the webhook awaited Duitku is a late payment dated now, not back-dated to the receipt", async () => {
    const bill = await openIntent({
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    setAnswer(bill.intentId, paid(bill.reference));
    const held = armGate(bill.intentId);

    const webhook = callback(
      bill.intentId,
      bill.reference,
      String(BILL_TOTAL),
    ).then((response) => response);
    // Meanwhile another transaction closes the intent (what the poller does
    // on a status 02 / lapsed code), committing before the webhook resumes.
    let closedAt = new Date(0);
    await whileWebhookHeld(held, webhook, async () => {
      const { rows } = await owner.query<{ closed_at: Date }>(
        `UPDATE payment_intents SET status = 'failed', updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'pending'
          RETURNING updated_at AS closed_at`,
        [bill.intentId],
      );
      expect(rows).toHaveLength(1);
      closedAt = rows[0]!.closed_at;
    });
    const response = await webhook;

    expect(response.status).toBe(200);
    expect(await intentStatus(bill.intentId)).toBe("paid");
    expect(await linkPaidIdr(bill.linkId)).toBe(BILL_TOTAL);
    expect(await evidenceCount(bill.intentId)).toBe(1);
    const paidRow = await owner.query<{ paid_at: Date; flags: string[] }>(
      "SELECT paid_at, flags FROM payment_intents WHERE id = $1",
      [bill.intentId],
    );
    expect(paidRow.rows[0]!.flags).toContain("late_payment");
    // Receipt time is before the close; paidAt must not be taken from it.
    expect(paidRow.rows[0]!.paid_at.getTime()).toBeGreaterThanOrEqual(
      closedAt.getTime(),
    );
  });
});

describe("legend-s0u8c F5 an amount mismatch is held for review, not ignored, and is warned without secrets", () => {
  it("marks the callback event failed with REJECTED_AMOUNT_MISMATCH, never ignored, and pays nothing", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));

    expect((await callback(bill.intentId, bill.reference, "1000")).status).toBe(
      200,
    );

    await expectNothingPaid(bill, 1);
    const rows = await eventRows(bill.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).not.toBe("ignored");
    expect(rows[0]).toMatchObject({
      status: "failed",
      last_error_code: "REJECTED_AMOUNT_MISMATCH",
    });
  });

  it("logs a warning about the mismatch that carries no signature, merchant key or raw payload", async () => {
    const bill = await openIntent();
    setAnswer(bill.intentId, paid(bill.reference));
    const warn = vi.spyOn(logger, "warn");

    expect((await callback(bill.intentId, bill.reference, "1000")).status).toBe(
      200,
    );

    const lines = warn.mock.calls.map((args) => JSON.stringify(args));
    const mismatch = lines.filter(
      (line) => line.includes(bill.intentId) || /mismatch/i.test(line),
    );
    expect(mismatch.length).toBeGreaterThanOrEqual(1);
    for (const line of mismatch) {
      expect(line).not.toContain(signatureFor(bill.intentId, "1000"));
      expect(line).not.toContain(apiKey);
      expect(line).not.toMatch(/signature=|merchantCode=|resultCode=/);
    }
  });
});
