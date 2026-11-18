// DOIT recurring billing, final architect fixes (brief-final-fixes.md items 1-4).
// Written from the brief and the existing test conventions, not from the
// implementation. Fail-first: every test pins behavior that does not exist yet,
// except the ones marked "control".
//
// - Item 1 (REC-53 follow-up): an invoice parked as needs_review
//   AWAITING_PREVIOUS_PERIOD must not become payable by a later release when
//   its `invoice.paid` was wrong (amount / period / plan differs, or the
//   subscription was paused / cancelled / needs_reconcile). It becomes
//   terminal: no period, no access. A clean paid parked invoice still releases.
// - Item 2 (facility quota): the subscription row is read FOR UPDATE, the
//   sweep runs one transaction per subscription (no deadlock with a pause),
//   and `revokeSubscriptionGrace` is exported.
// - Item 3: pause / cancel through the recurring service revoke the unused
//   live grace in the same transaction (no later sync needed), also with an
//   outlet-scoped context, and racing a sync leaves 0.
// - Item 4: a needs_reconcile row with a DOIT id (reason not PLAN_MISMATCH)
//   blocks a new start of the same customer + plan; resume is refused with
//   CONFLICT while another active / unresolved row exists for them.
//
// ASSUMPTIONS
// - Terminal state of a wrongly paid parked invoice: only the OUTCOME is
//   pinned (status not paid / open, review reason no longer
//   AWAITING_PREVIOUS_PERIOD, stored period unchanged, no access). The exact
//   status / reason names are not pinned.
// - Item 1 control: a parked invoice whose paid event matches exactly is
//   released by the later payment of its predecessor and becomes `paid`,
//   extending the period (that is the point of parking).
// - `revokeSubscriptionGrace(tx, context, { subscriptionId, now })` has the
//   same call shape as `syncSubscriptionQuota`; the return value is not used.
//   It is called here only as an after-the-fact revoke without the advisory
//   lock; the ledger is the assertion.
// - Pause / cancel fakes answer `{ id, status }` as DOIT does (round 3).
// - Grace tests put the paid period end on today's Jakarta date so `new Date()`
//   (what pause / cancel use inside the service) is a live grace day.
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import * as quota from "../services/facility-subscription-quota.ts";
import {
  cancelSubscription,
  pauseSubscription,
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
  asTenant,
  contextOf,
  createWorld,
  owner as worldOwner,
  seedMember,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  ledgerRows,
  outletContext,
  rejectionCode,
  seedFacility,
  type LedgerDbRow,
} from "./facility-entitlement-helpers.ts";
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
const jakartaToday = () =>
  new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const P_CUR = jakartaMonthStart(0);
const P_NEXT = jakartaMonthStart(1);
const P_AFTER = jakartaMonthStart(2);
const P_AFTER2 = jakartaMonthStart(3);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  dedicated = await createSecondTenant(owner, "finalfix");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const integrationOutlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet FF', 'Jl. FF', '{}')`,
    [
      integrationOutlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `FF-${unique()}`.toUpperCase(),
    ],
  );
  secret = `whsec-ff-${randomBytes(12).toString("hex")}`;
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
  // Same robust cleanup as payment-recurring-488-start-race.test.ts: every
  // step is isolated and the first error is rethrown at the end.
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
  await step(() => worldOwner.end());
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
// Fixtures (recurring tenant)
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
    status?: SubStatus;
    providerSubId?: string | null;
    reconcileReason?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    customerProfileId?: string;
  } = {},
): Promise<Sub> {
  const plan = options.plan ?? (await seedPlan());
  const sub: Sub = {
    ...plan,
    outletId,
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
      null,
    ],
  );
  subIds.push(sub.subId);
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
    period_start: string | null;
    period_end: string | null;
    next_start: string | null;
    next_end: string | null;
  }>(
    `SELECT status, reconcile_reason,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end,
            to_char(next_period_start, 'YYYY-MM-DD') AS next_start,
            to_char(next_period_end, 'YYYY-MM-DD') AS next_end
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

async function subsForPlan(planId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
  }>(
    `SELECT id, status FROM payment_recurring_subscriptions WHERE plan_id = $1`,
    [planId],
  );
  for (const row of rows) subIds.push(row.id);
  return rows;
}

async function invoiceRows(providerInvoiceId: string) {
  const { rows } = await owner.query<{
    status: string;
    review_reason: string | null;
  }>(
    `SELECT status, review_reason FROM subscription_invoices WHERE provider_invoice_id = $1`,
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
    amount?: number;
    planId?: string;
  },
) {
  const paid = type === "invoice.paid";
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type,
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: o.invoiceId,
        subscription_id: ids.providerSubId,
        plan_id: o.planId ?? ids.providerPlanId,
        amount: o.amount ?? PRICE,
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

function countingDoit(
  plan: Plan,
  method: "createSubscription" | "resumeSubscription",
  answer: object,
) {
  const state = { calls: 0 };
  return {
    state,
    deps: {
      clientFor: async () =>
        ({
          [method]: async () => {
            state.calls += 1;
            return method === "createSubscription"
              ? createdAnswer(plan)
              : answer;
          },
        }) as never,
    },
  };
}

// ---------------------------------------------------------------------------
// Item 1: parked invoice paid wrongly must become terminal
// ---------------------------------------------------------------------------

/** Active, paid for the current month; N1 (next month) is open. */
async function activeWithOpenNext() {
  const profileId = await seedProfile();
  const sub = await seedSub({
    status: "active",
    customerProfileId: profileId,
    periodStart: P_CUR,
    periodEnd: P_NEXT,
  });
  const n1 = `inv_${unique()}`;
  expect(
    (
      await deliver(
        invoiceEvent("invoice.created", sub, {
          invoiceId: n1,
          periodStart: P_NEXT,
          periodEnd: P_AFTER,
        }),
      )
    ).status,
  ).toBe(200);
  return { sub, n1 };
}

/** N2 (the period after N1) is created while N1 is unpaid: it is parked. */
async function parkedN2(sub: Sub) {
  const n2 = `inv_${unique()}`;
  expect(
    (
      await deliver(
        invoiceEvent("invoice.created", sub, {
          invoiceId: n2,
          periodStart: P_AFTER,
          periodEnd: P_AFTER2,
        }),
      )
    ).status,
  ).toBe(200);
  return n2;
}

const payN1 = async (sub: Sub, n1: string) =>
  expect(
    (
      await deliver(
        invoiceEvent("invoice.paid", sub, {
          invoiceId: n1,
          periodStart: P_NEXT,
          periodEnd: P_AFTER,
        }),
      )
    ).status,
  ).toBe(200);

/** After N1 is paid, the wrongly paid N2 gave no period and no access. */
async function expectN2Terminal(sub: Sub, n2: string) {
  const invoice = (await invoiceRows(n2))[0]!;
  expect(["paid", "open"]).not.toContain(invoice.status);
  expect(invoice.review_reason).not.toBe("AWAITING_PREVIOUS_PERIOD");
  const row = await subRow(sub.subId);
  // N1 (paid in advance) waits in the next slot; N2 must never extend it.
  expect(row.period_end).toBe(P_NEXT);
  expect(row.next_start).toBe(P_NEXT);
  expect(row.next_end).toBe(P_AFTER);
  expect(
    subscriptionHasAccess(
      await accessInput(sub.subId),
      noonJakarta(addDays(P_AFTER, 3)),
      3,
    ),
  ).toBe(false);
}

describe("item 1: a parked invoice that was paid wrongly never becomes payable", () => {
  it("REC-53 underpaid parked invoice: after the predecessor is paid it gives no period", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await parkedN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: P_AFTER2,
        amount: PRICE - 50_000,
      }),
    );
    await payN1(sub, n1);
    await expectN2Terminal(sub, n2);
  });

  it("REC-53 parked invoice paid with a different period: no period after release", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await parkedN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: addDays(P_AFTER2, 5),
      }),
    );
    await payN1(sub, n1);
    await expectN2Terminal(sub, n2);
  });

  it("REC-53 parked invoice paid with a different plan (review reason set): no period after release", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await parkedN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: P_AFTER2,
        planId: `plan_other_${unique()}`,
      }),
    );
    await payN1(sub, n1);
    await expectN2Terminal(sub, n2);
  });

  for (const status of ["paused", "cancelled", "needs_reconcile"] as const) {
    it(`REC-53 parked invoice paid while the subscription is ${status}: no period once it is active again and the predecessor is paid`, async () => {
      const { sub, n1 } = await activeWithOpenNext();
      const n2 = await parkedN2(sub);
      await owner.query(
        `UPDATE payment_recurring_subscriptions
            SET status = $2::varchar,
                reconcile_reason = CASE WHEN $2::varchar = 'needs_reconcile' THEN 'RESPONSE_MISMATCH' END,
                paused_at = CASE WHEN $2::varchar = 'paused' THEN now() END,
                cancelled_at = CASE WHEN $2::varchar = 'cancelled' THEN now() END
          WHERE id = $1`,
        [sub.subId, status],
      );
      await deliver(
        invoiceEvent("invoice.paid", sub, {
          invoiceId: n2,
          periodStart: P_AFTER,
          periodEnd: P_AFTER2,
        }),
      );
      // The operator fixes the subscription; the predecessor is then paid.
      await owner.query(
        `UPDATE payment_recurring_subscriptions
            SET status = 'active', reconcile_reason = NULL, paused_at = NULL, cancelled_at = NULL
          WHERE id = $1`,
        [sub.subId],
      );
      await payN1(sub, n1);
      await expectN2Terminal(sub, n2);
    });
  }

  it("REC-53 control: a parked invoice paid exactly as created is released by the predecessor's payment", async () => {
    const { sub, n1 } = await activeWithOpenNext();
    const n2 = await parkedN2(sub);
    await deliver(
      invoiceEvent("invoice.paid", sub, {
        invoiceId: n2,
        periodStart: P_AFTER,
        periodEnd: P_AFTER2,
      }),
    );
    await payN1(sub, n1);
    expect((await invoiceRows(n2))[0]!.status).toBe("paid");
    const row = await subRow(sub.subId);
    expect(row.next_start).toBe(P_NEXT);
    expect(row.next_end).toBe(P_AFTER2);
  });
});

// ---------------------------------------------------------------------------
// Item 4: blocking start and guarded resume
// ---------------------------------------------------------------------------

describe("item 4: start is blocked by an unresolved DOIT row; resume refuses a sibling", () => {
  const startWith = async (plan: Plan, profileId: string) => {
    const doit = countingDoit(plan, "createSubscription", {});
    const outcome = await startSubscription(
      context(),
      {
        planId: plan.planId,
        customerProfileId: profileId,
        idempotencyKey: `idem-${unique()}`,
      },
      doit.deps,
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    return { outcome, calls: doit.state.calls };
  };

  it("REC-54 a needs_reconcile row with a DOIT id (RESPONSE_MISMATCH) blocks a new start with CONFLICT and no DOIT call", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    await seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "RESPONSE_MISMATCH",
      customerProfileId: profileId,
    });
    const { outcome, calls } = await startWith(plan, profileId);
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    expect(await subsForPlan(plan.planId)).toHaveLength(1);
  });

  // legend-ycb85 / legend-965 (reverses the old controls): a PLAN_MISMATCH row
  // with a DOIT id is still a live DOIT subscription, so it BLOCKS a new start.
  it("REC-54 a needs_reconcile PLAN_MISMATCH row with a DOIT id blocks a new start with CONFLICT and no DOIT call", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    await seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      customerProfileId: profileId,
    });
    const { outcome, calls } = await startWith(plan, profileId);
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    expect(await subsForPlan(plan.planId)).toHaveLength(1);
  });

  const stale = (plan: Plan, profileId: string) =>
    seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "RESPONSE_MISMATCH",
      customerProfileId: profileId,
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
  const resumeOf = async (sub: Sub) => {
    const doit = countingDoit({ ...sub }, "resumeSubscription", {
      id: sub.providerSubId,
      status: "active",
    });
    const outcome = await resumeSubscription(
      context(),
      sub.subId,
      new Date(),
      doit.deps,
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    return { outcome, calls: doit.state.calls };
  };

  it("REC-54 resume is refused with CONFLICT while a pending_first_payment row of the same customer and plan exists", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const old = await stale(plan, profileId);
    await seedSub({
      plan,
      status: "pending_first_payment",
      customerProfileId: profileId,
    });
    const { outcome, calls } = await resumeOf(old);
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    expect((await subRow(old.subId)).status).toBe("needs_reconcile");
  });

  it("REC-54 resume is refused with CONFLICT while an active row of the same customer and plan exists", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const old = await stale(plan, profileId);
    await seedSub({
      plan,
      status: "active",
      customerProfileId: profileId,
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const { outcome, calls } = await resumeOf(old);
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    expect((await subRow(old.subId)).status).toBe("needs_reconcile");
  });

  // legend-965: provisioning + needs_reconcile are one unresolved set per
  // tenant + plan + customer (unique index), so a second unresolved sibling can
  // no longer exist: the database refuses it, and the first row stays as it was.
  it("REC-54 a second unresolved (needs_reconcile with DOIT id) row for the same customer and plan is refused by the database", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const old = await stale(plan, profileId);
    const second = await stale(plan, profileId).then(
      () => null,
      (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
    );
    expect(second).toBe("23505");
    expect((await subRow(old.subId)).status).toBe("needs_reconcile");
  });

  it("REC-54 control: resume works when the only other row is cancelled, and for another customer", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const old = await stale(plan, profileId);
    await seedSub({
      plan,
      status: "cancelled",
      customerProfileId: profileId,
    });
    await seedSub({
      plan,
      status: "active",
      customerProfileId: await seedProfile(),
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    await owner.query(
      `UPDATE payment_recurring_subscriptions SET activated_at = now() - interval '40 days' WHERE id = $1`,
      [old.subId],
    );
    const { outcome, calls } = await resumeOf(old);
    expect(outcome).toBeNull();
    expect(calls).toBe(1);
    expect((await subRow(old.subId)).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Items 2 and 3: facility quota locking and revoke on pause / cancel
// ---------------------------------------------------------------------------

const QUOTA = 10;
const worldIntegrations = new Map<string, string>();

/** One DOIT integration per world (the service resolves it by id). */
async function integrationOfWorld(world: World): Promise<string> {
  const cached = worldIntegrations.get(world.tenantId);
  if (cached) return cached;
  await worldOwner.query(
    `UPDATE tenants SET feature_flags = '{"modules":["loyalty"],"integrationProviders":["doit"]}' WHERE id = $1`,
    [world.tenantId],
  );
  const created = await upsertIntegration(
    contextOf(world.tenantId),
    {
      outletId: world.outletB as OutletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: {
        apiKey: `doit-key-${unique()}`,
        webhookSecret: `whsec-w-${randomBytes(8).toString("hex")}`,
      },
    },
    actor,
  );
  await setIntegrationStatus(
    contextOf(world.tenantId),
    created.id,
    { status: "active" },
    actor,
  );
  worldIntegrations.set(world.tenantId, created.id);
  return created.id;
}

type Fixture = {
  world: World;
  outletId: string;
  facilityId: string;
  customerProfileId: string;
  subscriptionId: string;
  providerSubId: string;
};

/**
 * Facility, facility plan, member and an active recurring subscription whose
 * paid period ENDS today (Jakarta) unless `periodEnd` is given: `new Date()`
 * is then on grace day 0.
 */
async function setup(
  options: { world?: World; grace?: number; periodEnd?: string } = {},
): Promise<Fixture> {
  const world = options.world ?? (await createWorld());
  const integration = await integrationOfWorld(world);
  const facilityId = await seedFacility(world, world.outletA);
  const member = await seedMember(world.tenantId);
  const recurringPlanId = randomUUID();
  const subscriptionId = randomUUID();
  const providerPlanId = `plan_${recurringPlanId.slice(0, 8)}`;
  const providerSubId = `sub_${subscriptionId.slice(0, 8)}`;
  const periodEnd = options.periodEnd ?? jakartaToday();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
       VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', 150000, 'month', 'active', $5)`,
      [
        recurringPlanId,
        world.tenantId,
        world.outletA,
        providerPlanId,
        integration,
      ],
    );
    await client.query(
      `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
              current_period_start, current_period_end, activated_at, gateway_integration_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, now() - interval '90 days', $9)`,
      [
        subscriptionId,
        world.tenantId,
        world.outletA,
        recurringPlanId,
        member.id,
        providerSubId,
        addDays(periodEnd, -30),
        periodEnd,
        integration,
      ],
    );
    await client.query(
      `INSERT INTO facility_subscription_plans (id, tenant_id, outlet_id, facility_id, name, price_idr, quota_per_period, interval, max_per_day, provider_plan_id, is_active)
       VALUES ($1, $2, $3, $4, 'Langganan', 150000, $5, 'month', NULL, $6, true)`,
      [
        randomUUID(),
        world.tenantId,
        world.outletA,
        facilityId,
        QUOTA,
        providerPlanId,
      ],
    );
    if (options.grace !== undefined)
      await client.query(
        `INSERT INTO payment_recurring_outlet_settings (tenant_id, outlet_id, grace_days)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET grace_days = EXCLUDED.grace_days`,
        [world.tenantId, world.outletA, options.grace],
      );
  });
  return {
    world,
    outletId: world.outletA,
    facilityId,
    customerProfileId: member.id,
    subscriptionId,
    providerSubId,
  };
}

function sync(fixture: Fixture, at: Date) {
  return withTenant(db, fixture.world.context, (tx) =>
    quota.syncSubscriptionQuota(tx, fixture.world.context, {
      subscriptionId: fixture.subscriptionId,
      now: at,
    }),
  );
}

function redeem(fixture: Fixture, at: Date) {
  return entitlementsOf(fixture.world).redeem({
    facilityId: fixture.facilityId,
    customerProfileId: fixture.customerProfileId,
    at,
  });
}

const rows = (fixture: Fixture): Promise<LedgerDbRow[]> =>
  ledgerRows(fixture.world.tenantId, {
    customerProfileId: fixture.customerProfileId,
  });
const sumOf = (list: LedgerDbRow[], type: LedgerDbRow["type"]) =>
  list
    .filter((row) => row.type === type)
    .reduce((total, row) => total + row.sessions, 0);
/** grants - cancel - expire: what the customer is still entitled to. */
async function netGranted(fixture: Fixture): Promise<number> {
  const list = await rows(fixture);
  return sumOf(list, "grant") - sumOf(list, "cancel") - sumOf(list, "expire");
}
async function statusOf(fixture: Fixture): Promise<string> {
  const { rows: found } = await worldOwner.query<{ status: string }>(
    "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
    [fixture.subscriptionId],
  );
  return found[0]!.status;
}

const doitAnswering = (fixture: Fixture, status: "paused" | "cancelled") =>
  ({
    clientFor: async () =>
      ({
        pauseSubscription: async () => ({
          id: fixture.providerSubId,
          status,
        }),
        cancelSubscription: async () => ({
          id: fixture.providerSubId,
          status,
        }),
      }) as never,
  }) as never;

const pause = (
  fixture: Fixture,
  ctx: ScopedTenantContext = fixture.world.context,
) =>
  pauseSubscription(
    ctx,
    fixture.subscriptionId,
    new Date(),
    doitAnswering(fixture, "paused"),
  );
const cancel = (
  fixture: Fixture,
  ctx: ScopedTenantContext = fixture.world.context,
) =>
  cancelSubscription(
    ctx,
    fixture.subscriptionId,
    new Date(),
    doitAnswering(fixture, "cancelled"),
  );

describe("item 3: pause / cancel revoke the unused live grace in the same transaction", () => {
  it("FAC-07 488-3 pausing during grace leaves 0 live grace, with no later sync", async () => {
    const fixture = await setup({ grace: 3 });
    const issued = await sync(fixture, new Date());
    expect(issued.issued).toHaveLength(1);
    expect(await netGranted(fixture)).toBe(1);

    await pause(fixture);

    expect(await statusOf(fixture)).toBe("paused");
    expect(await netGranted(fixture)).toBe(0);
    expect(await rejectionCode(redeem(fixture, new Date()))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 cancelling during grace leaves 0 live grace, with no later sync", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, new Date());
    expect(await netGranted(fixture)).toBe(1);

    await cancel(fixture);

    expect(await statusOf(fixture)).toBe("cancelled");
    expect(await netGranted(fixture)).toBe(0);
    expect(await rejectionCode(redeem(fixture, new Date()))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 pausing with an outlet-scoped context still revokes the grace", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, new Date());

    await pause(
      fixture,
      outletContext(fixture.world.tenantId, fixture.outletId),
    );

    expect(await statusOf(fixture)).toBe("paused");
    expect(await netGranted(fixture)).toBe(0);
  });

  it("FAC-07 488-3 control: pausing in the middle of a paid period keeps the paid grant", async () => {
    const fixture = await setup({
      grace: 3,
      periodEnd: addDays(jakartaToday(), 20),
    });
    await sync(fixture, new Date());
    expect(await netGranted(fixture)).toBe(QUOTA);

    await pause(fixture);

    expect(await statusOf(fixture)).toBe("paused");
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 488-3 a sync racing a pause leaves 0 live grace, whatever the order", async () => {
    for (let i = 0; i < 3; i += 1) {
      const fixture = await setup({ grace: 3 });
      await sync(fixture, new Date());
      const results = await Promise.allSettled([
        sync(fixture, new Date()),
        pause(fixture),
        sync(fixture, new Date()),
      ]);
      expect(results[1]!.status, `pause run ${i}`).toBe("fulfilled");
      expect(await statusOf(fixture)).toBe("paused");
      // No extra sync afterwards: the pause alone must have closed the grace.
      expect(await netGranted(fixture), `run ${i}`).toBe(0);
    }
  });
});

describe("item 2: row lock, one transaction per subscription, revokeSubscriptionGrace", () => {
  it("FAC-07 488-2 the sync reads the subscription row FOR UPDATE: a pause that is not yet committed is awaited, not overtaken", async () => {
    const fixture = await setup({ grace: 3 });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Another writer pauses the row and holds its transaction open.
    const holder = asTenant(fixture.world.tenantId, async (client) => {
      await client.query(
        "UPDATE payment_recurring_subscriptions SET status = 'paused', paused_at = now() WHERE id = $1",
        [fixture.subscriptionId],
      );
      locked();
      await gate;
    });
    await Promise.race([lockTaken, holder]);
    const syncing = sync(fixture, new Date());
    // A sync that reads without the row lock would already have granted by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await holder;
    await syncing;
    expect(await statusOf(fixture)).toBe("paused");
    expect(await netGranted(fixture)).toBe(0);
  });

  it("FAC-07 488-2 the sweep and pauses of several subscriptions at once never deadlock and leave 0 grace", async () => {
    const world = await createWorld();
    const fixtures: Fixture[] = [];
    for (let i = 0; i < 4; i += 1) {
      const fixture = await setup({ world, grace: 3 });
      await sync(fixture, new Date());
      fixtures.push(fixture);
    }
    const results = await Promise.allSettled([
      quota.syncSubscriptionQuotas(world.context, new Date()),
      ...fixtures.map((fixture) => pause(fixture)),
      quota.syncSubscriptionQuotas(world.context, new Date()),
    ]);
    expect(
      results.filter((r) => r.status === "rejected").map((r) => String(r)),
    ).toEqual([]);
    for (const fixture of fixtures) {
      expect(await statusOf(fixture)).toBe("paused");
      expect(await netGranted(fixture)).toBe(0);
    }
  });

  it("FAC-07 488-2 revokeSubscriptionGrace is exported and cancels the unused grace of a paused subscription, once", async () => {
    expect(typeof quota.revokeSubscriptionGrace).toBe("function");
    const fixture = await setup({ grace: 3 });
    await sync(fixture, new Date());
    await worldOwner.query(
      "UPDATE payment_recurring_subscriptions SET status = 'paused' WHERE id = $1",
      [fixture.subscriptionId],
    );
    const {
      rows: [subRow],
    } = await worldOwner.query<{
      customer_profile_id: string;
      current_period_end: string | null;
    }>(
      `SELECT customer_profile_id,
              to_char(current_period_end, 'YYYY-MM-DD') AS current_period_end
         FROM payment_recurring_subscriptions WHERE id = $1`,
      [fixture.subscriptionId],
    );
    const revoke = () =>
      withTenant(db, fixture.world.context, (tx) =>
        quota.revokeSubscriptionGrace(
          tx,
          fixture.world.context,
          {
            id: fixture.subscriptionId,
            customerProfileId: subRow!.customer_profile_id,
            currentPeriodEnd: subRow!.current_period_end,
          },
          new Date(),
        ),
      );
    await revoke();
    expect(await netGranted(fixture)).toBe(0);
    // Idempotent: a second revoke writes no second cancel row.
    await revoke();
    expect(
      (await rows(fixture)).filter((r) => r.type === "cancel"),
    ).toHaveLength(1);
    expect(await netGranted(fixture)).toBe(0);
  });
});
