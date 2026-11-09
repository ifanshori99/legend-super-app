// TEN-03 outlet isolation at the database (bead legend-tjey; PRD v1.7 §2
// "Isolasi multi-tenant", §3 "Isolasi Data", §6 konvensi multi-tenant; decision
// in docs/plan/contracts.md "TEN-03 outlet isolation layers").
//
// Migration 0032 adds `app.enforce_outlet_rls`: a RESTRICTIVE policy on every
// outlet-owned table that reads `app.outlet_ids`, which `withTenant` installs
// from the server-minted ScopedTenantContext. These tests prove that a query
// running under outlet scope A cannot read or write outlet B rows even when the
// service forgets its own outlet filter (raw SQL inside withTenant), that the
// tenant-wide wildcard keeps brand/tenant roles working, and that a missing or
// malformed outlet scope fails closed.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "./schema";
import { withTenant } from "./tenant";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appDb = drizzle(appPool, { schema });

const tenantBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const outletScope = (...ids: string[]) =>
  establishScopedTenantContext(tenantBase(), {
    kind: "outlets",
    outletIds: ids.map((id) => outletIdSchema.parse(id)),
  });
const tenantScope = () =>
  establishScopedTenantContext(tenantBase(), { kind: "tenant" });

// Drizzle wraps the pg error; the cause is the RLS WITH CHECK violation.
const rlsViolation = {
  cause: expect.objectContaining({
    code: "42501",
    message: expect.stringMatching(/row-level security/),
  }),
};

let stationA = "";
let stationB = "";

async function ownerInsertStation(outletId: string): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
      [tenantId, outletId, `Uji RLS ${randomUUID().slice(0, 8)}`],
    );
    await client.query("COMMIT");
    return result.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A raw legend_app session (no BYPASSRLS) with explicit local settings. */
async function asAppRole<T>(
  settings: { tenant?: string; outlets?: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (settings.tenant !== undefined)
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        settings.tenant,
      ]);
    if (settings.outlets !== undefined)
      await client.query("SELECT set_config('app.outlet_ids', $1, true)", [
        settings.outlets,
      ]);
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const selectBoth = (client: PoolClient) =>
  client.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM stations WHERE id = ANY($1::uuid[]) ORDER BY outlet_id",
    [[stationA, stationB]],
  );

describe("TEN-03 outlet isolation at the database (legend-tjey)", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    stationA = await ownerInsertStation(outletA);
    stationB = await ownerInsertStation(outletB);
  });

  afterAll(async () => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        [stationA, stationB].filter(Boolean),
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await appPool.end();
    await ownerPool.end();
  });

  it("TEN-03 every outlet-owned tenant table forces the restrictive outlet policy", async () => {
    // public.payment_link_tokens: the guest resolves the token before any
    // tenant or outlet context exists (TEN-02; see db/rls.test.ts).
    // public.brand_websites: brand-level public site content (legend-qgr6).
    // Its outlet_id names the featured outlet, it is data and not an access
    // scope; the public read and every staff read/write run with a tenant-wide
    // outlet scope (assertTenantWide in public-site.service.ts), so only the
    // tenant policy applies (website.custom.sql). Adding to this list needs an
    // Opus/owner review.
    const allowlist = ["public.payment_link_tokens", "public.brand_websites"];
    const result = await ownerPool.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
           AND a.attname = 'tenant_id' AND NOT a.attisdropped)
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
           AND a.attname = 'outlet_id' AND a.attnotnull AND NOT a.attisdropped)
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (
           SELECT 1 FROM pg_policy p
           WHERE p.polrelid = c.oid AND p.polname = 'outlet_isolation' AND NOT p.polpermissive
         ))
       ORDER BY 1`,
    );
    expect(
      result.rows.map((row) => row.table).filter((t) => !allowlist.includes(t)),
    ).toEqual([]);
  });

  it("TEN-03 outlet scope A cannot read outlet B rows through raw SQL in withTenant", async () => {
    const seen = await withTenant(appDb, outletScope(outletA), (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM stations WHERE id IN (${stationA}, ${stationB})`,
      ),
    );
    expect(seen.rows.map((row) => row.id)).toEqual([stationA]);
  });

  it("TEN-03 outlet scope A cannot update, delete or insert outlet B rows", async () => {
    await withTenant(appDb, outletScope(outletA), async (tx) => {
      const updated = await tx.execute(
        sql`UPDATE stations SET target_seconds = 60 WHERE id = ${stationB}`,
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await tx.execute(
        sql`DELETE FROM stations WHERE id = ${stationB}`,
      );
      expect(deleted.rowCount).toBe(0);
    });
    await expect(
      withTenant(appDb, outletScope(outletA), (tx) =>
        tx.execute(
          sql`INSERT INTO stations (tenant_id, outlet_id, name, type)
              VALUES (${tenantId}, ${outletB}, 'Uji RLS bocor', 'pastry')`,
        ),
      ),
    ).rejects.toMatchObject(rlsViolation);
    // Moving an own row into another outlet is a write into outlet B too.
    await expect(
      withTenant(appDb, outletScope(outletA), (tx) =>
        tx.execute(
          sql`UPDATE stations SET outlet_id = ${outletB} WHERE id = ${stationA}`,
        ),
      ),
    ).rejects.toMatchObject(rlsViolation);
    await asAppRole({ tenant: tenantId, outlets: "*" }, async (client) => {
      expect((await selectBoth(client)).rows).toHaveLength(2);
      const row = await client.query<{ target_seconds: number | null }>(
        "SELECT target_seconds FROM stations WHERE id = $1",
        [stationB],
      );
      expect(row.rows[0].target_seconds).toBeNull();
    });
  });

  it("TEN-03 a multi-outlet scope sees exactly its outlets; the tenant wildcard sees all", async () => {
    const both = await withTenant(appDb, outletScope(outletA, outletB), (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM stations WHERE id IN (${stationA}, ${stationB})`,
      ),
    );
    expect(both.rows).toHaveLength(2);
    const onlyB = await withTenant(appDb, outletScope(outletB), (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM stations WHERE id IN (${stationA}, ${stationB})`,
      ),
    );
    expect(onlyB.rows.map((row) => row.id)).toEqual([stationB]);
    // Brand/tenant roles: withTenant installs '*' for a tenant-wide scope.
    const all = await withTenant(appDb, tenantScope(), (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM stations WHERE id IN (${stationA}, ${stationB})`,
      ),
    );
    expect(all.rows).toHaveLength(2);
  });

  it("TEN-03 the outlet wildcard never crosses the tenant boundary", async () => {
    await asAppRole({ tenant: otherTenant, outlets: "*" }, async (client) => {
      expect((await selectBoth(client)).rows).toEqual([]);
    });
  });

  it("TEN-03 a missing outlet scope fails closed", async () => {
    await asAppRole({ tenant: tenantId }, async (client) => {
      await expect(selectBoth(client)).rejects.toThrow(
        "outlet scope context is required",
      );
    });
    await asAppRole({ tenant: tenantId, outlets: "" }, async (client) => {
      await expect(selectBoth(client)).rejects.toThrow(
        "outlet scope context is required",
      );
    });
  });

  it("TEN-03 a malformed outlet scope fails closed instead of widening", async () => {
    for (const malformed of [
      "all",
      "**",
      '{"outlets":[]}',
      `"${outletA}"`,
      "[1]",
      '["not-a-uuid"]',
      `[${JSON.stringify(outletA)}`,
    ]) {
      await asAppRole(
        { tenant: tenantId, outlets: malformed },
        async (client) => {
          await expect(selectBoth(client)).rejects.toThrow(
            "outlet scope context is malformed",
          );
        },
      );
    }
  });

  it("TEN-03 an empty outlet list sees and writes nothing", async () => {
    await asAppRole({ tenant: tenantId, outlets: "[]" }, async (client) => {
      expect((await selectBoth(client)).rows).toEqual([]);
      await expect(
        client.query(
          `INSERT INTO stations (tenant_id, outlet_id, name, type)
           VALUES ($1, $2, 'Uji RLS kosong', 'pastry')`,
          [tenantId, outletA],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("TEN-03 enforce_outlet_rls refuses a table without NOT NULL outlet_id or tenant RLS", async () => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE outlet_rls_nullable (id integer PRIMARY KEY, tenant_id uuid NOT NULL, outlet_id uuid)",
      );
      await client.query(
        "SELECT app.enforce_tenant_rls('public.outlet_rls_nullable'::regclass)",
      );
      await client.query("SAVEPOINT nullable");
      await expect(
        client.query(
          "SELECT app.enforce_outlet_rls('public.outlet_rls_nullable'::regclass)",
        ),
      ).rejects.toThrow("must have outlet_id UUID NOT NULL");
      await client.query("ROLLBACK TO SAVEPOINT nullable");
      await client.query(
        "CREATE TABLE outlet_rls_untenanted (id integer PRIMARY KEY, tenant_id uuid NOT NULL, outlet_id uuid NOT NULL)",
      );
      await expect(
        client.query(
          "SELECT app.enforce_outlet_rls('public.outlet_rls_untenanted'::regclass)",
        ),
      ).rejects.toThrow("must already enforce tenant RLS");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
