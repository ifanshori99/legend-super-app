// legend-gi697: release preflight for the FAC-07 index originally numbered
// 0301, shipped on m1 as 0266. A temporary clone keeps the real column/check
// contract while omitting indexes, reproducing the pre-index production state.
// The checked-in SQL runs unchanged on that clone; public tables are untouched.
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const preflightSql = readFileSync(
  new URL(
    "../../../../scripts/preflight/0301-duplicate-subscriptions.sql",
    import.meta.url,
  ),
  "utf8",
);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "10000000-0000-4000-8000-000000000002";
const planA = "20000000-0000-4000-8000-000000000001";
const planB = "20000000-0000-4000-8000-000000000002";
const customerA = "30000000-0000-4000-8000-000000000001";
const customerB = "30000000-0000-4000-8000-000000000002";
const outletA = "40000000-0000-4000-8000-000000000001";
const outletB = "40000000-0000-4000-8000-000000000002";
const integration = "50000000-0000-4000-8000-000000000001";
const subscriptionA = "60000000-0000-4000-8000-000000000001";
const subscriptionB = "60000000-0000-4000-8000-000000000002";

interface Subscription {
  id: string;
  status: string;
  tenantId?: string;
  planId?: string;
  customerId?: string;
  outletId?: string;
}

async function insertSubscription(client: PoolClient, input: Subscription) {
  await client.query(
    `INSERT INTO payment_recurring_subscriptions
       (id, tenant_id, outlet_id, plan_id, gateway_integration_id,
        customer_profile_id, status, provider_subscription_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.tenantId ?? tenantA,
      input.outletId ?? outletA,
      input.planId ?? planA,
      integration,
      input.customerId ?? customerA,
      input.status,
      ["provisioning", "needs_reconcile"].includes(input.status)
        ? null
        : `provider-${input.id}`,
    ],
  );
}

async function beforeIndex(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE payment_recurring_subscriptions
      (LIKE public.payment_recurring_subscriptions
        INCLUDING DEFAULTS INCLUDING CONSTRAINTS EXCLUDING INDEXES)
      ON COMMIT DROP`);
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema())
         AND tablename = 'payment_recurring_subscriptions'`,
    );
    expect(indexes.rows).toEqual([]);
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-gi697] migration 0301 duplicate subscription release gate", () => {
  it("[legend-gi697] lists pending/active duplicates across outlets before the index exists", async () => {
    await beforeIndex(async (client) => {
      await insertSubscription(client, {
        id: subscriptionA,
        status: "pending_first_payment",
      });
      await insertSubscription(client, {
        id: subscriptionB,
        status: "active",
        outletId: outletB,
      });
      const result = await client.query(preflightSql);
      expect(result.rows).toEqual([
        {
          tenant_id: tenantA,
          plan_id: planA,
          customer_profile_id: customerA,
          live_subscription_count: "2",
          subscription_ids: [subscriptionA, subscriptionB],
          provider_subscription_ids: [
            `provider-${subscriptionA}`,
            `provider-${subscriptionB}`,
          ],
        },
      ]);
    });
  });

  it("[legend-gi697] returns no rows when customer, plan, or tenant differs", async () => {
    await beforeIndex(async (client) => {
      const fixtures: Subscription[] = [
        { id: subscriptionA, status: "active" },
        { id: subscriptionB, status: "active", tenantId: tenantB },
        {
          id: "60000000-0000-4000-8000-000000000003",
          status: "active",
          planId: planB,
        },
        {
          id: "60000000-0000-4000-8000-000000000004",
          status: "pending_first_payment",
          customerId: customerB,
        },
      ];
      for (const input of fixtures) await insertSubscription(client, input);
      expect((await client.query(preflightSql)).rows).toEqual([]);
    });
  });

  it("[legend-gi697] returns no rows for a clean live key with every excluded status", async () => {
    await beforeIndex(async (client) => {
      await insertSubscription(client, {
        id: subscriptionA,
        status: "active",
      });
      const excludedStatuses = [
        "past_due",
        "paused",
        "cancelled",
        "provisioning",
        "needs_reconcile",
      ];
      for (const [index, status] of excludedStatuses.entries()) {
        await insertSubscription(client, {
          id: `70000000-0000-4000-8000-00000000000${index + 1}`,
          status,
        });
      }
      expect((await client.query(preflightSql)).rows).toEqual([]);
    });
  });
});
