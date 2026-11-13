// gateway_webhook_events at the database role (bead legend-b9i; PRD v1.7 §6
// `gateway_webhook_events`, TEN-01, TEN-02, PAY-03). Fixtures are written as the
// migration owner; every check runs as the restricted legend_app login.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const actor = randomUUID();
const eventA = randomUUID();
const eventB = randomUUID();
// A verified row always names the integration whose secret verified it
// (database check gateway_webhook_events_verified_integration_check).
const integrationA = randomUUID();
const integrationB = randomUUID();
const idA = `evt-a-${randomBytes(6).toString("hex")}`;
const idB = `evt-b-${randomBytes(6).toString("hex")}`;
const hash = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

/** Runs `run` inside a rolled-back legend_app transaction with tenant context. */
async function asTenant<T>(
  tenantId: string | null,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (tenantId !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const insertSql = `INSERT INTO gateway_webhook_events
  (tenant_id, provider, event_id, signature_valid, payload_hash, status, integration_id)
  VALUES ($1, 'doit', $2, true, $3, 'received', $4)`;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Webhook', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["doit"]}', $3, $4)`,
    [
      tenantB,
      `uji-webhook-${randomBytes(4).toString("hex")}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 3,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 10_000,
        emailCostCapIdr: 1_000,
      }),
      actor,
    ],
  );
  await owner.query(
    `INSERT INTO gateway_webhook_events (id, tenant_id, provider, event_id, signature_valid, payload_hash, status, integration_id)
     VALUES ($1, $2, 'doit', $3, true, $4, 'received', $5),
            ($6, $7, 'doit', $8, true, $9, 'received', $10)`,
    [
      eventA,
      tenantA,
      idA,
      hash("a"),
      integrationA,
      eventB,
      tenantB,
      idB,
      hash("b"),
      integrationB,
    ],
  );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM gateway_webhook_events WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  );
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("TEN-01 gateway_webhook_events isolation", () => {
  it("TEN-01 a tenant sees only its own webhook events", async () => {
    await asTenant(tenantA, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM gateway_webhook_events WHERE id = ANY($1::uuid[])",
        [[eventA, eventB]],
      );
      expect(rows.map((row) => row.id)).toEqual([eventA]);
    });
    await asTenant(tenantB, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM gateway_webhook_events WHERE id = ANY($1::uuid[])",
        [[eventA, eventB]],
      );
      expect(rows.map((row) => row.id)).toEqual([eventB]);
    });
  });

  it("TEN-01 tenant A cannot read, change or delete a tenant B row", async () => {
    await asTenant(tenantA, async (client) => {
      expect(
        (
          await client.query(
            "SELECT id FROM gateway_webhook_events WHERE id = $1",
            [eventB],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE gateway_webhook_events SET status = 'processed' WHERE id = $1",
            [eventB],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "DELETE FROM gateway_webhook_events WHERE id = $1",
            [eventB],
          )
        ).rowCount,
      ).toBe(0);
    });
    const untouched = await owner.query<{ status: string }>(
      "SELECT status FROM gateway_webhook_events WHERE id = $1",
      [eventB],
    );
    expect(untouched.rows).toEqual([{ status: "received" }]);
  });

  it("TEN-01 tenant A cannot insert a row for tenant B but can for itself", async () => {
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT cross_tenant");
      await expect(
        client.query(insertSql, [
          tenantB,
          `evt-x-${randomBytes(4).toString("hex")}`,
          hash("x"),
          integrationB,
        ]),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant");
      const own = await client.query(insertSql, [
        tenantA,
        `evt-own-${randomBytes(4).toString("hex")}`,
        hash("y"),
        integrationA,
      ]);
      expect(own.rowCount).toBe(1);
    });
  });

  it("TEN-01 tenant A cannot move its own row into tenant B", async () => {
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT move_row");
      await expect(
        client.query(
          "UPDATE gateway_webhook_events SET tenant_id = $1 WHERE id = $2",
          [tenantB, eventA],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT move_row");
    });
  });
});

describe("TEN-02 gateway_webhook_events forced RLS", () => {
  it("TEN-02 queries without tenant context are refused", async () => {
    await asTenant(null, async (client) => {
      await expect(
        client.query("SELECT id FROM gateway_webhook_events"),
      ).rejects.toThrow(/tenant context/i);
    });
  });

  it("TEN-02 the table has FORCE row level security and a restrictive tenant policy", async () => {
    const { rows } = await owner.query<{
      enabled: boolean;
      forced: boolean;
      restrictive: boolean;
    }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS restrictive
       FROM pg_class c WHERE c.oid = 'public.gateway_webhook_events'::regclass`,
    );
    expect(rows[0]).toEqual({ enabled: true, forced: true, restrictive: true });
  });

  it("TEN-02 tenant_id is NOT NULL", async () => {
    const { rows } = await owner.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'gateway_webhook_events' AND column_name = 'tenant_id'`,
    );
    expect(rows).toEqual([{ is_nullable: "NO" }]);
    await expect(
      owner.query(
        `INSERT INTO gateway_webhook_events (tenant_id, provider, signature_valid, payload_hash)
         VALUES (NULL, 'doit', false, $1)`,
        [hash("n")],
      ),
    ).rejects.toThrow(/null value|not-null/i);
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT null_tenant");
      await expect(
        client.query(
          `INSERT INTO gateway_webhook_events (tenant_id, provider, signature_valid, payload_hash)
           VALUES (NULL, 'doit', false, $1)`,
          [hash("n")],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT null_tenant");
    });
  });
});

describe("PAY-03 webhook event uniqueness", () => {
  it("PAY-03 a verified event id is unique per tenant and provider", async () => {
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT duplicate_event");
      await expect(
        client.query(insertSql, [tenantA, idA, hash("d"), integrationA]),
      ).rejects.toThrow(/duplicate key|unique/i);
      await client.query("ROLLBACK TO SAVEPOINT duplicate_event");
    });
  });

  it("PAY-03 the same event id is allowed in another tenant", async () => {
    await asTenant(tenantB, async (client) => {
      const { rowCount } = await client.query(insertSql, [
        tenantB,
        idA,
        hash("e"),
        integrationB,
      ]);
      expect(rowCount).toBe(1);
    });
  });

  it("PAY-03 the same event id is allowed for another integration of the same tenant", async () => {
    await asTenant(tenantA, async (client) => {
      const { rowCount } = await client.query(insertSql, [
        tenantA,
        idA,
        hash("f"),
        randomUUID(),
      ]);
      expect(rowCount).toBe(1);
    });
  });

  it("PAY-03 the database refuses a verified event without an integration", async () => {
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT no_integration");
      await expect(
        client.query(insertSql, [
          tenantA,
          `evt-nointeg-${randomBytes(4).toString("hex")}`,
          hash("g"),
          null,
        ]),
      ).rejects.toThrow(/verified_integration_check|check constraint/i);
      await client.query("ROLLBACK TO SAVEPOINT no_integration");
    });
  });

  // Fix wave 1 (migration 0065): a rejected delivery is stored once per payload
  // hash and tenant (partial unique index on rows with an invalid signature).
  it("PAY-03 rejected rows with different payloads may coexist, the same payload only once", async () => {
    await asTenant(tenantA, async (client) => {
      const reject = `INSERT INTO gateway_webhook_events
        (tenant_id, provider, event_id, signature_valid, payload_hash, status)
        VALUES ($1, 'doit', NULL, false, $2, 'rejected')`;
      expect((await client.query(reject, [tenantA, hash("r1")])).rowCount).toBe(
        1,
      );
      expect((await client.query(reject, [tenantA, hash("r2")])).rowCount).toBe(
        1,
      );
      await client.query("SAVEPOINT same_payload");
      await expect(client.query(reject, [tenantA, hash("r1")])).rejects.toThrow(
        /duplicate key|unique/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT same_payload");
      // ON CONFLICT DO NOTHING is how the service stores a repeat: no error, no row.
      const quiet = await client.query(
        `${reject} ON CONFLICT (tenant_id, payload_hash) WHERE NOT signature_valid DO NOTHING`,
        [tenantA, hash("r1")],
      );
      expect(quiet.rowCount).toBe(0);
    });
  });

  it("PAY-03 the same rejected payload hash is allowed in another tenant", async () => {
    await asTenant(tenantB, async (client) => {
      const reject = `INSERT INTO gateway_webhook_events
        (tenant_id, provider, event_id, signature_valid, payload_hash, status)
        VALUES ($1, 'doit', NULL, false, $2, 'rejected')`;
      expect((await client.query(reject, [tenantB, hash("r1")])).rowCount).toBe(
        1,
      );
    });
  });

  it("PAY-03 the rejected-hash index does not restrict verified rows", async () => {
    await asTenant(tenantA, async (client) => {
      const verified = `INSERT INTO gateway_webhook_events
        (tenant_id, provider, event_id, signature_valid, payload_hash, status, integration_id)
        VALUES ($1, 'doit', $2, true, $3, 'received', $4)`;
      expect(
        (
          await client.query(verified, [
            tenantA,
            "same-hash-1",
            hash("v"),
            integrationA,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(verified, [
            tenantA,
            "same-hash-2",
            hash("v"),
            integrationA,
          ])
        ).rowCount,
      ).toBe(1);
    });
  });

  it("PAY-03 only known providers and statuses are accepted", async () => {
    await asTenant(tenantA, async (client) => {
      await client.query("SAVEPOINT bad_provider");
      await expect(
        client.query(
          `INSERT INTO gateway_webhook_events (tenant_id, provider, signature_valid, payload_hash)
           VALUES ($1, 'unknown', false, $2)`,
          [tenantA, hash("p")],
        ),
      ).rejects.toThrow(/check constraint/i);
      await client.query("ROLLBACK TO SAVEPOINT bad_provider");
      await client.query("SAVEPOINT bad_status");
      await expect(
        client.query(
          `INSERT INTO gateway_webhook_events (tenant_id, provider, signature_valid, payload_hash, status)
           VALUES ($1, 'doit', false, $2, 'weird')`,
          [tenantA, hash("s")],
        ),
      ).rejects.toThrow(/check constraint/i);
      await client.query("ROLLBACK TO SAVEPOINT bad_status");
    });
  });
});
