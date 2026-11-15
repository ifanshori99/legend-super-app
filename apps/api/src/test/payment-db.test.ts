// Payment isolation at the database role (bead legend-gz3; TEN-01/TEN-03 and
// PRD v1.7 §6 D). Runs against the disposable test database as the migration
// owner (fixtures) and as the restricted legend_app login (checks).
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Both tenants are created fresh. The shared fixture tenant is used by other
// files (deposit allocations, finance exceptions) that run in parallel, so an
// isolation proof against it saw their rows and their teardown raced ours.
const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const tenantB = randomUUID();
const brandB = randomUUID();
const legalEntityB = randomUUID();
const outletB = randomUUID();
const linkA = randomUUID();
const linkB = randomUUID();
const intentA = randomUUID();
const intentB = randomUUID();
const tokenA = randomBytes(32).toString("hex");
const tokenB = randomBytes(32).toString("hex");

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

async function insertLink(
  id: string,
  tenantId: string,
  outletId: string,
  tokenHash: string,
) {
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, table_label, pax,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 'A03', 3, 125000, 0, 6250, 13125, 0, 144375, 0, 'seed')`,
    [id, tenantId, outletId, tokenHash, `REF-${id.slice(0, 6)}`],
  );
  await owner.query(
    `INSERT INTO payment_link_tokens (token_hash, tenant_id, outlet_id, payment_link_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
    [tokenHash, tenantId, outletId, id],
  );
}

async function insertIntent(
  id: string,
  tenantId: string,
  outletId: string,
  linkId: string,
) {
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, status, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 144375, $5, 'pending',
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '10 minutes')`,
    [id, tenantId, outletId, linkId, `idem-${id.slice(0, 8)}`],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const limits = JSON.stringify({
    maxOutlets: 5,
    maxActiveEmployees: 30,
    maxDevices: 10,
    aiRequestsPerMonth: 0,
    whatsappCostCapIdr: 0,
    aiCostCapIdr: 0,
    emailCostCapIdr: 0,
  });
  for (const [tenant, side, brand, entity, outlet] of [
    [tenantA, "a", brandA, legalEntityA, outletA],
    [tenantB, "b", brandB, legalEntityB, outletB],
  ] as const) {
    const upper = side.toUpperCase();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $4, $5)`,
      [
        tenant,
        `uji-payment-${side}-${tenant.slice(0, 8)}`,
        `Payment Tenant ${upper}`,
        limits,
        randomUUID(),
      ],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [brand, tenant, `uji-payment-brand-${side}`, `Brand ${upper}`],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
      [entity, tenant, `PT Payment ${upper}`],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`,
      [
        outlet,
        tenant,
        brand,
        entity,
        `OUT-${upper}`,
        `Outlet ${upper}`,
        `Jl. ${upper}`,
      ],
    );
  }
  await insertLink(linkA, tenantA, outletA, tokenA);
  await insertLink(linkB, tenantB, outletB, tokenB);
  await insertIntent(intentA, tenantA, outletA, linkA);
  await insertIntent(intentB, tenantB, outletB, linkB);
});

afterAll(async () => {
  // Own rows only: both tenants are this file's, so the deletes go by tenant.
  const tenants = [tenantA, tenantB];
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    [intentA, intentB],
  ]);
  await owner.query(
    "DELETE FROM payment_links WHERE tenant_id = ANY($1::uuid[])",
    [tenants],
  );
  await owner.query("DELETE FROM outlets WHERE tenant_id = ANY($1::uuid[])", [
    tenants,
  ]);
  await owner.query(
    "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
    [tenants],
  );
  await owner.query("DELETE FROM brands WHERE tenant_id = ANY($1::uuid[])", [
    tenants,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
    tenants,
  ]);
  await appPool.end();
  await owner.end();
});
describe("TEN-01 payment tables are tenant isolated", () => {
  it("TEN-01 an application login reads only its tenant's links, intents and funds", async () => {
    const rows = await asTenant(tenantA, async (client) => {
      const links = await client.query<{ id: string }>(
        "SELECT id FROM payment_links ORDER BY id",
      );
      const intents = await client.query<{ id: string }>(
        "SELECT id FROM payment_intents ORDER BY id",
      );
      return { links: links.rows, intents: intents.rows };
    });
    expect(rows.links.map((row) => row.id)).toEqual([linkA]);
    expect(rows.intents.map((row) => row.id)).toEqual([intentA]);
  });

  it("TEN-01 a release without tenant context cannot read a link", async () => {
    await expect(
      asTenant(null, (client) => client.query("SELECT id FROM payment_links")),
    ).rejects.toThrow(/tenant context is required/);
  });

  it("TEN-01 a tenant cannot write a link or an intent for another tenant", async () => {
    await expect(
      asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO payment_links
             (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
           VALUES ($1, $2, $3, $4, 'X', 1, 1, 'seed')`,
          [randomUUID(), tenantB, outletB, randomBytes(32).toString("hex")],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO payment_intents
             (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
              idempotency_key, instructions, expires_at)
           VALUES ($1, $2, $3, $4, 'qris', 'doit', 1000, $5,
                   '{"method":"qris","qrPayload":"x","issuer":null}', now())`,
          [randomUUID(), tenantB, outletB, linkB, `x-${randomUUID()}`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("TEN-01 a composite key stops an intent from referencing another tenant's link", async () => {
    await expect(
      owner.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
            idempotency_key, instructions, expires_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', 1000, $5,
                 '{"method":"qris","qrPayload":"x","issuer":null}', now())`,
        [randomUUID(), tenantA, outletA, linkB, `x-${randomUUID()}`],
      ),
    ).rejects.toThrow(/payment_intents_link_fk/);
  });
});

describe("payment_link_tokens bootstrap credential index", () => {
  it("TEN-02 the token index is readable before a tenant exists, without bill data", async () => {
    const rows = await asTenant(null, async (client) => {
      const result = await client.query<{
        token_hash: string;
        tenant_id: string;
        payment_link_id: string;
      }>(
        "SELECT token_hash, tenant_id, payment_link_id FROM payment_link_tokens WHERE token_hash = ANY($1::text[])",
        [[tokenA, tokenB]],
      );
      return result.rows;
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.tenant_id === tenantA)?.payment_link_id).toBe(
      linkA,
    );
    expect(rows.find((row) => row.tenant_id === tenantB)?.payment_link_id).toBe(
      linkB,
    );
  });

  it("TEN-01 the token index refuses a row for another tenant", async () => {
    await expect(
      asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO payment_link_tokens (token_hash, tenant_id, outlet_id, payment_link_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
          [randomBytes(32).toString("hex"), tenantB, outletB, linkB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
