// Bead legend-ycb85 / legend-yqne1 (brief 965 P2): every provisioning /
// needs_reconcile row of a customer + plan, with or without a DOIT id and
// whatever the reason (PLAN_MISMATCH too), blocks a new start and a resume of
// another row. Migration 0445 adds the unique partial index behind it, and a
// start that loses to that index answers CONFLICT, never KEY_REUSED.
// Fail-first: written before the service and schema change.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  pauseSubscription,
  resumeSubscription,
  startSubscription,
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

// Building the app installs the audit writer that upsertIntegration needs.
createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
let integrationId = "";
const planIds: string[] = [];
const profileCleanups: (() => Promise<void>)[] = [];

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  dedicated = await createSecondTenant(owner, "unres965");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const integrationOutlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet U965', 'Jl. U', '{}')`,
    [
      integrationOutlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `U9-${unique()}`.toUpperCase(),
    ],
  );
  const created = await upsertIntegration(
    context(),
    {
      outletId: integrationOutlet as OutletId,
      provider: "doit",
      // Never contacted: every DOIT call in this file goes through `clientFor`.
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: {
        apiKey: `doit-key-${unique()}`,
        webhookSecret: `whsec-u965-${randomBytes(12).toString("hex")}`,
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
  clearDoitWebhookSecretCache();
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
  await step(() =>
    owner.query(
      "DELETE FROM payment_recurring_subscriptions WHERE plan_id = ANY($1::uuid[])",
      [planIds],
    ),
  );
  await step(() =>
    owner.query(
      "DELETE FROM payment_recurring_plans WHERE id = ANY($1::uuid[])",
      [planIds],
    ),
  );
  for (const cleanup of profileCleanups) await step(cleanup);
  await step(() =>
    owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
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

type Plan = { planId: string; providerPlanId: string };

async function seedPlan(): Promise<Plan> {
  const plan: Plan = {
    planId: randomUUID(),
    providerPlanId: `plan_${unique()}`,
  };
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', 150000, 'month', 'active', $5)`,
    [plan.planId, tenantId, outletId, plan.providerPlanId, integrationId],
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

type Seed = {
  plan: Plan;
  customerProfileId: string;
  status: string;
  providerSubId?: string | null;
  reconcileReason?: string | null;
};

async function seedSub(seed: Seed): Promise<string> {
  const subId = randomUUID();
  const unresolved = ["provisioning", "needs_reconcile"].includes(seed.status);
  const providerSubId =
    seed.providerSubId === undefined
      ? unresolved
        ? null
        : `sub_${unique()}`
      : seed.providerSubId;
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, reconcile_reason, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      subId,
      tenantId,
      outletId,
      seed.plan.planId,
      seed.customerProfileId,
      providerSubId,
      seed.status,
      seed.reconcileReason ?? null,
      integrationId,
    ],
  );
  return subId;
}

async function rowsFor(planId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    "SELECT id, status FROM payment_recurring_subscriptions WHERE plan_id = $1",
    [planId],
  );
  return rows;
}

function countingStart(plan: Plan) {
  const state = { calls: 0 };
  return {
    state,
    deps: {
      clientFor: async () =>
        ({
          createSubscription: async () => {
            state.calls += 1;
            return {
              id: `sub_${unique()}`,
              plan_id: plan.providerPlanId,
              status: "pending",
              first_invoice_url: null,
            };
          },
        }) as never,
    },
  };
}

async function startOutcome(plan: Plan, customerProfileId: string) {
  const doit = countingStart(plan);
  const outcome = await startSubscription(
    context(),
    {
      planId: plan.planId,
      customerProfileId,
      idempotencyKey: `idem-${unique()}`,
    },
    doit.deps,
  ).then(
    () => null,
    (error: unknown) => error as { code?: string },
  );
  return { outcome, calls: doit.state.calls };
}

describe("965 P2: an unresolved row blocks a new start, whatever its reason or id", () => {
  it.each([
    ["PLAN_MISMATCH with a DOIT id", "needs_reconcile", "PLAN_MISMATCH", "id"],
    [
      "RESPONSE_MISMATCH with a DOIT id",
      "needs_reconcile",
      "RESPONSE_MISMATCH",
      "id",
    ],
    ["PROVIDER_ERROR without id", "needs_reconcile", "PROVIDER_ERROR", "none"],
    ["provisioning without id", "provisioning", null, "none"],
  ])(
    "%s: CONFLICT, no DOIT call, no new row",
    async (_name, status, reconcileReason, idKind) => {
      const plan = await seedPlan();
      const customerProfileId = await seedProfile();
      await seedSub({
        plan,
        customerProfileId,
        status,
        reconcileReason,
        providerSubId: idKind === "id" ? `sub_${unique()}` : null,
      });
      const { outcome, calls } = await startOutcome(plan, customerProfileId);
      expect(outcome).toMatchObject({ code: "CONFLICT" });
      expect(calls).toBe(0);
      expect(await rowsFor(plan.planId)).toHaveLength(1);
    },
  );

  it("a PLAN_MISMATCH row is free again once it is cancelled", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    await seedSub({
      plan,
      customerProfileId,
      status: "cancelled",
      reconcileReason: "PLAN_MISMATCH",
    });
    const { outcome, calls } = await startOutcome(plan, customerProfileId);
    expect(outcome).toBeNull();
    expect(calls).toBe(1);
  });

  it("another customer on the same plan is not blocked", async () => {
    const plan = await seedPlan();
    await seedSub({
      plan,
      customerProfileId: await seedProfile(),
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      providerSubId: `sub_${unique()}`,
    });
    const { outcome, calls } = await startOutcome(plan, await seedProfile());
    expect(outcome).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("965 P2: resume of another row is refused next to a PLAN_MISMATCH row", () => {
  it("CONFLICT, no DOIT call, the paused row stays paused", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    const paused = await seedSub({ plan, customerProfileId, status: "paused" });
    await seedSub({
      plan,
      customerProfileId,
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      providerSubId: `sub_${unique()}`,
    });
    let calls = 0;
    const outcome = await resumeSubscription(context(), paused, new Date(), {
      clientFor: async () =>
        ({
          resumeSubscription: async () => {
            calls += 1;
            return { id: "x", status: "active" };
          },
        }) as never,
    }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(0);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
      [paused],
    );
    expect(rows[0]!.status).toBe("paused");
  });
});

describe("965 P2: unique partial index on unresolved rows (migration 0445)", () => {
  it("the index exists", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'payment_recurring_subscriptions_unresolved_customer_plan_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/);
  });

  it("a second unresolved row of the same customer + plan is refused with 23505", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    await seedSub({ plan, customerProfileId, status: "provisioning" });
    await expect(
      seedSub({
        plan,
        customerProfileId,
        status: "needs_reconcile",
        reconcileReason: "PLAN_MISMATCH",
        providerSubId: `sub_${unique()}`,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("an unresolved row next to a cancelled one is allowed", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    await seedSub({ plan, customerProfileId, status: "cancelled" });
    await seedSub({ plan, customerProfileId, status: "cancelled" });
    await seedSub({ plan, customerProfileId, status: "needs_reconcile" });
    expect(await rowsFor(plan.planId)).toHaveLength(3);
  });
});

describe("965 P2: a cancelled start intent without a DOIT id is never retried", () => {
  it("the same key answers CONFLICT and DOIT is not called", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    const key = `idem-${unique()}`;
    await owner.query(
      `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id, start_idempotency_key, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'cancelled', $6, $7, now())`,
      [
        randomUUID(),
        tenantId,
        outletId,
        plan.planId,
        customerProfileId,
        integrationId,
        key,
      ],
    );
    const doit = countingStart(plan);
    const outcome = await startSubscription(
      context(),
      { planId: plan.planId, customerProfileId, idempotencyKey: key },
      doit.deps,
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    expect(doit.state.calls).toBe(0);
    expect(await rowsFor(plan.planId)).toHaveLength(1);
  });
});

describe("965 review: an unconfirmed pause cannot park a row next to an unresolved one", () => {
  it("23505 on the move to needs_reconcile is CONFLICT, the row keeps its status", async () => {
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    const active = await seedSub({ plan, customerProfileId, status: "active" });
    await seedSub({
      plan,
      customerProfileId,
      status: "needs_reconcile",
      reconcileReason: "PLAN_MISMATCH",
      providerSubId: `sub_${unique()}`,
    });
    const outcome = await pauseSubscription(context(), active, new Date(), {
      // DOIT answers about another subscription: the pause is unconfirmed.
      clientFor: async () =>
        ({
          pauseSubscription: async () => ({
            id: `sub_other_${unique()}`,
            plan_id: plan.providerPlanId,
            status: "paused",
          }),
        }) as never,
    }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(outcome).toMatchObject({ code: "CONFLICT" });
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
      [active],
    );
    expect(rows[0]!.status).toBe("active");
  });
});

describe("965 review: migration 0445 preflight counts mixed groups", () => {
  const migration = readFileSync(
    new URL(
      "../../drizzle/0445_recurring_unresolved_start_key.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const preflight = /DO \$\$[\s\S]*?\n\$\$;/.exec(migration)?.[0] ?? "";

  it("an unresolved row next to a non-cancelled row of the same customer + plan stops the migration", async () => {
    expect(preflight).not.toBe("");
    const plan = await seedPlan();
    const customerProfileId = await seedProfile();
    await seedSub({ plan, customerProfileId, status: "paused" });
    await seedSub({ plan, customerProfileId, status: "needs_reconcile" });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await expect(client.query(preflight)).rejects.toThrow(
        /unresolved row next to another non-cancelled row/,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
