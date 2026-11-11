// legend-10nex round 2: at boot the edge seeds catalog freshness from its pull
// checkpoints (`edge_pull_checkpoints`, key `catalog:<stream>`), so a restart
// does not hide a stale catalog. Covers loadCatalogLastSuccess (which rows it
// reads, RLS) and seedCatalogFreshness (the boot wiring the runtime calls).
// Edge database: a separate disposable database on the restricted login.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  CRITICAL_CATALOG_STREAMS,
  createCatalogFreshness,
} from "../edge/catalog-freshness.ts";
import {
  loadCatalogLastSuccess,
  seedCatalogFreshness,
} from "../edge/master-sync.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const MIN = 60_000;
const NOW = new Date("2026-11-11T03:05:00.000Z");
const NIGHT = new Date(NOW.getTime() - 8 * 60 * MIN); // 02:05 in Asia/Jakarta

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

let O1 = "";
let edge: EdgeDatabase;
let nodeId = "";

const scopeOf = (
  source: "session" | "device",
  forTenant: string,
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: forTenant, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const edgeContext = () => scopeOf("device", tenantId, O1);

/** Writes a checkpoint row as superuser (FK off: only the key matters here). */
async function checkpoint(
  stream: string,
  lastSuccessAt: Date,
  forNode = nodeId,
) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [tenantId, O1, forNode, stream, lastSuccessAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji last success katalog",
  );
  const registered = await registerEdgeNode(
    scopeOf("session", tenantId, O1),
    actor,
    {
      outletId: O1,
      role: "standby",
      label: "Mini PC uji last success katalog",
    },
  );
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({ tenantId, outletId: O1 });
}, 240_000);

beforeEach(async () => {
  await edge.owner.query("DELETE FROM edge_pull_checkpoints");
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    await mainOwner.query("DELETE FROM edge_nodes WHERE outlet_id = $1", [O1]);
    await mainOwner.query("DELETE FROM outlets WHERE id = $1", [O1]);
  } catch {
    // Best effort: private ids on a private outlet.
  }
  await mainOwner.end();
});

describe("legend-10nex loadCatalogLastSuccess reads the pull checkpoints", () => {
  it("returns the last_success_at of every critical stream, keyed by stream name", async () => {
    for (const [index, stream] of CRITICAL_CATALOG_STREAMS.entries())
      await checkpoint(
        `catalog:${stream}`,
        new Date(NIGHT.getTime() + index * MIN),
      );
    const loaded = await loadCatalogLastSuccess(
      edgeContext(),
      nodeId,
      edge.database as never,
    );
    expect([...loaded.keys()].sort()).toEqual(
      [...CRITICAL_CATALOG_STREAMS].sort(),
    );
    for (const [index, stream] of CRITICAL_CATALOG_STREAMS.entries())
      expect(loaded.get(stream)).toEqual(
        new Date(NIGHT.getTime() + index * MIN),
      );
  });

  it("a new edge (no checkpoint rows) gets an empty map", async () => {
    const loaded = await loadCatalogLastSuccess(
      edgeContext(),
      nodeId,
      edge.database as never,
    );
    expect(loaded.size).toBe(0);
  });

  it("ignores non-critical streams, the parents row and other edge nodes", async () => {
    await checkpoint("catalog:price_lists", NIGHT);
    await checkpoint("catalog:stations", NIGHT);
    await checkpoint("catalog:menu_categories", NIGHT);
    await checkpoint("catalog:menu_categories:parents", NIGHT);
    await checkpoint("device_registry", NIGHT);
    await checkpoint("catalog:menu_items", NOW, randomUUID());
    const loaded = await loadCatalogLastSuccess(
      edgeContext(),
      nodeId,
      edge.database as never,
    );
    expect([...loaded.keys()]).toEqual(["price_lists"]);
  });

  it("RLS: another tenant's context reads nothing", async () => {
    await checkpoint("catalog:price_lists", NIGHT);
    const other = scopeOf("device", randomUUID(), O1);
    const loaded = await loadCatalogLastSuccess(
      other,
      nodeId,
      edge.database as never,
    );
    expect(loaded.size).toBe(0);
  });
});

describe("legend-10nex seedCatalogFreshness (boot wiring)", () => {
  function tracker() {
    let clock = NOW.getTime();
    return {
      freshness: createCatalogFreshness({ now: () => new Date(clock) }),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("a restart after a night with a failing sync: warning at once, alarm only when the failure lasts, dated from the checkpoint", async () => {
    for (const stream of CRITICAL_CATALOG_STREAMS)
      await checkpoint(`catalog:${stream}`, NIGHT);
    const { freshness, advance } = tracker();
    await seedCatalogFreshness(
      freshness,
      edgeContext(),
      nodeId,
      edge.database as never,
    );
    expect(freshness.snapshot().stale).toBe(false);

    freshness.recordFailure("price_lists", {
      reason: "HTTP_500",
      cloudReachable: true,
    });
    let snap = freshness.snapshot();
    expect(snap.cashierWarning).toBe("katalog belum diperbarui sejak 02:05");
    expect(snap.ownerAlarm).toBe(false); // one failed tick

    advance(5 * MIN);
    freshness.recordFailure("price_lists", {
      reason: "HTTP_500",
      cloudReachable: true,
    });
    snap = freshness.snapshot();
    expect(snap.ownerAlarm).toBe(true);
    expect(snap.alarmStreams[0]?.staleSince).toEqual(NIGHT);
  });

  it("a new edge seeds nothing and stays quiet", async () => {
    const { freshness } = tracker();
    await seedCatalogFreshness(
      freshness,
      edgeContext(),
      nodeId,
      edge.database as never,
    );
    expect(freshness.snapshot().stale).toBe(false);
    expect(freshness.snapshot().streams.price_lists?.lastSuccessAt).toBeNull();
  });
});
