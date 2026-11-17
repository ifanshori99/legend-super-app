// DOIT recurring billing, card legend-yqne1 (follow-up of legend-6c6 round 3,
// architect P3). Written from the card text and the existing recurring test
// conventions, NOT from the implementation. Fail-first: every test marked
// "NEW" pins behavior that does not exist yet; "control" tests pass today.
//
// Card: a `needs_reconcile` subscription that already holds a DOIT id can only
// be cancelled (no resolve path), and two concurrent starts for the same plan +
// customer can both get through because provisioning / needs_reconcile rows
// have no unique index. Reconciliation must match the DOIT status.
//
// NAMES THE IMPLEMENTER SHOULD FOLLOW (adjust, then tell the test-writer):
// - DB: a partial unique index on payment_recurring_subscriptions
//   (customer_profile_id, plan_id) for status = 'provisioning' and another for
//   status = 'needs_reconcile' (one live row per status). The existing live
//   index (pending_first_payment, active) stays. Decision after P1-P3 (brief
//   965): provisioning + needs_reconcile are ONE unresolved set per tenant +
//   plan + customer, so any two unresolved rows of the pair are refused.
// - Service: `resolveNeedsReconcileSubscription(context, subscriptionId,
//   now = new Date(), deps?)` in payment-recurring.service.ts, same `deps`
//   seam (`clientFor`) as pause/resume/cancel. It asks DOIT for the subscription
//   with the NEW client method `getSubscription(providerSubscriptionId)` which
//   answers the usual DOIT subscription shape `{ id, plan_id, status,
//   first_invoice_url }` (status: pending | active | paused | cancelled).
// - Route: POST /api/payments/recurring/subscriptions/:subscriptionId/resolve,
//   permission `payment.recurring.manage` (same gate as pause/resume/cancel).
//
// ASSUMPTIONS (money safe: when in doubt, never grant access)
// - Only a verified invoice.paid webhook activates a subscription and sets a
//   period. So when DOIT says `pending` (not paid) OR `active`, resolve takes
//   the row out of needs_reconcile to `pending_first_payment` (reason cleared),
//   with NO period dates and NO access. It never writes `active`.
// - DOIT `cancelled` -> `cancelled`.
// - A plan_id or id in the DOIT answer that differs from the row keeps the row
//   `needs_reconcile` (cancel-only), never pending/active.
// - A DOIT failure rejects (code not pinned) and leaves the row untouched.
// - A row that is not `needs_reconcile`, or has no DOIT id, answers CONFLICT
//   without any DOIT call; a row of another tenant answers NOT_FOUND without
//   any DOIT call (cross-tenant ids look like unknown ids).
// - Resolve never calls a mutating DOIT method (create/pause/resume/cancel).
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
import { subscriptionHasAccess } from "../services/payment-recurring.service";
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
  dedicated = await createSecondTenant(owner, "yqne1");
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
     VALUES ($1, $2, $3, 'doit', $4, 'Plan yqne1 A', $5, 'month', 'active', $6)`,
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
  const ownerId = await createUser("yqne1 owner", ownerClient);
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
  await createUser("yqne1 no role", noRoleClient);
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
  id: string | null;
  plan_id: string;
  status: string;
  first_invoice_url?: string | null;
};
type Deps = { clientFor?: () => Promise<never> };
type ResolveFn = (
  context: ScopedTenantContext,
  subscriptionId: string,
  now?: Date,
  deps?: Deps,
) => Promise<unknown>;

function resolveFn(): ResolveFn {
  const fn = (recurringService as unknown as Record<string, unknown>)
    .resolveNeedsReconcileSubscription;
  if (typeof fn !== "function")
    throw new Error(
      "MISSING: payment-recurring.service must export resolveNeedsReconcileSubscription(context, subscriptionId, now?, deps?)",
    );
  return fn as ResolveFn;
}

/** A DOIT fake. `getSubscription` answers or throws; any other method is a
 * mutation, recorded and answered with an error so it cannot go unnoticed. */
function fakeDoit(answer: DoitAnswer | Error) {
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
    getSubscription: record("getSubscription", () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    createSubscription: record("createSubscription", unexpected),
    pauseSubscription: record("pauseSubscription", unexpected),
    resumeSubscription: record("resumeSubscription", unexpected),
    cancelSubscription: record("cancelSubscription", unexpected),
    createPlan: record("createPlan", unexpected),
  };
  return {
    calls,
    mutations: () => calls.filter((c) => c.method !== "getSubscription"),
    deps: { clientFor: async () => client as never } satisfies Deps,
  };
}

const doitAnswer = (
  sub: Sub,
  status: string,
  overrides: Partial<DoitAnswer> = {},
): DoitAnswer => ({
  id: sub.providerSubId,
  plan_id: sub.providerPlanId,
  status,
  first_invoice_url: null,
  ...overrides,
});

const NOW = () => new Date();

// ---------------------------------------------------------------------------
// Unique index: one provisioning and one needs_reconcile row per customer + plan
// ---------------------------------------------------------------------------

describe("yqne1 the database refuses two provisioning or two needs_reconcile rows for one customer and plan", () => {
  const insertRaw = (
    plan: Plan,
    profileId: string,
    status: SubStatus,
    providerSubId: string | null,
  ) => {
    const id = randomUUID();
    subIds.push(id);
    return owner
      .query(
        `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
                reconcile_reason, gateway_integration_id, start_idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, $10)`,
        [
          id,
          tenantId,
          outletId,
          plan.planId,
          profileId,
          providerSubId,
          status,
          status === "needs_reconcile" ? "RESPONSE_MISMATCH" : null,
          integrationId,
          `idem-${unique()}`,
        ],
      )
      .then(
        () => null,
        (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
      );
  };

  it("yqne1 NEW a second provisioning row for the same customer and plan is a unique violation (23505)", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    expect(await insertRaw(plan, profileId, "provisioning", null)).toBeNull();
    expect(await insertRaw(plan, profileId, "provisioning", null)).toBe(
      "23505",
    );
  });

  it("yqne1 NEW a second needs_reconcile row for the same customer and plan is a unique violation (23505)", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    expect(
      await insertRaw(plan, profileId, "needs_reconcile", `sub_${unique()}`),
    ).toBeNull();
    expect(
      await insertRaw(plan, profileId, "needs_reconcile", `sub_${unique()}`),
    ).toBe("23505");
  });

  it("yqne1 NEW two concurrent provisioning inserts for the same customer and plan: exactly one lands", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const results = await Promise.all([
      insertRaw(plan, profileId, "provisioning", null),
      insertRaw(plan, profileId, "provisioning", null),
    ]);
    expect(results.filter((code) => code === null)).toHaveLength(1);
    expect(results.filter((code) => code === "23505")).toHaveLength(1);
  });

  it("yqne1 NEW a provisioning row and a needs_reconcile row of one customer and plan are one unresolved set: the second is refused (23505)", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    expect(await insertRaw(plan, profileId, "provisioning", null)).toBeNull();
    expect(
      await insertRaw(plan, profileId, "needs_reconcile", `sub_${unique()}`),
    ).toBe("23505");
  });

  it("yqne1 control: a cancelled row does not block a provisioning or a needs_reconcile row", async () => {
    for (const status of ["provisioning", "needs_reconcile"] as const) {
      const plan = await seedPlan();
      const profileId = await seedProfile();
      expect(
        await insertRaw(plan, profileId, "cancelled", `sub_${unique()}`),
      ).toBeNull();
      expect(
        await insertRaw(
          plan,
          profileId,
          status,
          status === "provisioning" ? null : `sub_${unique()}`,
        ),
      ).toBeNull();
    }
  });

  it("yqne1 control: other customers and other plans are not blocked", async () => {
    const plan = await seedPlan();
    const otherPlan = await seedPlan();
    const [a, b] = [await seedProfile(), await seedProfile()];
    expect(await insertRaw(plan, a, "provisioning", null)).toBeNull();
    expect(await insertRaw(plan, b, "provisioning", null)).toBeNull();
    expect(await insertRaw(otherPlan, a, "provisioning", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolve tool: match the DOIT status, never activate without payment
// ---------------------------------------------------------------------------

describe("yqne1 resolve matches the DOIT status of a needs_reconcile subscription", () => {
  for (const doitStatus of ["pending", "active"] as const) {
    it(`yqne1 NEW DOIT says ${doitStatus}: the row leaves needs_reconcile as pending_first_payment with no period and no access (only a paid invoice activates)`, async () => {
      const sub = await seedSub({ reconcileReason: "RESPONSE_MISMATCH" });
      const { calls, mutations, deps } = fakeDoit(doitAnswer(sub, doitStatus));
      await resolveFn()(context(), sub.subId, NOW(), deps);
      const row = await subRow(sub.subId);
      expect(row).toMatchObject({
        status: "pending_first_payment",
        reconcile_reason: null,
        provider_subscription_id: sub.providerSubId,
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
          30,
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]).toBe(sub.providerSubId);
      expect(mutations()).toEqual([]);
    });
  }

  it("yqne1 NEW DOIT says cancelled: the row becomes cancelled", async () => {
    const sub = await seedSub();
    const { mutations, deps } = fakeDoit(doitAnswer(sub, "cancelled"));
    await resolveFn()(context(), sub.subId, NOW(), deps);
    const row = await subRow(sub.subId);
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_at).not.toBeNull();
    expect(mutations()).toEqual([]);
  });

  it("yqne1 NEW DOIT answers another plan: the row stays needs_reconcile, never pending or active", async () => {
    const sub = await seedSub({ reconcileReason: "PLAN_MISMATCH" });
    const { mutations, deps } = fakeDoit(
      doitAnswer(sub, "pending", { plan_id: `plan_other_${unique()}` }),
    );
    await codeOf(resolveFn()(context(), sub.subId, NOW(), deps));
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      provider_subscription_id: sub.providerSubId,
    });
    expect(mutations()).toEqual([]);
  });

  it("yqne1 NEW DOIT answers another subscription id: the row stays needs_reconcile", async () => {
    const sub = await seedSub();
    const { deps } = fakeDoit(
      doitAnswer(sub, "active", { id: `sub_other_${unique()}` }),
    );
    await codeOf(resolveFn()(context(), sub.subId, NOW(), deps));
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      provider_subscription_id: sub.providerSubId,
    });
  });

  it("yqne1 NEW a DOIT failure rejects and leaves the row untouched", async () => {
    const sub = await seedSub({ reconcileReason: "RESPONSE_MISMATCH" });
    const { calls, mutations, deps } = fakeDoit(new Error("DOIT is down"));
    const code = await codeOf(resolveFn()(context(), sub.subId, NOW(), deps));
    expect(code).not.toBeNull();
    // A missing tool would also reject; the DOIT lookup must have happened.
    expect(calls).toHaveLength(1);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "RESPONSE_MISMATCH",
    });
    expect(mutations()).toEqual([]);
  });

  it("yqne1 NEW a row that is not needs_reconcile, or has no DOIT id, answers CONFLICT without calling DOIT", async () => {
    const rows = [
      await seedSub({ status: "pending_first_payment" }),
      await seedSub({ status: "active" }),
      await seedSub({ status: "cancelled" }),
      await seedSub({
        status: "needs_reconcile",
        providerSubId: null,
        reconcileReason: "PROVIDER_ERROR",
      }),
    ];
    for (const sub of rows) {
      const { calls, deps } = fakeDoit(doitAnswer(sub, "active"));
      const before = await subRow(sub.subId);
      expect(await codeOf(resolveFn()(context(), sub.subId, NOW(), deps))).toBe(
        "CONFLICT",
      );
      expect(calls).toEqual([]);
      expect(await subRow(sub.subId)).toEqual(before);
    }
  });

  it("yqne1 NEW another tenant cannot resolve the row: NOT_FOUND, DOIT is not called, the row is untouched", async () => {
    const sub = await seedSub();
    const { calls, deps } = fakeDoit(doitAnswer(sub, "active"));
    expect(
      await codeOf(
        resolveFn()(tenantContext(tenantAId), sub.subId, NOW(), deps),
      ),
    ).toBe("NOT_FOUND");
    expect(calls).toEqual([]);
    expect(await subRow(sub.subId)).toMatchObject({
      status: "needs_reconcile",
    });
  });

  it("yqne1 NEW a resolved row is not resolved twice (second call is CONFLICT, no second DOIT call)", async () => {
    const sub = await seedSub();
    const first = fakeDoit(doitAnswer(sub, "pending"));
    await resolveFn()(context(), sub.subId, NOW(), first.deps);
    const second = fakeDoit(doitAnswer(sub, "pending"));
    expect(
      await codeOf(resolveFn()(context(), sub.subId, NOW(), second.deps)),
    ).toBe("CONFLICT");
    expect(second.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolve route: permission and tenant filter
// ---------------------------------------------------------------------------

describe("yqne1 POST /subscriptions/:id/resolve", () => {
  const url = (id: string) => `${base}/subscriptions/${id}/resolve`;

  it("yqne1 NEW a manager reaches the route (a row that is not needs_reconcile is 409 CONFLICT) and another tenant's row is 404", async () => {
    const own = await ownerClient
      .post(url(graphA.sub))
      .set(originHeader)
      .send({});
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe("CONFLICT");

    const foreignSub = await seedSub();
    const foreign = await ownerClient
      .post(url(foreignSub.subId))
      .set(originHeader)
      .send({});
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(foreign.body)).not.toContain(
      foreignSub.providerSubId!,
    );
    expect(await subRow(foreignSub.subId)).toMatchObject({
      status: "needs_reconcile",
    });
  });

  it("yqne1 NEW a signed-in user without the recurring permission is refused (403) and the row is untouched", async () => {
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

  it("yqne1 control: the route needs a session", async () => {
    const response = await request(app)
      .post(url(graphA.sub))
      .set(originHeader)
      .send({});
    expect(response.status).toBe(401);
  });
});
