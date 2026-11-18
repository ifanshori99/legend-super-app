// legend-kai round 2, item 1 (P1): the 0484 baseline backfill under FORCE RLS.
//
// 0484 gives every edge node that already queued edge_to_cloud events a row in
// edge_txn_ledger_baselines (from_link_seq = next_out_seq), read from
// sync_cursors. sync_cursors carries FORCE ROW LEVEL SECURITY (tenant policy
// plus the outlet backstop), and production runs migrations as a plain table
// owner: NOSUPERUSER, NOBYPASSRLS. A backfill without a tenant (and outlet)
// context raises "tenant context required" for that owner, so the whole
// migration, and the deploy, would fail on a database that already has edge
// sync data. A superuser ignores RLS, so only a run as that owner shows it.
//
// Assumption: the contract is "per-tenant loop that sets app.tenant_id (and the
// outlet scope the outlet policy needs) for the backfill". The test asserts the
// outcome (rows copied, RLS still forced), not how the SQL does it.
//
// Model: stock-ledger-posting-seq-migration.test.ts (non-superuser owner suite)
// and access-perm-backfill-migration.test.ts (fixtures in the pre-migration
// shape). The scratch database lives on the disposable test server and is
// dropped in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migration-session";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleDir = join(apiRoot, "drizzle");
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const TAG_PREFIX = "0484_";

type Journal = {
  entries: { idx: number; when: number; tag: string }[];
};

function readJournal(): Journal {
  return JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

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

// Pool.end() resolves before the server has closed the sessions; a forced
// DROP DATABASE racing them terminates a client that is still closing (57P01).
async function waitForNoSessions(admin: Pool, db: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [db],
    );
    if (rows[0]?.n === 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
}

// A copy of drizzle/ holding every migration before 0484 (the journal is cut at
// the 0484 entry; its SQL file is not copied).
function copyFolderWithout0484(workDir: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter(
    (entry) => !entry.tag.startsWith(TAG_PREFIX),
  );
  expect(kept.length).toBeLessThan(journal.entries.length);
  const keptTags = new Set(kept.map((entry) => entry.tag));
  const folder = join(workDir, "drizzle-before-0484");
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const file of readdirSync(drizzleDir))
    if (file.endsWith(".sql") && keptTags.has(file.replace(/\.sql$/, "")))
      cpSync(join(drizzleDir, file), join(folder, file));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

// Fixture ids. Tenant one has two outlets (the backfill must cover every
// outlet of a tenant, not one scope); tenant two has one; tenant three has
// nothing edge-related at all.
const tenantOne = randomUUID();
const tenantTwo = randomUUID();
const tenantThree = randomUUID();
const outletOneA = randomUUID();
const outletOneB = randomUUID();
const outletTwo = randomUUID();
const outletOneC = randomUUID(); // own outlet: one active primary node per outlet
const outletTwoB = randomUUID();
const nodeOneA = randomUUID(); // edge_to_cloud next_out_seq 7, cloud_to_edge 5
const nodeOneB = randomUUID(); // other outlet of tenant one, next_out_seq 11
const nodeOneC = randomUUID(); // edge_to_cloud next_out_seq 0: never queued
const nodeTwoA = randomUUID(); // tenant two, next_out_seq 3
const nodeTwoB = randomUUID(); // tenant two, only cloud_to_edge activity

async function insertTenant(client: PoolClient, tenantId: string) {
  await client.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Edge ledger backfill', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `edge-ledger-${tenantId}`, randomUUID()],
  );
}

async function insertOutlet(
  client: PoolClient,
  tenantId: string,
  outletId: string,
  code: string,
) {
  await client.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, randomUUID(), randomUUID(), code],
  );
}

async function insertNode(
  client: PoolClient,
  tenantId: string,
  outletId: string,
  nodeId: string,
) {
  await client.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
     VALUES ($1, $2, $3, 'primary', $4, $5)`,
    [
      nodeId,
      tenantId,
      outletId,
      `node-${nodeId}`,
      randomBytes(32).toString("hex"),
    ],
  );
}

async function insertCursor(
  client: PoolClient,
  tenantId: string,
  outletId: string,
  nodeId: string,
  direction: "edge_to_cloud" | "cloud_to_edge",
  nextOutSeq: number,
) {
  await client.query(
    `INSERT INTO sync_cursors
       (tenant_id, outlet_id, edge_node_id, direction, next_out_seq, acked_out_seq, received_in_seq)
     VALUES ($1, $2, $3, $4, $5, 0, 0)`,
    [tenantId, outletId, nodeId, direction, nextOutSeq],
  );
}

// Pre-0484 data, written by the superuser (RLS bypassed).
async function seedOldEdgeData(client: PoolClient) {
  for (const tenantId of [tenantOne, tenantTwo, tenantThree])
    await insertTenant(client, tenantId);
  await insertOutlet(client, tenantOne, outletOneA, "KAI-1A");
  await insertOutlet(client, tenantOne, outletOneB, "KAI-1B");
  await insertOutlet(client, tenantTwo, outletTwo, "KAI-2");
  await insertOutlet(client, tenantOne, outletOneC, "KAI-1C");
  await insertOutlet(client, tenantTwo, outletTwoB, "KAI-2B");
  await insertNode(client, tenantOne, outletOneA, nodeOneA);
  await insertNode(client, tenantOne, outletOneB, nodeOneB);
  await insertNode(client, tenantOne, outletOneC, nodeOneC);
  await insertNode(client, tenantTwo, outletTwo, nodeTwoA);
  await insertNode(client, tenantTwo, outletTwoB, nodeTwoB);
  await insertCursor(
    client,
    tenantOne,
    outletOneA,
    nodeOneA,
    "edge_to_cloud",
    7,
  );
  await insertCursor(
    client,
    tenantOne,
    outletOneA,
    nodeOneA,
    "cloud_to_edge",
    5,
  );
  await insertCursor(
    client,
    tenantOne,
    outletOneB,
    nodeOneB,
    "edge_to_cloud",
    11,
  );
  await insertCursor(
    client,
    tenantOne,
    outletOneC,
    nodeOneC,
    "edge_to_cloud",
    0,
  );
  await insertCursor(
    client,
    tenantTwo,
    outletTwo,
    nodeTwoA,
    "edge_to_cloud",
    3,
  );
  await insertCursor(
    client,
    tenantTwo,
    outletTwoB,
    nodeTwoB,
    "cloud_to_edge",
    9,
  );
}

// Production runs migrations as a plain table owner. Older migrations need
// BYPASSRLS for a non-superuser owner (foreign keys onto force-RLS tables
// validate rows under the tenant policy), so the role loses it only after the
// migrations before 0484 are applied, exactly like the posting-seq suite.
describe("legend-kai migration 0484 baseline backfill run by a non-superuser table owner", () => {
  const ownerRole = `edgeledger_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `edgeledger_own_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, default database
  let adminInScratch: Pool; // superuser, the owner's database
  let owner: Pool; // the migrator: NOSUPERUSER NOBYPASSRLS
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role name and hex password are generated here, so interpolation into DDL
    // (no bind parameters) is safe.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    // legend_payout (drizzle/0410) is cluster-wide and already exists, created by
    // the bootstrap superuser; the migrator manages it through ADMIN OPTION only,
    // as provisionMigrator gives it in production (db/migrator-role.ts).
    await admin.query(
      `GRANT legend_payout TO ${ownerRole} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    await admin.query(`CREATE DATABASE ${ownerDatabase} OWNER ${ownerRole}`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
    adminInScratch = new Pool({
      connectionString: urlFor(ownerDatabase),
      max: 1,
    });
    workDir = mkdtempSync(join(tmpdir(), "legend-edge-ledger-owner-"));
    await runMigrations(owner, copyFolderWithout0484(workDir), {
      lockTimeout: "10s",
      statementTimeout: "0",
    });

    // Fixtures go in as superuser (RLS bypassed, foreign keys skipped).
    const client = await adminInScratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await seedOldEdgeData(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // ALTER ROLE applies to new sessions only: reopen the migrator's pool.
    await owner.end();
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
  }, 240_000);

  afterAll(async () => {
    await owner?.end();
    await adminInScratch?.end();
    if (admin) {
      await waitForNoSessions(admin, ownerDatabase);
      await admin.query(
        `DROP DATABASE IF EXISTS ${ownerDatabase} WITH (FORCE)`,
      );
      await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      await admin.end();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the migrator really is a plain table owner that FORCE RLS applies to, over old edge data", async () => {
    const role = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const table = await adminInScratch.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE oid = 'public.sync_cursors'::regclass`,
    );
    expect(table.rows[0]?.owner).toBe(ownerRole);
    // Without a tenant context the owner cannot read the cursors: FORCE RLS is
    // in effect (zero rows or a "tenant context required" error).
    const seen = await owner.query("SELECT 1 FROM sync_cursors").then(
      (result) => result.rowCount,
      (error: Error) => error.message,
    );
    expect(
      seen === 0 || /tenant context|scope context/i.test(String(seen)),
    ).toBe(true);
    // The superuser sees the six old cursor rows the backfill must read.
    const all = await adminInScratch.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sync_cursors",
    );
    expect(all.rows[0]?.n).toBe(6);
    const ledger = await adminInScratch.query(
      "SELECT to_regclass('public.edge_txn_ledger_baselines') AS name",
    );
    expect(ledger.rows[0]?.name).toBeNull();
  });

  it("applies the real 0484 as that owner without error", async () => {
    await expect(
      runMigrations(owner, drizzleDir, {
        lockTimeout: "10s",
        statementTimeout: "0",
      }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("copies the link sequence of every node that already queued edge_to_cloud events, in every tenant and outlet", async () => {
    const { rows } = await adminInScratch.query<{
      tenant_id: string;
      outlet_id: string;
      edge_node_id: string;
      from_link_seq: string;
    }>(
      `SELECT tenant_id, outlet_id, edge_node_id, from_link_seq::text AS from_link_seq
         FROM edge_txn_ledger_baselines ORDER BY from_link_seq::bigint`,
    );
    expect(rows).toEqual([
      {
        tenant_id: tenantTwo,
        outlet_id: outletTwo,
        edge_node_id: nodeTwoA,
        from_link_seq: "3",
      },
      {
        tenant_id: tenantOne,
        outlet_id: outletOneA,
        edge_node_id: nodeOneA,
        from_link_seq: "7",
      },
      {
        tenant_id: tenantOne,
        outlet_id: outletOneB,
        edge_node_id: nodeOneB,
        from_link_seq: "11",
      },
    ]);
  });

  it("writes no baseline for cloud_to_edge cursors or for a node that never queued", async () => {
    const { rows } = await adminInScratch.query<{ edge_node_id: string }>(
      `SELECT edge_node_id FROM edge_txn_ledger_baselines
        WHERE edge_node_id = ANY($1::uuid[])`,
      [[nodeOneC, nodeTwoB]],
    );
    expect(rows).toEqual([]);
    const tenantThreeRows = await adminInScratch.query(
      "SELECT 1 FROM edge_txn_ledger_baselines WHERE tenant_id = $1",
      [tenantThree],
    );
    expect(tenantThreeRows.rowCount).toBe(0);
  });

  it("leaves the old cursors untouched", async () => {
    const { rows } = await adminInScratch.query<{
      edge_node_id: string;
      direction: string;
      next_out_seq: string;
    }>(
      `SELECT edge_node_id, direction, next_out_seq::text AS next_out_seq
         FROM sync_cursors ORDER BY edge_node_id, direction`,
    );
    expect(rows).toHaveLength(6);
    const seq = (node: string, direction: string) =>
      rows.find(
        (row) => row.edge_node_id === node && row.direction === direction,
      )?.next_out_seq;
    expect(seq(nodeOneA, "edge_to_cloud")).toBe("7");
    expect(seq(nodeOneA, "cloud_to_edge")).toBe("5");
    expect(seq(nodeOneB, "edge_to_cloud")).toBe("11");
    expect(seq(nodeTwoA, "edge_to_cloud")).toBe("3");
  });

  it("the new tables and the tables the backfill read still enforce FORCE RLS with an outlet policy", async () => {
    const tables = [
      "sync_cursors",
      "edge_nodes",
      "edge_txn_ledger",
      "edge_txn_ledger_baselines",
      "edge_txn_ledger_events",
      "edge_reconciliation_runs",
    ];
    const flags = await adminInScratch.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [tables],
    );
    const byName = Object.fromEntries(flags.rows.map((r) => [r.relname, r]));
    for (const table of tables) {
      expect(byName[table]?.relrowsecurity, `${table} row security`).toBe(true);
      expect(byName[table]?.relforcerowsecurity, `${table} FORCE`).toBe(true);
    }
    const policies = await adminInScratch.query<{
      tablename: string;
      policyname: string;
    }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [tables.filter((t) => t.startsWith("edge_txn") || t.endsWith("_runs"))],
    );
    for (const table of tables.filter(
      (t) => t.startsWith("edge_txn") || t.endsWith("_runs"),
    )) {
      const names = policies.rows
        .filter((row) => row.tablename === table)
        .map((row) => row.policyname);
      expect(names, `${table} policies`).toContain("tenant_isolation");
      expect(names, `${table} policies`).toContain("outlet_isolation");
    }
  });

  it("an owner without a tenant context still reads nothing from the new baselines (RLS was not weakened)", async () => {
    const seen = await owner
      .query("SELECT 1 FROM edge_txn_ledger_baselines")
      .then(
        (result) => result.rowCount,
        (error: Error) => error.message,
      );
    expect(
      seen === 0 || /tenant context|scope context/i.test(String(seen)),
    ).toBe(true);
  });

  it("migration 0484 is registered in the journal after every earlier migration", () => {
    const entries = readJournal().entries;
    const entry = entries.find((item) => item.tag.startsWith(TAG_PREFIX));
    expect(entry?.tag).toBe("0484_edge_txn_ledger");
    // Drizzle skips a migration whose `when` is not above the last applied
    // one, so this entry must out-rank every entry before it. Later
    // migrations may legitimately out-rank it, so it is not required to be
    // the newest.
    const before = entries.filter((item) => item.idx < (entry?.idx ?? 0));
    expect(before.length).toBeGreaterThan(0);
    expect(entry?.when).toBeGreaterThan(
      Math.max(...before.map((item) => item.when)),
    );
  });
});
