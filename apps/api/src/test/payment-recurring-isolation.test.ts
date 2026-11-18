// Cross-tenant isolation for DOIT recurring billing (bead legend-6c6; PRD TEN-01,
// TEN-03). Same pattern as tenant-isolation-payment-inventory.test.ts: tenant A
// is Cafe Legend, tenant B a throwaway tenant. Each of the three tables
// (`payment_recurring_plans`, `payment_recurring_subscriptions`,
// `subscription_invoices`) is proven by table RLS as legend_app, by composite
// foreign keys, by the real service with a one-tenant context and by HTTP.
//
// Real service signatures: `listRecurringPlans(context, { outletId? })` returns
// an array, `getSubscription(context, id)`, `listSubscriptionInvoices(context,
// id)` (array), `pauseSubscription` / `resumeSubscription` /
// `cancelSubscription(context, id, now?, deps?)`. A cross-tenant id answers
// 404 NOT_FOUND before any DOIT call and leaves the row untouched.
// Plans and subscriptions carry `gateway_integration_id` (NOT NULL, fix round
// 1 finding 1): each tenant gets one DOIT integration row, inserted directly
// (tenant B's feature flags do not allow integrations through the service).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { env } from "../config/env";
import { createApp } from "../app";
import {
  cancelSubscription,
  getSubscription,
  listRecurringPlans,
  listSubscriptionInvoices,
  pauseSubscription,
  resumeSubscription,
} from "../services/payment-recurring.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
const outletAId = cafeLegendPlatformFixtures.outlets[0]!.id;
const base = "/api/payments/recurring";

let owner: Pool;
let appPool: Pool;
let tenantB: SecondTenant;
let client: ReturnType<typeof agent>;
let actorId: string;
let actorBId: string;
const createdUsers: string[] = [];

type Graph = {
  plan: string;
  sub: string;
  invoice: string;
  providerSub: string;
};
const integrationIds = { a: randomUUID(), b: randomUUID() };
const graphA: Graph = {
  plan: randomUUID(),
  sub: randomUUID(),
  invoice: randomUUID(),
  providerSub: `sub_iso_a_${randomUUID().slice(0, 8)}`,
};
const graphB: Graph = {
  plan: randomUUID(),
  sub: randomUUID(),
  invoice: randomUUID(),
  providerSub: `sub_iso_b_${randomUUID().slice(0, 8)}`,
};

// Status 'disabled', never 'active': tenant A is the shared fixture tenant, and
// an active DOIT row with only `credentials_encrypted` (no secret ref, field
// names, set-at/by) satisfies the DB check but fails the TenantIntegration
// contract parse. payment-webhook-api (parallel file, same tenant) lists every
// row of the tenant and parses it, so it answered 422 "An active integration
// needs stored credentials" for as long as this row existed. The recurring
// rows below only need the id for their gateway_integration_id foreign key.
async function insertIntegration(
  id: string,
  tenantId: string,
  outletId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO tenant_integrations (id, tenant_id, outlet_id, provider, config, status, credentials_encrypted)
     VALUES ($1, $2, $3, 'doit', '{}', 'disabled', 'sealed')`,
    [id, tenantId, outletId],
  );
}

async function insertGraph(
  tenantId: string,
  outletId: string,
  ids: Graph,
  integrationId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Isolation plan', 150000, 'month', 'active', $5)`,
    [
      ids.plan,
      tenantId,
      outletId,
      `plan_${ids.plan.slice(0, 8)}`,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            current_period_start, current_period_end, activated_at, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', '2026-11-01', '2026-12-01', now(), $7)`,
    [
      ids.sub,
      tenantId,
      outletId,
      ids.plan,
      randomUUID(),
      ids.providerSub,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO subscription_invoices (id, tenant_id, outlet_id, subscription_id, provider_invoice_id, period_start, period_end,
            amount_idr, hosted_url, status, source_event_id)
     VALUES ($1, $2, $3, $4, $5, '2026-11-01', '2026-12-01', 150000, 'https://pay.doit.example/i', 'open', $6)`,
    [
      ids.invoice,
      tenantId,
      outletId,
      ids.sub,
      `inv_${ids.invoice.slice(0, 8)}`,
      randomUUID(),
    ],
  );
}

async function createUser(label: string, who: ReturnType<typeof agent>) {
  const email = await signUp(who, label);
  const session = await who.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  createdUsers.push(id);
  return { id, email };
}

async function assignOwner(tenantId: string, roleId: string, userId: string) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

async function expectNotFound(run: Promise<unknown>): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
}

async function subStatus(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
    [id],
  );
  return rows[0]!.status;
}

beforeAll(async () => {
  // The recurring routes answer 503 unless this gate is on (default off).
  env.DOIT_RECURRING_ENABLED = true;
  requireDisposableDatabase();
  owner = createOwnerPool();
  appPool = createAppPool();
  tenantB = await createSecondTenant(owner, "recur");
  await insertIntegration(integrationIds.a, tenantAId, outletAId);
  await insertIntegration(integrationIds.b, tenantB.tenantId, tenantB.outletId);
  await insertGraph(tenantAId, outletAId, graphA, integrationIds.a);
  await insertGraph(
    tenantB.tenantId,
    tenantB.outletId,
    graphB,
    integrationIds.b,
  );

  client = agent(app);
  const userA = await createUser("Isolation recurring", client);
  actorId = userA.id;
  await verifySessionMfa(userA.email);
  const roleA = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantAId],
  );
  await assignOwner(tenantAId, roleA.rows[0]!.id, actorId);
  const roleB = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
     FROM roles WHERE id = $2
     RETURNING id`,
    [tenantB.tenantId, roleA.rows[0]!.id],
  );
  const userB = await createUser("Isolation recurring B", agent(app));
  actorBId = userB.id;
  await assignOwner(tenantB.tenantId, roleB.rows[0]!.id, actorBId);
});

afterAll(async () => {
  const errors: unknown[] = [];
  const steps: Array<() => Promise<unknown>> = [
    () =>
      owner.query(
        "DELETE FROM subscription_invoices WHERE id = ANY($1::uuid[])",
        [[graphA.invoice, graphB.invoice]],
      ),
    () =>
      owner.query(
        "DELETE FROM payment_recurring_subscriptions WHERE id = ANY($1::uuid[])",
        [[graphA.sub, graphB.sub]],
      ),
    () =>
      owner.query(
        "DELETE FROM payment_recurring_plans WHERE id = ANY($1::uuid[])",
        [[graphA.plan, graphB.plan]],
      ),
    () =>
      owner.query(
        "DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])",
        [[integrationIds.a, integrationIds.b]],
      ),
    () =>
      owner.query(
        "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
        [createdUsers],
      ),
    () =>
      owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB.tenantId]),
    () =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        createdUsers,
      ]),
    () => removeSecondTenant(owner, tenantB),
    () => appPool.end(),
    () => owner.end(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

describe("TEN-01 recurring billing row-level security", () => {
  it("TEN-01 plans are isolated by row-level security", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "payment_recurring_plans",
        updateSet: "name = name || 'x'",
        tenantA: { tenantId: tenantAId, rowId: graphA.plan },
        tenantB: { tenantId: tenantB.tenantId, rowId: graphB.plan },
      },
      owner,
    );
  });

  it("TEN-01 subscriptions are isolated by row-level security", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "payment_recurring_subscriptions",
        updateSet: "provider_subscription_id = provider_subscription_id || 'x'",
        tenantA: { tenantId: tenantAId, rowId: graphA.sub },
        tenantB: { tenantId: tenantB.tenantId, rowId: graphB.sub },
      },
      owner,
    );
  });

  it("TEN-01 subscription invoices are isolated by row-level security", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "subscription_invoices",
        updateSet: "hosted_url = hosted_url || 'x'",
        tenantA: { tenantId: tenantAId, rowId: graphA.invoice },
        tenantB: { tenantId: tenantB.tenantId, rowId: graphB.invoice },
      },
      owner,
    );
  });
});

describe("TEN-01 recurring billing composite keys", () => {
  const foreignKeyViolation = { code: "23503" };

  it("TEN-01 a tenant A subscription cannot point at tenant B's plan", async () => {
    await expect(
      owner.query(
        `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_first_payment', $7)`,
        [
          randomUUID(),
          tenantAId,
          outletAId,
          graphB.plan,
          randomUUID(),
          `sub_x_${randomUUID().slice(0, 8)}`,
          integrationIds.a,
        ],
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it("TEN-01 a tenant A invoice cannot point at tenant B's subscription", async () => {
    await expect(
      owner.query(
        `INSERT INTO subscription_invoices (id, tenant_id, outlet_id, subscription_id, provider_invoice_id, period_start, period_end,
                amount_idr, hosted_url, status, source_event_id)
         VALUES ($1, $2, $3, $4, $5, '2027-01-01', '2027-02-01', 150000, 'https://pay.doit.example/x', 'open', $6)`,
        [
          randomUUID(),
          tenantAId,
          outletAId,
          graphB.sub,
          `inv_x_${randomUUID().slice(0, 8)}`,
          randomUUID(),
        ],
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it("TEN-01 a tenant A plan cannot use tenant B's outlet", async () => {
    await expect(
      owner.query(
        `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
         VALUES ($1, $2, $3, 'doit', $4, 'Foreign outlet', 150000, 'month', 'active', $5)`,
        [
          randomUUID(),
          tenantAId,
          tenantB.outletId,
          `plan_x_${randomUUID().slice(0, 8)}`,
          integrationIds.a,
        ],
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });
});

describe("TEN-01 recurring billing services", () => {
  it("TEN-01 listRecurringPlans returns each tenant only its own plan", async () => {
    const plansA = await listRecurringPlans(tenantContext(tenantAId), {});
    const idsA = plansA.map((row) => row.id);
    expect(idsA).toContain(graphA.plan);
    expect(idsA).not.toContain(graphB.plan);

    const plansB = await listRecurringPlans(
      tenantContext(tenantB.tenantId),
      {},
    );
    const idsB = plansB.map((row) => row.id);
    expect(idsB).toContain(graphB.plan);
    expect(idsB).not.toContain(graphA.plan);
  });

  it("TEN-01 tenant A cannot read tenant B's subscription or invoices", async () => {
    const context = tenantContext(tenantAId);
    // Control: tenant A reads its own subscription with the same calls.
    const own = await getSubscription(context, graphA.sub);
    expect(own.id).toBe(graphA.sub);
    const ownInvoices = await listSubscriptionInvoices(context, graphA.sub);
    expect(ownInvoices.map((i) => i.id)).toContain(graphA.invoice);

    await expectNotFound(getSubscription(context, graphB.sub));
    await expectNotFound(listSubscriptionInvoices(context, graphB.sub));
  });

  it("TEN-01 tenant B cannot read tenant A's subscription", async () => {
    await expectNotFound(
      getSubscription(tenantContext(tenantB.tenantId), graphA.sub),
    );
  });

  it("TEN-01 tenant A cannot pause, resume or cancel tenant B's subscription, and it stays active", async () => {
    const context = tenantContext(tenantAId);
    const now = new Date();
    await expectNotFound(pauseSubscription(context, graphB.sub, now));
    await expectNotFound(resumeSubscription(context, graphB.sub, now));
    await expectNotFound(cancelSubscription(context, graphB.sub, now));
    expect(await subStatus(graphB.sub)).toBe("active");
  });
});

describe("TEN-01 recurring billing routes", () => {
  it("TEN-01 the plan list shows only the caller's tenant", async () => {
    const list = await client.get(`${base}/plans?outletId=${outletAId}`);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(graphA.plan);
    expect(ids).not.toContain(graphB.plan);
  });

  it("TEN-01 tenant B's subscription and invoices answer 404 to tenant A", async () => {
    const own = await client.get(`${base}/subscriptions/${graphA.sub}`);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe(graphA.sub);

    const foreign = await client.get(`${base}/subscriptions/${graphB.sub}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(foreign.body)).not.toContain(graphB.providerSub);

    const invoices = await client.get(
      `${base}/subscriptions/${graphB.sub}/invoices`,
    );
    expect(invoices.status).toBe(404);
  });

  it("TEN-01 tenant A cannot pause or cancel tenant B's subscription over HTTP", async () => {
    for (const action of ["pause", "resume", "cancel"]) {
      const response = await client
        .post(`${base}/subscriptions/${graphB.sub}/${action}`)
        .set(originHeader)
        .send({});
      expect(response.status).toBe(404);
    }
    expect(await subStatus(graphB.sub)).toBe("active");
  });
});
