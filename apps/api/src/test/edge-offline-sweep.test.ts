// legend-5ab0l (S6), cloud "edge offline" alarm sweep. Written from
// docs/design/edge-status-cloud.md section 8 (D9-D12, tests T29-T34), not from
// the implementation. The pure window helper has its own unit test:
// src/test/edge-offline-open-since.test.ts.
//
//   services/edge-offline-sweep.ts
//     sweepEdgeOfflineAlerts(db, { now, thresholdMinutes })
//       -> Promise<{ raised, resolved, failed }>
//
// Assumptions (the design does not spell them out):
// - `raised` counts alerts newly opened by this sweep, `resolved` counts alerts
//   closed by it, `failed` counts nodes whose handling threw. Only the FIRST
//   sweep of a scenario has its counts asserted exactly; a repeat sweep asserts
//   rows and notifications (a repeat that re-confirms an open alert may or may
//   not be counted in `raised`).
// - `now` is a fixed instant in the past (March 2026). Nodes made by other test
//   files carry heartbeats from the real clock, so for them `now - heartbeat` is
//   negative: they never alarm and the counts below stay exact. Nodes of THIS file
//   have their heartbeat reset to null before each test (null = skipped).
// - Threshold is `>=`: a gap of exactly `thresholdMinutes` alarms.
// - Notification copy: "Edge outlet tidak terhubung lebih dari {menit} menit saat
//   jam buka" plus the outlet name; the test joins title and body, so it holds
//   whichever field carries the text. Recipients: outlet supervisors and owners.
// - The alert kind is the string "edge_offline".
// - A failure is injected with a database trigger that refuses inserts into
//   edge_node_alerts for one node id (implementation independent), dropped
//   afterwards.
// - Resolving needs only a fresh heartbeat (D11), even when the outlet is closed.
// - Fixtures: tenant 1 with outlet A (supervisor + node), outlet B (node, no
//   supervisor), an owner; tenant 2 with outlet C (node) and its own owner.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  cafeLegendPlatformFixtures,
  type OpeningHours,
} from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { db } from "../db/index.ts";
import { createAppPool } from "../db/role.ts";
import * as schema from "../db/schema/index.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  startEdgeOfflineSweepWorker,
  sweepEdgeOfflineAlerts,
} from "../services/edge-offline-sweep.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const tenant2Id = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const outletC = randomUUID();
const supervisorUserId = randomUUID();
const ownerUserId = randomUUID();
const owner2UserId = randomUUID();
const NAME_A = "Outlet Offline Alfa";
const NAME_B = "Outlet Offline Bravo";
const NAME_C = "Outlet Offline Charlie";
const KIND = "edge_offline";
const MINUTE = 60_000;

type Day = keyof OpeningHours;
type Hours = { opens: string; closes: string } | null;
type Site = {
  tenantId: string;
  outletId: string;
  nodeId: string;
  name: string;
};
let siteA: Site;
let siteB: Site;
let siteC: Site;

const week = (days: Partial<Record<Day, Hours>>): OpeningHours => ({
  mon: null,
  tue: null,
  wed: null,
  thu: null,
  fri: null,
  sat: null,
  sun: null,
  ...days,
});
const everyDay = (hours: Hours): OpeningHours =>
  week({
    mon: hours,
    tue: hours,
    wed: hours,
    thu: hours,
    fri: hours,
    sat: hours,
    sun: hours,
  });
const DAILY = everyDay({ opens: "08:00", closes: "22:00" });

// 2026-03-04 is a Wednesday. Asia/Jakarta is UTC+7, Asia/Jayapura UTC+9.
const NOW_OPEN = new Date("2026-03-04T05:00:00.000Z"); // Wed 12:00 WIB, open since 08:00
const before = (from: Date, minutes: number) =>
  new Date(from.getTime() - minutes * MINUTE);
const after = (from: Date, minutes: number) =>
  new Date(from.getTime() + minutes * MINUTE);

const scopeFor = (tid: string, outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tid, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function asOwnerTenant<T>(
  tid: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tid],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------- fixtures

async function createTenantFixture(tid: string) {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Edge Offline', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tid,
      `edge-offline-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tid, `edge-offline-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tid],
  );
  return { brand, entity };
}

async function addOutlet(
  tid: string,
  fixture: { brand: string; entity: string },
  outletId: string,
  name: string,
) {
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', 'Asia/Jakarta', $7, 'active')`,
    [
      outletId,
      tid,
      fixture.brand,
      fixture.entity,
      `EOF-${randomBytes(3).toString("hex").toUpperCase()}`,
      name,
      JSON.stringify(DAILY),
    ],
  );
}

async function addUser(
  tid: string,
  userId: string,
  name: string,
  templateKey: "supervisor" | "owner",
  scope: { type: "outlet" | "tenant"; id: string | null },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `offline-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [roleId, tid, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  if (role.rowCount !== 1) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tid, userId, roleId, scope.type, scope.id],
  );
}

async function registerSite(
  tid: string,
  outletId: string,
  name: string,
): Promise<Site> {
  const registered = await registerEdgeNode(scopeFor(tid, [outletId]), actor, {
    outletId,
    role: "primary",
    label: `Node ${name}`,
  });
  return { tenantId: tid, outletId, nodeId: registered.edgeNode.id, name };
}

/** A fresh outlet with its own primary node (a revoked node frees nothing). */
async function newSite(tid: string, name: string): Promise<Site> {
  const fixture = await asOwnerTenant(tid, async (client) => {
    const { rows } = await client.query<{
      brand_id: string;
      legal_entity_id: string;
    }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
      tid === tenantId ? outletA : outletC,
    ]);
    return { brand: rows[0]!.brand_id, entity: rows[0]!.legal_entity_id };
  });
  const outletId = randomUUID();
  await addOutlet(tid, fixture, outletId, name);
  return registerSite(tid, outletId, name);
}

// --------------------------------------------------------------------- state

const setHeartbeat = (site: Site, at: Date | null) =>
  asOwnerTenant(site.tenantId, (client) =>
    client.query("UPDATE edge_nodes SET last_heartbeat_at = $2 WHERE id = $1", [
      site.nodeId,
      at,
    ]),
  );

const setHours = (site: Site, hours: OpeningHours, timeZone = "Asia/Jakarta") =>
  asOwnerTenant(site.tenantId, (client) =>
    client.query(
      "UPDATE outlets SET opening_hours = $2, timezone = $3 WHERE id = $1",
      [site.outletId, JSON.stringify(hours), timeZone],
    ),
  );

type AlertRow = {
  id: string;
  edge_node_id: string;
  outlet_id: string;
  tenant_id: string;
  raised_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
};

async function alertsOf(tid: string, nodeId?: string): Promise<AlertRow[]> {
  return asOwnerTenant(tid, async (client) => {
    const { rows } = await client.query<AlertRow>(
      `SELECT id, edge_node_id, outlet_id, tenant_id, raised_at, last_seen_at, resolved_at
         FROM edge_node_alerts
        WHERE tenant_id = $1 AND kind = $2 AND ($3::uuid IS NULL OR edge_node_id = $3::uuid)
        ORDER BY raised_at, created_at`,
      [tid, KIND, nodeId ?? null],
    );
    return rows;
  });
}

const openAlertsOf = async (tid: string, nodeId?: string) =>
  (await alertsOf(tid, nodeId)).filter((row) => row.resolved_at === null);

type NotificationRow = { user_id: string; text: string };

async function notificationsOf(tid: string): Promise<NotificationRow[]> {
  const { rows } = await owner.query<NotificationRow>(
    `SELECT user_id, title || ' ' || body AS text
       FROM notifications WHERE tenant_id = $1 ORDER BY user_id, created_at`,
    [tid],
  );
  return rows;
}

const aboutOutlet = (rows: NotificationRow[], name: string) =>
  rows.filter((row) => row.text.includes(name));

const sweep = (now: Date, thresholdMinutes = 30) =>
  sweepEdgeOfflineAlerts(db, { now, thresholdMinutes });

async function restartedWorkerSweep(now: Date) {
  let finish!: (result: Awaited<ReturnType<typeof sweep>>) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<Awaited<ReturnType<typeof sweep>>>(
    (resolve, reject) => {
      finish = resolve;
      fail = reject;
    },
  );
  const worker = startEdgeOfflineSweepWorker(
    db,
    { intervalMs: 3_600_000, thresholdMinutes: 30 },
    async (database, options) => {
      try {
        const result = await sweepEdgeOfflineAlerts(database, {
          ...options,
          now,
        });
        finish(result);
        return result;
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  );
  try {
    return await done;
  } finally {
    await worker.stop();
  }
}

async function resetState() {
  for (const tid of [tenantId, tenant2Id]) {
    await asOwnerTenant(tid, async (client) => {
      await client.query("DELETE FROM edge_node_alerts WHERE tenant_id = $1", [
        tid,
      ]);
      await client.query(
        "UPDATE edge_nodes SET last_heartbeat_at = NULL WHERE tenant_id = $1",
        [tid],
      );
    });
    await owner.query("DELETE FROM delivery_attempts WHERE tenant_id = $1", [
      tid,
    ]);
    await owner.query("DELETE FROM notifications WHERE tenant_id = $1", [tid]);
    // Notification ids derive from the alert id; clear the consumer's dedupe too.
    await owner.query("DELETE FROM notification_outbox WHERE tenant_id = $1", [
      tid,
    ]);
  }
  for (const site of [siteA, siteB, siteC]) await setHours(site, DAILY);
  await asOwnerTenant(tenantId, (client) =>
    client.query("UPDATE outlets SET status = 'active' WHERE id = $1", [
      outletA,
    ]),
  );
}

// ------------------------------------------------------------------- set up

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // registerEdgeNode / revokeEdgeNode refuse to run without an audit writer.
  setAuditWriter(coreAuditWriter);
  const one = await createTenantFixture(tenantId);
  await addOutlet(tenantId, one, outletA, NAME_A);
  await addOutlet(tenantId, one, outletB, NAME_B);
  const two = await createTenantFixture(tenant2Id);
  await addOutlet(tenant2Id, two, outletC, NAME_C);
  await addUser(
    tenantId,
    supervisorUserId,
    "Supervisor Offline",
    "supervisor",
    {
      type: "outlet",
      id: outletA,
    },
  );
  await addUser(tenantId, ownerUserId, "Owner Offline", "owner", {
    type: "tenant",
    id: null,
  });
  await addUser(tenant2Id, owner2UserId, "Owner Offline Dua", "owner", {
    type: "tenant",
    id: null,
  });
  siteA = await registerSite(tenantId, outletA, NAME_A);
  siteB = await registerSite(tenantId, outletB, NAME_B);
  siteC = await registerSite(tenant2Id, outletC, NAME_C);
});

beforeEach(resetState);

afterAll(async () => {
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_node_alerts",
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      for (const tid of [tenantId, tenant2Id])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tid]);
    for (const tid of [tenantId, tenant2Id])
      await client.query("DELETE FROM tenants WHERE id = $1", [tid]);
    await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      [supervisorUserId, ownerUserId, owner2UserId],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

// ---------------------------------------------------------- race: concurrent
// legend-tj9y6 F1 (second opinion, ronde 2). A second connection commits a
// change (outlet closed, node revoked) after the sweep has read its node list
// but before it reads the open alarms. The sweep gets a drizzle handle over its
// own app pool whose connections pause, once, right before the tenant's
// "open alarms" SELECT (the first statement touching edge_node_alerts for that
// tenant). While paused, `during` runs on the owner pool and commits. No
// production seam is needed: sweepEdgeOfflineAlerts already takes `database`.
async function sweepWithConcurrentChange(
  now: Date,
  tid: string,
  during: () => Promise<void>,
) {
  const racePool = createAppPool(
    (process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL)!,
    { max: 3 },
  );
  let armed = true;
  let paused = false;
  const hook = (client: PoolClient) => {
    const marker = client as PoolClient & { __raceHooked?: boolean };
    if (marker.__raceHooked) return;
    marker.__raceHooked = true;
    const query = client.query.bind(client) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (client as unknown as { query: typeof query }).query = async (
      ...args: unknown[]
    ) => {
      const first = args[0];
      const text =
        typeof first === "string"
          ? first
          : ((first as { text?: string } | undefined)?.text ?? "");
      const values =
        (args[1] as unknown[] | undefined) ??
        (first as { values?: unknown[] } | undefined)?.values ??
        [];
      if (
        armed &&
        /^\s*select/i.test(text) &&
        text.includes('"edge_node_alerts"') &&
        values.includes(tid)
      ) {
        armed = false;
        paused = true;
        await during();
      }
      return query(...args);
    };
  };
  // pg-pool calls connect() with a callback for pool.query(), and drizzle
  // awaits it for transactions: hook both forms.
  const connect = racePool.connect.bind(racePool) as (
    ...args: unknown[]
  ) => Promise<PoolClient> | undefined;
  (racePool as unknown as { connect: typeof connect }).connect = (
    ...args: unknown[]
  ) => {
    const callback = args[0];
    if (typeof callback === "function")
      return connect(
        (error: unknown, client: PoolClient | undefined, done: unknown) => {
          if (client) hook(client);
          (callback as (...a: unknown[]) => void)(error, client, done);
        },
      );
    return (connect() as Promise<PoolClient>).then((client) => {
      hook(client);
      return client;
    });
  };
  const raceDb = drizzle(racePool, { schema }) as unknown as typeof db;
  try {
    const result = await sweepEdgeOfflineAlerts(raceDb, {
      now,
      thresholdMinutes: 30,
    });
    // The change must really have landed between the two reads; otherwise the
    // test would pass for the wrong reason.
    expect(paused).toBe(true);
    return result;
  } finally {
    await racePool.end();
  }
}

const revokeNow = async (site: Site) => {
  await revokeEdgeNode(scopeFor(site.tenantId, [site.outletId]), actor, {
    edgeNodeId: site.nodeId,
    reason: "Perangkat hilang",
  });
};

const closeOutletNow = (outletId: string) =>
  asOwnerTenant(tenantId, async (client) => {
    await client.query("UPDATE outlets SET status = 'closed' WHERE id = $1", [
      outletId,
    ]);
  });

describe("legend-tj9y6 F1 offline sweep: outlet or node retired mid-sweep", () => {
  it("legend-tj9y6 F1 outlet closed between the node read and the alarm read resolves the old alarm and raises nothing new", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 60));
    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 1, resolved: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    const notesBefore = await notificationsOf(tenantId);
    expect(notesBefore.length).toBeGreaterThan(0);

    const result = await sweepWithConcurrentChange(
      after(NOW_OPEN, 1),
      tenantId,
      () => closeOutletNow(outletA),
    );

    expect(result).toMatchObject({ raised: 0, resolved: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore.length);
  });

  it("legend-tj9y6 F1 outlet closed mid-sweep with no earlier alarm gets no alarm and no notification", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 60));

    const result = await sweepWithConcurrentChange(NOW_OPEN, tenantId, () =>
      closeOutletNow(outletA),
    );

    expect(result).toMatchObject({ raised: 0, resolved: 0, failed: 0 });
    expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });

  it("legend-tj9y6 F1 node revoked between the node read and the alarm read resolves the old alarm and raises nothing new", async () => {
    const site = await newSite(tenantId, "Outlet Offline Race Revoke");
    await setHeartbeat(site, before(NOW_OPEN, 60));
    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 1, resolved: 0 });
    expect(await openAlertsOf(tenantId, site.nodeId)).toHaveLength(1);
    const notesBefore = await notificationsOf(tenantId);

    const result = await sweepWithConcurrentChange(
      after(NOW_OPEN, 1),
      tenantId,
      () => revokeNow(site),
    );

    // Assumption: only the safety outcome is specified for a node revoked
    // mid-sweep; `resolved` (the retired path may or may not resolve the old alarm) and `failed`
    // (silent skip vs. guarded rejection) are not asserted.
    expect(result.raised).toBe(0);
    expect(await openAlertsOf(tenantId, site.nodeId)).toHaveLength(0);
    expect(await alertsOf(tenantId, site.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore.length);
  });

  it("legend-tj9y6 F1 node revoked mid-sweep with no earlier alarm gets no alarm and no notification", async () => {
    const site = await newSite(tenantId, "Outlet Offline Race Revoke Fresh");
    await setHeartbeat(site, before(NOW_OPEN, 60));

    const result = await sweepWithConcurrentChange(NOW_OPEN, tenantId, () =>
      revokeNow(site),
    );

    expect(result.raised).toBe(0);
    expect(await alertsOf(tenantId, site.nodeId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });
});

// -------------------------------------------------------------- T29 closed

describe("legend-5ab0l offline sweep: closed outlet", () => {
  it("legend-tj9y6 a closed outlet never alarms even when its old schedule is open and its node remains active", async () => {
    await asOwnerTenant(tenantId, (client) =>
      client.query("UPDATE outlets SET status = 'closed' WHERE id = $1", [
        outletA,
      ]),
    );
    await setHeartbeat(siteA, before(NOW_OPEN, 60));

    expect(await sweep(NOW_OPEN)).toMatchObject({
      raised: 0,
      resolved: 0,
      failed: 0,
    });
    expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });

  it("legend-tj9y6 closing an outlet resolves its existing offline alarm without another notification", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 60));
    await sweep(NOW_OPEN);
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    const notesBefore = await notificationsOf(tenantId);

    await asOwnerTenant(tenantId, (client) =>
      client.query("UPDATE outlets SET status = 'closed' WHERE id = $1", [
        outletA,
      ]),
    );
    expect(await sweep(after(NOW_OPEN, 1))).toMatchObject({
      raised: 0,
      resolved: 1,
      failed: 0,
    });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore.length);
    expect(await sweep(after(NOW_OPEN, 60))).toMatchObject({
      raised: 0,
      resolved: 0,
      failed: 0,
    });
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore.length);
  });

  it("T29 an outlet that is closed now gets no alert and no notification, however old the heartbeat", async () => {
    // Thu 00:00 WIB, hours 08:00-22:00: closed.
    const now = new Date("2026-03-04T17:00:00.000Z");
    await setHeartbeat(siteA, before(now, 5 * 60));

    const result = await sweep(now);

    expect(result).toMatchObject({ raised: 0, resolved: 0, failed: 0 });
    expect(await alertsOf(tenantId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });

  it("T29 before opening time and on a closed weekday (null day) are closed too", async () => {
    // Wed 07:30 WIB, opens at 08:00.
    const early = new Date("2026-03-04T00:30:00.000Z");
    await setHeartbeat(siteA, before(early, 10 * 60));
    expect(await sweep(early)).toMatchObject({ raised: 0, failed: 0 });

    // Wednesday null: closed all day, even at noon.
    await setHours(siteA, week({ tue: { opens: "08:00", closes: "22:00" } }));
    await setHeartbeat(siteA, before(NOW_OPEN, 5 * 60));
    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 0, failed: 0 });

    expect(await alertsOf(tenantId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });
});

// ------------------------------------------------------------ T30 raises

describe("legend-5ab0l offline sweep: open outlet offline", () => {
  it("T30 offline 31 minutes while open raises one alert and notifies the outlet's supervisor and the owner once", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 31));

    const result = await sweep(NOW_OPEN);

    expect(result).toMatchObject({ raised: 1, resolved: 0, failed: 0 });
    const alerts = await alertsOf(tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      tenant_id: tenantId,
      outlet_id: outletA,
      edge_node_id: siteA.nodeId,
      resolved_at: null,
    });

    const notes = await notificationsOf(tenantId);
    expect(notes.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    for (const row of notes) {
      expect(row.text).toContain(NAME_A);
      expect(row.text).toContain("tidak terhubung lebih dari 30 menit");
      expect(row.text).toContain("jam buka");
    }
  });

  it("T30 threshold is inclusive: 29 minutes offline is fine, exactly 30 alarms", async () => {
    await setHeartbeat(siteA, NOW_OPEN);

    expect(await sweep(after(NOW_OPEN, 29))).toMatchObject({
      raised: 0,
      failed: 0,
    });
    expect(await alertsOf(tenantId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);

    expect(await sweep(after(NOW_OPEN, 30))).toMatchObject({
      raised: 1,
      failed: 0,
    });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
  });

  it("T30 thresholdMinutes is honoured and printed in the message", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 45));
    expect(await sweep(NOW_OPEN, 60)).toMatchObject({ raised: 0, failed: 0 });
    expect(await alertsOf(tenantId)).toHaveLength(0);

    expect(await sweep(after(NOW_OPEN, 15), 60)).toMatchObject({
      raised: 1,
      failed: 0,
    });
    const notes = await notificationsOf(tenantId);
    expect(notes).not.toHaveLength(0);
    for (const row of notes)
      expect(row.text).toContain("tidak terhubung lebih dari 60 menit");
  });

  it("T30 an outlet without its own supervisor notifies only owners, and a supervisor never hears about another outlet", async () => {
    await setHeartbeat(siteB, before(NOW_OPEN, 40));

    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 1, failed: 0 });

    const notes = await notificationsOf(tenantId);
    expect(notes.map((row) => row.user_id)).toEqual([ownerUserId]);
    expect(notes[0]!.text).toContain(NAME_B);
    expect(await openAlertsOf(tenantId, siteB.nodeId)).toHaveLength(1);
  });
});

// ----------------------------------------------------------- T31 idempotent

describe("legend-5ab0l offline sweep: repeated sweeps", () => {
  it("T31 sweeping twice keeps one open alert and one notification per recipient", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 35));

    await sweep(NOW_OPEN);
    const firstAlert = (await alertsOf(tenantId))[0]!;
    const firstNotes = await notificationsOf(tenantId);
    expect(firstNotes).toHaveLength(2); // supervisor + owner

    const second = await sweep(after(NOW_OPEN, 1));
    expect(second.failed).toBe(0);
    expect(second.resolved).toBe(0);

    const alerts = await alertsOf(tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolved_at).toBeNull();
    expect(alerts[0]!.raised_at.getTime()).toBe(firstAlert.raised_at.getTime());
    expect(await notificationsOf(tenantId)).toHaveLength(firstNotes.length);

    // A third, much later sweep (heartbeat still silent) still adds nothing.
    await sweep(after(NOW_OPEN, 60));
    expect(await alertsOf(tenantId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(firstNotes.length);
  });
});

// ------------------------------------------------------------ T32 resolves

describe("legend-5ab0l offline sweep: heartbeat returns", () => {
  it("T32 a fresh heartbeat resolves the open alert without a new notification", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 31));
    await sweep(NOW_OPEN);
    const notesBefore = (await notificationsOf(tenantId)).length;
    expect(notesBefore).toBe(2);

    const back = after(NOW_OPEN, 10);
    await setHeartbeat(siteA, before(back, 1));
    const result = await sweep(back);

    expect(result).toMatchObject({ raised: 0, resolved: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    const alerts = await alertsOf(tenantId, siteA.nodeId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolved_at).not.toBeNull();
    expect(alerts[0]!.resolved_at!.getTime()).toBeGreaterThanOrEqual(
      alerts[0]!.raised_at.getTime(),
    );
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore);
  });

  it("T32 a heartbeat just inside the threshold resolves; the next outage is a new episode with a new notification", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 31));
    await sweep(NOW_OPEN);

    // Heartbeat 29 minutes old at the next sweep: within the 30 minute threshold.
    const returned = after(NOW_OPEN, 10);
    await setHeartbeat(siteA, before(returned, 29));
    expect(await sweep(returned)).toMatchObject({ resolved: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(0);

    // Silent again for 31 minutes: a second alert and a second notification each.
    const later = after(returned, 31);
    expect(await sweep(later)).toMatchObject({ raised: 1, failed: 0 });
    const alerts = await alertsOf(tenantId, siteA.nodeId);
    expect(alerts).toHaveLength(2);
    expect(alerts.filter((row) => row.resolved_at === null)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(4);
  });

  it.each([
    ["a delayed sweep", sweep],
    ["a restarted worker", restartedWorkerSweep],
  ] as const)(
    "legend-qwuqq %s recognises recovery between sweeps and notifies once for the new episode",
    async (_label, runSweep) => {
      // Wed 09:00 WIB: the first outage has already crossed the threshold.
      const first = new Date("2026-03-04T02:00:00.000Z");
      await setHeartbeat(siteA, before(first, 40));
      await runSweep(first);
      const firstAlert = (await alertsOf(tenantId, siteA.nodeId))[0]!;
      expect(await notificationsOf(tenantId)).toHaveLength(2);

      // A heartbeat arrives at 09:01, but by the 10:00 sweep it is 59 minutes old.
      await setHeartbeat(siteA, after(first, 1));
      const second = after(first, 60);
      expect(await runSweep(second)).toMatchObject({
        raised: 1,
        resolved: 1,
        failed: 0,
      });

      const alerts = await alertsOf(tenantId, siteA.nodeId);
      expect(alerts).toHaveLength(2);
      expect(
        alerts.find((alert) => alert.id === firstAlert.id)?.resolved_at,
      ).not.toBeNull();
      const open = await openAlertsOf(tenantId, siteA.nodeId);
      expect(open).toHaveLength(1);
      expect(open[0]!.id).not.toBe(firstAlert.id);
      expect(open[0]!.raised_at).toEqual(second);
      const notes = await notificationsOf(tenantId);
      expect(
        notes.filter((row) => row.user_id === supervisorUserId),
      ).toHaveLength(2);
      expect(notes.filter((row) => row.user_id === ownerUserId)).toHaveLength(
        2,
      );

      // Restarting again while the second outage continues must not duplicate it.
      expect(await runSweep(after(second, 1))).toMatchObject({
        raised: 0,
        resolved: 0,
        failed: 0,
      });
      expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(2);
      expect(await notificationsOf(tenantId)).toHaveLength(4);
    },
  );

  it("T32 a fresh heartbeat resolves the alert even after the outlet has closed", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 31));
    await sweep(NOW_OPEN);

    // 23:00 WIB: outlet closed. The node reconnected one minute ago.
    const night = new Date("2026-03-04T16:00:00.000Z");
    await setHeartbeat(siteA, before(night, 1));
    expect(await sweep(night)).toMatchObject({ resolved: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
  });
});

// --------------------------------------------- T33 past midnight and zones

describe("legend-5ab0l offline sweep: open window and time zone", () => {
  it("legend-l83d2 spring DST counts elapsed time from the actual opening instant", async () => {
    await setHours(
      siteA,
      week({ sun: { opens: "01:50", closes: "05:00" } }),
      "America/New_York",
    );
    await setHeartbeat(siteA, new Date("2026-03-08T06:00:00.000Z"));

    // 03:10 EDT, but only 20 real minutes since 01:50 EST (06:50Z).
    expect(await sweep(new Date("2026-03-08T07:10:00.000Z"))).toMatchObject({
      raised: 0,
      failed: 0,
    });
    expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
    expect(await sweep(new Date("2026-03-08T07:20:00.000Z"))).toMatchObject({
      raised: 1,
      failed: 0,
    });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(2);
  });

  it("legend-l83d2 autumn DST includes the repeated hour in elapsed open time", async () => {
    await setHours(
      siteA,
      week({ sun: { opens: "00:50", closes: "05:00" } }),
      "America/New_York",
    );
    await setHeartbeat(siteA, new Date("2026-11-01T04:00:00.000Z"));

    // The second 01:10 is 80 real minutes after 00:50 EDT (04:50Z).
    expect(await sweep(new Date("2026-11-01T06:10:00.000Z"))).toMatchObject({
      raised: 1,
      failed: 0,
    });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(2);
  });

  it("T33 a window that runs past midnight alarms after midnight, counted from its opening", async () => {
    await setHours(siteA, week({ wed: { opens: "18:00", closes: "02:00" } }));
    // Thu 01:30 WIB. Last heartbeat Wed 12:00 WIB, before the window opened.
    const now = new Date("2026-03-04T18:30:00.000Z");
    await setHeartbeat(siteA, new Date("2026-03-04T05:00:00.000Z"));

    expect(await sweep(now)).toMatchObject({ raised: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
  });

  it("T33 a past-midnight window that ended at 02:00 is closed at 02:30", async () => {
    await setHours(siteA, week({ wed: { opens: "18:00", closes: "02:00" } }));
    const now = new Date("2026-03-04T19:30:00.000Z"); // Thu 02:30 WIB
    await setHeartbeat(siteA, new Date("2026-03-04T05:00:00.000Z"));

    expect(await sweep(now)).toMatchObject({ raised: 0, failed: 0 });
    expect(await alertsOf(tenantId)).toHaveLength(0);
  });

  it("T33 an overnight gap alone does not alarm at opening: the clock counts open time only", async () => {
    // Heartbeat Tue 22:30 WIB (closed since 22:00); opened Wed 08:00 WIB.
    await setHeartbeat(siteA, new Date("2026-03-03T15:30:00.000Z"));

    // Wed 08:10 WIB: open for 10 minutes only.
    expect(await sweep(new Date("2026-03-04T01:10:00.000Z"))).toMatchObject({
      raised: 0,
      failed: 0,
    });
    expect(await alertsOf(tenantId)).toHaveLength(0);

    // Wed 08:29 WIB: 29 open minutes, still quiet.
    expect(await sweep(new Date("2026-03-04T01:29:00.000Z"))).toMatchObject({
      raised: 0,
      failed: 0,
    });
    expect(await alertsOf(tenantId)).toHaveLength(0);

    // Wed 08:30 WIB: 30 open minutes without a heartbeat.
    expect(await sweep(new Date("2026-03-04T01:30:00.000Z"))).toMatchObject({
      raised: 1,
      failed: 0,
    });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
  });

  it("T33 the outlet's own time zone decides whether it is open", async () => {
    const nineToNine = everyDay({ opens: "09:00", closes: "21:00" });
    await setHours(siteA, nineToNine, "Asia/Jakarta");
    await setHours(siteB, nineToNine, "Asia/Jayapura");
    // 13:30Z = 20:30 WIB (open) = 22:30 WIT (closed). Both silent for 2 hours.
    const now = new Date("2026-03-04T13:30:00.000Z");
    await setHeartbeat(siteA, before(now, 120));
    await setHeartbeat(siteB, before(now, 120));

    expect(await sweep(now)).toMatchObject({ raised: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(await alertsOf(tenantId, siteB.nodeId)).toHaveLength(0);
    const notes = await notificationsOf(tenantId);
    expect(aboutOutlet(notes, NAME_A)).not.toHaveLength(0);
    expect(aboutOutlet(notes, NAME_B)).toHaveLength(0);
  });
});

// ------------------------------- T34 skipped nodes, failure, tenant isolation

describe("legend-5ab0l offline sweep: skipped nodes, failures, isolation", () => {
  it("T34 a node that never connected (null heartbeat) is skipped", async () => {
    await setHeartbeat(siteA, null);

    const result = await sweep(NOW_OPEN);

    expect(result).toMatchObject({ raised: 0, resolved: 0, failed: 0 });
    expect(await alertsOf(tenantId)).toHaveLength(0);
    expect(await notificationsOf(tenantId)).toHaveLength(0);
  });

  it("T34 a revoked node resolves its open alert and raises no new one", async () => {
    const site = await newSite(tenantId, "Outlet Offline Dicabut");
    await setHeartbeat(site, before(NOW_OPEN, 40));
    await sweep(NOW_OPEN);
    expect(await openAlertsOf(tenantId, site.nodeId)).toHaveLength(1);
    const notesBefore = (await notificationsOf(tenantId)).length;

    await revokeEdgeNode(scopeFor(tenantId, [site.outletId]), actor, {
      edgeNodeId: site.nodeId,
      reason: "Perangkat hilang",
    });
    const result = await sweep(after(NOW_OPEN, 5));

    expect(result).toMatchObject({ raised: 0, resolved: 1, failed: 0 });
    expect(await openAlertsOf(tenantId, site.nodeId)).toHaveLength(0);
    expect(await alertsOf(tenantId, site.nodeId)).toHaveLength(1);
    expect(await notificationsOf(tenantId)).toHaveLength(notesBefore);

    // Still silent and still revoked: nothing comes back.
    await sweep(after(NOW_OPEN, 90));
    expect(await alertsOf(tenantId, site.nodeId)).toHaveLength(1);
    expect(await openAlertsOf(tenantId, site.nodeId)).toHaveLength(0);
  });

  it("T34 a node revoked before it ever alarmed is never alarmed", async () => {
    const site = await newSite(tenantId, "Outlet Offline Batal");
    await setHeartbeat(site, before(NOW_OPEN, 40));
    await revokeEdgeNode(scopeFor(tenantId, [site.outletId]), actor, {
      edgeNodeId: site.nodeId,
      reason: "Salah daftar",
    });

    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 0, failed: 0 });
    expect(await alertsOf(tenantId, site.nodeId)).toHaveLength(0);
    expect(aboutOutlet(await notificationsOf(tenantId), "Batal")).toHaveLength(
      0,
    );
  });

  it("T34 one failing node does not stop the sweep for other nodes or other tenants", async () => {
    // The database refuses to store an alert for outlet A's node only.
    const fn = `edge_offline_block_${randomBytes(4).toString("hex")}`;
    await owner.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.edge_node_id = '${siteA.nodeId}'::uuid THEN
           RAISE EXCEPTION 'blocked by test';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON edge_node_alerts
       FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      for (const site of [siteA, siteB, siteC])
        await setHeartbeat(site, before(NOW_OPEN, 45));

      const result = await sweep(NOW_OPEN);

      expect(result).toMatchObject({ raised: 2, resolved: 0, failed: 1 });
      // The failed node left nothing behind: no alert, no notification.
      expect(await alertsOf(tenantId, siteA.nodeId)).toHaveLength(0);
      const notes1 = await notificationsOf(tenantId);
      expect(aboutOutlet(notes1, NAME_A)).toHaveLength(0);
      // Same tenant, other node, and the other tenant, were handled.
      expect(await openAlertsOf(tenantId, siteB.nodeId)).toHaveLength(1);
      expect(aboutOutlet(notes1, NAME_B)).not.toHaveLength(0);
      expect(await openAlertsOf(tenant2Id, siteC.nodeId)).toHaveLength(1);
      expect(
        aboutOutlet(await notificationsOf(tenant2Id), NAME_C),
      ).not.toHaveLength(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON edge_node_alerts`);
      await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }

    // The failed node is picked up by the next sweep.
    const retry = await sweep(after(NOW_OPEN, 1));
    expect(retry.failed).toBe(0);
    expect(await openAlertsOf(tenantId, siteA.nodeId)).toHaveLength(1);
    expect(
      aboutOutlet(await notificationsOf(tenantId), NAME_A),
    ).not.toHaveLength(0);
  });

  it("T34 tenants stay apart: each alert and notification belongs to its own tenant", async () => {
    await setHeartbeat(siteA, before(NOW_OPEN, 45));
    await setHeartbeat(siteC, before(NOW_OPEN, 45));

    expect(await sweep(NOW_OPEN)).toMatchObject({ raised: 2, failed: 0 });

    const one = await alertsOf(tenantId);
    expect(
      one.map((row) => [row.tenant_id, row.outlet_id, row.edge_node_id]),
    ).toEqual([[tenantId, outletA, siteA.nodeId]]);
    const two = await alertsOf(tenant2Id);
    expect(
      two.map((row) => [row.tenant_id, row.outlet_id, row.edge_node_id]),
    ).toEqual([[tenant2Id, outletC, siteC.nodeId]]);

    const notes1 = await notificationsOf(tenantId);
    const notes2 = await notificationsOf(tenant2Id);
    expect(notes1.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    expect(notes2.map((row) => row.user_id)).toEqual([owner2UserId]);
    expect(aboutOutlet(notes1, NAME_C)).toHaveLength(0);
    expect(aboutOutlet(notes2, NAME_A)).toHaveLength(0);
    expect(aboutOutlet(notes2, NAME_C)).toHaveLength(1);
  });
});
