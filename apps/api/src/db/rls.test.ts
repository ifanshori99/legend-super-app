import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { outletIdSchema } from "@starter/shared/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "./schema";
import { withTenant } from "./tenant";

const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 1,
});
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

describe("TEN-01/TEN-02 database role tenant isolation", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await pool.query(
      "CREATE TABLE rls_fixture (id integer PRIMARY KEY, tenant_id uuid NOT NULL, value text NOT NULL)",
    );
    await pool.query(
      "SELECT app.enforce_tenant_rls('public.rls_fixture'::regclass)",
    );
    await pool.query(
      "INSERT INTO rls_fixture VALUES (1, $1, 'a'), (2, $2, 'b')",
      [tenantA, tenantB],
    );
  });
  afterAll(async () => {
    await appPool.end();
    await pool.query("DROP TABLE IF EXISTS rls_fixture");
    await pool.end();
  });

  it("TEN-02 every migrated table with tenant_id forces RLS with the restrictive tenant policy", async () => {
    // Bootstrap-only tables that carry a tenant_id but are deliberately not
    // tenant-scoped. Adding to this list needs an Opus/owner review.
    //
    // public.tenant_domains: host -> tenant resolution runs BEFORE a tenant
    // context exists (TEN-02), so reads must work without app.tenant_id. Its
    // migration enables RLS with an open SELECT policy and a tenant-checked
    // write policy (INSERT/UPDATE/DELETE), and does not FORCE it so the
    // migration owner can repair rows. Proven by the test below.
    //
    // public.payment_link_tokens: the guest holds a payment link token and has
    // no tenant context yet (PRD §3.13, TEN-02). The row is only a SHA-256 token
    // hash plus tenant/outlet/link ids — never an amount or guest data — so
    // SELECT is open while writes stay tenant-checked (migration 0017). Its
    // tenant table, payment_links, keeps the full restrictive policy.
    //
    // public.session: authentication also runs BEFORE a tenant context exists
    // (the session cookie is what resolves the caller), so the device list and
    // the revoke path read this global §6 B table outside a tenant transaction;
    // tenant_id is nullable and only records the tenant of a tenant-bound
    // login. RLS would make a signed-in user's own sessions unreadable. See
    // identity-session-api.test.ts for the global-read proof.
    //
    // public.login_challenges and public.wa_inbound_messages: coordinator
    // decision (docs/plan/contracts.md `login_challenges`, bead legend-v0o).
    // A WhatsApp login attempt exists before any session or tenant context, and
    // the KirimDev webhook resolves the tenant FROM the receiving number, so
    // these §6 B "(global)" tables are service-scoped instead of RLS. The
    // services refuse a message received on another tenant's number
    // (identity-login.test.ts "AUTH-02 rejects a message received on another
    // tenant's number").
    //
    // public.delivery_store_index: the delivery platform webhook resolves the
    // tenant FROM the platform's store id (legend-5bn3 D3), the same shape as
    // payment_link_tokens: ids only (platform, store id, tenant, outlet), open
    // SELECT, tenant-checked writes, kept in step by a trigger on
    // delivery_channels, which keeps the full restrictive policy. Also listed in
    // provision-roles.ts TENANT_RLS_EXCEPTIONS. Pending CTO approval (WS-08 D3).
    const allowlist = [
      "public.tenant_domains",
      "public.payment_link_tokens",
      "public.delivery_store_index",
      "public.session",
      "public.login_challenges",
      "public.wa_inbound_messages",
    ];
    const result = await pool.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.attname = 'tenant_id' AND NOT a.attisdropped
         AND c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (
           SELECT 1 FROM pg_policy p
           WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND NOT p.polpermissive
         ))
       ORDER BY 1`,
    );
    expect(
      result.rows.map((row) => row.table).filter((t) => !allowlist.includes(t)),
    ).toEqual([]);
  });

  it("sets scoped locals for a non-bypass login and clears them after commit", async () => {
    const database = drizzle(appPool, { schema });
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "domain",
      }),
      {
        kind: "outlets",
        outletIds: [
          outletIdSchema.parse("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ],
      },
    );
    await withTenant(database, context, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id, current_setting('app.tenant_id') AS tenant, current_setting('app.outlet_ids') AS outlets FROM rls_fixture`,
      );
      expect(result.rows).toEqual([
        {
          id: 1,
          tenant: tenantA,
          outlets: '["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]',
        },
      ]);
    });
    const settings = await appPool.query(
      "SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.outlet_ids', true) AS outlets",
    );
    expect(settings.rows[0].tenant || null).toBeNull();
    expect(settings.rows[0].outlets || null).toBeNull();
    await expect(appPool.query("SELECT * FROM rls_fixture")).rejects.toThrow();
  });

  it("rejects a bypass-capable session before tenant queries", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    await expect(
      withTenant(drizzle(pool, { schema }), context, async () => true),
    ).rejects.toThrow("Unsafe database role");
  });

  it("uses a role that cannot bypass RLS and fails closed without context", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      const role = await client.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await expect(client.query("SELECT * FROM rls_fixture")).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("restricts reads and rejects cross-tenant writes", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ]);
      expect(
        (await client.query("SELECT id FROM rls_fixture ORDER BY id")).rows,
      ).toEqual([{ id: 1 }]);
      expect(
        (
          await client.query(
            "UPDATE rls_fixture SET value = 'bad' WHERE id = 2",
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query("DELETE FROM rls_fixture WHERE id = 2")).rowCount,
      ).toBe(0);
      await expect(
        client.query("INSERT INTO rls_fixture VALUES (3, $1, 'bad')", [
          tenantB,
        ]),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
