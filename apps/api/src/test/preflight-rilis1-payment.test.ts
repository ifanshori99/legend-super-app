// Release gates run against temporary pre-index clones. Production rows and
// indexes remain untouched; the checked-in SELECT runs without rewriting it.
import { existsSync, readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const firstId = "60000000-0000-4000-8000-000000000001";
const secondId = "60000000-0000-4000-8000-000000000002";
const actionId = "abcdefab-cdef-4abc-8def-abcdefabcdef";

function gateSql(id: "etov3" | "47rgt") {
  const file = new URL(
    `../../../../scripts/preflight/rilis1-legend-${id}.sql`,
    import.meta.url,
  );
  expect(existsSync(file), `release gate legend-${id} must exist`).toBe(true);
  return readFileSync(file, "utf8");
}

async function beforeIndex(
  table: "payment_recurring_subscriptions" | "promotions",
  run: (client: PoolClient) => Promise<void>,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE ${table}
      (LIKE public.${table}
        INCLUDING DEFAULTS INCLUDING CONSTRAINTS EXCLUDING INDEXES)
      ON COMMIT DROP`);
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema())
         AND tablename = $1`,
      [table],
    );
    expect(indexes.rows).toEqual([]);
    if (table === "promotions") {
      // The gate must work before 0446 introduces this replay-guard column.
      await client.query(
        "ALTER TABLE promotions DROP COLUMN ai_action_request_id",
      );
    }
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Subscription {
  id: string;
  status: string;
  tenantId?: string;
  planId?: string;
  customerId?: string;
  outletId?: string;
  providerId?: string | null;
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
      input.providerId === undefined
        ? ["provisioning", "needs_reconcile"].includes(input.status)
          ? null
          : `provider-${input.id}`
        : input.providerId,
    ],
  );
}

interface Promotion {
  id: string;
  tenantId?: string;
  description?: string;
  status?: "draft" | "active" | "paused" | "ended";
}

async function insertPromotion(client: PoolClient, input: Promotion) {
  await client.query(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, voucher_required,
        starts_at, conditions, benefit, stack_group, stackable, priority)
     VALUES ($1, $2, 'Release gate fixture', $3, $4, false,
       '2020-01-01T00:00:00Z', '[]', '{"type":"fixed","amountIdr":1000}',
       'release-gate', false, 1)`,
    [
      input.id,
      input.tenantId ?? tenantA,
      input.description ?? `Discount [ai:${actionId}]`,
      input.status ?? "active",
    ],
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-etov3] unresolved recurring release gate before 0445", () => {
  it.each(["provisioning", "needs_reconcile"])(
    "[legend-etov3] blocks %s beside every other non-cancelled state, across outlets",
    async (unresolvedStatus) => {
      for (const otherStatus of [
        "pending_first_payment",
        "active",
        "past_due",
        "paused",
        "provisioning",
        "needs_reconcile",
      ]) {
        await beforeIndex("payment_recurring_subscriptions", async (client) => {
          await insertSubscription(client, {
            id: firstId,
            status: unresolvedStatus,
            providerId: "doit-may-still-charge-this-subscription",
          });
          await insertSubscription(client, {
            id: secondId,
            status: otherStatus,
            outletId: outletB,
          });
          const result = await client.query(gateSql("etov3"));
          expect(result.rows).toHaveLength(1);
          expect(result.rows[0]).toEqual({
            tenant_id: tenantA,
            plan_id: planA,
            customer_profile_id: customerA,
            subscription_count: "2",
          });
        });
      }
    },
  );

  it("[legend-etov3] allows an unresolved row alone or beside cancelled rows", async () => {
    await beforeIndex("payment_recurring_subscriptions", async (client) => {
      await insertSubscription(client, {
        id: firstId,
        status: "needs_reconcile",
      });
      expect((await client.query(gateSql("etov3"))).rows).toEqual([]);
      await insertSubscription(client, {
        id: secondId,
        status: "cancelled",
        providerId: null,
      });
      expect((await client.query(gateSql("etov3"))).rows).toEqual([]);
    });
  });

  it("[legend-etov3] counts each subscription once when several unresolved rows share a key", async () => {
    await beforeIndex("payment_recurring_subscriptions", async (client) => {
      await insertSubscription(client, { id: firstId, status: "provisioning" });
      await insertSubscription(client, {
        id: secondId,
        status: "needs_reconcile",
      });
      await insertSubscription(client, {
        id: "60000000-0000-4000-8000-000000000003",
        status: "active",
      });
      expect((await client.query(gateSql("etov3"))).rows).toEqual([
        {
          tenant_id: tenantA,
          plan_id: planA,
          customer_profile_id: customerA,
          subscription_count: "3",
        },
      ]);
    });
  });

  it("[legend-etov3] keeps tenant, customer, and plan boundaries separate", async () => {
    await beforeIndex("payment_recurring_subscriptions", async (client) => {
      const fixtures: Subscription[] = [
        { id: firstId, status: "provisioning" },
        { id: secondId, status: "active", tenantId: tenantB },
        {
          id: "60000000-0000-4000-8000-000000000003",
          status: "active",
          customerId: customerB,
        },
        {
          id: "60000000-0000-4000-8000-000000000004",
          status: "active",
          planId: planB,
        },
      ];
      for (const fixture of fixtures) await insertSubscription(client, fixture);
      expect((await client.query(gateSql("etov3"))).rows).toEqual([]);
    });
  });

  it("[legend-etov3] does not block settled rows without any unresolved row", async () => {
    await beforeIndex("payment_recurring_subscriptions", async (client) => {
      await insertSubscription(client, { id: firstId, status: "active" });
      await insertSubscription(client, { id: secondId, status: "paused" });
      expect((await client.query(gateSql("etov3"))).rows).toEqual([]);
    });
  });
});

describe("[legend-47rgt] duplicate active AI promotion gate before 0446", () => {
  it("[legend-47rgt] blocks duplicate active discounts from the same AI request", async () => {
    await beforeIndex("promotions", async (client) => {
      await insertPromotion(client, { id: firstId });
      await insertPromotion(client, {
        id: secondId,
        description: `Retry [ai:${actionId.toUpperCase()}]  ` + "\n",
      });
      const result = await client.query(gateSql("47rgt"));
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        tenant_id: tenantA,
        ai_action_request_id: actionId,
        promotion_count: "2",
      });
    });
  });

  it("[legend-47rgt] clears after extra promotions are deactivated", async () => {
    await beforeIndex("promotions", async (client) => {
      await insertPromotion(client, { id: firstId });
      const inactiveStatuses: Promotion["status"][] = [
        "draft",
        "paused",
        "ended",
      ];
      for (const [index, status] of inactiveStatuses.entries()) {
        await insertPromotion(client, {
          id: `60000000-0000-4000-8000-00000000000${index + 2}`,
          status,
        });
      }
      expect((await client.query(gateSql("47rgt"))).rows).toEqual([]);
    });
  });

  it("[legend-47rgt] keeps the same marker in different tenants separate", async () => {
    await beforeIndex("promotions", async (client) => {
      await insertPromotion(client, { id: firstId });
      await insertPromotion(client, { id: secondId, tenantId: tenantB });
      expect((await client.query(gateSql("47rgt"))).rows).toEqual([]);
    });
  });

  it("[legend-47rgt] allows distinct valid markers and ignores malformed or non-suffix markers", async () => {
    await beforeIndex("promotions", async (client) => {
      const descriptions = [
        `First [ai:${actionId}]`,
        "Other [ai:abcdefab-cdef-4abc-8def-abcdefabcdea]",
        "Manual discount",
        "Malformed [ai:------------------------------------]",
        "Malformed [ai:------------------------------------]",
        `Not a suffix [ai:${actionId}] extra words`,
      ];
      for (const [index, description] of descriptions.entries()) {
        await insertPromotion(client, {
          id: `60000000-0000-4000-8000-00000000000${index + 1}`,
          description,
        });
      }
      expect((await client.query(gateSql("47rgt"))).rows).toEqual([]);
    });
  });
});
