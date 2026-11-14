// legend-edxtt: a data-migration replay in a test must only touch the rows of
// the tenant the test owns. Migrations 0147 / 0335 / 0360 do INSERT ... SELECT
// over every tenant; replayed globally they trip over rows of other tests'
// tenants (FK 23503 on chart_of_accounts_tenant_id_tenants_id_fk when the
// tenant is gone) and can leave FORCE ROW LEVEL SECURITY off after a failure.
// Written fail-first from the brief, not from the helper implementation.
//
// Assumptions:
// - Helper contract: replayMigrationForTenant(owner, sql, tenantId) rejects
//   with the original error when a statement fails, rolls back, and FORCE ROW
//   LEVEL SECURITY on chart_of_accounts / account_mappings is on afterwards.
// - The migration owner is a superuser, so a row for a nonexistent tenant can
//   be planted (and removed) under SET LOCAL session_replication_role=replica.
// - The 0360 migration is the probe: it is the newest one that adds accounts
//   for every provisioned (tenant, legal entity) pair.
// - Test files run one at a time (fileParallelism false).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { replayMigrationForTenant } from "./helpers/migration-replay.ts";

const fixtureTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const migrationSql = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0360_cash_movement_mapping_backfill.sql",
  ),
  "utf8",
);

/** The pre-fix replay: every statement as the owner, over every tenant. */
async function oldGlobalReplay(sql: string): Promise<void> {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const stripped = statement.replace(/--.*$/gm, "").trim();
    if (stripped) await owner.query(statement);
  }
}

/** Runs `fn` in a transaction on the owner with FK and trigger checks off. */
async function asReplica<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const createdEntityIds: string[] = [];
const createdTenantIds: string[] = [];
const orphanTenantIds: string[] = [];

async function forceRls(): Promise<Record<string, boolean>> {
  const { rows } = await owner.query<{
    relname: string;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('chart_of_accounts', 'account_mappings')`,
  );
  return Object.fromEntries(
    rows.map((row) => [row.relname, row.relforcerowsecurity]),
  );
}

async function provisionedEntity(tenantId: string): Promise<string> {
  const entityId = randomUUID();
  createdEntityIds.push(entityId);
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entityId, tenantId, `Entity edxtt ${entityId.slice(0, 8)}`],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1101', 'Kas', 'asset', 'current_asset') RETURNING id`,
    [tenantId, entityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'cash_on_hand', $3)`,
    [tenantId, entityId, rows[0]!.id],
  );
  return entityId;
}

async function plantOrphanMapping(): Promise<string> {
  const orphanTenantId = randomUUID();
  orphanTenantIds.push(orphanTenantId);
  await asReplica((client) =>
    client.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'cash_on_hand', $3)`,
      [orphanTenantId, randomUUID(), randomUUID()],
    ),
  );
  return orphanTenantId;
}

async function countFor(
  table: "chart_of_accounts" | "account_mappings",
  column: "tenant_id" | "legal_entity_id",
  id: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`,
    [id],
  );
  return Number(rows[0]!.n);
}

async function accountCodes(entityId: string): Promise<string[]> {
  const { rows } = await owner.query<{ code: string }>(
    "SELECT code FROM chart_of_accounts WHERE legal_entity_id = $1 ORDER BY code",
    [entityId],
  );
  return rows.map((row) => row.code);
}

async function newTenant(): Promise<string> {
  const id = randomUUID();
  createdTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Isolasi Replay', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-edxtt-${id.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  return id;
}

describe("legend-edxtt migration replay is scoped to its own tenant", () => {
  beforeAll(() => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
  });

  afterAll(async () => {
    try {
      await asReplica(async (client) => {
        const entities = createdEntityIds;
        const tenants = [...createdTenantIds, ...orphanTenantIds];
        await client.query(
          "DELETE FROM account_mappings WHERE legal_entity_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])",
          [entities, tenants],
        );
        await client.query(
          "DELETE FROM chart_of_accounts WHERE legal_entity_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])",
          [entities, tenants],
        );
        await client.query(
          "DELETE FROM legal_entities WHERE id = ANY($1::uuid[])",
          [entities],
        );
        await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
          createdTenantIds,
        ]);
      });
    } finally {
      await owner.end();
    }
  });

  it("ISO-00 documents the bug: the old global replay fails 23503 on an orphan mapping and is the reason for the helper", async () => {
    const orphan = await plantOrphanMapping();
    try {
      await expect(oldGlobalReplay(migrationSql)).rejects.toMatchObject({
        code: "23503",
      });
    } finally {
      // The old replay left FORCE off when it failed; put it back.
      await owner.query(
        "ALTER TABLE public.account_mappings FORCE ROW LEVEL SECURITY",
      );
      await owner.query(
        "ALTER TABLE public.chart_of_accounts FORCE ROW LEVEL SECURITY",
      );
      await asReplica((client) =>
        client.query("DELETE FROM account_mappings WHERE tenant_id = $1", [
          orphan,
        ]),
      );
    }
  });

  it("ISO-01 replay for the fixture tenant succeeds with a foreign orphan mapping present and leaves that row untouched", async () => {
    const entityId = await provisionedEntity(fixtureTenantId);
    const orphan = await plantOrphanMapping();

    await replayMigrationForTenant(owner, migrationSql, fixtureTenantId);

    // The fixture entity got its accounts from the replay.
    expect(await accountCodes(entityId)).toEqual(["1101", "2108", "6112"]);
    // The foreign row is still there, and nothing was created for it.
    expect(await countFor("account_mappings", "tenant_id", orphan)).toBe(1);
    expect(await countFor("chart_of_accounts", "tenant_id", orphan)).toBe(0);
    expect(await forceRls()).toEqual({
      account_mappings: true,
      chart_of_accounts: true,
    });
  });

  it("ISO-02 a second real tenant with a provisioned entity gains no 2108 / 6112 from the fixture tenant replay", async () => {
    const otherTenantId = await newTenant();
    const otherEntityId = await provisionedEntity(otherTenantId);
    const fixtureEntityId = await provisionedEntity(fixtureTenantId);

    await replayMigrationForTenant(owner, migrationSql, fixtureTenantId);

    expect(await accountCodes(fixtureEntityId)).toEqual([
      "1101",
      "2108",
      "6112",
    ]);
    expect(await accountCodes(otherEntityId)).toEqual(["1101"]);
    expect(
      await countFor("account_mappings", "legal_entity_id", otherEntityId),
    ).toBe(1);
  });

  it("ISO-03 a failing replay rolls back and leaves FORCE ROW LEVEL SECURITY on chart_of_accounts and account_mappings", async () => {
    const failing = [
      "ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;",
      "--> statement-breakpoint",
      "ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;",
      "--> statement-breakpoint",
      "SELECT 1/0;",
    ].join("\n");

    await expect(
      replayMigrationForTenant(owner, failing, fixtureTenantId),
    ).rejects.toThrow(/division by zero/);

    expect(await forceRls()).toEqual({
      account_mappings: true,
      chart_of_accounts: true,
    });
    // The pool still works: the client was released in a clean state.
    const { rows } = await owner.query<{ one: number }>("SELECT 1 AS one");
    expect(rows[0]!.one).toBe(1);
  });

  it("ISO-04 a replay that commits never lifts FORCE ROW LEVEL SECURITY (the NO FORCE statements are skipped)", async () => {
    const lifting = [
      "ALTER TABLE public.chart_of_accounts NO FORCE ROW LEVEL SECURITY;",
      "--> statement-breakpoint",
      "ALTER TABLE public.account_mappings NO FORCE ROW LEVEL SECURITY;",
      "--> statement-breakpoint",
      "SELECT 1;",
    ].join("\n");

    await replayMigrationForTenant(owner, lifting, fixtureTenantId);

    expect(await forceRls()).toEqual({
      account_mappings: true,
      chart_of_accounts: true,
    });
  });
});
