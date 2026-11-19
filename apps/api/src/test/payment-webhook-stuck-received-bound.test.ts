// legend-dhzqb: the crash loop of a stuck `received` DOIT webhook row is bounded.
//
// Contract under test (brief dhzqb, CTO-approved design):
// - A worker claim of a row whose old status is `received` (a stuck one) counts as
//   an attempt (+1). A claim of a `failed` row does NOT add an attempt (the recorded
//   outcome already counted it). Same for the redelivery claim (resend).
// - A `received` row is stuck again only after max(5 minutes, back-off(attempts))
//   with back-off(a) = min(2^min(a,6), 60) minutes, so the retry interval grows.
// - At 6 attempts a stuck `received` row is not claimed again: the sweep flips it to
//   `failed` / `STUCK_EXHAUSTED` and raises ONE alert for that event; later sweeps
//   never claim it again and never alert again.
// - A manual resend (redelivery of the same payload) still processes an exhausted
//   row once; a second redelivery is a duplicate. The payment is recorded once.
//
// SIMULATING A DEAD PROCESS. The process that dies after its claim is simulated by a
// database trigger (created here, dropped afterwards) that refuses every outcome
// write (`status` leaving `received`, except the STUCK_EXHAUSTED flip) on rows whose
// payload_hash starts with "dead". The claim itself therefore stays committed and
// the row stays `received`, exactly what a killed process leaves. Rows with a normal
// hash behave normally. TIME is simulated by moving `updated_at` into the past
// (wide margins of 2 minutes against the windows), never by waiting.
//
// ASSUMPTIONS
// - Attempts after a dead claim is exactly the number of claims (the outcome write
//   that would also count is refused). Hence "bounded count of processing calls" is
//   read from `attempts`.
// - The ALERT is asserted on the notification pipeline of the tenant: a row in
//   `notification_outbox` (one per alert) or in `notifications` (one per recipient)
//   created after the test started that mentions the event id (the stable alert id
//   is `webhook-stuck-exhausted:<eventId>`) or whose event type mentions "stuck".
//   Count = max(outbox rows, most rows any single recipient got). If the helper
//   stores the stable id in a hashed form that never contains the event id, the
//   alert helper/test column must be adapted by the engineer (report says so).
// - Existing test payment-webhook-retry-integration "two workers ... attempts toBe(1)"
//   expects a processed received row to end with attempts 1; with the claim +1 it is
//   up to the engineer whether markRow counts again (then that test needs 2).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-webhook-stuck-received-bound.test.ts" heavy pnpm test
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
import { setPaymentGateway } from "../services/payment-gateway";
import { createPaymentLink } from "../services/payment.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { agent } from "./helpers";
import { BILL_TOTAL, FakeDoit } from "./payment-webhook-fake-doit";

const app = createApp();
const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const actor = randomUUID();

const apiKey = `doit-key-stuck-${randomBytes(12).toString("hex")}`;
const secret = `whsec-stuck-${randomBytes(16).toString("hex")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdLinkIds: string[] = [];
const integrationIds: string[] = [];
const eventIds: string[] = [];
let integrationId = "";

const doit = new FakeDoit(apiKey);
const unique = () => randomBytes(4).toString("hex");
const newEventId = () => `evt_${randomBytes(8).toString("hex")}`;

const MAX_STUCK_ATTEMPTS = 6;
const EXHAUSTED = "STUCK_EXHAUSTED";
const TRIGGER = "zz_dhzqb_dead_worker";

function contextFor(source: "session" | "webhook"): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: tenantA, brandId: null, source }),
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await doit.start();
  const created = await upsertIntegration(
    contextFor("session"),
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: doit.baseUrl },
      credentials: { apiKey, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    contextFor("session"),
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  integrationIds.push(created.id);
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
  // The "dead process": refuses every outcome write on rows with a "dead" hash.
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${TRIGGER}_fn() RETURNS trigger AS $$
    BEGIN
      IF OLD.payload_hash LIKE 'dead%' AND NEW.payload_hash LIKE 'dead%'
         AND NEW.status <> 'received'
         AND coalesce(NEW.last_error_code, '') <> '${EXHAUSTED}' THEN
        RAISE EXCEPTION 'simulated crash before the outcome was recorded';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await owner.query(
    `DROP TRIGGER IF EXISTS ${TRIGGER} ON gateway_webhook_events`,
  );
  await owner.query(
    `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON gateway_webhook_events
       FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}_fn()`,
  );
});

afterAll(async () => {
  setPaymentGateway(null);
  await owner.query(
    `DROP TRIGGER IF EXISTS ${TRIGGER} ON gateway_webhook_events`,
  );
  await owner.query(`DROP FUNCTION IF EXISTS ${TRIGGER}_fn()`);
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = ANY($2::text[])",
    [tenantA, eventIds],
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
  await owner.end();
  await doit.stop();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

afterEach(() => {
  clearDoitWebhookSecretCache();
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

type Bill = { linkId: string; intentId: string; providerRef: string };

async function openIntent(): Promise<Bill> {
  const opened = await createPaymentLink(
    outletContext([outletA]),
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
  const created = await agent(app)
    .post(`/api/payments/links/${opened.token}/intents`)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `k-${unique()}`,
    });
  expect(created.status).toBe(201);
  const intentId = created.body.data.id as string;
  const { rows } = await owner.query<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payment_intents WHERE id = $1",
    [intentId],
  );
  const providerRef = rows[0]?.provider_ref;
  if (!providerRef) throw new Error("Intent has no DOIT payment id");
  return { linkId: opened.linkId, intentId, providerRef };
}

/** The retry window of a `received` row: the larger of the 5 minute stuck guard
 * and the back-off of its attempts, in seconds. */
const windowSeconds = (attempts: number) =>
  Math.max(5, Math.min(2 ** Math.min(attempts, 6), 60)) * 60;

type StoredStatus = "received" | "failed";

/** Stores a verified row of the integration. `dead` rows refuse outcome writes
 * (the simulated dead process); the others behave normally. */
async function storeRow(
  eventId: string,
  status: StoredStatus,
  payload: object,
  attempts: number,
  idleSeconds: number,
  options: { dead?: boolean; lastErrorCode?: string | null } = {},
) {
  eventIds.push(eventId);
  const updatedAt = new Date(Date.now() - idleSeconds * 1000);
  const hash = `${options.dead ? "dead" : "live"}${randomBytes(30).toString("hex")}`;
  await owner.query(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, last_error_code, received_at,
        updated_at, integration_id)
     VALUES ($1, 'doit', $2, 'payment.paid', true, $3, $4::jsonb, $5, $6, $7, $8, $9, $9, $10)`,
    [
      tenantA,
      eventId,
      hash,
      JSON.stringify(payload),
      (payload as { data: { id: string } }).data.id,
      status,
      attempts,
      options.lastErrorCode ?? null,
      updatedAt,
      integrationId,
    ],
  );
}

/** Time passes: the row has been idle for `idleSeconds` (database clock). */
async function age(eventId: string, idleSeconds: number) {
  await owner.query(
    `UPDATE gateway_webhook_events
        SET updated_at = now() - ($3::int * interval '1 second'),
            received_at = least(received_at, now() - ($3::int * interval '1 second'))
      WHERE tenant_id = $1 AND event_id = $2`,
    [tenantA, eventId, idleSeconds],
  );
}

/** One worker sweep. A refused outcome write may surface as a rejection (the
 * dead process); that is part of the simulation, not a failure. */
async function sweep() {
  await reprocessStoredWebhookEvents(
    contextFor("webhook"),
    new Date(),
    100,
  ).catch(() => undefined);
}

function deliver(body: object) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantA}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", `t=${t},v1=${mac}`)
    .send(raw);
}

async function eventRow(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
    attempts: number;
  }>(
    `SELECT status, last_error_code, attempts FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2 AND signature_valid`,
    [tenantA, eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

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

async function evidenceCount(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantA, intentId],
  );
  return Number(rows[0]!.n);
}

async function expectPending(bill: Bill, label: string) {
  expect(await intentStatus(bill.intentId), `${label}: intent pending`).toBe(
    "pending",
  );
  expect(await linkPaidIdr(bill.linkId), `${label}: nothing paid`).toBe(0);
  expect(await evidenceCount(bill.intentId), `${label}: no evidence`).toBe(0);
}

async function expectPaidOnce(bill: Bill, label: string) {
  expect(await intentStatus(bill.intentId), `${label}: intent paid`).toBe(
    "paid",
  );
  expect(await linkPaidIdr(bill.linkId), `${label}: paid exactly once`).toBe(
    BILL_TOTAL,
  );
  expect(
    await evidenceCount(bill.intentId),
    `${label}: exactly one evidence row`,
  ).toBe(1);
}

/** Database time, to scope alert counts to what this test caused. */
async function dbNow(): Promise<Date> {
  const { rows } = await owner.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  return rows[0]!.now;
}

/** How many alerts the stuck-exhausted event `eventId` caused since `since`. */
async function alertCount(eventId: string, since: Date): Promise<number> {
  const outbox = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_outbox o
      WHERE o.tenant_id = $1 AND o.created_at >= $2
        AND (o.event_type ILIKE '%stuck%' OR to_jsonb(o)::text LIKE '%' || $3 || '%')`,
    [tenantA, since, eventId],
  );
  const perUser = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications n
      WHERE n.tenant_id = $1 AND n.created_at >= $2
        AND to_jsonb(n)::text LIKE '%' || $3 || '%'
      GROUP BY n.user_id`,
    [tenantA, since, eventId],
  );
  return Math.max(
    Number(outbox.rows[0]?.n ?? 0),
    ...perUser.rows.map((row) => Number(row.n)),
  );
}

/**
 * Drives a dead-process row through its crash loop with the real clock moved by
 * `age`. For every attempt k the sweep first runs too early (2 minutes short of
 * the window of k attempts: must NOT claim), then late enough (must claim exactly
 * once). Returns after the sixth claim, the row `received` with 6 attempts.
 */
async function crashUntilCap(
  eventId: string,
  bill: Bill,
  options: { stopAfter?: number; checkPending?: boolean } = {},
) {
  const stopAfter = options.stopAfter ?? MAX_STUCK_ATTEMPTS;
  const checkPending = options.checkPending ?? true;
  for (let claim = 1; claim <= stopAfter; claim += 1) {
    const before = await eventRow(eventId);
    expect(before.attempts, `before claim ${claim}`).toBe(claim - 1);

    await age(eventId, windowSeconds(before.attempts) - 120);
    await sweep();
    const early = await eventRow(eventId);
    expect(
      early.attempts,
      `claim ${claim}: a row idle 2 minutes short of its back-off window (${windowSeconds(before.attempts) / 60 - 2} min, ${before.attempts} attempts) is not reprocessed`,
    ).toBe(before.attempts);
    expect(early.status).toBe("received");

    await age(eventId, windowSeconds(before.attempts) + 120);
    await sweep();
    const claimed = await eventRow(eventId);
    expect(
      claimed.attempts,
      `claim ${claim}: a stuck received row claimed by the worker gets exactly one more attempt`,
    ).toBe(claim);
    expect(
      claimed.status,
      `claim ${claim}: the dead worker left it received`,
    ).toBe("received");
    if (checkPending) await expectPending(bill, `claim ${claim}`);
  }
}

// ---------------------------------------------------------------------------
// a. The crash loop is bounded
// ---------------------------------------------------------------------------

describe("dhzqb a crash loop of a stuck received row is bounded", () => {
  it("dhzqb-a-01 attempts count every claim, the retry window grows, and the sixth stuck claim ends in failed/STUCK_EXHAUSTED", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      0,
      windowSeconds(0) + 120,
      { dead: true },
    );

    await crashUntilCap(eventId, bill);

    // Attempts reached the cap while the row is still `received`: it has not
    // been processed a seventh time. The next sweep, past the 60 minute window,
    // gives up on it.
    await age(eventId, windowSeconds(MAX_STUCK_ATTEMPTS) + 120);
    await sweep();
    const exhausted = await eventRow(eventId);
    expect(exhausted.status, "row given up on").toBe("failed");
    expect(exhausted.last_error_code).toBe(EXHAUSTED);
    expect(exhausted.attempts, "no extra processing call").toBe(
      MAX_STUCK_ATTEMPTS,
    );
    await expectPending(bill, "after exhaustion");
  });

  it("dhzqb-a-02 sweeps after exhaustion never claim the row again, however much time passes", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      0,
      windowSeconds(0) + 120,
      { dead: true },
    );
    await crashUntilCap(eventId, bill);
    await age(eventId, windowSeconds(MAX_STUCK_ATTEMPTS) + 120);
    await sweep();
    expect((await eventRow(eventId)).last_error_code).toBe(EXHAUSTED);

    for (const idle of [60, 3_600, 86_400, 864_000, 8_640_000]) {
      await age(eventId, idle);
      await sweep();
      const row = await eventRow(eventId);
      expect(row.status, `idle ${idle}s: still failed`).toBe("failed");
      expect(row.last_error_code, `idle ${idle}s`).toBe(EXHAUSTED);
      expect(row.attempts, `idle ${idle}s: not claimed again`).toBe(
        MAX_STUCK_ATTEMPTS,
      );
    }
    await expectPending(bill, "after many sweeps");
  });

  it("dhzqb-a-03 a stuck received row already at the cap is flagged, not processed: the bill stays unpaid and no payment is recorded by the sweep", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    // A perfectly processable paid event, but stuck with 6 attempts: the worker
    // must give up instead of running it a seventh time.
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) + 120,
    );

    await sweep();

    const row = await eventRow(eventId);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe(EXHAUSTED);
    expect(row.attempts).toBe(MAX_STUCK_ATTEMPTS);
    await expectPending(bill, "cap reached");
  });

  it("dhzqb-a-04 a received row at the cap that is not yet stuck is left alone (no flip, no alert)", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) - 120,
    );

    await sweep();

    const row = await eventRow(eventId);
    expect(row.status).toBe("received");
    expect(row.last_error_code).toBeNull();
    expect(row.attempts).toBe(MAX_STUCK_ATTEMPTS);
    expect(await alertCount(eventId, since)).toBe(0);
    await expectPending(bill, "inside the window");
  });
});

// ---------------------------------------------------------------------------
// b. The alert is raised exactly once
// ---------------------------------------------------------------------------

describe("dhzqb b the exhausted row raises one alert", () => {
  it("dhzqb-b-01 exactly one alert, however many more sweeps run", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      0,
      windowSeconds(0) + 120,
      { dead: true },
    );
    await crashUntilCap(eventId, bill);
    expect(
      await alertCount(eventId, since),
      "no alert while the row is still being retried",
    ).toBe(0);

    await age(eventId, windowSeconds(MAX_STUCK_ATTEMPTS) + 120);
    await sweep();
    expect((await eventRow(eventId)).last_error_code).toBe(EXHAUSTED);
    expect(
      await alertCount(eventId, since),
      "one alert when the row is given up on",
    ).toBe(1);

    for (let round = 0; round < 6; round += 1) {
      await age(eventId, 86_400 * (round + 1));
      await sweep();
    }
    expect(
      await alertCount(eventId, since),
      "still exactly one alert after six more sweeps",
    ).toBe(1);
  });

  it("dhzqb-b-02 two workers sweeping at once raise one alert for the same row", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) + 120,
    );

    await Promise.all([sweep(), sweep(), sweep()]);

    const row = await eventRow(eventId);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe(EXHAUSTED);
    expect(await alertCount(eventId, since)).toBe(1);
  });

  it("dhzqb-b-03 a row still being retried, or one that is fine, raises no alert", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      0,
      windowSeconds(0) + 120,
      { dead: true },
    );

    await crashUntilCap(eventId, bill, { stopAfter: 3 });

    expect(await alertCount(eventId, since)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// c. The payment is recorded exactly once
// ---------------------------------------------------------------------------

describe("dhzqb c a stuck row that finally processes records the payment once", () => {
  it("dhzqb-c-01 processing that succeeds after 2 crashes pays the bill exactly once", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      0,
      windowSeconds(0) + 120,
      { dead: true },
    );

    await crashUntilCap(eventId, bill, { stopAfter: 2, checkPending: false });

    // The process no longer dies: the row (2 attempts, stuck) is retried and works.
    await owner.query(
      "UPDATE gateway_webhook_events SET payload_hash = $3 WHERE tenant_id = $1 AND event_id = $2",
      [tenantA, eventId, `live${randomBytes(30).toString("hex")}`],
    );
    await age(eventId, windowSeconds(2) + 120);
    await sweep();

    await expectPaidOnce(bill, "after the successful retry");
    expect((await eventRow(eventId)).status).toBe("processed");

    // Later sweeps and a redelivery change nothing.
    await age(eventId, 864_000);
    await sweep();
    const response = await deliver(
      doit.eventFor(bill.providerRef, "paid", eventId),
    );
    expect(response.status).toBeLessThan(500);
    await expectPaidOnce(bill, "after more sweeps and a redelivery");
    expect((await eventRow(eventId)).status).toBe("processed");
  });

  it("dhzqb-c-02 two workers racing for a stuck row with 5 attempts pay once and never exceed the cap", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "paid", eventId),
      MAX_STUCK_ATTEMPTS - 1,
      windowSeconds(MAX_STUCK_ATTEMPTS - 1) + 120,
    );

    await Promise.all([sweep(), sweep()]);

    await expectPaidOnce(bill, "racing workers");
    const row = await eventRow(eventId);
    expect(row.status).toBe("processed");
    expect(row.last_error_code).not.toBe(EXHAUSTED);
  });
});

// ---------------------------------------------------------------------------
// d. Manual resend of an exhausted row
// ---------------------------------------------------------------------------

describe("dhzqb d a manual resend processes an exhausted row once", () => {
  it("dhzqb-d-01 redelivery of the same payload settles the bill; a second redelivery is a duplicate", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "failed", body, MAX_STUCK_ATTEMPTS, 600, {
      lastErrorCode: EXHAUSTED,
    });

    const first = await deliver(body);

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("processed");
    await expectPaidOnce(bill, "after the manual resend");
    expect((await eventRow(eventId)).status).toBe("processed");

    const second = await deliver(body);

    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
    await expectPaidOnce(bill, "after the second redelivery");
    expect((await eventRow(eventId)).status).toBe("processed");
  });

  it("dhzqb-d-02 a worker sweep after the manual resend finds nothing to do", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "paid", eventId);
    await storeRow(eventId, "failed", body, MAX_STUCK_ATTEMPTS, 600, {
      lastErrorCode: EXHAUSTED,
    });
    expect((await deliver(body)).body.status).toBe("processed");

    await age(eventId, 864_000);
    await sweep();

    await expectPaidOnce(bill, "after the sweep");
    expect((await eventRow(eventId)).status).toBe("processed");
  });
});

// ---------------------------------------------------------------------------
// e. The claim of a failed row does not add an attempt
// ---------------------------------------------------------------------------

describe("dhzqb e only a stuck received claim counts as an attempt", () => {
  it("dhzqb-e-01 the worker claim of a failed row leaves attempts alone", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    await storeRow(
      eventId,
      "failed",
      doit.eventFor(bill.providerRef, "pending", eventId),
      2,
      3_600,
      { dead: true, lastErrorCode: "INTERNAL_ERROR" },
    );

    await sweep();

    const row = await eventRow(eventId);
    expect(row.status, "claimed, then the process died").toBe("received");
    expect(row.attempts, "a failed row's claim is not an attempt").toBe(2);
  });

  it("dhzqb-e-02 the redelivery claim of a failed row leaves attempts alone", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "pending", eventId);
    await storeRow(eventId, "failed", body, 2, 3_600, {
      dead: true,
      lastErrorCode: "INTERNAL_ERROR",
    });

    await deliver(body);

    const row = await eventRow(eventId);
    expect(row.status).toBe("received");
    expect(row.attempts, "a failed row's claim is not an attempt").toBe(2);
  });

  it("dhzqb-e-03 the redelivery claim of a stuck received row counts as one attempt", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "pending", eventId);
    await storeRow(eventId, "received", body, 2, windowSeconds(2) + 120, {
      dead: true,
    });

    await deliver(body);

    const row = await eventRow(eventId);
    expect(row.status).toBe("received");
    expect(row.attempts, "stuck received claim by a resend").toBe(3);
  });

  it("dhzqb-e-04 a failed row with 0 attempts keeps its normal back-off and is retried after 2 minutes idle", async () => {
    const bill = await openIntent();
    const retried = newEventId();
    await storeRow(
      retried,
      "failed",
      doit.eventFor(bill.providerRef, "paid", retried),
      0,
      120,
    );
    await sweep();
    await expectPaidOnce(bill, "failed with 0 attempts, idle 2 minutes");
    expect((await eventRow(retried)).status).toBe("processed");
  });
});

// ---------------------------------------------------------------------------
// f. A fresh received row is untouched
// ---------------------------------------------------------------------------

describe("dhzqb f a received row inside its window is untouched", () => {
  for (const [attempts, idleSeconds] of [
    [0, 120],
    [3, 7 * 60],
    [5, 30 * 60],
  ] as const) {
    it(`dhzqb-f-0${attempts} received with ${attempts} attempts idle ${idleSeconds / 60} minutes (window ${windowSeconds(attempts) / 60}) is not reprocessed`, async () => {
      const bill = await openIntent();
      const eventId = newEventId();
      await storeRow(
        eventId,
        "received",
        doit.eventFor(bill.providerRef, "paid", eventId),
        attempts,
        idleSeconds,
      );
      const { rows: before } = await owner.query<{ updated_at: Date }>(
        "SELECT updated_at FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
        [tenantA, eventId],
      );

      await sweep();

      const row = await eventRow(eventId);
      expect(row.status).toBe("received");
      expect(row.attempts).toBe(attempts);
      await expectPending(bill, "inside the window");
      const { rows: after } = await owner.query<{ updated_at: Date }>(
        "SELECT updated_at FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
        [tenantA, eventId],
      );
      expect(after[0]!.updated_at).toEqual(before[0]!.updated_at);
    });
  }
});

// ---------------------------------------------------------------------------
// g. Only rows that never recorded an outcome are capped
// ---------------------------------------------------------------------------

describe("dhzqb g a row with a recorded failure is never given up on", () => {
  it("dhzqb-g-01 a failed-then-crashed row with 6+ attempts keeps being retried on the backoff and never becomes STUCK_EXHAUSTED", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const since = await dbNow();
    // Recorded failure (INTERNAL_ERROR, 6 attempts), then claimed by the
    // worker whose process died: received again, stuck.
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) + 120,
      { dead: true, lastErrorCode: "INTERNAL_ERROR" },
    );

    await sweep();
    const first = await eventRow(eventId);
    expect(first.status, "claimed again, then the process died").toBe(
      "received",
    );
    expect(first.attempts, "retried, not given up on").toBe(
      MAX_STUCK_ATTEMPTS + 1,
    );
    expect(first.last_error_code).toBe("INTERNAL_ERROR");

    await age(eventId, windowSeconds(MAX_STUCK_ATTEMPTS + 1) + 120);
    await sweep();
    const second = await eventRow(eventId);
    expect(second.status).toBe("received");
    expect(second.attempts, "still retried on a later sweep").toBe(
      MAX_STUCK_ATTEMPTS + 2,
    );
    expect(second.last_error_code).toBe("INTERNAL_ERROR");
    expect(await alertCount(eventId, since)).toBe(0);
    await expectPending(bill, "retried, never exhausted");
  });
});

// ---------------------------------------------------------------------------
// h. The flip and its alert are one unit
// ---------------------------------------------------------------------------

const ALERT_TRIGGER = "zz_dhzqb_alert_fails";
const ALERT_MARK = "zzfailalert";

async function failAlertsFor(mark: string) {
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${ALERT_TRIGGER}_fn() RETURNS trigger AS $$
    BEGIN
      IF to_jsonb(NEW)::text LIKE '%${mark}%' THEN
        RAISE EXCEPTION 'simulated alert failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  for (const table of ["notification_outbox", "notifications"]) {
    await owner.query(`DROP TRIGGER IF EXISTS ${ALERT_TRIGGER} ON ${table}`);
    await owner.query(
      `CREATE TRIGGER ${ALERT_TRIGGER} BEFORE INSERT ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${ALERT_TRIGGER}_fn()`,
    );
  }
}

async function alertsWork() {
  for (const table of ["notification_outbox", "notifications"])
    await owner.query(`DROP TRIGGER IF EXISTS ${ALERT_TRIGGER} ON ${table}`);
  await owner.query(`DROP FUNCTION IF EXISTS ${ALERT_TRIGGER}_fn()`);
}

describe("dhzqb h the exhaust flip and its alert succeed or fail together", () => {
  it("dhzqb-h-01 an alert that fails leaves the row stuck; a later sweep exhausts it and alerts once", async () => {
    const bill = await openIntent();
    const eventId = `evt_${ALERT_MARK}_${randomBytes(6).toString("hex")}`;
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      doit.eventFor(bill.providerRef, "pending", eventId),
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) + 120,
    );

    await failAlertsFor(ALERT_MARK);
    try {
      await sweep();
      const stuck = await eventRow(eventId);
      expect(stuck.status, "flip rolled back with the alert").toBe("received");
      expect(stuck.last_error_code).toBeNull();
      expect(stuck.attempts).toBe(MAX_STUCK_ATTEMPTS);
      expect(await alertCount(eventId, since)).toBe(0);
    } finally {
      await alertsWork();
    }

    await sweep();
    const row = await eventRow(eventId);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe(EXHAUSTED);
    expect(await alertCount(eventId, since)).toBe(1);

    await sweep();
    expect(await alertCount(eventId, since)).toBe(1);
    await expectPending(bill, "never processed by the sweeps");
  });

  it("dhzqb-h-02 a second exhaustion after a resend that crashed alerts again", async () => {
    const bill = await openIntent();
    const eventId = newEventId();
    const body = doit.eventFor(bill.providerRef, "pending", eventId);
    const since = await dbNow();
    await storeRow(
      eventId,
      "received",
      body,
      MAX_STUCK_ATTEMPTS,
      windowSeconds(MAX_STUCK_ATTEMPTS) + 120,
      { dead: true },
    );

    await sweep();
    expect((await eventRow(eventId)).last_error_code).toBe(EXHAUSTED);
    expect(await alertCount(eventId, since)).toBe(1);

    // Manual resend: claimed, then the process dies again.
    await age(eventId, 600);
    await deliver(body);
    const resent = await eventRow(eventId);
    expect(resent.status, "claimed by the resend, then it died").toBe(
      "received",
    );

    await age(eventId, windowSeconds(MAX_STUCK_ATTEMPTS) + 120);
    await sweep();

    const row = await eventRow(eventId);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe(EXHAUSTED);
    expect(
      await alertCount(eventId, since),
      "the second exhaustion is a new alert",
    ).toBe(2);
  });
});
