// DOIT recurring billing, brief 488 items 1 and 8 (docs/briefs/488-findings-fixes.md).
// Written from the brief and the existing test conventions, not from the
// implementation. Fail-first: every test below pins behavior that does not
// exist yet (except the controls, marked "control").
//
// - REC-52 (item 1): two concurrent starts for the same customer + plan with
//   different idempotency keys create ONE subscription; the other is refused
//   with CONFLICT; DOIT is called once (the per customer + plan lock is taken
//   BEFORE the gateway call); the database refuses a second active / pending
//   row for the same (customer, plan) through a unique partial index.
// - REC-53 (item 8): an invoice for a period AFTER an unpaid one is parked, not
//   left in needs_review PERIOD_MISMATCH forever; once the previous period is
//   paid it is re-evaluated (open); no access comes from it before it is paid.
//
// ASSUMPTIONS
// - The refused concurrent start answers `HttpError.code` CONFLICT (same code as
//   the existing "a start for the same customer and plan is blocked" refusals).
// - The unique partial index covers `pending_first_payment` and `active` rows of
//   one (customer_profile_id, plan_id); the exact status list is only pinned for
//   those two, and a `cancelled` row never blocks (control).
// - Item 8 park state: the brief gives no name for it, so only the OUTCOME is
//   pinned: before the predecessor is paid the invoice is not `paid`/`void` and
//   grants no access; after the predecessor is paid (webhook `invoice.paid`)
//   the invoice is `open` with no review reason, with no extra worker call.
// - Paying the parked invoice BEFORE its predecessor must not extend access;
//   whether the row keeps a park/needs_review status is not pinned.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import {
  resumeSubscription,
  startSubscription,
  subscriptionHasAccess,
} from "../services/payment-recurring.service";
import { clearDoitWebhookSecretCache } from "../services/payment-webhook.service";
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
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");
const PRICE = 150_000;

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
let integrationId = "";
let secret = "";
const planIds: string[] = [];
const subIds: string[] = [];
const profileCleanups: (() => Promise<void>)[] = [];

function contextFor(id: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}
function context(): ScopedTenantContext {
  return contextFor(tenantId);
}

// ---------------------------------------------------------------------------
// Date helpers (Asia/Jakarta business dates)
// ---------------------------------------------------------------------------

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** 12:00 Asia/Jakarta on a business date (05:00 UTC). */
const noonJakarta = (date: string) => new Date(`${date}T05:00:00.000Z`);
function jakartaMonthStart(monthOffset: number): string {
  const now = new Date(Date.now() + 7 * 3_600_000);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1),
  )
    .toISOString()
    .slice(0, 10);
}
const P_CUR = jakartaMonthStart(0);
const P_NEXT = jakartaMonthStart(1);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  dedicated = await createSecondTenant(owner, "startrace");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const integrationOutlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet SR', 'Jl. SR', '{}')`,
    [
      integrationOutlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `SR-${unique()}`.toUpperCase(),
    ],
  );
  secret = `whsec-sr-${randomBytes(12).toString("hex")}`;
  const created = await upsertIntegration(
    context(),
    {
      outletId: integrationOutlet as OutletId,
      provider: "doit",
      // Never contacted: every DOIT call in this file goes through `clientFor`.
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey: `doit-key-${unique()}`, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    context(),
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
  clearDoitWebhookSecretCache();
});

afterAll(async () => {
  // Same robust cleanup as payment-recurring-reconcile.test.ts: every step is
  // isolated and the first error is rethrown at the end.
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const query = (text: string, values: unknown[]) => () =>
    owner.query(text, values);
  // Dependents first. Subscriptions created through `startSubscription` (not
  // `seedSub`) are not tracked one by one: pick up every row of the plans.
  await step(async () => {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM payment_recurring_subscriptions WHERE plan_id = ANY($1::uuid[])",
      [planIds],
    );
    for (const row of rows) subIds.push(row.id);
  });
  await step(
    query("DELETE FROM domain_event_outbox WHERE tenant_id = $1", [tenantId]),
  );
  await step(
    query(
      "DELETE FROM subscription_invoices WHERE subscription_id = ANY($1::uuid[])",
      [subIds],
    ),
  );
  await step(
    query(
      "DELETE FROM payment_recurring_subscriptions WHERE id = ANY($1::uuid[])",
      [subIds],
    ),
  );
  await step(
    query("DELETE FROM payment_recurring_plans WHERE id = ANY($1::uuid[])", [
      planIds,
    ]),
  );
  await step(
    query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
      tenantId,
    ]),
  );
  for (const cleanup of profileCleanups) await step(cleanup);
  await step(
    query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId || randomUUID(),
    ]),
  );
  await step(() => sweepTenantRows(tenantId));
  await step(() => removeSecondTenant(owner, dedicated));
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
});

async function sweepTenantRows(id: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [id],
    );
    const { rows } = await client.query<{ tbl: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS tbl
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.contype = 'f'
          AND c.confrelid IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                              'public.brands'::regclass, 'public.legal_entities'::regclass)
          AND c.conrelid NOT IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                                 'public.brands'::regclass, 'public.legal_entities'::regclass)`,
    );
    // `tbl` comes from pg_catalog (regclass text, already quoted), not input.
    for (const { tbl } of rows)
      await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SubStatus =
  | "pending_first_payment"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "provisioning"
  | "needs_reconcile";

type Sub = {
  outletId: string;
  planId: string;
  providerPlanId: string;
  subId: string;
  /** Null for rows without a DOIT subscription id. */
  providerSubId: string | null;
  customerProfileId: string;
};

type Plan = { planId: string; providerPlanId: string };

async function seedPlan(outlet: string = outletId): Promise<Plan> {
  const plan: Plan = {
    planId: randomUUID(),
    providerPlanId: `plan_${unique()}`,
  };
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, 'month', 'active', $6)`,
    [plan.planId, tenantId, outlet, plan.providerPlanId, PRICE, integrationId],
  );
  planIds.push(plan.planId);
  return plan;
}

async function seedSub(
  options: {
    plan?: Plan;
    /** Outlet of the subscription (and of a freshly seeded plan). */
    outlet?: string;
    status?: SubStatus;
    providerSubId?: string | null;
    reconcileReason?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    customerProfileId?: string;
    startKey?: string | null;
    /** Backdates created_at (hours) after the insert. */
    createdHoursAgo?: number;
  } = {},
): Promise<Sub> {
  const plan = options.plan ?? (await seedPlan(options.outlet));
  const sub: Sub = {
    ...plan,
    outletId: options.outlet ?? outletId,
    subId: randomUUID(),
    providerSubId:
      options.providerSubId === undefined
        ? `sub_${unique()}`
        : options.providerSubId,
    customerProfileId: options.customerProfileId ?? randomUUID(),
  };
  const status = options.status ?? "pending_first_payment";
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            reconcile_reason, current_period_start, current_period_end, activated_at, paused_at, cancelled_at, gateway_integration_id, start_idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, $10,
             CASE WHEN $7::varchar IN ('active','past_due','paused','cancelled') THEN now() - interval '40 days' END,
             CASE WHEN $7::varchar = 'paused' THEN now() END,
             CASE WHEN $7::varchar = 'cancelled' THEN now() END,
             $11, $12)`,
    [
      sub.subId,
      tenantId,
      sub.outletId,
      sub.planId,
      sub.customerProfileId,
      sub.providerSubId,
      status,
      options.reconcileReason ?? null,
      options.periodStart ?? null,
      options.periodEnd ?? null,
      integrationId,
      options.startKey ?? null,
    ],
  );
  subIds.push(sub.subId);
  if (options.createdHoursAgo !== undefined)
    await owner.query(
      `UPDATE payment_recurring_subscriptions SET created_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [sub.subId, options.createdHoursAgo],
    );
  return sub;
}

async function seedProfile(): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan uji', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Pelanggan uji', 'active', now())`,
    [profileId, tenantId, userId],
  );
  profileCleanups.push(async () => {
    await owner.query("DELETE FROM customer_profiles WHERE id = $1", [
      profileId,
    ]);
    await owner.query('DELETE FROM "user" WHERE id = $1', [userId]);
  });
  return profileId;
}

async function subRow(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
    period_start: string | null;
    period_end: string | null;
    next_start: string | null;
    next_end: string | null;
    activated_at: string | null;
  }>(
    `SELECT status, reconcile_reason, provider_subscription_id,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end,
            to_char(next_period_start, 'YYYY-MM-DD') AS next_start,
            to_char(next_period_end, 'YYYY-MM-DD') AS next_end,
            activated_at::text AS activated_at
       FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

/** The camelCase row `subscriptionHasAccess` takes, read back from the DB. */
async function accessInput(subId: string) {
  const row = await subRow(subId);
  return {
    status: row.status,
    currentPeriodStart: row.period_start,
    currentPeriodEnd: row.period_end,
    nextPeriodStart: row.next_start,
    nextPeriodEnd: row.next_end,
  } as never;
}

async function subsForPlan(planId: string, exceptId?: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
  }>(
    `SELECT id, status, reconcile_reason, provider_subscription_id
       FROM payment_recurring_subscriptions WHERE plan_id = $1 AND id <> $2`,
    [planId, exceptId ?? randomUUID()],
  );
  for (const row of rows) subIds.push(row.id);
  return rows;
}

async function invoiceRows(providerInvoiceId: string) {
  const { rows } = await owner.query<{
    status: string;
    review_reason: string | null;
    period_start: string;
    period_end: string;
  }>(
    `SELECT status, review_reason,
            to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end
       FROM subscription_invoices WHERE provider_invoice_id = $1`,
    [providerInvoiceId],
  );
  return rows;
}

type Ids = Pick<Sub, "providerPlanId" | "providerSubId">;

function invoiceEvent(
  type: "invoice.created" | "invoice.paid",
  ids: Ids,
  o: {
    invoiceId: string;
    periodStart?: string;
    periodEnd?: string;
    eventId?: string;
  },
) {
  const paid = type === "invoice.paid";
  return {
    id: o.eventId ?? `evt_${randomBytes(8).toString("hex")}`,
    type,
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: o.invoiceId,
        subscription_id: ids.providerSubId,
        plan_id: ids.providerPlanId,
        amount: PRICE,
        currency: "IDR",
        period_start: o.periodStart ?? P_CUR,
        period_end: o.periodEnd ?? P_NEXT,
        hosted_url: `https://pay.doit.example/invoices/${o.invoiceId}`,
        status: paid ? "paid" : "open",
        ...(paid ? { paid_at: new Date().toISOString() } : {}),
      },
    },
  };
}

function signatureHeader(raw: string, key: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", key).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

function deliver(body: object) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw, secret))
    .send(raw);
}

const createdAnswer = (plan: Plan, providerId = `sub_${unique()}`) => ({
  id: providerId,
  plan_id: plan.providerPlanId,
  status: "pending",
  first_invoice_url: null,
});

// ---------------------------------------------------------------------------
// Item 1: concurrent starts
// ---------------------------------------------------------------------------

/** A DOIT fake whose createSubscription answers after `delayMs` (widens the race). */
function slowDoit(plan: Plan, delayMs: number) {
  const state = { calls: 0 };
  return {
    state,
    deps: {
      clientFor: async () =>
        ({
          createSubscription: async () => {
            state.calls += 1;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return createdAnswer(plan);
          },
        }) as never,
    },
  };
}

const startInput = (plan: Plan, customerProfileId: string) => ({
  planId: plan.planId,
  customerProfileId,
  idempotencyKey: `idem-${unique()}`,
});

describe("REC-52 two concurrent starts for one customer and plan create one subscription", () => {
  it("REC-52 parallel starts with different keys: one wins, the other gets CONFLICT, one DOIT call, one row", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const { state, deps } = slowDoit(plan, 200);
    const results = await Promise.allSettled([
      startSubscription(context(), startInput(plan, profileId), deps),
      startSubscription(context(), startInput(plan, profileId), deps),
    ]);
    const rows = await subsForPlan(plan.planId);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });
    expect(state.calls).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending_first_payment" });
  });

  it("REC-52 five parallel starts still leave exactly one live subscription and one DOIT call", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const { state, deps } = slowDoit(plan, 150);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        startSubscription(context(), startInput(plan, profileId), deps),
      ),
    );
    const rows = await subsForPlan(plan.planId);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(state.calls).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("REC-52 control: different customers on the same plan both start", async () => {
    const plan = await seedPlan();
    const [a, b] = [await seedProfile(), await seedProfile()];
    const { deps } = slowDoit(plan, 100);
    const results = await Promise.allSettled([
      startSubscription(context(), startInput(plan, a), deps),
      startSubscription(context(), startInput(plan, b), deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await subsForPlan(plan.planId)).toHaveLength(2);
  });

  it("REC-52 control: the same customer on two different plans both start", async () => {
    const [planA, planB] = [await seedPlan(), await seedPlan()];
    const profileId = await seedProfile();
    const results = await Promise.allSettled([
      startSubscription(
        context(),
        startInput(planA, profileId),
        slowDoit(planA, 100).deps,
      ),
      startSubscription(
        context(),
        startInput(planB, profileId),
        slowDoit(planB, 100).deps,
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // Registers both rows for cleanup before the plans are deleted.
    expect(await subsForPlan(planA.planId)).toHaveLength(1);
    expect(await subsForPlan(planB.planId)).toHaveLength(1);
  });

  it("REC-52 resuming a needs_reconcile row with a DOIT id next to a new start is CONFLICT, not a unique violation", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    // Never paid, holds a DOIT id. It blocks a new start (it can be resumed),
    // so the pending row is seeded directly to meet the live index.
    const stale = await seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "RESPONSE_MISMATCH",
      customerProfileId: profileId,
    });
    await seedSub({
      plan,
      status: "pending_first_payment",
      customerProfileId: profileId,
    });
    const resumed = await resumeSubscription(
      context(),
      stale.subId,
      new Date(),
      {
        clientFor: async () =>
          ({
            resumeSubscription: async () => ({
              id: stale.providerSubId,
              status: "active",
            }),
          }) as never,
      },
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(resumed).toMatchObject({ code: "CONFLICT" });
    expect(await subRow(stale.subId)).toMatchObject({
      status: "needs_reconcile",
    });
  });
});

describe("REC-52 the database refuses two live rows for one customer and plan", () => {
  const insertRaw = (
    plan: Plan,
    profileId: string,
    status: SubStatus,
    providerSubId: string,
  ) =>
    owner
      .query(
        `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id, start_idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9)`,
        [
          (() => {
            const id = randomUUID();
            subIds.push(id);
            return id;
          })(),
          tenantId,
          outletId,
          plan.planId,
          profileId,
          providerSubId,
          status,
          integrationId,
          `idem-${unique()}`,
        ],
      )
      .then(
        () => null,
        (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
      );

  for (const status of ["pending_first_payment", "active"] as const) {
    it(`REC-52 a second ${status} row for the same customer and plan is a unique violation (23505)`, async () => {
      const plan = await seedPlan();
      const profileId = await seedProfile();
      expect(
        await insertRaw(plan, profileId, status, `sub_${unique()}`),
      ).toBeNull();
      expect(await insertRaw(plan, profileId, status, `sub_${unique()}`)).toBe(
        "23505",
      );
    });
  }

  it("REC-52 control: a cancelled row does not block a new pending row", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    expect(
      await insertRaw(plan, profileId, "cancelled", `sub_${unique()}`),
    ).toBeNull();
    expect(
      await insertRaw(
        plan,
        profileId,
        "pending_first_payment",
        `sub_${unique()}`,
      ),
    ).toBeNull();
    expect(
      await insertRaw(plan, profileId, "cancelled", `sub_${unique()}`),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 8: sequential invoices
// ---------------------------------------------------------------------------

const P_AFTER = jakartaMonthStart(2);
const P_AFTER2 = jakartaMonthStart(3);

/** Active subscription paid for the current month, with an open invoice for the next month (N1). */
async function activeWithOpenNext() {
  const profileId = await seedProfile();
  const sub = await seedSub({
    status: "active",
    customerProfileId: profileId,
    periodStart: P_CUR,
    periodEnd: P_NEXT,
  });
  const n1 = `inv_${unique()}`;
  const created = await deliver(
    invoiceEvent("invoice.created", sub, {
      invoiceId: n1,
      periodStart: P_NEXT,
      periodEnd: P_AFTER,
    }),
  );
  expect(created.status).toBe(200);
  expect((await invoiceRows(n1))[0]).toMatchObject({ status: "open" });
  return { sub, n1 };
}

const createN2 = async (sub: Sub) => {
  const n2 = `inv_${unique()}`;
  const response = await deliver(
    invoiceEvent("invoice.created", sub, {
      invoiceId: n2,
      periodStart: P_AFTER,
      periodEnd: P_AFTER2,
    }),
  );
  expect(response.status).toBe(200);
  return n2;
};

describe("REC-53 an invoice for a period after an unpaid one is parked and re-evaluated once the previous period is paid", () => {
  it("REC-53 the next-next invoice does not stay in needs_review PERIOD_MISMATCH after the previous period is paid", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await createN2(sub);
    // Parked: never paid, never void, and no access from it yet.
    const parked = (await invoiceRows(n2))[0]!;
    expect(["paid", "void"]).not.toContain(parked.status);
    const lateDay = noonJakarta(addDays(P_AFTER, 10));
    expect(
      subscriptionHasAccess(await accessInput(sub.subId), lateDay, 3),
    ).toBe(false);

    const paid = await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n1,
        periodStart: P_NEXT,
        periodEnd: P_AFTER,
      }),
    );
    expect(paid.status).toBe(200);
    expect((await invoiceRows(n1))[0]!.status).toBe("paid");
    // Re-evaluated: now it follows the paid period, so it is a normal open invoice.
    expect((await invoiceRows(n2))[0]).toMatchObject({
      status: "open",
      review_reason: null,
    });
    // Still no access from the unpaid N2 itself.
    expect(
      subscriptionHasAccess(await accessInput(sub.subId), lateDay, 3),
    ).toBe(false);
  });

  it("REC-53 once re-evaluated, paying the next-next invoice extends access through its period", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await createN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n1,
        periodStart: P_NEXT,
        periodEnd: P_AFTER,
      }),
    );
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: P_AFTER2,
      }),
    );
    expect((await invoiceRows(n2))[0]!.status).toBe("paid");
    // Mid-way through the N2 period: covered; ten days past it: not.
    expect(
      subscriptionHasAccess(
        await accessInput(sub.subId),
        noonJakarta(addDays(P_AFTER, 3)),
        3,
      ),
    ).toBe(true);
    expect(
      subscriptionHasAccess(
        await accessInput(sub.subId),
        noonJakarta(addDays(P_AFTER2, 10)),
        3,
      ),
    ).toBe(false);
  });

  it("REC-53 paying the parked invoice before its predecessor does not extend access", async () => {
    const { sub } = await activeWithOpenNext();
    const n2 = await createN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: P_AFTER2,
      }),
    );
    const row = await subRow(sub.subId);
    // The stored paid period never jumps past the unpaid one in between.
    expect(row.period_end).toBe(P_NEXT);
    expect(row.next_start === null || row.next_start === P_NEXT).toBe(true);
    expect(
      subscriptionHasAccess(
        await accessInput(sub.subId),
        noonJakarta(addDays(P_AFTER, 3)),
        3,
      ),
    ).toBe(false);
  });

  it("REC-53 control: an invoice that directly follows the stored period is open at once", async () => {
    const profileId = await seedProfile();
    const sub = await seedSub({
      status: "active",
      customerProfileId: profileId,
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const id = `inv_${unique()}`;
    await deliver(
      invoiceEvent("invoice.created", sub, {
        invoiceId: id,
        periodStart: P_NEXT,
        periodEnd: P_AFTER,
      }),
    );
    expect((await invoiceRows(id))[0]).toMatchObject({
      status: "open",
      review_reason: null,
    });
  });
});
