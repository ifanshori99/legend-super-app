import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Upgrade test for migration 0065 (beads legend-wg5t item 7). The first draft
// (then numbered 0063) added a partial UNIQUE index on edge_inbound_events and failed with
// 23505 on real pre-0065 data where the primary and the standby both hold a
// receipt for the same edge_to_cloud event. 0065 now creates the tenant-wide
// registry edge_received_events and backfills it with one row per event.
// This suite proves the upgrade path on such data: it migrates a scratch
// database to 0064, seeds the duplicate shape, then applies the full folder.
// The scratch database lives on the disposable test server and is dropped in
// afterAll; the shared test database and the real journal are never touched.
// A second suite repeats the upgrade with a NON-superuser table owner, like
// production (drizzle/0001: the migration connection is a separate owner with
// CREATEROLE), because 0065 lifts and restores FORCE ROW LEVEL SECURITY and
// the test server's default user is a superuser that bypasses RLS anyway.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const scratchName = `edge_rcv_mig_${randomBytes(6).toString("hex")}`;

type Node = { id: string; role: "primary" | "standby" };
type Fixture = {
  tenantId: string;
  outletId: string;
  primary: Node;
  standby: Node;
};

const newFixture = (): Fixture => ({
  tenantId: randomUUID(),
  outletId: randomUUID(),
  primary: { id: randomUUID(), role: "primary" },
  standby: { id: randomUUID(), role: "standby" },
});
const one = newFixture();
const two = newFixture();
const dupEvent = randomUUID(); // seen by both nodes of tenant one, and by tenant two
const primaryOnlyEvent = randomUUID();
const cloudToEdgeEvent = randomUUID();

function urlFor(database: string, user?: string, password?: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
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

// Temp copy of the migrations, journal cut at idx 64 (the last migration
// before 0065). The real folder and
// journal stay untouched.
function copyMigrationsUpTo0064() {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-0064-"));
  const upTo0064 = join(dir, "drizzle");
  cpSync(drizzleFolder, upTo0064, { recursive: true });
  const journalPath = join(upTo0064, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 64);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, upTo0064 };
}

async function seedTenant(
  scratch: Pool,
  fixture: Fixture,
  withStandby: boolean,
) {
  const brand = randomUUID();
  const entity = randomUUID();
  const suffix = randomBytes(4).toString("hex");
  // Minimum columns the table constraints require (no seed tenant exists in a
  // database that stops at migration 0064).
  await scratch.query(
    `INSERT INTO tenants (id, slug, name, plan, deployment_mode, limits, created_by)
     VALUES ($1, $2, 'Tenant Upgrade Uji', 'starter', 'shared', '{}'::jsonb, $3)`,
    [fixture.tenantId, `upgrade-uji-${suffix}`, randomUUID()],
  );
  await scratch.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, fixture.tenantId, `upgrade-uji-${suffix}`],
  );
  await scratch.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, fixture.tenantId],
  );
  await scratch.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'UJI-01', 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [fixture.outletId, fixture.tenantId, brand, entity],
  );
  const nodes = withStandby
    ? [fixture.primary, fixture.standby]
    : [fixture.primary];
  for (const node of nodes)
    await scratch.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        node.id,
        fixture.tenantId,
        fixture.outletId,
        node.role,
        `node-${node.role}`,
        randomBytes(32).toString("hex"),
      ],
    );
}

function receipt(
  scratch: Pool,
  fixture: Fixture,
  node: Node,
  direction: "edge_to_cloud" | "cloud_to_edge",
  eventId: string,
  receivedAt: string,
) {
  return scratch.query(
    `INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome, received_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'order', $6, 1, 'transaction_event', 'applied', $7)`,
    [
      fixture.tenantId,
      fixture.outletId,
      node.id,
      direction,
      eventId,
      randomUUID(),
      receivedAt,
    ],
  );
}

// Pre-0065 data. Receipt times are explicit: the standby holds the EARLIEST
// receipt of the duplicated event, so the backfill must pick the standby,
// not simply the first node inserted. Seeded by the superuser, which
// bypasses RLS on the owner's tables.
async function seedDuplicateShape(scratch: Pool) {
  await seedTenant(scratch, one, true);
  await seedTenant(scratch, two, false);
  const at = (second: number) => `2026-11-08T10:00:0${second}Z`;
  await receipt(scratch, one, one.primary, "edge_to_cloud", dupEvent, at(2));
  await receipt(scratch, one, one.standby, "edge_to_cloud", dupEvent, at(1));
  await receipt(
    scratch,
    one,
    one.primary,
    "edge_to_cloud",
    primaryOnlyEvent,
    at(3),
  );
  await receipt(
    scratch,
    one,
    one.primary,
    "cloud_to_edge",
    cloudToEdgeEvent,
    at(4),
  );
  // Another tenant reuses the same event id: dedupe is per tenant.
  await receipt(scratch, two, two.primary, "edge_to_cloud", dupEvent, at(5));
}

async function expectBackfilledRegistry(scratch: Pool) {
  const rows = await scratch.query(
    `SELECT tenant_id, event_id, outlet_id, first_edge_node_id
       FROM edge_received_events ORDER BY tenant_id, event_id`,
  );
  // tenant one: duplicated event + primary-only event; tenant two: the reused id.
  expect(rows.rowCount).toBe(3);
  const key = (tenantId: string, eventId: string) =>
    rows.rows.find((r) => r.tenant_id === tenantId && r.event_id === eventId);
  const dup = key(one.tenantId, dupEvent);
  expect(dup.first_edge_node_id).toBe(one.standby.id);
  expect(dup.outlet_id).toBe(one.outletId);
  expect(key(one.tenantId, primaryOnlyEvent).first_edge_node_id).toBe(
    one.primary.id,
  );
  expect(key(two.tenantId, dupEvent).first_edge_node_id).toBe(two.primary.id);
  // cloud_to_edge receipts are per node and never enter the registry.
  expect(key(one.tenantId, cloudToEdgeEvent)).toBeUndefined();
}

async function expectReceiptsKept(scratch: Pool) {
  const dup = await scratch.query(
    `SELECT count(*)::int AS n FROM edge_inbound_events
      WHERE tenant_id = $1 AND direction = 'edge_to_cloud' AND event_id = $2`,
    [one.tenantId, dupEvent],
  );
  expect(dup.rows[0].n).toBe(2);
  const all = await scratch.query(
    `SELECT count(*)::int AS n FROM edge_inbound_events`,
  );
  expect(all.rows[0].n).toBe(5);
}

async function expectMigrationForeignKeysValidated(scratch: Pool) {
  const constraint = await scratch.query(
    `SELECT c.convalidated,
            c.confrelid = 'public.payroll_payout_gl_postings'::regclass AS correct_target,
            ARRAY(
              SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ORDER BY k.position
            ) AS source_columns,
            ARRAY(
              SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
              ORDER BY k.position
            ) AS target_columns
       FROM pg_constraint c
      WHERE c.conname = 'payroll_disbursement_items_gl_posting_fk'
        AND c.conrelid = 'public.payroll_disbursement_items'::regclass
        AND c.contype = 'f'`,
  );
  expect(constraint.rows).toEqual([
    {
      convalidated: true,
      correct_target: true,
      source_columns: ["tenant_id", "batch_id", "gl_posting_id"],
      target_columns: ["tenant_id", "batch_id", "id"],
    },
  ]);
  const edgeConstraints = await scratch.query(
    `SELECT conname, convalidated, confrelid::regclass::text AS target_table
       FROM pg_constraint
      WHERE conname = ANY($1)
        AND contype = 'f'
      ORDER BY conname`,
    [
      [
        "edge_link_dead_letters_edge_node_fk",
        "edge_link_dead_letters_outlet_id_outlets_id_fk",
        "edge_receipt_skips_outlet_id_outlets_id_fk",
      ],
    ],
  );
  expect(edgeConstraints.rows).toEqual([
    {
      conname: "edge_link_dead_letters_edge_node_fk",
      convalidated: true,
      target_table: "edge_nodes",
    },
    {
      conname: "edge_link_dead_letters_outlet_id_outlets_id_fk",
      convalidated: true,
      target_table: "outlets",
    },
    {
      conname: "edge_receipt_skips_outlet_id_outlets_id_fk",
      convalidated: true,
      target_table: "outlets",
    },
  ]);
}

// legend-pz641 (0376): the slot table is backfilled from the counted receipts
// only. Every seeded receipt sits at link_seq 1, so the primary's two counted
// edge_to_cloud receipts share one slot and that slot must stay empty.
async function expectLinkSlotsBackfilled(scratch: Pool) {
  const rows = await scratch.query(
    `SELECT tenant_id, edge_node_id, direction, link_seq::int AS link_seq, event_id
       FROM edge_link_slots`,
  );
  const slot = (
    tenantId: string,
    nodeId: string,
    direction: string,
    eventId: string,
  ) => ({
    tenant_id: tenantId,
    edge_node_id: nodeId,
    direction,
    link_seq: 1,
    event_id: eventId,
  });
  const sortKey = (r: { tenant_id: string; edge_node_id: string }) =>
    `${r.tenant_id}/${r.edge_node_id}`;
  expect(
    [...rows.rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  ).toEqual(
    [
      slot(one.tenantId, one.standby.id, "edge_to_cloud", dupEvent),
      slot(one.tenantId, one.primary.id, "cloud_to_edge", cloudToEdgeEvent),
      slot(two.tenantId, two.primary.id, "edge_to_cloud", dupEvent),
    ].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  );
  const flags = await scratch.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'public.edge_link_slots'::regclass`,
  );
  expect(flags.rows[0]).toEqual({
    relrowsecurity: true,
    relforcerowsecurity: true,
  });
}

async function expectRlsStillForced(scratch: Pool) {
  // 0065 lifts FORCE on outlets, edge_nodes and edge_inbound_events for its
  // FKs and backfill; 0068 lifts it on outlets and stations; 0069 on outlets
  // and edge_nodes. Each must restore it before it commits, and the tables the
  // three migrations create must end with RLS forced. 0386 also lifts FORCE
  // for its handover FK; 0534 does so for its payout posting FK. Each must
  // restore FORCE before the transaction commits. 0352 and 0353 must also
  // leave their new edge tables and FK targets with FORCE restored.
  const tables = [
    "outlets",
    "edge_nodes",
    "stations",
    "edge_inbound_events",
    "edge_received_events",
    "devices",
    "device_training_periods",
    "edge_pull_checkpoints",
    "shift_handovers",
    "payroll_disbursement_items",
    "payroll_payout_gl_postings",
    "edge_link_dead_letters",
    "edge_receipt_skips",
  ];
  const flags = await scratch.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
    [tables],
  );
  const byName = Object.fromEntries(flags.rows.map((r) => [r.relname, r]));
  for (const table of tables) {
    expect(byName[table]?.relrowsecurity, `${table} row security`).toBe(true);
    expect(byName[table]?.relforcerowsecurity, `${table} FORCE`).toBe(true);
  }
}

describe("legend-wg5t migration 0065 on pre-0065 duplicate receipts", () => {
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsUpTo0064();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.upTo0064 });
    await seedDuplicateShape(scratch);
    // 65 migrations into a fresh database outlast the default hook timeout on a
    // slow disposable Postgres.
  }, 120_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the fixture really holds the data shape that broke the old index", async () => {
    const dup = await scratch.query(
      `SELECT count(*)::int AS n FROM edge_inbound_events
        WHERE tenant_id = $1 AND direction = 'edge_to_cloud' AND event_id = $2`,
      [one.tenantId, dupEvent],
    );
    expect(dup.rows[0].n).toBe(2);
    const registry = await scratch.query(
      `SELECT to_regclass('public.edge_received_events') AS name`,
    );
    expect(registry.rows[0].name).toBeNull();
  });

  // The growing full migration folder can outlast the default test timeout.
  it("applies the full migration folder without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("backfills one registry row per edge_to_cloud event, from the earliest receipt", async () => {
    await expectBackfilledRegistry(scratch);
  });

  it("keeps every receipt: both duplicate receipts survive (append-only)", async () => {
    await expectReceiptsKept(scratch);
  });

  it("leaves row level security forced on the receipts and on the new registry", async () => {
    await expectRlsStillForced(scratch);
    await expectMigrationForeignKeysValidated(scratch);
  });

  it("the old partial unique index is gone and the registry is append-only", async () => {
    const indexes = await scratch.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'edge_inbound_events' AND indexdef ILIKE '%UNIQUE%event_id%edge_to_cloud%'`,
    );
    expect(indexes.rowCount).toBe(0);
    await expect(
      scratch.query(`DELETE FROM edge_received_events WHERE tenant_id = $1`, [
        one.tenantId,
      ]),
    ).rejects.toThrow(/append-only|not allowed|immutable/i);
  });
});

describe("legend-wg5t migration 0065 run by a non-superuser table owner", () => {
  const ownerRole = `edge_rcv_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const ownerDatabase = `edge_rcv_own_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, connected to the server's default database
  let adminInScratch: Pool; // superuser, connected to the owner's database
  let owner: Pool; // the migrator, NOSUPERUSER; reopened without BYPASSRLS
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Role names and the hex password are generated here, so interpolation
    // into DDL (which takes no bind parameters) is safe.
    // Only 0065 is under test here. Migrations 0000..0064 need BYPASSRLS for
    // a non-superuser owner: adding a foreign key to a table with FORCE ROW
    // LEVEL SECURITY validates existing rows under the tenant policy, which
    // raises "tenant context is required" without app.tenant_id (first hit
    // in 0004, domain_event_replays; again in 0063,
    // fiscal_period_snapshot_lines). That is older than 0065 and out of scope,
    // so the role starts with BYPASSRLS and loses it before 0065 runs.
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
    const copy = copyMigrationsUpTo0064();
    workDir = copy.dir;
    await migrate(drizzle(owner), { migrationsFolder: copy.upTo0064 });
    await seedDuplicateShape(adminInScratch);
    // Production shape from here on (drizzle/0001): a plain table owner with
    // CREATEROLE, subject to RLS. ALTER ROLE only applies to new sessions, so
    // the migrator gets a fresh pool.
    await endTestPool(owner);
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
    owner = new Pool({
      connectionString: urlFor(ownerDatabase, ownerRole, ownerPassword),
      max: 1,
    });
  }, 120_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (adminInScratch) await endTestPool(adminInScratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, ownerDatabase);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the migrator really is a plain table owner that RLS applies to", async () => {
    const role = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = $1`,
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: true,
    });
    // The migrator's own session is the one that must be a plain owner.
    const session = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(session.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const tableOwner = await adminInScratch.query(
      `SELECT pg_get_userbyid(relowner) AS owner, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.edge_inbound_events'::regclass`,
    );
    expect(tableOwner.rows[0]).toEqual({
      owner: ownerRole,
      relforcerowsecurity: true,
    });
  });

  // The growing full migration folder can outlast the default test timeout.
  it("applies the full migration folder as the non-superuser owner", async () => {
    await expect(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 120_000);

  it("backfills one registry row per edge_to_cloud event, from the earliest receipt", async () => {
    await expectBackfilledRegistry(adminInScratch);
  });

  it("keeps every receipt: both duplicate receipts survive (append-only)", async () => {
    await expectReceiptsKept(adminInScratch);
  });

  it("leaves row level security forced on the receipts and on the new registry", async () => {
    await expectRlsStillForced(adminInScratch);
    await expectMigrationForeignKeysValidated(adminInScratch);
  });

  it("0376 backfills edge_link_slots from counted receipts and restores FORCE RLS", async () => {
    await expectLinkSlotsBackfilled(adminInScratch);
  });
});
