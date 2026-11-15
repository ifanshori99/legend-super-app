import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Convention test for beads legend-m007: how a migration may add a foreign
// key into a table that FORCEs tenant row level security.
//
// The migrator may be a plain table owner (NOSUPERUSER, NOBYPASSRLS). FORCE
// ROW LEVEL SECURITY then applies the tenant policy to it, and when
// ALTER TABLE ... ADD FOREIGN KEY validates the existing rows it reads the
// referenced table under that policy. With no app.tenant_id set,
// app.require_tenant_id() raises "tenant context is required" (42501-class
// failure, aborting the whole migration transaction).
//
// This suite reproduces that failure on a scratch database and pins the
// sanctioned patterns (docs/plan/contracts.md, "Migrations: foreign keys into
// FORCE RLS tables"). The guard that every shipped migration from 0065 on
// follows them is "applies the full migration folder as the non-superuser
// owner" in edge-received-events-migration.test.ts (0000-0064 still need
// BYPASSRLS there). migrator-role.test.ts "cannot run the migrations from
// zero" is the contrast case: a plain owner is expected to fail on 0000-0064.
// The scratch database lives on the disposable test server and is dropped in
// afterAll.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const ownerRole = `fkrls_owner_${randomBytes(6).toString("hex")}`;
const ownerPassword = randomBytes(16).toString("hex");
const database = `fkrls_${randomBytes(6).toString("hex")}`;

function urlFor(db: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${db}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

// Refuse to create databases on anything but the disposable test server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

describe("legend-m007 foreign keys into FORCE RLS tables, run by a plain table owner", () => {
  let admin: Pool; // superuser on the server's default database
  let owner: Pool; // the migrator: NOSUPERUSER, NOBYPASSRLS, owns the tables

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Names and the hex password are generated here, so interpolation into
    // DDL (which takes no bind parameters) is safe.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB`,
    );
    await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
    owner = new Pool({
      connectionString: urlFor(database, ownerRole, ownerPassword),
      max: 1,
    });
    // The tenant policy shape the migrations create (app.enforce_tenant_rls).
    await owner.query(`
      CREATE SCHEMA app;
      CREATE FUNCTION app.require_tenant_id() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
      DECLARE v text := nullif(current_setting('app.tenant_id', true), '');
      BEGIN
        IF v IS NULL THEN RAISE EXCEPTION 'tenant context is required' USING ERRCODE = '42501'; END IF;
        RETURN v::uuid;
      END $$;
      CREATE TABLE parent_forced (
        tenant_id uuid NOT NULL,
        id uuid NOT NULL,
        CONSTRAINT parent_forced_pk PRIMARY KEY (tenant_id, id)
      );
      ALTER TABLE parent_forced ENABLE ROW LEVEL SECURITY;
      ALTER TABLE parent_forced FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON parent_forced
        USING (tenant_id = app.require_tenant_id())
        WITH CHECK (tenant_id = app.require_tenant_id());
    `);
  }, 60_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (admin) {
      try {
        await dropTestDatabase(admin, database);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
  });

  const createChild = (name: string, inline = "") =>
    `CREATE TABLE ${name} (tenant_id uuid NOT NULL, id uuid NOT NULL, parent_id uuid NOT NULL${inline}, PRIMARY KEY (tenant_id, id))`;
  const fk = (name: string, tail = "") =>
    `ALTER TABLE ${name} ADD CONSTRAINT ${name}_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES parent_forced (tenant_id, id)${tail}`;

  it("the migrator really is a plain owner that FORCE applies to", async () => {
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const parent = await owner.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.parent_forced'::regclass`,
    );
    expect(parent.rows[0]).toEqual({ relforcerowsecurity: true });
  });

  it("reproduces legend-m007: ADD FOREIGN KEY after CREATE TABLE fails with 'tenant context is required'", async () => {
    await owner.query(createChild("child_alter"));
    await expect(owner.query(fk("child_alter"))).rejects.toThrow(
      /tenant context is required/,
    );
  });

  it("pattern 1: a foreign key declared inside CREATE TABLE of the new table is accepted", async () => {
    await expect(
      owner.query(
        createChild(
          "child_inline",
          `, CONSTRAINT child_inline_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES parent_forced (tenant_id, id)`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("not a pattern: NOT VALID is accepted, but VALIDATE CONSTRAINT later hits the same error", async () => {
    await owner.query(createChild("child_not_valid"));
    await owner.query(fk("child_not_valid", " NOT VALID"));
    await expect(
      owner.query(
        `ALTER TABLE child_not_valid VALIDATE CONSTRAINT child_not_valid_parent_fk`,
      ),
    ).rejects.toThrow(/tenant context is required/);
  });

  it("pattern 2: NO FORCE for the transaction, ADD FOREIGN KEY, FORCE again before commit", async () => {
    await owner.query(createChild("child_lift"));
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE parent_forced NO FORCE ROW LEVEL SECURITY`,
      );
      await client.query(fk("child_lift"));
      await client.query(`ALTER TABLE parent_forced FORCE ROW LEVEL SECURITY`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const state = await owner.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.parent_forced'::regclass`,
    );
    expect(state.rows[0]).toEqual({ relforcerowsecurity: true });
  });

  it("pattern 2 on an empty FORCE child into a parent without RLS: the child must be lifted", async () => {
    // Like a FORCE tenant table gaining a foreign key into tenants: the
    // validation scan reads the child as the migrator, so FORCE there raises
    // even with zero rows and no RLS on the parent.
    await owner.query(`
      CREATE TABLE parent_plain (id uuid PRIMARY KEY);
      CREATE TABLE child_into_plain (tenant_id uuid NOT NULL, id uuid PRIMARY KEY, plain_id uuid NOT NULL);
      ALTER TABLE child_into_plain ENABLE ROW LEVEL SECURITY;
      ALTER TABLE child_into_plain FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON child_into_plain
        USING (tenant_id = app.require_tenant_id())
        WITH CHECK (tenant_id = app.require_tenant_id());
    `);
    const addFk = `ALTER TABLE child_into_plain ADD CONSTRAINT child_into_plain_fk FOREIGN KEY (plain_id) REFERENCES parent_plain (id)`;
    await expect(owner.query(addFk)).rejects.toThrow(
      /tenant context is required/,
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE child_into_plain NO FORCE ROW LEVEL SECURITY`,
      );
      await client.query(addFk);
      await client.query(
        `ALTER TABLE child_into_plain FORCE ROW LEVEL SECURITY`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const state = await owner.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.child_into_plain'::regclass`,
    );
    expect(state.rows[0]).toEqual({ relforcerowsecurity: true });
  });

  it("pattern 2 on a populated FORCE child: lift the child too, and validation still sees every row", async () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const parentId = "22222222-2222-4222-8222-222222222222";
    const orphanId = "33333333-3333-4333-8333-333333333333";
    // A FORCE tenant child holding one valid row, like an existing table
    // that gains a foreign key later.
    await owner.query(`
      ${createChild("child_forced")};
      ALTER TABLE child_forced ENABLE ROW LEVEL SECURITY;
      ALTER TABLE child_forced FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON child_forced
        USING (tenant_id = app.require_tenant_id())
        WITH CHECK (tenant_id = app.require_tenant_id());
    `);
    const seed = await owner.connect();
    try {
      await seed.query("BEGIN");
      await seed.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenant,
      ]);
      await seed.query(
        `INSERT INTO parent_forced (tenant_id, id) VALUES ($1, $2)`,
        [tenant, parentId],
      );
      await seed.query(
        `INSERT INTO child_forced (tenant_id, id, parent_id) VALUES ($1, gen_random_uuid(), $2)`,
        [tenant, parentId],
      );
      await seed.query("COMMIT");
    } finally {
      seed.release();
    }

    const inTransaction = async (statements: string[]) => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) await client.query(statement);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const liftBoth = (statement: string) => [
      `ALTER TABLE parent_forced NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE child_forced NO FORCE ROW LEVEL SECURITY`,
      statement,
      `ALTER TABLE child_forced FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE parent_forced FORCE ROW LEVEL SECURITY`,
    ];

    // Lifting only the parent: the scan of the FORCE child still raises.
    await expect(
      inTransaction([
        `ALTER TABLE parent_forced NO FORCE ROW LEVEL SECURITY`,
        fk("child_forced"),
        `ALTER TABLE parent_forced FORCE ROW LEVEL SECURITY`,
      ]),
    ).rejects.toThrow(/tenant context is required/);

    // Both lifted, plus an orphan row: validation sees it and rejects.
    await inTransaction([
      `ALTER TABLE child_forced NO FORCE ROW LEVEL SECURITY`,
      `INSERT INTO child_forced (tenant_id, id, parent_id) VALUES ('${tenant}', gen_random_uuid(), '${orphanId}')`,
      `ALTER TABLE child_forced FORCE ROW LEVEL SECURITY`,
    ]);
    await expect(inTransaction(liftBoth(fk("child_forced")))).rejects.toThrow(
      /violates foreign key constraint/,
    );

    // Orphan gone: both lifted, the foreign key validates and FORCE is back.
    await inTransaction([
      `ALTER TABLE child_forced NO FORCE ROW LEVEL SECURITY`,
      `DELETE FROM child_forced WHERE parent_id = '${orphanId}'`,
      `ALTER TABLE child_forced FORCE ROW LEVEL SECURITY`,
    ]);
    await inTransaction(liftBoth(fk("child_forced")));
    const state = await owner.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE oid IN ('public.parent_forced'::regclass, 'public.child_forced'::regclass)
        ORDER BY relname`,
    );
    expect(state.rows).toEqual([
      { relname: "child_forced", relforcerowsecurity: true },
      { relname: "parent_forced", relforcerowsecurity: true },
    ]);
    const constraint = await owner.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'child_forced_parent_fk'`,
    );
    expect(constraint.rows[0]).toEqual({ convalidated: true });
  });

  it("[legend-do1o] migration 0307 applies under a plain owner while referenced tenant tables FORCE RLS", async () => {
    // Use the shipped RLS helpers and the actual migration SQL. The scratch
    // parents expose the real referenced keys and retain the FORCE policies.
    for (const [filename, names] of [
      ["0001_tenant_rls.sql", ["enforce_tenant_rls"]],
      [
        "0032_outlet_rls.sql",
        ["outlet_scope_is_tenant", "scoped_outlet_ids", "enforce_outlet_rls"],
      ],
    ] as const) {
      const statements = readFileSync(
        new URL(`../../drizzle/${filename}`, import.meta.url),
        "utf8",
      ).split("--> statement-breakpoint");
      for (const name of names) {
        const definition = statements.find((statement) =>
          statement.includes(`CREATE FUNCTION app.${name}(`),
        );
        expect(definition, `shipped RLS helper ${name}`).toBeDefined();
        await owner.query(definition!);
      }
    }
    await owner.query(`
      CREATE TABLE tenants (id uuid PRIMARY KEY);
      CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE outlets (tenant_id uuid NOT NULL, id uuid PRIMARY KEY, UNIQUE (tenant_id, id));
      CREATE TABLE inventory_items (tenant_id uuid NOT NULL, id uuid PRIMARY KEY, UNIQUE (tenant_id, id));
      SELECT app.enforce_tenant_rls('public.outlets'::regclass);
      SELECT app.enforce_tenant_rls('public.inventory_items'::regclass);
      SELECT set_config('app.tenant_id', '', false), set_config('app.outlet_ids', '', false);
    `);
    const role = await owner.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const migration = readFileSync(
      new URL("../../drizzle/0307_prep_item_shelf_life.sql", import.meta.url),
      "utf8",
    );
    const applyMigration = async () => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(applyMigration()).resolves.toBeUndefined();
    const foreignKeys = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.prep_item_settings'::regclass AND contype = 'f' AND convalidated",
    );
    expect(foreignKeys.rows[0]!.n).toBe(5);
    const policies = await owner.query(
      `SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN (
        'public.outlets'::regclass, 'public.inventory_items'::regclass, 'public.prep_item_settings'::regclass
      ) ORDER BY relname`,
    );
    expect(policies.rows).toEqual([
      { relname: "inventory_items", relforcerowsecurity: true },
      { relname: "outlets", relforcerowsecurity: true },
      { relname: "prep_item_settings", relforcerowsecurity: true },
    ]);
  });
});
