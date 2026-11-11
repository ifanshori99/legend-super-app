// DOIT recurring billing, round 4 (docs/briefs/480-doit-recurring-round4.md;
// contract in docs/briefs/480-design.md). Written from the brief and the design
// contract, not from the implementation. Fail-first: every test below pins
// behavior that does not exist yet.
//
// - REC-35 (item 1): a needs_reconcile subscription WITH a DOIT id can pause /
//   resume / cancel; a validated answer applies the normal status rules and
//   clears `reconcile_reason`; a mismatching answer keeps it needs_reconcile;
//   without a DOIT id only a local cancel works (no DOIT call).
// - REC-36 (item 1): a new idempotency key is not blocked by a needs_reconcile
//   row that already has a DOIT id (a row without an id still blocks).
// - REC-37 (item 2): a start answered for another plan stores the DOIT id with
//   needs_reconcile / PLAN_MISMATCH; its invoice events land in needs_review.
// - REC-38 (item 3): parked events whose subscription now exists skip the
//   retry back-off, created before paid, across sweeps.
// - REC-39 (item 4): an event stuck in `received` for more than ~5 minutes is
//   retried by the regular worker (no 24 h cap).
// - REC-40 (item 5): an automatic start retry of an intent older than 24 h is
//   refused (needs_reconcile / INTENT_EXPIRED, no DOIT call, CONFLICT).
// - REC-41 (item 6): an event for an unknown subscription is answered 200
//   ("parked"), stored durably, and processed once the subscription appears.
// - REC-42 (item 7): active -> past_due after the 3 day grace, idempotent worker.
// - REC-43 (item 7): a late payment makes it active again, no duplicate period.
//
// ASSUMPTIONS
// - Error codes use the repo's `HttpError.code`: CONFLICT for the refusals
//   (design: "CONFLICT/konflik status"); other codes are not pinned.
// - Invoice due date = period_start of the invoice's period (design item 7); the
//   subscription's current period ends (exclusive) on that same day. "Day N" is
//   noon Asia/Jakarta of due + N days; grace is RECURRING_GRACE_DAYS (3), so day
//   3 is still active and day 4 is past_due. Access on day 3 (period already
//   over) is deliberately NOT asserted.
// - `markOverdueSubscriptionsPastDue` only moves `active` rows with an `open`
//   invoice past the grace; paused / cancelled / needs_reconcile /
//   pending_first_payment rows and rows whose invoice is paid stay as they are.
// - The 24 h refusal is also applied to a `needs_reconcile` intent without a
//   DOIT id (a lost response retried with the same key after 25 h): the design
//   names `provisioning`, the brief's rationale (DOIT idempotency window) covers
//   both. Flagged for the lead.
// - The parked webhook answer body is `{ received: true, status: "parked" }`.
// - An existing REC-28 case in payment-recurring-reconcile.test.ts ("an
//   unnarrowed run honors the back-off", second subscription already seeded)
//   conflicts with item 3; that file is not touched here.
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
  RECURRING_GRACE_DAYS,
  cancelSubscription,
  markOverdueSubscriptionsPastDue,
  pauseSubscription,
  resumeSubscription,
  startSubscription,
  subscriptionHasAccess,
} from "../services/payment-recurring.service";
import {
  clearDoitWebhookSecretCache,
  reprocessParkedRecurringEvents,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
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
const MIN = 60_000;

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
let integrationId = "";
let secret = "";
const planIds: string[] = [];
const subIds: string[] = [];
const profileCleanups: (() => Promise<void>)[] = [];

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

// ---------------------------------------------------------------------------
// Date helpers (Asia/Jakarta business dates)
// ---------------------------------------------------------------------------

function jakartaToday(): string {
  return new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
}
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
  dedicated = await createSecondTenant(owner, "round4");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const integrationOutlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet R4', 'Jl. R4', '{}')`,
    [
      integrationOutlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `R4-${unique()}`.toUpperCase(),
    ],
  );
  secret = `whsec-r4-${randomBytes(12).toString("hex")}`;
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
  planId: string;
  providerPlanId: string;
  subId: string;
  /** Null for rows without a DOIT subscription id. */
  providerSubId: string | null;
  customerProfileId: string;
};

type Plan = { planId: string; providerPlanId: string };

async function seedPlan(): Promise<Plan> {
  const plan: Plan = {
    planId: randomUUID(),
    providerPlanId: `plan_${unique()}`,
  };
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, 'month', 'active', $6)`,
    [
      plan.planId,
      tenantId,
      outletId,
      plan.providerPlanId,
      PRICE,
      integrationId,
    ],
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
    startKey?: string | null;
    /** Backdates created_at (hours) after the insert. */
    createdHoursAgo?: number;
  } = {},
): Promise<Sub> {
  const plan = options.plan ?? (await seedPlan());
  const sub: Sub = {
    ...plan,
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
      outletId,
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

/** Seeds an invoice row directly (owner). */
async function seedInvoice(
  sub: Sub,
  o: {
    status: "open" | "paid" | "void";
    periodStart: string;
    periodEnd: string;
    providerInvoiceId?: string;
  },
): Promise<string> {
  const providerInvoiceId = o.providerInvoiceId ?? `inv_${unique()}`;
  await owner.query(
    `INSERT INTO subscription_invoices (id, tenant_id, outlet_id, subscription_id, provider_invoice_id, period_start, period_end,
            amount_idr, hosted_url, status, source_event_id, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::varchar, $11,
             CASE WHEN $10::varchar = 'paid' THEN now() END)`,
    [
      randomUUID(),
      tenantId,
      outletId,
      sub.subId,
      providerInvoiceId,
      o.periodStart,
      o.periodEnd,
      PRICE,
      `https://pay.doit.example/invoices/${providerInvoiceId}`,
      o.status,
      randomUUID(),
    ],
  );
  return providerInvoiceId;
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

function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
  );
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

async function invoicesOfSub(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    period_start: string;
  }>(
    `SELECT status, to_char(period_start, 'YYYY-MM-DD') AS period_start
       FROM subscription_invoices WHERE subscription_id = $1`,
    [subId],
  );
  return rows;
}

async function eventRow(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    `SELECT status, last_error_code FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows[0];
}

/** Moves a stored event into the past (received and last touched). */
const backdate = (eventId: string, minutes: number) =>
  owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - make_interval(mins => $2),
            updated_at = now() - make_interval(mins => $2)
      WHERE tenant_id = $1 AND event_id = $3`,
    [tenantId, minutes, eventId],
  );

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

/** A DOIT client fake that records calls and answers with `answer`. */
function fakeDoit(method: string, answer: unknown) {
  const state = { calls: 0 };
  return {
    state,
    deps: {
      clientFor: async () =>
        ({
          [method]: async () => {
            state.calls += 1;
            return answer;
          },
        }) as never,
    },
  };
}

const createdAnswer = (plan: Plan, providerId = `sub_${unique()}`) => ({
  id: providerId,
  plan_id: plan.providerPlanId,
  status: "pending",
  first_invoice_url: null,
});

// ---------------------------------------------------------------------------
// REC-35 (item 1): needs_reconcile with a DOIT id can be recovered
// ---------------------------------------------------------------------------

describe("REC-35 a needs_reconcile subscription with a DOIT id can pause, resume or cancel", () => {
  const actions = {
    pause: {
      run: pauseSubscription,
      method: "pauseSubscription",
      expected: "paused",
      wrong: "active",
    },
    resume: {
      run: resumeSubscription,
      method: "resumeSubscription",
      expected: "active",
      wrong: "paused",
    },
    cancel: {
      run: cancelSubscription,
      method: "cancelSubscription",
      expected: "cancelled",
      wrong: "active",
    },
  } as const;

  // A mismatch row with a period was paid before: it was activated earlier.
  const seedMismatch = async (
    providerSubId: string | null = `sub_${unique()}`,
  ) => {
    const sub = await seedSub({
      status: "needs_reconcile",
      reconcileReason: "RESPONSE_MISMATCH",
      providerSubId,
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    await owner.query(
      `UPDATE payment_recurring_subscriptions SET activated_at = now() - interval '40 days' WHERE id = $1`,
      [sub.subId],
    );
    return sub;
  };

  for (const action of ["pause", "resume", "cancel"] as const) {
    const a = actions[action];

    it(`REC-35 ${action} from needs_reconcile with a DOIT id applies the confirmed status and clears the reconcile reason`, async () => {
      const sub = await seedMismatch();
      const { state, deps } = fakeDoit(a.method, {
        id: sub.providerSubId,
        status: a.expected,
      });
      const result = await a.run(context(), sub.subId, new Date(), deps);
      expect(result.status).toBe(a.expected);
      expect(state.calls).toBe(1);
      expect(await subRow(sub.subId)).toMatchObject({
        status: a.expected,
        reconcile_reason: null,
        provider_subscription_id: sub.providerSubId,
      });
    });

    it(`REC-35 ${action} from needs_reconcile with a DOIT answer that does not match stays needs_reconcile`, async () => {
      for (const answer of [
        (s: Sub) => ({ id: s.providerSubId, status: a.wrong }),
        () => ({ id: `sub_other_${unique()}`, status: a.expected }),
        () => ({}),
      ]) {
        const sub = await seedMismatch();
        const { deps } = fakeDoit(a.method, answer(sub));
        expect(
          await codeOf(a.run(context(), sub.subId, new Date(), deps)),
        ).toBe("CONFLICT");
        expect((await subRow(sub.subId)).status).toBe("needs_reconcile");
      }
    });
  }

  it("REC-35 resume after a mismatch restores access for a subscription whose period covers today", async () => {
    const sub = await seedMismatch();
    expect(
      subscriptionHasAccess(await accessInput(sub.subId), new Date()),
    ).toBe(false);
    const { deps } = fakeDoit("resumeSubscription", {
      id: sub.providerSubId,
      status: "active",
    });
    await resumeSubscription(context(), sub.subId, new Date(), deps);
    expect(
      subscriptionHasAccess(await accessInput(sub.subId), new Date()),
    ).toBe(true);
  });

  it("REC-35 without a DOIT id, pause, resume and cancel are refused and DOIT is never called", async () => {
    for (const action of ["pause", "resume", "cancel"] as const) {
      const a = actions[action];
      const sub = await seedMismatch(null);
      const { state, deps } = fakeDoit(a.method, {
        id: "sub_none",
        status: a.expected,
      });
      expect(
        await codeOf(a.run(context(), sub.subId, new Date(), deps)),
        `${action} without a DOIT id`,
      ).toBe("CONFLICT");
      expect(state.calls).toBe(0);
      expect((await subRow(sub.subId)).status).toBe("needs_reconcile");
    }
  });
});

describe("REC-35 a PLAN_MISMATCH row may only be cancelled", () => {
  const seedPlanMismatch = async () => {
    const sub = await seedSub({
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      providerSubId: `sub_${unique()}`,
    });
    return sub;
  };

  it("REC-35 pause and resume are refused, DOIT is not called, and the marker stays", async () => {
    for (const [run, method] of [
      [pauseSubscription, "pauseSubscription"],
      [resumeSubscription, "resumeSubscription"],
    ] as const) {
      const sub = await seedPlanMismatch();
      const { state, deps } = fakeDoit(method, {
        id: sub.providerSubId,
        status: "active",
      });
      expect(await codeOf(run(context(), sub.subId, new Date(), deps))).toBe(
        "CONFLICT",
      );
      expect(state.calls).toBe(0);
      expect(await subRow(sub.subId)).toMatchObject({
        status: "needs_reconcile",
        reconcile_reason: "PLAN_MISMATCH",
      });
    }
  });

  it("REC-35 cancel works when DOIT confirms", async () => {
    const sub = await seedPlanMismatch();
    const { state, deps } = fakeDoit("cancelSubscription", {
      id: sub.providerSubId,
      status: "cancelled",
    });
    const result = await cancelSubscription(
      context(),
      sub.subId,
      new Date(),
      deps,
    );
    expect(result.status).toBe("cancelled");
    expect(state.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// REC-36 (item 1): a mismatch row with a DOIT id does not block a new key
// ---------------------------------------------------------------------------

describe("REC-36 a new idempotency key is not blocked by a needs_reconcile row that has a DOIT id", () => {
  it("REC-36 a new key starts normally next to a PLAN_MISMATCH row that holds a DOIT id", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const stale = await seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      customerProfileId: profileId,
      startKey: `idem-${unique()}`,
    });
    const providerId = `sub_${unique()}`;
    const { state, deps } = fakeDoit(
      "createSubscription",
      createdAnswer(plan, providerId),
    );
    const result = await startSubscription(
      context(),
      {
        planId: plan.planId,
        customerProfileId: profileId,
        idempotencyKey: `idem-${unique()}`,
      },
      deps,
    );
    expect(result.subscription.status).toBe("pending_first_payment");
    expect(state.calls).toBe(1);
    const rows = await subsForPlan(plan.planId, stale.subId);
    expect(rows).toEqual([
      expect.objectContaining({
        status: "pending_first_payment",
        provider_subscription_id: providerId,
      }),
    ]);
    // The old mismatch row is untouched.
    expect((await subRow(stale.subId)).status).toBe("needs_reconcile");
  });

  it("REC-36 a needs_reconcile row WITHOUT a DOIT id still blocks a new key (control)", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    await seedSub({
      plan,
      status: "needs_reconcile",
      reconcileReason: "PROVIDER_ERROR",
      providerSubId: null,
      customerProfileId: profileId,
      startKey: `idem-${unique()}`,
    });
    const { state, deps } = fakeDoit("createSubscription", createdAnswer(plan));
    expect(
      await codeOf(
        startSubscription(
          context(),
          {
            planId: plan.planId,
            customerProfileId: profileId,
            idempotencyKey: `idem-${unique()}`,
          },
          deps,
        ),
      ),
    ).toBe("CONFLICT");
    expect(state.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REC-37 (item 2): PLAN_MISMATCH keeps the DOIT subscription id
// ---------------------------------------------------------------------------

describe("REC-37 a start answered for another plan stores the DOIT id", () => {
  it("REC-37 the row is needs_reconcile / PLAN_MISMATCH and holds the DOIT subscription id", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const providerId = `sub_${unique()}`;
    const { deps } = fakeDoit("createSubscription", {
      ...createdAnswer(plan, providerId),
      plan_id: `plan_other_${unique()}`,
    });
    const code = await codeOf(
      startSubscription(
        context(),
        {
          planId: plan.planId,
          customerProfileId: profileId,
          idempotencyKey: `idem-${unique()}`,
        },
        deps,
      ),
    );
    expect(code).toBe("CONFLICT");
    const rows = await subsForPlan(plan.planId);
    expect(rows).toEqual([
      expect.objectContaining({
        status: "needs_reconcile",
        reconcile_reason: "PLAN_MISMATCH",
        provider_subscription_id: providerId,
      }),
    ]);
  });

  it("REC-37 a paid invoice for that subscription is needs_review SUBSCRIPTION_NEEDS_RECONCILE, not an unknown subscription, and never activates", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const providerId = `sub_${unique()}`;
    const { deps } = fakeDoit("createSubscription", {
      ...createdAnswer(plan, providerId),
      plan_id: `plan_other_${unique()}`,
    });
    await codeOf(
      startSubscription(
        context(),
        {
          planId: plan.planId,
          customerProfileId: profileId,
          idempotencyKey: `idem-${unique()}`,
        },
        deps,
      ),
    );
    const [row] = await subsForPlan(plan.planId);
    expect(row).toBeDefined();
    const sub: Sub = {
      ...plan,
      subId: row!.id,
      providerSubId: providerId,
      customerProfileId: profileId,
    };
    const invoiceId = await seedInvoice(sub, {
      status: "open",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const body = invoiceEvent("invoice.paid", sub, { invoiceId });
    expect((await deliver(body)).status).toBe(200);
    expect((await eventRow(body.id))?.last_error_code).not.toBe(
      "UNKNOWN_SUBSCRIPTION",
    );
    expect(await invoiceRows(invoiceId)).toEqual([
      expect.objectContaining({
        status: "needs_review",
        review_reason: "SUBSCRIPTION_NEEDS_RECONCILE",
      }),
    ]);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      activated_at: null,
    });
  });
});

// ---------------------------------------------------------------------------
// REC-38 (item 3): parked events skip the back-off once the subscription exists
// ---------------------------------------------------------------------------

describe("REC-38 parked events whose subscription now exists are processed without waiting, created before paid", () => {
  async function parkPair() {
    const plan = await seedPlan();
    const ids: Ids = {
      providerPlanId: plan.providerPlanId,
      providerSubId: `sub_${unique()}`,
    };
    const invoiceId = `inv_${unique()}`;
    const created = invoiceEvent("invoice.created", ids, { invoiceId });
    const paid = invoiceEvent("invoice.paid", ids, { invoiceId });
    // Reordered delivery: paid first, created second; the subscription is unknown.
    await deliver(paid);
    await deliver(created);
    for (const event of [paid, created])
      expect(await eventRow(event.id)).toMatchObject({
        status: "failed",
        last_error_code: "UNKNOWN_SUBSCRIPTION",
      });
    return { plan, ids, invoiceId, created, paid };
  }

  async function subscriptionAppears(plan: Plan, ids: Ids) {
    const sub = await seedSub({ plan, providerSubId: ids.providerSubId });
    return sub;
  }

  it("REC-38 right after the subscription appears one sweep processes both events, created first, with no waiting", async () => {
    const { plan, ids, invoiceId, created, paid } = await parkPair();
    const sub = await subscriptionAppears(plan, ids);
    // `now` is the real clock: the retry back-off of a just-parked event has not elapsed.
    await reprocessParkedRecurringEvents(context(), new Date());
    expect((await eventRow(created.id))?.status).toBe("processed");
    expect((await eventRow(paid.id))?.status).toBe("processed");
    expect(await invoiceRows(invoiceId)).toEqual([
      expect.objectContaining({ status: "paid", review_reason: null }),
    ]);
    expect((await subRow(sub.subId)).status).toBe("active");
  });

  it("REC-38 sweeps that ran before the subscription existed do not delay the next sweep once it exists", async () => {
    const { plan, ids, invoiceId, created, paid } = await parkPair();
    // Two earlier sweeps (the subscription does not exist yet): events stay parked.
    for (const minutes of [20, 3 * 60])
      await reprocessParkedRecurringEvents(
        context(),
        new Date(Date.now() + minutes * MIN),
      );
    for (const event of [paid, created])
      expect((await eventRow(event.id))?.status).toBe("failed");
    expect(await invoiceRows(invoiceId)).toHaveLength(0);

    const sub = await subscriptionAppears(plan, ids);
    await reprocessParkedRecurringEvents(context(), new Date());
    expect((await eventRow(created.id))?.status).toBe("processed");
    expect((await eventRow(paid.id))?.status).toBe("processed");
    expect(await invoiceRows(invoiceId)).toEqual([
      expect.objectContaining({ status: "paid", review_reason: null }),
    ]);
    expect((await subRow(sub.subId)).status).toBe("active");

    // A further sweep changes nothing (idempotent).
    await reprocessParkedRecurringEvents(context(), new Date());
    expect(await invoicesOfSub(sub.subId)).toHaveLength(1);
  });

  it("REC-38 an event whose subscription still does not exist is not processed early and stays parked (control)", async () => {
    const plan = await seedPlan();
    const ids: Ids = {
      providerPlanId: plan.providerPlanId,
      providerSubId: `sub_${unique()}`,
    };
    const invoiceId = `inv_${unique()}`;
    const created = invoiceEvent("invoice.created", ids, { invoiceId });
    await deliver(created);
    await reprocessParkedRecurringEvents(context(), new Date());
    expect(await eventRow(created.id)).toMatchObject({
      status: "failed",
      last_error_code: "UNKNOWN_SUBSCRIPTION",
    });
    expect(await invoiceRows(invoiceId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REC-39 (item 4): events stuck in `received` are retried
// ---------------------------------------------------------------------------

describe("REC-39 an event stuck in received for more than 5 minutes is retried by the regular worker", () => {
  /** A stored event whose processing never finished: back to `received`, no invoice. */
  async function stuckEvent(minutesAgo: number) {
    const sub = await seedSub();
    const invoiceId = `inv_${unique()}`;
    const body = invoiceEvent("invoice.created", sub, { invoiceId });
    expect((await deliver(body)).status).toBe(200);
    await owner.query(
      "DELETE FROM subscription_invoices WHERE provider_invoice_id = $1",
      [invoiceId],
    );
    await owner.query(
      `UPDATE gateway_webhook_events
          SET status = 'received', last_error_code = NULL, attempts = 0
        WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, body.id],
    );
    await backdate(body.id, minutesAgo);
    return { sub, invoiceId, body };
  }

  it("REC-39 a received event older than 5 minutes is processed and its invoice stored once", async () => {
    const { invoiceId, body } = await stuckEvent(10);
    await reprocessStoredWebhookEvents(context(), new Date(), 100);
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(invoiceId)).toEqual([
      expect.objectContaining({ status: "open", review_reason: null }),
    ]);
    // A second worker run is a no-op.
    await reprocessStoredWebhookEvents(context(), new Date(), 100);
    expect(await invoiceRows(invoiceId)).toHaveLength(1);
  });

  it("REC-39 there is no 24 hour cap: a received event 48 hours old is still retried", async () => {
    const { invoiceId, body } = await stuckEvent(48 * 60);
    await reprocessStoredWebhookEvents(context(), new Date(), 100);
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(invoiceId)).toHaveLength(1);
  });

  it("REC-39 a received event of 1 minute ago is left alone (still being processed)", async () => {
    const { invoiceId, body } = await stuckEvent(1);
    await reprocessStoredWebhookEvents(context(), new Date(), 100);
    expect((await eventRow(body.id))?.status).toBe("received");
    expect(await invoiceRows(invoiceId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REC-40 (item 5): no automatic start retry after 24 hours
// ---------------------------------------------------------------------------

describe("REC-40 an automatic start retry of an intent older than 24 hours is refused", () => {
  async function intent(
    status: "provisioning" | "needs_reconcile",
    hoursAgo: number,
  ) {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const key = `idem-${unique()}`;
    const sub = await seedSub({
      plan,
      status,
      providerSubId: null,
      reconcileReason: status === "needs_reconcile" ? "PROVIDER_ERROR" : null,
      customerProfileId: profileId,
      startKey: key,
      createdHoursAgo: hoursAgo,
    });
    return {
      plan,
      sub,
      input: {
        planId: plan.planId,
        customerProfileId: profileId,
        idempotencyKey: key,
      },
    };
  }

  for (const status of ["provisioning", "needs_reconcile"] as const) {
    it(`REC-40 a ${status} intent of 25 hours ago is needs_reconcile INTENT_EXPIRED, DOIT is not called and the caller gets a CONFLICT`, async () => {
      const { plan, sub, input } = await intent(status, 25);
      const { state, deps } = fakeDoit(
        "createSubscription",
        createdAnswer(plan),
      );
      expect(await codeOf(startSubscription(context(), input, deps))).toBe(
        "CONFLICT",
      );
      expect(state.calls).toBe(0);
      expect(await subRow(sub.subId)).toMatchObject({
        status: "needs_reconcile",
        reconcile_reason: "INTENT_EXPIRED",
        provider_subscription_id: null,
      });
      expect(await subsForPlan(plan.planId, sub.subId)).toHaveLength(0);
    });
  }

  it("REC-40 a provisioning intent of 23 hours ago is still retried and resolves (control)", async () => {
    const { plan, sub, input } = await intent("provisioning", 23);
    const providerId = `sub_${unique()}`;
    const { state, deps } = fakeDoit(
      "createSubscription",
      createdAnswer(plan, providerId),
    );
    const result = await startSubscription(context(), input, deps);
    expect(result.subscription.status).toBe("pending_first_payment");
    expect(state.calls).toBe(1);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "pending_first_payment",
      provider_subscription_id: providerId,
    });
  });
});

// ---------------------------------------------------------------------------
// REC-41 (item 6, legend-05am0): unknown subscription -> 200 and kept
// ---------------------------------------------------------------------------

describe("REC-41 an invoice event for an unknown subscription is answered 200, stored, and processed once the subscription appears", () => {
  for (const type of ["invoice.created", "invoice.paid"] as const) {
    it(`REC-41 ${type} for an unknown subscription answers 200 parked and stays stored as failed UNKNOWN_SUBSCRIPTION`, async () => {
      const plan = await seedPlan();
      const ids: Ids = {
        providerPlanId: plan.providerPlanId,
        providerSubId: `sub_${unique()}`,
      };
      const body = invoiceEvent(type, ids, { invoiceId: `inv_${unique()}` });
      const response = await deliver(body);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ received: true, status: "parked" });
      expect(await eventRow(body.id)).toMatchObject({
        status: "failed",
        last_error_code: "UNKNOWN_SUBSCRIPTION",
      });
      expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    });
  }

  it("REC-41 once the subscription exists the parked event is processed exactly once", async () => {
    const plan = await seedPlan();
    const ids: Ids = {
      providerPlanId: plan.providerPlanId,
      providerSubId: `sub_${unique()}`,
    };
    const body = invoiceEvent("invoice.created", ids, {
      invoiceId: `inv_${unique()}`,
    });
    expect((await deliver(body)).status).toBe(200);
    const sub = await seedSub({ plan, providerSubId: ids.providerSubId });

    await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 20 * MIN),
    );
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(body.data.invoice.id)).toEqual([
      expect.objectContaining({ status: "open", review_reason: null }),
    ]);

    // A second sweep and a redelivery of the same event add nothing.
    await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 3 * 60 * MIN),
    );
    expect((await deliver(body)).status).toBe(200);
    expect(await invoicesOfSub(sub.subId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REC-42 (item 7, legend-rsrcb): active -> past_due after the grace
// ---------------------------------------------------------------------------
// Fixture: the subscription is active in [D-30, D) and its next invoice (period
// D..D+30) is open, so the invoice is due on D. D is 5 days ago, so a payment
// made today (REC-43) still covers today.

describe("REC-42 an unpaid invoice moves an active subscription to past_due after the 3 day grace", () => {
  const D = addDays(jakartaToday(), -5);

  async function overdueSub(
    due = D,
    status: SubStatus = "active",
    invoiceStatus: "open" | "paid" = "open",
  ) {
    const sub = await seedSub({
      status,
      periodStart: addDays(due, -30),
      periodEnd: due,
    });
    const invoiceId = await seedInvoice(sub, {
      status: invoiceStatus,
      periodStart: due,
      periodEnd: addDays(due, 30),
    });
    return { sub, invoiceId };
  }

  it("REC-42 the grace is three days", () => {
    expect(RECURRING_GRACE_DAYS).toBe(3);
  });

  it("REC-42 day 4 after the due date: past_due and no access", async () => {
    const { sub } = await overdueSub();
    const now = noonJakarta(addDays(D, RECURRING_GRACE_DAYS + 1));
    const changed = await markOverdueSubscriptionsPastDue(context(), now);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect((await subRow(sub.subId)).status).toBe("past_due");
    expect(subscriptionHasAccess(await accessInput(sub.subId), now)).toBe(
      false,
    );
  });

  it("REC-42 up to and including day 3 (and before the due date) the subscription is still active", async () => {
    const { sub } = await overdueSub();
    for (const offset of [-2, 0, 1, RECURRING_GRACE_DAYS]) {
      await markOverdueSubscriptionsPastDue(
        context(),
        noonJakarta(addDays(D, offset)),
      );
      expect(
        (await subRow(sub.subId)).status,
        `still active at due + ${offset} days`,
      ).toBe("active");
    }
    // The very next day it flips.
    await markOverdueSubscriptionsPastDue(
      context(),
      noonJakarta(addDays(D, RECURRING_GRACE_DAYS + 1)),
    );
    expect((await subRow(sub.subId)).status).toBe("past_due");
  });

  it("REC-42 running the worker twice gives the same result and changes nothing the second time", async () => {
    const { sub } = await overdueSub();
    const now = noonJakarta(addDays(D, RECURRING_GRACE_DAYS + 1));
    await markOverdueSubscriptionsPastDue(context(), now);
    const after = await subRow(sub.subId);
    const invoicesAfter = await invoicesOfSub(sub.subId);
    expect(await markOverdueSubscriptionsPastDue(context(), now)).toBe(0);
    expect(await subRow(sub.subId)).toEqual(after);
    expect(await invoicesOfSub(sub.subId)).toEqual(invoicesAfter);
  });

  it("REC-42 a subscription whose invoice is already paid is never past_due", async () => {
    const { sub } = await overdueSub(D, "active", "paid");
    await markOverdueSubscriptionsPastDue(
      context(),
      noonJakarta(addDays(D, 30)),
    );
    expect((await subRow(sub.subId)).status).toBe("active");
  });

  for (const status of [
    "paused",
    "cancelled",
    "needs_reconcile",
    "pending_first_payment",
  ] as const) {
    it(`REC-42 a ${status} subscription with an overdue open invoice is left alone`, async () => {
      const { sub } = await overdueSub(D, status);
      await markOverdueSubscriptionsPastDue(
        context(),
        noonJakarta(addDays(D, RECURRING_GRACE_DAYS + 1)),
      );
      expect((await subRow(sub.subId)).status).toBe(status);
    });
  }
});

// ---------------------------------------------------------------------------
// REC-43 (item 7): late payment -> active again, no duplicate period
// ---------------------------------------------------------------------------

describe("REC-43 a late payment makes a past_due subscription active again without a duplicate period", () => {
  const D = addDays(jakartaToday(), -5);
  const day4 = noonJakarta(addDays(D, RECURRING_GRACE_DAYS + 1));

  async function pastDueSub() {
    const sub = await seedSub({
      status: "active",
      periodStart: addDays(D, -30),
      periodEnd: D,
    });
    const invoiceId = await seedInvoice(sub, {
      status: "open",
      periodStart: D,
      periodEnd: addDays(D, 30),
    });
    await markOverdueSubscriptionsPastDue(context(), day4);
    expect((await subRow(sub.subId)).status).toBe("past_due");
    return { sub, invoiceId };
  }

  it("REC-43 paying the open invoice late makes it active for the invoice period, with access today", async () => {
    const { sub, invoiceId } = await pastDueSub();
    const body = invoiceEvent("invoice.paid", sub, {
      invoiceId,
      periodStart: D,
      periodEnd: addDays(D, 30),
    });
    expect((await deliver(body)).status).toBe(200);
    expect(await invoiceRows(invoiceId)).toEqual([
      expect.objectContaining({ status: "paid" }),
    ]);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "active",
      period_start: D,
      period_end: addDays(D, 30),
    });
    expect(
      subscriptionHasAccess(await accessInput(sub.subId), new Date()),
    ).toBe(true);
  });

  it("REC-43 a repeated paid event creates no second period and the worker never flips it back, run twice", async () => {
    const { sub, invoiceId } = await pastDueSub();
    const paid = () =>
      invoiceEvent("invoice.paid", sub, {
        invoiceId,
        periodStart: D,
        periodEnd: addDays(D, 30),
      });
    expect((await deliver(paid())).status).toBe(200);
    const after = await subRow(sub.subId);
    const invoicesAfter = await invoicesOfSub(sub.subId);

    expect((await deliver(paid())).status).toBe(200);
    expect(await subRow(sub.subId)).toEqual(after);

    // The worker twice, even long after the grace: the paid invoice keeps it active.
    for (let run = 0; run < 2; run += 1)
      await markOverdueSubscriptionsPastDue(context(), day4);
    expect(await subRow(sub.subId)).toEqual(after);
    expect(await invoicesOfSub(sub.subId)).toEqual(invoicesAfter);
    expect(invoicesAfter).toEqual([{ status: "paid", period_start: D }]);
  });
});
