// Upgrade test for migration 0063 (beads legend-wg5t item 7). The first draft
// of 0063 added a partial UNIQUE index on edge_inbound_events and failed with
// 23505 on real pre-0063 data where the primary and the standby both hold a
// receipt for the same edge_to_cloud event. 0063 now creates the tenant-wide
// registry edge_received_events and backfills it with one row per event.
// This suite proves the upgrade path on such data: it migrates a scratch
// database to 0062, seeds the duplicate shape, then applies the full folder.
// The scratch database lives on the disposable test server and is dropped in
// afterAll; the shared test database and the real journal are never touched.
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

let admin: Pool;
let scratch: Pool;
let workDir: string;

function scratchUrl() {
  const url = new URL(adminUrl as string);
  url.pathname = `/${scratchName}`;
  return url.toString();
}

async function seedTenant(fixture: Fixture, withStandby: boolean) {
  const brand = randomUUID();
  const entity = randomUUID();
  const suffix = randomBytes(4).toString("hex");
  // Minimum columns the table constraints require (no seed tenant exists in a
  // database that stops at migration 0062).
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

beforeAll(async () => {
  // Refuse to create databases on anything but the disposable test server.
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${scratchName}`);
  scratch = new Pool({ connectionString: scratchUrl(), max: 2 });

  // Temp copy of the migrations, journal cut at idx 62. The real folder and
  // journal stay untouched.
  workDir = mkdtempSync(join(tmpdir(), "legend-mig-0062-"));
  const upTo0062 = join(workDir, "drizzle");
  cpSync(drizzleFolder, upTo0062, { recursive: true });
  const journalPath = join(upTo0062, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 62);
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrate(drizzle(scratch), { migrationsFolder: upTo0062 });

  // Pre-0063 data. Receipt times are explicit: the standby holds the EARLIEST
  // receipt of the duplicated event, so the backfill must pick the standby,
  // not simply the first node inserted.
  await seedTenant(one, true);
  await seedTenant(two, false);
  await receipt(
    one,
    one.primary,
    "edge_to_cloud",
    dupEvent,
    "2026-11-08T10:00:02Z",
  );
  await receipt(
    one,
    one.standby,
    "edge_to_cloud",
    dupEvent,
    "2026-11-08T10:00:01Z",
  );
  await receipt(
    one,
    one.primary,
    "edge_to_cloud",
    primaryOnlyEvent,
    "2026-11-08T10:00:03Z",
  );
  await receipt(
    one,
    one.primary,
    "cloud_to_edge",
    cloudToEdgeEvent,
    "2026-11-08T10:00:04Z",
  );
  // Another tenant reuses the same event id: dedupe is per tenant.
  await receipt(
    two,
    two.primary,
    "edge_to_cloud",
    dupEvent,
    "2026-11-08T10:00:05Z",
  );
  // 62 migrations into a fresh database outlast the default hook timeout on a
  // slow disposable Postgres.
}, 120_000);

afterAll(async () => {
  await scratch?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin.end();
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("legend-wg5t migration 0063 on pre-0063 duplicate receipts", () => {
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

  it("applies the full migration folder without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  });

  it("backfills one registry row per edge_to_cloud event, from the earliest receipt", async () => {
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
  });

  it("keeps every receipt: both duplicate receipts survive (append-only)", async () => {
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
  });

  it("leaves row level security forced on the receipts and on the new registry", async () => {
    const flags = await scratch.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('edge_inbound_events', 'edge_received_events')`,
    );
    const byName = Object.fromEntries(flags.rows.map((r) => [r.relname, r]));
    expect(byName.edge_inbound_events.relforcerowsecurity).toBe(true);
    expect(byName.edge_received_events.relrowsecurity).toBe(true);
    expect(byName.edge_received_events.relforcerowsecurity).toBe(true);
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
