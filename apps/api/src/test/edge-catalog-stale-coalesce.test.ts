// Catalog stale alarm coalescing (bead legend-ssnf9, hardening 1190 piece C).
// Written from docs/briefs/sub-1190-edge-catalog-hardening.md and the way
// edge-catalog-stale-alert.test.ts exercises the alarm, not from the
// implementation. Fail-first: today the cloud sends one notification per stale
// stream and the edge also reports skipped child streams.
//
// Contract under test:
//  - Cloud: one heartbeat that carries several NEW stale streams produces ONE
//    notification per recipient (supervisors and owners) for that edge. The same
//    heartbeat repeated adds nothing, also after a restart of the cloud
//    process. A later heartbeat with one more stream adds exactly one more
//    notification.
//  - The alert id hashes the WHOLE stale set of the heartbeat (sorted); a
//    notification is sent only when at least one entry is new. A heartbeat whose
//    entries were all reported before sends nothing.
//  - Edge (architect addendum): `catalogStaleForHeartbeat` does NOT drop
//    `CATALOG_PARENT_FAILED` entries; every alarm stream is reported.
//
// How the cloud half is driven: through the real cloud link (`registerEdgeLink`
// on an ephemeral http server) and the real edge link client, one connection
// per heartbeat. `notifyCatalogStale` inside runtime.ts is not exported, and
// the once-per-episode memory lives next to it, so only the link exercises the
// whole rule.
//
// Assumptions (the brief is silent), each easy to change:
//  - A recipient gets one `notifications` row per alert; the disposable tenant
//    has one supervisor and one owner, so one alert is 2 rows.
//  - The coalesced text "names all new streams (or the root stream and a
//    count)": the body must mention every stream name or the count "4".
//  - A "new process" is simulated with vi.resetModules() and a second
//    registerEdgeLink: the in-memory once-per-episode memory is then empty, so
//    only the stable alert id keeps a repeated set from notifying again.
//  - The cloud has finished a heartbeat when edge_nodes.last_heartbeat_at has
//    moved and the notification count has stopped at the expected value after
//    a LATER, distinct sentinel heartbeat was processed (a positive signal;
//    no sleeps).
//  - Opening a new connection for the same node replaces the old one (4409),
//    so each heartbeat waits for the previous link to be gone.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  catalogStaleForHeartbeat,
  createCatalogFreshness,
} from "../edge/catalog-freshness.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkStore } from "../edge/link-peer.ts";
import type { CatalogStale } from "../edge/protocol.ts";
import { registerEdgeLink, type EdgeLinkHandle } from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = randomUUID();
const outletId = randomUUID();
const supervisorUserId = randomUUID();
const ownerUserId = randomUUID();
const sessionContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
);

const SINCE = "2026-11-11T03:05:00.000Z";
const FOUR = ["price_lists", "menu_items", "item_variants", "modifiers"];
const stale = (streams: string[], reason = "HTTP_500"): CatalogStale =>
  streams.map((stream) => ({ stream, staleSince: SINCE, reason }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Did not settle");
    await sleep(20);
  }
}

/** A store with nothing queued; enough for hello and heartbeat traffic. */
function emptyStore(): LinkStore {
  return {
    outboundHead: async () => 0,
    lastAckedOutbound: async () => 0,
    readOutbound: async () => [],
    ackOutbound: async () => undefined,
    lastReceivedInbound: async () => 0,
    applyInbound: async () => undefined,
  };
}

async function notificationRows() {
  const { rows } = await owner.query<{
    user_id: string;
    title: string;
    body: string;
  }>(
    "SELECT user_id, title, body FROM notifications WHERE tenant_id = $1 ORDER BY created_at",
    [tenantId],
  );
  return rows;
}

async function addUser(
  userId: string,
  name: string,
  templateKey: "supervisor" | "owner",
  scope: { type: "outlet" | "tenant"; id: string | null },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `esc-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  if (role.rowCount !== 1) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
}

let server: Server;
let link: EdgeLinkHandle;
let url = "";
let node: { id: string; credential: string };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Catalog Coalesce', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `catalog-coalesce-${randomBytes(4).toString("hex")}`,
      randomUUID(),
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `catalog-coalesce-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'ECO-01', 'ECO-01', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, brand, entity],
  );
  await addUser(supervisorUserId, "Supervisor ECO", "supervisor", {
    type: "outlet",
    id: outletId,
  });
  await addUser(ownerUserId, "Owner ECO", "owner", {
    type: "tenant",
    id: null,
  });
  const registered = await registerEdgeNode(sessionContext, randomUUID(), {
    outletId,
    role: "primary",
    label: "Mini PC uji coalesce katalog",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };

  server = createServer();
  link = await registerEdgeLink(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
}, 120_000);

afterAll(async () => {
  setAuditWriter(null);
  await link?.close().catch(() => undefined);
  await new Promise<void>((resolve) =>
    server?.listening ? server.close(() => resolve()) : resolve(),
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_link_slots",
      "edge_outbound_queue",
      "edge_inbound_events",
      "sync_cursors",
      "edge_nodes",
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client
        .query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId])
        .catch(() => undefined);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      [supervisorUserId, ownerUserId],
    ]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await owner.end();
  }
});

const heartbeatAt = async () =>
  (
    await owner.query<{ at: Date | null }>(
      "SELECT last_heartbeat_at AS at FROM edge_nodes WHERE id = $1",
      [node.id],
    )
  ).rows[0]?.at?.getTime() ?? 0;

/**
 * One edge connection that sends exactly one heartbeat carrying `catalogStale`
 * (the first heartbeat goes out when the link opens). Waits until the cloud has
 * recorded it, then closes and waits until the cloud has dropped the link.
 */
async function sendHeartbeat(
  catalogStale: CatalogStale,
  cloud: EdgeLinkHandle = link,
  cloudUrl: string = url,
) {
  const seenBefore = await heartbeatAt();
  const client = createEdgeLinkClient({
    url: cloudUrl,
    credential: node.credential,
    scope: { tenantId, outletId, edgeNodeId: node.id } as never,
    store: emptyStore(),
    version: "1.0.0",
    catalogStale: () => catalogStale,
    heartbeatIntervalMs: 600_000,
    ackTimeoutMs: 60_000,
    random: () => 0,
  });
  await until(() => client.state().cloudLink === "connected");
  await until(async () => (await heartbeatAt()) > seenBefore);
  await client.stop();
  await until(() => !cloud.isConnected(node.id));
}

const perUser = (rows: { user_id: string }[], userId: string) =>
  rows.filter((row) => row.user_id === userId).length;

describe("ssnf9 cloud: one notification per edge and heartbeat, not per stream", () => {
  it("coalesces 4 streams into one alert per recipient; repeats, subsets and a restarted cloud process add nothing; only a heartbeat with a new stream notifies again", async () => {
    // 1. Four new streams in one heartbeat: ONE notification per recipient.
    await sendHeartbeat(stale(FOUR));
    await until(async () => (await notificationRows()).length >= 2);
    const first = await notificationRows();
    expect(first.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    for (const row of first) {
      expect(row.title).toBe("Katalog edge belum diperbarui");
      const namesAll = FOUR.every((name) => row.body.includes(name));
      expect(
        namesAll || /\b4\b/.test(row.body),
        "body names every new stream or says how many",
      ).toBe(true);
    }

    // 2. The same heartbeat again, and a subset of it: nothing new to report.
    await sendHeartbeat(stale(FOUR));
    await sendHeartbeat(stale(FOUR.slice(0, 2)));

    // 3. A restarted cloud process (memory empty): the same set maps to the
    // same alert id, so it still adds nothing.
    await link.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.resetModules();
    const fresh = await import("../edge/runtime.ts");
    const server2 = createServer();
    const link2 = await fresh.registerEdgeLink(server2);
    await new Promise<void>((resolve) =>
      server2.listen(0, "127.0.0.1", resolve),
    );
    const url2 = `ws://127.0.0.1:${(server2.address() as AddressInfo).port}/api/edge-link`;
    try {
      await sendHeartbeat(stale(FOUR), link2, url2);

      // 4. One more stream: a bigger set is a new alert, one per recipient.
      await sendHeartbeat(stale([...FOUR, "stations"]), link2, url2);
      await until(async () => (await notificationRows()).length >= 4);

      // 5. The set seen before again: nothing new.
      await sendHeartbeat(stale([...FOUR, "stations"]), link2, url2);
      await sendHeartbeat(stale(FOUR), link2, url2);

      // 6. Sentinel: one more new stream. Once its alert is visible every
      // earlier heartbeat has been processed, so the total proves they added
      // nothing.
      await sendHeartbeat(
        stale([...FOUR, "stations", "menu_categories"]),
        link2,
        url2,
      );
      await until(async () => (await notificationRows()).length >= 6);
      const rows = await notificationRows();
      expect(rows).toHaveLength(6);
      expect(perUser(rows, supervisorUserId)).toBe(3);
      expect(perUser(rows, ownerUserId)).toBe(3);
    } finally {
      await link2.close();
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      // afterAll closes the original handle again; keep it harmless.
    }
  }, 120_000);
});

describe("ssnf9 edge: the heartbeat reports every alarm stream", () => {
  const MIN = 60_000;

  function freshnessWith(failures: Array<{ stream: string; reason: string }>) {
    let clock = Date.parse(SINCE);
    const freshness = createCatalogFreshness({
      now: () => new Date(clock),
      failurePersistMs: 0,
    });
    for (const stream of FOUR) freshness.recordSuccess(stream);
    clock += 31 * MIN;
    for (const failure of failures)
      freshness.recordFailure(failure.stream, {
        reason: failure.reason,
        cloudReachable: true,
      });
    return freshness;
  }

  it("keeps CATALOG_PARENT_FAILED entries next to the failed stream (not filtered)", () => {
    const freshness = freshnessWith([
      { stream: "price_lists", reason: "HTTP_500" },
      { stream: "menu_items", reason: "CATALOG_PARENT_FAILED" },
      { stream: "modifiers", reason: "CATALOG_PARENT_FAILED" },
    ]);
    expect(
      catalogStaleForHeartbeat(freshness.snapshot())
        .map((entry) => `${entry.stream}:${entry.reason}`)
        .sort(),
    ).toEqual([
      "menu_items:CATALOG_PARENT_FAILED",
      "modifiers:CATALOG_PARENT_FAILED",
      "price_lists:HTTP_500",
    ]);
  });

  it("an outdated cloud still sends nothing (guard unchanged)", () => {
    const freshness = freshnessWith([
      { stream: "price_lists", reason: "CATALOG_CLOUD_OUTDATED" },
      { stream: "menu_items", reason: "HTTP_500" },
    ]);
    expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R3 / T3 (bead legend-7r7q6, second opinion 1197): the once-per-episode rule
// must hold per (stream, staleSince) EPISODE, not per whole heartbeat set, and
// must survive a cloud restart and the 1000-entry in-memory eviction.
//
// Contract (docs/briefs/sub-1199-edge-catalog-so1197.md, R3):
//  - {A@t,B@t} then a cloud restart then {B@t} => still ONE alert.
//  - {B@t,C@u} adds exactly ONE alert (only C is new).
//  - Subsets and reorders of already-reported episodes add nothing.
//  - After the in-memory cache has been evicted (1000 entries) an episode that
//    was already reported does not alert again.
//
// Assumptions (spec silent), easy to change:
//  - One alert = 2 `notifications` rows (supervisor + owner), as above.
//  - "Episode" identity = stream + staleSince. Each scenario below uses its own
//    stream names and staleSince so it is independent of the other tests.
//  - The cloud accepts any stream name (the wire schema only demands text);
//    eviction needs >1000 distinct entries and a heartbeat carries at most 16,
//    so 64 heartbeats of 16 distinct (stream, staleSince) pairs are sent.
//  - Heartbeats are handled in order for one edge, so after two identical
//    "sentinel" heartbeats of a brand-new episode every earlier heartbeat has
//    been fully processed; the total row count is then final.
// ---------------------------------------------------------------------------

async function startCloud() {
  vi.resetModules();
  const fresh = await import("../edge/runtime.ts");
  const srv = createServer();
  const handle = await fresh.registerEdgeLink(srv);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const cloudUrl = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/edge-link`;
  return {
    handle,
    url: cloudUrl,
    close: async () => {
      await handle.close().catch(() => undefined);
      await new Promise<void>((resolve) =>
        srv.listening ? srv.close(() => resolve()) : resolve(),
      );
    },
  };
}

type Cloud = Awaited<ReturnType<typeof startCloud>>;
const rowCount = async () => (await notificationRows()).length;
const entry = (stream: string, staleSince: string, reason = "HTTP_500") => ({
  stream,
  staleSince,
  reason,
});

/**
 * Proves every earlier heartbeat has been processed: a brand-new episode must
 * add exactly one alert (2 rows), and the same heartbeat again adds nothing.
 * Then the total is exactly `expectedRows`.
 */
async function expectTotalAfterSentinel(
  cloud: Cloud,
  sentinel: CatalogStale,
  expectedRows: number,
) {
  await sendHeartbeat(sentinel, cloud.handle, cloud.url);
  await sendHeartbeat(sentinel, cloud.handle, cloud.url);
  await until(async () => (await rowCount()) >= expectedRows);
  const rows = await notificationRows();
  expect(rows).toHaveLength(expectedRows);
  expect(perUser(rows, supervisorUserId)).toBe(perUser(rows, ownerUserId));
}

describe("7r7q6 R3 cloud: alerts dedupe per episode, durable across restart and eviction", () => {
  it("{A@t,B@t}, restart, then {B@t} stays at ONE alert", async () => {
    const t = "2026-11-12T01:00:00.000Z";
    const base = await rowCount();
    const before = await startCloud();
    try {
      await sendHeartbeat(
        [entry("price_lists", t), entry("menu_items", t)],
        before.handle,
        before.url,
      );
      await until(async () => (await rowCount()) >= base + 2);
    } finally {
      await before.close();
    }

    // The cloud process restarts: in-memory memory is empty.
    const after = await startCloud();
    try {
      await sendHeartbeat([entry("menu_items", t)], after.handle, after.url);
      // Sentinel: one more new episode proves the {B@t} heartbeat was handled.
      await expectTotalAfterSentinel(
        after,
        [entry("modifiers", "2026-11-12T01:05:00.000Z")],
        base + 2 + 2,
      );
    } finally {
      await after.close();
    }
  }, 120_000);

  it("{B@t,C@u} adds exactly ONE alert; subsets and reorders add none", async () => {
    const t = "2026-11-13T01:00:00.000Z";
    const u = "2026-11-13T02:00:00.000Z";
    const base = await rowCount();
    const cloud = await startCloud();
    try {
      await sendHeartbeat(
        [entry("price_lists", t), entry("menu_items", t)],
        cloud.handle,
        cloud.url,
      );
      await until(async () => (await rowCount()) >= base + 2);

      // Only C@u is new: exactly one more alert for the recipients.
      await sendHeartbeat(
        [entry("menu_items", t), entry("item_variants", u)],
        cloud.handle,
        cloud.url,
      );
      await until(async () => (await rowCount()) >= base + 4);

      // Subsets and reorders of what was reported: nothing new.
      await sendHeartbeat([entry("item_variants", u)], cloud.handle, cloud.url);
      await sendHeartbeat([entry("menu_items", t)], cloud.handle, cloud.url);
      await sendHeartbeat(
        [entry("item_variants", u), entry("menu_items", t)],
        cloud.handle,
        cloud.url,
      );
      await sendHeartbeat(
        [
          entry("menu_items", t),
          entry("price_lists", t),
          entry("item_variants", u),
        ],
        cloud.handle,
        cloud.url,
      );

      await expectTotalAfterSentinel(
        cloud,
        [entry("stations", "2026-11-13T03:00:00.000Z")],
        base + 4 + 2,
      );
    } finally {
      await cloud.close();
    }
  }, 120_000);

  it("after the in-memory cache is evicted (1000+ entries) an already reported episode does not alert again", async () => {
    const t = "2026-11-14T01:00:00.000Z";
    const ownerRows = async () =>
      perUser(await notificationRows(), ownerUserId);
    const cloud = await startCloud();
    const clients: Array<ReturnType<typeof createEdgeLinkClient>> = [];
    try {
      // Earlier tests already left owner rows, and the alert commits after the
      // heartbeat is recorded: wait for this alert itself, not for any row.
      const beforeFirst = await ownerRows();
      await sendHeartbeat(
        [entry("price_lists", t), entry("menu_categories", t)],
        cloud.handle,
        cloud.url,
      );
      await until(async () => (await ownerRows()) >= beforeFirst + 1);
      const ownerBase = await ownerRows();
      expect(ownerBase, "the first heartbeat is one alert").toBe(
        beforeFirst + 1,
      );

      // The cloud throttles heartbeats per edge, so 1024 distinct episodes
      // (> 1000) are spread over 64 edges (16 per heartbeat, the wire maximum),
      // all connected at once. Each heartbeat is one new alert for the owner.
      const EDGES = 64;
      const { rows: shape } = await owner.query<{
        brand_id: string;
        legal_entity_id: string;
      }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
        outletId,
      ]);
      const origin = Date.parse("2027-01-01T00:00:00.000Z");
      // Setup is independent per edge, so it runs in parallel batches: the
      // serial version spent most of its time registering 64 edges one by one.
      const makeEdge = async (i: number) => {
        const extraOutlet = randomUUID();
        await owner.query(
          `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
           VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
          [
            extraOutlet,
            tenantId,
            shape[0]!.brand_id,
            shape[0]!.legal_entity_id,
            `EVI-${i}`,
          ],
        );
        const ctx = establishScopedTenantContext(
          establishTenantContext({
            tenantId,
            brandId: null,
            source: "session",
          }),
          { kind: "outlets", outletIds: [outletIdSchema.parse(extraOutlet)] },
        );
        const reg = await registerEdgeNode(ctx, randomUUID(), {
          outletId: extraOutlet,
          role: "primary",
          label: `Mini PC eviction ${i}`,
        });
        return {
          id: reg.edgeNode.id,
          credential: reg.credential,
          outlet: extraOutlet,
        };
      };
      const extra: Array<{ id: string; credential: string; outlet: string }> =
        [];
      for (let from = 0; from < EDGES; from += 8) {
        const batch = Array.from(
          { length: Math.min(8, EDGES - from) },
          (_, k) => makeEdge(from + k),
        );
        extra.push(...(await Promise.all(batch)));
      }
      extra.forEach((edge, i) => {
        const batch = Array.from({ length: 16 }, (_, j) =>
          entry(
            `evict_${i * 16 + j}`,
            new Date(origin + (i * 16 + j) * 1000).toISOString(),
          ),
        );
        clients.push(
          createEdgeLinkClient({
            url: cloud.url,
            credential: edge.credential,
            scope: {
              tenantId,
              outletId: edge.outlet,
              edgeNodeId: edge.id,
            } as never,
            store: emptyStore(),
            version: "1.0.0",
            catalogStale: () => batch,
            heartbeatIntervalMs: 600_000,
            ackTimeoutMs: 60_000,
            random: () => 0,
          }),
        );
      });
      await until(
        async () => (await ownerRows()) >= ownerBase + EDGES,
        120_000,
      );
      await Promise.all(clients.map((client) => client.stop()));
      await until(() => !cloud.handle.isConnected(node.id));

      // B@t was reported before the cache was evicted: still nothing new.
      const afterFillers = await ownerRows();
      expect(afterFillers, "one alert per filler edge").toBe(ownerBase + EDGES);
      await sendHeartbeat(
        [entry("menu_categories", t)],
        cloud.handle,
        cloud.url,
      );
      await sendHeartbeat(
        [entry("price_lists", t), entry("menu_categories", t)],
        cloud.handle,
        cloud.url,
      );

      // Sentinel: a brand-new episode adds exactly one owner alert.
      const sentinel = [entry("modifiers", "2026-11-14T05:00:00.000Z")];
      await sendHeartbeat(sentinel, cloud.handle, cloud.url);
      await sendHeartbeat(sentinel, cloud.handle, cloud.url);
      await until(async () => (await ownerRows()) >= afterFillers + 1);
      expect(await ownerRows()).toBe(afterFillers + 1);
    } finally {
      await Promise.all(clients.map((client) => client.stop())).catch(
        () => undefined,
      );
      await cloud.close();
    }
  }, 300_000);
});
