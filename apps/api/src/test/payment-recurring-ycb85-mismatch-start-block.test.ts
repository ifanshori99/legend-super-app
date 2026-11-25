// DOIT recurring billing, card legend-ycb85 (architect P3 6c6): a new start key
// next to a PLAN_MISMATCH row that holds a DOIT id could bill the customer twice
// (the mismatch row is still a live DOIT subscription). Written from the card
// text and the existing recurring test conventions (payment-recurring-
// round4.test.ts REC-36/REC-37), NOT from the implementation.
//
// Rule pinned: while a `needs_reconcile` row with a DOIT id (PLAN_MISMATCH)
// exists for the same customer + plan and is not cancelled, a NEW start (new
// idempotency key) is REFUSED and DOIT is NOT called. Cancelling the mismatch
// row (the cancel-only path of REC-35) lifts the block.
//
// This REVERSES REC-36 "a new key starts normally next to a PLAN_MISMATCH row
// that holds a DOIT id" in payment-recurring-round4.test.ts: the implementer
// must update or remove that one test (the rest of REC-36 stays).
//
// ASSUMPTIONS
// - The refusal is `HttpError.code` CONFLICT, like the other start refusals.
// - The block is per customer + plan: another customer, or the same customer on
//   another plan, still starts. A `cancelled` mismatch row never blocks.
// - RESPONSE_MISMATCH rows with a DOIT id already block today (control).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { env } from "../config/env";
import {
  cancelSubscription,
  resumeSubscription,
  startSubscription,
} from "../services/payment-recurring.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";
import { seedFacility } from "./facility-entitlement-helpers";
import { owner as memberOwner } from "./member-loyalty-helpers";

// Installs the audit writer the integration service needs.
createApp();
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
const planIds: string[] = [];
const subIds: string[] = [];
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
  dedicated = await createSecondTenant(owner, "ycb85");
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
        webhookSecret: `whsec-yc-${randomBytes(12).toString("hex")}`,
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
  for (const cleanup of profileCleanups) await step(cleanup);
  await step(
    query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId || randomUUID(),
    ]),
  );
  await step(() => sweepTenantRows(tenantId));
  await step(() => removeSecondTenant(owner, dedicated));
  await step(() => memberOwner.end());
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

/** A needs_reconcile row that holds a DOIT subscription id. */
async function seedMismatch(
  plan: Plan,
  customerProfileId: string,
  reason: "PLAN_MISMATCH" | "RESPONSE_MISMATCH" = "PLAN_MISMATCH",
) {
  const id = randomUUID();
  const providerSubId = `sub_${unique()}`;
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            reconcile_reason, gateway_integration_id, start_idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'needs_reconcile', $7, $8, $9)`,
    [
      id,
      tenantId,
      outletId,
      plan.planId,
      customerProfileId,
      providerSubId,
      reason,
      integrationId,
      `idem-${unique()}`,
    ],
  );
  subIds.push(id);
  return { id, providerSubId };
}

async function rowsOfPlan(planId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
  }>(
    `SELECT id, status, reconcile_reason, provider_subscription_id
       FROM payment_recurring_subscriptions WHERE plan_id = $1`,
    [planId],
  );
  for (const row of rows) subIds.push(row.id);
  return rows;
}

function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
  );
}

/** DOIT fake: counts calls per method, answers `answers[method]`. */
function fakeDoit(answers: Record<string, unknown>) {
  const calls: Record<string, number> = {};
  const client = Object.fromEntries(
    Object.entries(answers).map(([method, answer]) => [
      method,
      async () => {
        calls[method] = (calls[method] ?? 0) + 1;
        return answer;
      },
    ]),
  );
  return {
    calls,
    deps: { clientFor: async () => client as never },
  };
}

const createdAnswer = (plan: Plan, providerId = `sub_${unique()}`) => ({
  id: providerId,
  plan_id: plan.providerPlanId,
  status: "pending",
  first_invoice_url: null,
});

const startInput = (plan: Plan, customerProfileId: string) => ({
  planId: plan.planId,
  customerProfileId,
  idempotencyKey: `idem-${unique()}`,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ycb85 a new start is refused while a mismatch row with a DOIT id is not cancelled", () => {
  it("ycb85 NEW a new key next to a PLAN_MISMATCH row with a DOIT id is CONFLICT, DOIT is not called, no new row", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const mismatch = await seedMismatch(plan, profileId);
    const { calls, deps } = fakeDoit({
      createSubscription: createdAnswer(plan),
    });
    expect(
      await codeOf(
        startSubscription(context(), startInput(plan, profileId), deps),
      ),
    ).toBe("CONFLICT");
    expect(calls.createSubscription ?? 0).toBe(0);
    expect(await rowsOfPlan(plan.planId)).toEqual([
      expect.objectContaining({
        id: mismatch.id,
        status: "needs_reconcile",
        reconcile_reason: "PLAN_MISMATCH",
        provider_subscription_id: mismatch.providerSubId,
      }),
    ]);
  });

  it("ycb85 NEW real flow: a start DOIT answers for another plan, then a second start with a new key, creates exactly one DOIT subscription", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const wrongPlan = fakeDoit({
      createSubscription: {
        ...createdAnswer(plan),
        plan_id: `plan_other_${unique()}`,
      },
    });
    expect(
      await codeOf(
        startSubscription(
          context(),
          startInput(plan, profileId),
          wrongPlan.deps,
        ),
      ),
    ).toBe("CONFLICT");
    expect(wrongPlan.calls.createSubscription).toBe(1);

    const retry = fakeDoit({ createSubscription: createdAnswer(plan) });
    expect(
      await codeOf(
        startSubscription(context(), startInput(plan, profileId), retry.deps),
      ),
    ).toBe("CONFLICT");
    expect(retry.calls.createSubscription ?? 0).toBe(0);
    expect(await rowsOfPlan(plan.planId)).toEqual([
      expect.objectContaining({
        status: "needs_reconcile",
        reconcile_reason: "PLAN_MISMATCH",
      }),
    ]);
  });

  it("ycb85 NEW once the mismatch row is cancelled a new start works, with one DOIT call", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const mismatch = await seedMismatch(plan, profileId);
    const stop = fakeDoit({
      cancelSubscription: { id: mismatch.providerSubId, status: "cancelled" },
    });
    // Still blocked before the cancel.
    const blocked = fakeDoit({ createSubscription: createdAnswer(plan) });
    expect(
      await codeOf(
        startSubscription(context(), startInput(plan, profileId), blocked.deps),
      ),
    ).toBe("CONFLICT");
    expect(blocked.calls.createSubscription ?? 0).toBe(0);

    const cancelled = await cancelSubscription(
      context(),
      mismatch.id,
      new Date(),
      stop.deps,
    );
    expect(cancelled.status).toBe("cancelled");

    const providerId = `sub_${unique()}`;
    const fresh = fakeDoit({
      createSubscription: createdAnswer(plan, providerId),
    });
    const started = await startSubscription(
      context(),
      startInput(plan, profileId),
      fresh.deps,
    );
    expect(started.subscription.status).toBe("pending_first_payment");
    expect(fresh.calls.createSubscription).toBe(1);
  });

  it("ycb85 control: a RESPONSE_MISMATCH row with a DOIT id blocks a new key (already true)", async () => {
    const plan = await seedPlan();
    const profileId = await seedProfile();
    await seedMismatch(plan, profileId, "RESPONSE_MISMATCH");
    const { calls, deps } = fakeDoit({
      createSubscription: createdAnswer(plan),
    });
    expect(
      await codeOf(
        startSubscription(context(), startInput(plan, profileId), deps),
      ),
    ).toBe("CONFLICT");
    expect(calls.createSubscription ?? 0).toBe(0);
  });

  it("ycb85 control: another customer on the same plan, and the same customer on another plan, still start", async () => {
    const plan = await seedPlan();
    const otherPlan = await seedPlan();
    const [blockedCustomer, otherCustomer] = [
      await seedProfile(),
      await seedProfile(),
    ];
    await seedMismatch(plan, blockedCustomer);
    const sameCustomerOtherPlan = fakeDoit({
      createSubscription: createdAnswer(otherPlan),
    });
    const otherCustomerSamePlan = fakeDoit({
      createSubscription: createdAnswer(plan),
    });
    const results = await Promise.allSettled([
      startSubscription(
        context(),
        startInput(otherPlan, blockedCustomer),
        sameCustomerOtherPlan.deps,
      ),
      startSubscription(
        context(),
        startInput(plan, otherCustomer),
        otherCustomerSamePlan.deps,
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(sameCustomerOtherPlan.calls.createSubscription).toBe(1);
    expect(otherCustomerSamePlan.calls.createSubscription).toBe(1);
  });
});

describe("1269 F0 a shower plan takes no new billing while the shower is off", () => {
  const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
  const was = flag.FACILITY_SHOWER_ENABLED;
  beforeEach(() => {
    flag.FACILITY_SHOWER_ENABLED = false;
  });
  afterEach(() => {
    flag.FACILITY_SHOWER_ENABLED = was;
  });

  /** A recurring plan that pays for a facility plan of this type. */
  async function planOf(type: "shower" | "coworking"): Promise<Plan> {
    const plan = await seedPlan();
    const facilityId = await seedFacility(
      { tenantId, outletA: outletId },
      outletId,
      type,
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query(
        `INSERT INTO facility_subscription_plans (id, tenant_id, outlet_id, facility_id, name, price_idr, quota_per_period, interval, max_per_day, provider_plan_id, is_active)
         VALUES ($1, $2, $3, $4, 'Langganan Uji', $5, 10, 'month', 1, $6, true)`,
        [
          randomUUID(),
          tenantId,
          outletId,
          facilityId,
          PRICE,
          plan.providerPlanId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return plan;
  }

  it("a start is refused: DOIT is not called and no row is stored", async () => {
    const plan = await planOf("shower");
    const { calls, deps } = fakeDoit({
      createSubscription: createdAnswer(plan),
    });
    expect(
      await codeOf(
        startSubscription(
          context(),
          startInput(plan, await seedProfile()),
          deps,
        ),
      ),
    ).toBe("FACILITY_SHOWER_DISABLED");
    expect(calls.createSubscription ?? 0).toBe(0);
    expect(await rowsOfPlan(plan.planId)).toEqual([]);
  });

  it("a resume is refused (DOIT would charge again), a cancel still works", async () => {
    const plan = await planOf("shower");
    const id = randomUUID();
    const providerSubId = `sub_${unique()}`;
    await owner.query(
      `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
              gateway_integration_id, start_idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'paused', $7, $8)`,
      [
        id,
        tenantId,
        outletId,
        plan.planId,
        await seedProfile(),
        providerSubId,
        integrationId,
        `idem-${unique()}`,
      ],
    );
    subIds.push(id);
    const { calls, deps } = fakeDoit({
      resumeSubscription: { id: providerSubId, status: "active" },
      cancelSubscription: { id: providerSubId, status: "cancelled" },
    });
    const now = new Date();
    expect(await codeOf(resumeSubscription(context(), id, now, deps))).toBe(
      "FACILITY_SHOWER_DISABLED",
    );
    expect(calls.resumeSubscription ?? 0).toBe(0);
    expect(await codeOf(cancelSubscription(context(), id, now, deps))).toBe(
      null,
    );
    expect(calls.cancelSubscription).toBe(1);
  });

  it("a coworking plan still starts", async () => {
    const plan = await planOf("coworking");
    const { calls, deps } = fakeDoit({
      createSubscription: createdAnswer(plan),
    });
    await startSubscription(
      context(),
      startInput(plan, await seedProfile()),
      deps,
    );
    expect(calls.createSubscription).toBe(1);
  });
});
