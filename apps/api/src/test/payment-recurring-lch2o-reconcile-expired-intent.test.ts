// DOIT recurring billing, card legend-lch2o (from legend-6c6: a start intent
// older than 24 hours is refused automatically and stays blocked until a manual
// reconcile tool exists). Written from the card text, brief 480 item 5 and the
// existing recurring test conventions (payment-recurring-round4.test.ts REC-40),
// NOT from the implementation. Fail-first: tests marked "NEW" pin behavior that
// does not exist yet; "control" tests pass today.
//
// The blocked intent is a `needs_reconcile` row with reason INTENT_EXPIRED and
// NO DOIT subscription id (REC-40). The tool asks DOIT whether a subscription
// exists for that start. It proceeds ONLY if DOIT confirms it, otherwise it
// cancels the intent. It never creates a subscription at DOIT (that is what
// could charge the customer twice).
//
// NAMES THE IMPLEMENTER SHOULD FOLLOW (adjust, then tell the test-writer):
// - Service: `reconcileExpiredStartIntent(context, subscriptionId,
//   now = new Date(), deps?)` in payment-recurring.service.ts, same `deps` seam
//   (`clientFor`) as pause/resume/cancel.
// - DOIT client: NEW method `findSubscriptionByReference(reference)` (the
//   `reference` DOIT got in createSubscription) answering the usual DOIT
//   subscription shape `{ id, plan_id, status, first_invoice_url }`; the real client
//   returns an ARRAY: empty = DOIT has none, more than one = ambiguous (refused,
//   row unchanged).
// - Route: POST /api/payments/recurring/subscriptions/:subscriptionId/
//   reconcile-intent, permission `payment.recurring.manage`.
//
// ASSUMPTIONS (money safe: when in doubt, never grant access or bill)
// - DOIT confirms (found, same plan) with status pending OR active: the row
//   stores the DOIT id and becomes `pending_first_payment` (reason cleared),
//   with no period dates and no access. Only a verified invoice.paid webhook
//   activates, so it never writes `active` here.
// - DOIT answers an empty list (no subscription for the reference), or a subscription already `cancelled`: the intent is
//   `cancelled` (no DOIT id stored for null) and a later start is possible.
// - DOIT answers another plan: the row becomes/stays `needs_reconcile` with
//   reason PLAN_MISMATCH and the DOIT id stored (cancel-only), never pending.
// - A DOIT failure rejects (code not pinned), leaves the row INTENT_EXPIRED.
// - Only an INTENT_EXPIRED row without a DOIT id is accepted. Anything else
//   (fresh provisioning, a row with a DOIT id, active, cancelled) is CONFLICT,
//   no DOIT call. A fresh intent might still be in flight, so reconciling it by
//   hand could race the automatic retry (double charge).
// - In no outcome does the tool call a DOIT mutation (create/pause/resume/
//   cancel). Another tenant's row is NOT_FOUND, with no DOIT call.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import * as recurringService from "../services/payment-recurring.service";
import {
  startSubscription,
  subscriptionHasAccess,
} from "../services/payment-recurring.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createSecondTenant,
  removeSecondTenant,
  tenantAId,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");
const PRICE = 150_000;
const base = "/api/payments/recurring";
const outletAId = cafeLegendPlatformFixtures.outlets[0]!.id;

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
let integrationId = "";
const planIds: string[] = [];
const subIds: string[] = [];
const profileCleanups: (() => Promise<void>)[] = [];
const createdUsers: string[] = [];
// Cafe Legend (tenant A) rows used only for HTTP checks.
const graphA = {
  integration: randomUUID(),
  plan: randomUUID(),
  sub: randomUUID(),
};
let ownerClient: ReturnType<typeof agent>;
let noRoleClient: ReturnType<typeof agent>;

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function createUser(label: string, who: ReturnType<typeof agent>) {
  const email = await signUp(who, label);
  const session = await who.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  createdUsers.push(id);
  await verifySessionMfa(email);
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  dedicated = await createSecondTenant(owner, "lch2o");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const created = await upsertIntegration(
    context(),
    {
      outletId: outletId as OutletId,
      provider: "doit",
      // Never contacted: every DOIT call in this file goes through `clientFor`.
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: {
        apiKey: `doit-key-${unique()}`,
        webhookSecret: `whsec-yq-${randomBytes(12).toString("hex")}`,
      },
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

  // Tenant A (Cafe Legend): a disabled integration, plan and a pending sub.
  await owner.query(
    `INSERT INTO tenant_integrations (id, tenant_id, outlet_id, provider, config, status, credentials_encrypted)
     VALUES ($1, $2, $3, 'doit', '{}', 'disabled', 'sealed')`,
    [graphA.integration, tenantAId, outletAId],
  );
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Plan lch2o A', $5, 'month', 'active', $6)`,
    [
      graphA.plan,
      tenantAId,
      outletAId,
      `plan_${unique()}`,
      PRICE,
      graphA.integration,
    ],
  );
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_first_payment', $7)`,
    [
      graphA.sub,
      tenantAId,
      outletAId,
      graphA.plan,
      randomUUID(),
      `sub_${unique()}`,
      graphA.integration,
    ],
  );
  ownerClient = agent(app);
  const ownerId = await createUser("lch2o owner", ownerClient);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantAId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantAId, ownerId, role.rows[0]!.id],
  );
  noRoleClient = agent(app);
  await createUser("lch2o no role", noRoleClient);
});

afterAll(async () => {
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
      [[...planIds, graphA.plan]],
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
      [...planIds, graphA.plan],
    ]),
  );
  for (const cleanup of profileCleanups) await step(cleanup);
  await step(
    query("DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])", [
      [integrationId || randomUUID(), graphA.integration],
    ]),
  );
  await step(
    query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      createdUsers,
    ]),
  );
  await step(
    query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers]),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SubStatus =
  | "pending_first_payment"
  | "active"
  | "cancelled"
  | "provisioning"
  | "needs_reconcile";
type Plan = { planId: string; providerPlanId: string };
type Sub = Plan & {
  subId: string;
  providerSubId: string | null;
  customerProfileId: string;
};

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

async function seedSub(
  options: {
    plan?: Plan;
    status?: SubStatus;
    providerSubId?: string | null;
    reconcileReason?: string | null;
    customerProfileId?: string;
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
  const status = options.status ?? "needs_reconcile";
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            reconcile_reason, gateway_integration_id, start_idempotency_key, activated_at, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, $10,
             CASE WHEN $7::varchar IN ('active','cancelled') THEN now() - interval '40 days' END,
             CASE WHEN $7::varchar = 'cancelled' THEN now() END)`,
    [
      sub.subId,
      tenantId,
      outletId,
      sub.planId,
      sub.customerProfileId,
      sub.providerSubId,
      status,
      status === "needs_reconcile"
        ? (options.reconcileReason ?? "RESPONSE_MISMATCH")
        : null,
      integrationId,
      `idem-${unique()}`,
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

async function subRow(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
    period_start: string | null;
    period_end: string | null;
    next_start: string | null;
    next_end: string | null;
    cancelled_at: string | null;
  }>(
    `SELECT status, reconcile_reason, provider_subscription_id,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end,
            to_char(next_period_start, 'YYYY-MM-DD') AS next_start,
            to_char(next_period_end, 'YYYY-MM-DD') AS next_end,
            cancelled_at::text AS cancelled_at
       FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
  );
}

// ---------------------------------------------------------------------------
// The tool under test (looked up by name so a missing export fails with a clear
// message instead of a bare TypeError)
// ---------------------------------------------------------------------------

type DoitAnswer = {
  id: string;
  plan_id: string;
  status: string;
  first_invoice_url?: string | null;
};
type Deps = { clientFor?: () => Promise<never> };
type ReconcileFn = (
  context: ScopedTenantContext,
  subscriptionId: string,
  now?: Date,
  deps?: Deps,
) => Promise<unknown>;

function reconcileFn(): ReconcileFn {
  const fn = (recurringService as unknown as Record<string, unknown>)
    .reconcileExpiredStartIntent;
  if (typeof fn !== "function")
    throw new Error(
      "MISSING: payment-recurring.service must export reconcileExpiredStartIntent(context, subscriptionId, now?, deps?)",
    );
  return fn as ReconcileFn;
}

/** A DOIT fake. `findSubscriptionByReference` answers like the real client: an
 * ARRAY (empty = DOIT has none, one = the subscription, several = ambiguous;
 * a single object or null passed here is wrapped/emptied) or throws; any other method is a mutation, recorded and answered with an
 * error so it cannot go unnoticed. `createAnswer` lets a later fresh start
 * work. */
function fakeDoit(
  answer: DoitAnswer | DoitAnswer[] | null | Error,
  createAnswer?: DoitAnswer,
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, run: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return run();
    };
  const unexpected = () => {
    throw new Error("unexpected mutating DOIT call");
  };
  const client = {
    findSubscriptionByReference: record("findSubscriptionByReference", () => {
      if (answer instanceof Error) throw answer;
      if (answer === null) return [];
      return Array.isArray(answer) ? answer : [answer];
    }),
    createSubscription: record("createSubscription", () => {
      if (!createAnswer) return unexpected();
      return createAnswer;
    }),
    pauseSubscription: record("pauseSubscription", unexpected),
    resumeSubscription: record("resumeSubscription", unexpected),
    cancelSubscription: record("cancelSubscription", unexpected),
    createPlan: record("createPlan", unexpected),
  };
  return {
    calls,
    count: (method: string) => calls.filter((c) => c.method === method).length,
    mutations: () =>
      calls.filter((c) => c.method !== "findSubscriptionByReference"),
    deps: { clientFor: async () => client as never } satisfies Deps,
  };
}

const NOW = () => new Date();

/** The blocked intent of REC-40: needs_reconcile INTENT_EXPIRED, no DOIT id. */
const expiredIntent = async (hoursAgo = 25) =>
  seedSub({
    customerProfileId: await seedProfile(),
    status: "needs_reconcile",
    providerSubId: null,
    reconcileReason: "INTENT_EXPIRED",
    createdHoursAgo: hoursAgo,
  });

const confirmed = (
  sub: Sub,
  status = "pending",
  providerId = `sub_${unique()}`,
) =>
  ({
    id: providerId,
    plan_id: sub.providerPlanId,
    status,
    first_invoice_url: null,
  }) satisfies DoitAnswer;

async function rowsOfPlan(planId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    "SELECT id, status FROM payment_recurring_subscriptions WHERE plan_id = $1",
    [planId],
  );
  for (const row of rows) subIds.push(row.id);
  return rows;
}

// ---------------------------------------------------------------------------
// Reconcile: continue only on DOIT confirmation, cancel otherwise
// ---------------------------------------------------------------------------

describe("lch2o reconcile of a start intent older than 24 hours", () => {
  for (const doitStatus of ["pending", "active"] as const) {
    it(`lch2o NEW DOIT confirms the subscription (${doitStatus}): the intent continues as pending_first_payment with the DOIT id, no access, no second create`, async () => {
      const sub = await expiredIntent();
      const answer = confirmed(sub, doitStatus);
      const { calls, count, mutations, deps } = fakeDoit(answer);
      await reconcileFn()(context(), sub.subId, NOW(), deps);
      const row = await subRow(sub.subId);
      expect(row).toMatchObject({
        status: "pending_first_payment",
        reconcile_reason: null,
        provider_subscription_id: answer.id,
        period_start: null,
        period_end: null,
        next_start: null,
        next_end: null,
      });
      expect(
        subscriptionHasAccess(
          {
            status: row.status,
            currentPeriodStart: row.period_start,
            currentPeriodEnd: row.period_end,
            nextPeriodStart: row.next_start,
            nextPeriodEnd: row.next_end,
          } as never,
          new Date(),
        ),
      ).toBe(false);
      expect(count("findSubscriptionByReference")).toBe(1);
      expect(typeof calls[0]!.args[0]).toBe("string");
      expect(mutations()).toEqual([]);
      expect(await rowsOfPlan(sub.planId)).toHaveLength(1);
    });
  }

  it("lch2o NEW DOIT has no subscription for the intent: it is cancelled, nothing is created at DOIT, and the customer can start again once", async () => {
    const sub = await expiredIntent();
    const profileId = sub.customerProfileId;
    const { count, mutations, deps } = fakeDoit(null);
    await reconcileFn()(context(), sub.subId, NOW(), deps);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "cancelled",
      provider_subscription_id: null,
    });
    expect(count("findSubscriptionByReference")).toBe(1);
    expect(mutations()).toEqual([]);

    // The cancelled intent no longer blocks: exactly one fresh start works.
    const providerId = `sub_${unique()}`;
    const fresh = fakeDoit(null, confirmed(sub, "pending", providerId));
    const started = await startSubscription(
      context(),
      {
        planId: sub.planId,
        customerProfileId: profileId,
        idempotencyKey: `idem-${unique()}`,
      },
      fresh.deps,
    );
    expect(started.subscription.status).toBe("pending_first_payment");
    expect(fresh.count("createSubscription")).toBe(1);
    expect(await rowsOfPlan(sub.planId)).toHaveLength(2);
  });

  it("lch2o NEW DOIT reports the subscription as cancelled: the intent is cancelled, never continued", async () => {
    const sub = await expiredIntent();
    const { mutations, deps } = fakeDoit(confirmed(sub, "cancelled"));
    await reconcileFn()(context(), sub.subId, NOW(), deps);
    expect((await subRow(sub.subId)).status).toBe("cancelled");
    expect(mutations()).toEqual([]);
  });

  it("lch2o NEW DOIT answers another plan: the row is needs_reconcile PLAN_MISMATCH (cancel-only), never pending or active", async () => {
    const sub = await expiredIntent();
    const answer = {
      ...confirmed(sub),
      plan_id: `plan_other_${unique()}`,
    };
    const { mutations, deps } = fakeDoit(answer);
    await codeOf(reconcileFn()(context(), sub.subId, NOW(), deps));
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "PLAN_MISMATCH",
      provider_subscription_id: answer.id,
    });
    expect(mutations()).toEqual([]);
  });

  it("lch2o NEW DOIT answers several subscriptions for the reference (ambiguous): rejected, the intent stays blocked, nothing is created", async () => {
    const sub = await expiredIntent();
    const { count, mutations, deps } = fakeDoit([
      confirmed(sub),
      confirmed(sub),
    ]);
    expect(
      await codeOf(reconcileFn()(context(), sub.subId, NOW(), deps)),
    ).not.toBeNull();
    expect(count("findSubscriptionByReference")).toBe(1);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "INTENT_EXPIRED",
      provider_subscription_id: null,
    });
    expect(mutations()).toEqual([]);
  });

  it("lch2o NEW a DOIT failure rejects, the intent stays blocked, nothing is created at DOIT", async () => {
    const sub = await expiredIntent();
    const { count, mutations, deps } = fakeDoit(new Error("DOIT is down"));
    expect(
      await codeOf(reconcileFn()(context(), sub.subId, NOW(), deps)),
    ).not.toBeNull();
    // A missing tool would also reject; the DOIT lookup must have happened.
    expect(count("findSubscriptionByReference")).toBe(1);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "INTENT_EXPIRED",
      provider_subscription_id: null,
    });
    expect(mutations()).toEqual([]);
  });

  it("lch2o NEW only an expired intent without a DOIT id is reconciled; anything else is CONFLICT with no DOIT call", async () => {
    const others = [
      // Fresh intents may still be in flight: the automatic retry owns them.
      await seedSub({
        status: "provisioning",
        providerSubId: null,
        createdHoursAgo: 1,
      }),
      await seedSub({
        status: "needs_reconcile",
        providerSubId: null,
        reconcileReason: "INTENT_EXPIRED",
        createdHoursAgo: 2,
      }),
      // Holds a DOIT id: that is the resolve tool's case (legend-yqne1).
      await seedSub({
        status: "needs_reconcile",
        reconcileReason: "RESPONSE_MISMATCH",
        createdHoursAgo: 30,
      }),
      await seedSub({ status: "active", createdHoursAgo: 30 }),
      await seedSub({ status: "cancelled", createdHoursAgo: 30 }),
    ];
    for (const sub of others) {
      const { calls, deps } = fakeDoit(confirmed(sub));
      const before = await subRow(sub.subId);
      expect(
        await codeOf(reconcileFn()(context(), sub.subId, NOW(), deps)),
      ).toBe("CONFLICT");
      expect(calls).toEqual([]);
      expect(await subRow(sub.subId)).toEqual(before);
    }
  });

  it("lch2o NEW another tenant cannot reconcile the intent: NOT_FOUND, DOIT is not called, the row is untouched", async () => {
    const sub = await expiredIntent();
    const { calls, deps } = fakeDoit(confirmed(sub));
    expect(
      await codeOf(
        reconcileFn()(tenantContext(tenantAId), sub.subId, NOW(), deps),
      ),
    ).toBe("NOT_FOUND");
    expect(calls).toEqual([]);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "INTENT_EXPIRED",
    });
  });

  it("lch2o NEW a reconciled intent is not reconciled twice (CONFLICT, no second DOIT call)", async () => {
    const sub = await expiredIntent();
    const first = fakeDoit(confirmed(sub));
    await reconcileFn()(context(), sub.subId, NOW(), first.deps);
    const second = fakeDoit(confirmed(sub));
    expect(
      await codeOf(reconcileFn()(context(), sub.subId, NOW(), second.deps)),
    ).toBe("CONFLICT");
    expect(second.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reconcile route: permission and tenant filter
// ---------------------------------------------------------------------------

describe("lch2o POST /subscriptions/:id/reconcile-intent", () => {
  const url = (id: string) => `${base}/subscriptions/${id}/reconcile-intent`;

  it("lch2o NEW a manager reaches the route (a row that is not an expired intent is 409 CONFLICT) and another tenant's intent is 404", async () => {
    const own = await ownerClient
      .post(url(graphA.sub))
      .set(originHeader)
      .send({});
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe("CONFLICT");

    const foreign = await expiredIntent();
    const response = await ownerClient
      .post(url(foreign.subId))
      .set(originHeader)
      .send({});
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await subRow(foreign.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "INTENT_EXPIRED",
    });
  });

  it("lch2o NEW a signed-in user without the recurring permission is refused (403) and the row is untouched", async () => {
    const response = await noRoleClient
      .post(url(graphA.sub))
      .set(originHeader)
      .send({});
    expect(response.status).toBe(403);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
      [graphA.sub],
    );
    expect(rows[0]!.status).toBe("pending_first_payment");
  });

  it("lch2o control: the route needs a session", async () => {
    const response = await request(app)
      .post(url(graphA.sub))
      .set(originHeader)
      .send({});
    expect(response.status).toBe(401);
  });
});
