// CTO-930 / legend-i78o6 follow-up. Acceptance tests written before source
// changes, from the approved v3 compatibility and durable resync contract.
// HTTP is scripted; parsing, applying, checkpoints, locks and PostgreSQL are real.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
  stationSyncRecordSchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { applyCatalogRecords } from "../services/edge-catalog-apply.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { catCursor, settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Stream = (typeof CATALOG_SYNC_STREAMS)[number];
type RecordData = Record<string, unknown>;
type FetchPage = (stream: string, since: string | null) => Promise<unknown>;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const stationId = randomUUID();
const revisionKey = "catalog:schema-revision";
const at = "2026-11-15T03:00:00.000Z";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let outletId = "";
let brandId = "";
let nodeId = "";
let edge: EdgeDatabase;

const context = (source: "session" | "device" = "device") =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

const legacyStation = (over: RecordData = {}): RecordData => ({
  id: stationId,
  tenantId,
  outletId,
  name: "Bar kontrak 930",
  type: "coffee_bar",
  printerDeviceId: null,
  targetSeconds: 90,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  syncTxid: "100",
  ...over,
});
const station = (over: RecordData = {}) =>
  legacyStation({
    displayOrder: 17,
    isActive: false,
    autoPrintFallback: true,
    ...over,
  });

// Frozen canonical m1 v3 consumer: unknown additions are stripped. This must
// stay independent from the current schema or compatibility is a tautology.
const oldStationSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  outletId: z.uuid(),
  name: z.string().min(1).max(150),
  type: z.enum([
    "coffee_bar",
    "beverage_bar",
    "hot_kitchen",
    "cold_kitchen",
    "pastry",
  ]),
  printerDeviceId: z.uuid().nullable(),
  targetSeconds: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  syncTxid: z.string().regex(/^\d+$/),
});
const oldPageSchema = z.object({
  protocolVersion: z.number().int().optional(),
  stream: z.literal("stations"),
  records: z.array(oldStationSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

async function apply(records: RecordData[]) {
  const parsed = records.map((record) => stationSyncRecordSchema.parse(record));
  return edge.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', ${JSON.stringify([outletId])}, true)`,
    );
    return applyCatalogRecords(tx as never, {
      tenantId,
      stream: "stations",
      records: parsed,
    });
  });
}

async function pull(
  fetchPage: FetchPage,
  streams?: Stream[],
  maxPages?: number,
) {
  return pullCatalog({
    database: edge.database,
    context: context(),
    edgeNodeId: nodeId,
    fetchPage,
    ...(streams ? { streams } : {}),
    ...(maxPages === undefined ? {} : { maxPages }),
  } as never);
}

async function checkpoint(stream: string, watermark: string, forNode = nodeId) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_pull_checkpoints
       (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, edge_node_id, stream) DO UPDATE SET watermark = EXCLUDED.watermark`,
      [tenantId, outletId, forNode, stream, watermark],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function watermark(stream: string, forNode = nodeId) {
  return (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [forNode, stream],
    )
  )[0]?.watermark;
}

async function localStation() {
  return (
    await edge.rows(
      `SELECT name, display_order, is_active, auto_print_fallback,
       sync_txid::text AS txid FROM stations WHERE id = $1`,
      [stationId],
    )
  )[0];
}

function cloud(overrides: Partial<Record<Stream, FetchPage>> = {}) {
  const calls: { stream: string; since: string | null }[] = [];
  const fetchPage: FetchPage = async (stream, since) => {
    calls.push({ stream, since });
    const override = overrides[stream as Stream];
    if (override) return override(stream, since);
    return {
      protocolVersion: 3,
      stream,
      records: stream === "stations" && since === null ? [station()] : [],
      nextCursor: since ?? catCursor(100, stationId),
      hasMore: false,
    };
  };
  return { calls, fetchPage };
}

async function upgradedEdge() {
  await apply([
    station({ displayOrder: 0, isActive: true, autoPrintFallback: false }),
  ]);
  for (const stream of CATALOG_SYNC_STREAMS) {
    await checkpoint(`catalog:${stream}`, catCursor(100, stationId));
    await checkpoint(`catalog:init:${stream}`, "1");
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji schema katalog 930",
  );
  brandId = (
    await owner.query("SELECT brand_id FROM outlets WHERE id = $1", [outletId])
  ).rows[0].brand_id;
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type,
     display_order, is_active, auto_print_fallback)
     VALUES ($1, $2, $3, 'Bar kontrak 930', 'coffee_bar', 17, false, true)`,
    [stationId, tenantId, outletId],
  );
  const registered = await registerEdgeNode(context("session"), randomUUID(), {
    outletId,
    role: "standby",
    label: "Mini PC schema katalog 930",
  });
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({ tenantId, outletId });
  const node = await owner.query(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [nodeId],
  );
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
      [JSON.stringify(node.rows[0].row)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await settleCloud(owner);
}, 240_000);

beforeEach(async () => {
  await edge.owner.query("DELETE FROM edge_pull_checkpoints");
  await edge.owner.query("DELETE FROM stations");
  await edge.owner.query("DELETE FROM menu_categories");
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  await owner.query("DELETE FROM stations WHERE outlet_id = $1", [outletId]);
  // Edge-node history is immutable. This private outlet and registered node
  // disappear with the parent disposable database, rather than bypassing it.
  await owner.end();
});

describe("CTO-930 compatibility / legend-i78o6", () => {
  it("AC1 the canonical old edge accepts enriched v3 cloud pages for every negotiated version", async () => {
    for (const protocolVersion of [2, 3]) {
      const page = await listCatalogRecordsSince(db, {
        tenantId,
        outletId: outletIdSchema.parse(outletId),
        query: catalogSyncQuerySchema.parse({
          stream: "stations",
          protocolVersion,
        }),
      });
      // Never the cloud's own version: an old edge only knows its own.
      expect(page.protocolVersion).toBe(protocolVersion);
      const record = stationSyncRecordSchema
        .array()
        .parse(page.records)
        .find((row) => row.id === stationId);
      expect(record).toMatchObject({
        displayOrder: 17,
        isActive: false,
        autoPrintFallback: true,
      });
      expect(
        oldPageSchema.parse(page).records.find((row) => row.id === stationId),
      ).toMatchObject({ name: "Bar kontrak 930" });
      expect(oldPageSchema.parse(page).records[0]).not.toHaveProperty(
        "displayOrder",
      );
    }
    const legacyPage = await listCatalogRecordsSince(db, {
      tenantId,
      outletId: outletIdSchema.parse(outletId),
      query: catalogSyncQuerySchema.parse({ stream: "stations" }),
    });
    const legacy = stationSyncRecordSchema
      .array()
      .parse(legacyPage.records)
      .find((row) => row.id === stationId);
    expect(legacy).not.toHaveProperty("displayOrder");
    expect(legacy).not.toHaveProperty("isActive");
    expect(legacy).not.toHaveProperty("autoPrintFallback");
    expect(CATALOG_PROTOCOL_VERSION).toBe(4);
  });

  it("AC2 a legacy station remains valid without inventing absent KDS fields", () => {
    const parsed = stationSyncRecordSchema.safeParse(legacyStation());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("displayOrder");
    expect(parsed.data).not.toHaveProperty("isActive");
    expect(parsed.data).not.toHaveProperty("autoPrintFallback");
  });

  it("AC3 an older payload uses defaults for a fresh station and preserves configured values on later updates", async () => {
    await apply([legacyStation()]);
    expect(await localStation()).toMatchObject({
      display_order: 0,
      is_active: true,
      auto_print_fallback: false,
    });
    await apply([station({ syncTxid: "101" })]);
    await apply([legacyStation({ syncTxid: "102", name: "Bar lama berubah" })]);
    expect(await localStation()).toMatchObject({
      name: "Bar lama berubah",
      display_order: 17,
      is_active: false,
      auto_print_fallback: true,
      txid: "102",
    });
  });

  it("AC4 a v2 cloud page remains readable by the new edge", async () => {
    const page = {
      protocolVersion: 2,
      stream: "stations",
      records: [legacyStation()],
      nextCursor: catCursor(100, stationId),
      hasMore: false,
    };
    expect(catalogSyncPageSchema.safeParse(page).success).toBe(true);
    const result = await pull(async () => page, ["stations"]);
    expect(result.streams.stations?.error).toBeFalsy();
    expect(await localStation()).toMatchObject({
      display_order: 0,
      is_active: true,
      auto_print_fallback: false,
    });
  });

  it("AC5 ordinary equal or stale station txids never replace the current KDS settings", async () => {
    await apply([station()]);
    await apply([
      station({
        syncTxid: "99",
        displayOrder: 1,
        isActive: true,
        autoPrintFallback: false,
      }),
    ]);
    await apply([
      station({ displayOrder: 2, isActive: true, autoPrintFallback: false }),
    ]);
    expect(await localStation()).toMatchObject({
      display_order: 17,
      is_active: false,
      auto_print_fallback: true,
      txid: "100",
    });
  });
});

describe("CTO-930 durable catalog schema revision", () => {
  it.each(["catalog:schema-revision", "catalog:schema-pending"])(
    "AC12 older code preserves a newer durable %s without rewinding",
    async (key) => {
      await upgradedEdge();
      await checkpoint(key, "2");
      const remote = cloud();
      await pull(remote.fetchPage);
      expect(
        remote.calls.find((call) => call.stream === "stations")?.since,
      ).toBe(catCursor(100, stationId));
      expect(await watermark(key)).toBe("2");
      expect(await watermark(revisionKey)).toBe(
        key === revisionKey ? "2" : undefined,
      );
    },
  );

  it("AC6 upgrade rewinds all streams once, repairs equal-txid station fields and persists across new pull invocations", async () => {
    await upgradedEdge();
    const otherNode = randomUUID();
    const preserved = [
      "device_registry",
      "staff_pins",
      "catalog:parents:menu_categories",
      "catalog:fallback:printers",
      "catalog:init:stations",
    ];
    for (const key of preserved) await checkpoint(key, "keep-930");
    await checkpoint("catalog:stations", "another-node", otherNode);
    const remote = cloud();
    const first = await pull(remote.fetchPage);
    for (const stream of CATALOG_SYNC_STREAMS)
      expect(first.streams[stream]?.error).toBeFalsy();
    expect(
      remote.calls
        .filter((call) => call.since === null)
        .map((call) => call.stream),
    ).toEqual([...CATALOG_SYNC_STREAMS]);
    expect(await localStation()).toMatchObject({
      display_order: 17,
      is_active: false,
      auto_print_fallback: true,
      txid: "100",
    });
    expect(await watermark(revisionKey)).toBe("1");
    for (const key of preserved) expect(await watermark(key)).toBe("keep-930");
    expect(await watermark("catalog:stations", otherNode)).toBe("another-node");

    // A fresh invocation has no caller-held state. Only persisted DB state can
    // prevent a second full pull after the process restarts.
    const restarted = cloud();
    await pull(restarted.fetchPage);
    expect(restarted.calls).toHaveLength(CATALOG_SYNC_STREAMS.length);
    expect(
      restarted.calls.find((call) => call.stream === "stations")?.since,
    ).toBe(catCursor(100, stationId));
    expect(await watermark(revisionKey)).toBe("1");
  });

  it("AC7 a failed multi-page resync is not marked complete and restart resumes its durable cursor", async () => {
    await upgradedEdge();
    const categoryId = randomUUID();
    const firstPageCursor = catCursor(101, categoryId);
    let failed = false;
    const remote = cloud({
      menu_categories: async (stream, since) => {
        if (since === firstPageCursor && !failed) {
          failed = true;
          throw new Error("cloud connection interrupted");
        }
        return {
          protocolVersion: 3,
          stream,
          records:
            since === null
              ? [
                  {
                    id: categoryId,
                    tenantId,
                    brandId,
                    name: "Kategori 930",
                    sortOrder: 0,
                    parentId: null,
                    createdAt: at,
                    updatedAt: at,
                    deletedAt: null,
                    syncTxid: "101",
                  },
                ]
              : [],
          nextCursor: since ?? firstPageCursor,
          hasMore: since === null,
        };
      },
    });
    const first = await pull(remote.fetchPage);
    expect(first.streams.menu_categories?.error).toBeTruthy();
    expect(await watermark(revisionKey)).toBeUndefined();
    expect(await watermark("catalog:menu_categories")).toBe(firstPageCursor);
    const priorCalls = remote.calls.length;
    await pull(remote.fetchPage);
    expect(
      remote.calls
        .slice(priorCalls)
        .find((call) => call.stream === "menu_categories")?.since,
    ).toBe(firstPageCursor);
    expect(
      remote.calls.filter(
        (call) => call.stream === "stations" && call.since === null,
      ),
    ).toHaveLength(1);
    expect(await watermark(revisionKey)).toBe("1");
  });

  it("AC10 a page-limited backlog remains pending and resumes instead of rewinding again", async () => {
    await upgradedEdge();
    const firstCursor = catCursor(100, stationId);
    const lastCursor = catCursor(101, stationId);
    const remote = cloud({
      stations: async (stream, since) => ({
        protocolVersion: 3,
        stream,
        records:
          since === null
            ? [station()]
            : since === firstCursor
              ? [station({ syncTxid: "101", name: "Bar backlog tuntas" })]
              : [],
        nextCursor: since === null ? firstCursor : lastCursor,
        hasMore: since === null,
      }),
    });
    await pull(remote.fetchPage, undefined, 1);
    expect(await watermark(revisionKey)).toBeUndefined();
    expect(await watermark("catalog:stations")).toBe(firstCursor);
    const priorCalls = remote.calls.length;
    await pull(remote.fetchPage, undefined, 1);
    expect(
      remote.calls.slice(priorCalls).find((call) => call.stream === "stations")
        ?.since,
    ).toBe(firstCursor);
    expect(
      remote.calls.filter(
        (call) => call.stream === "stations" && call.since === null,
      ),
    ).toHaveLength(1);
    expect(await localStation()).toMatchObject({
      name: "Bar backlog tuntas",
      txid: "101",
    });
    expect(await watermark(revisionKey)).toBe("1");
  });

  it("AC8 a partial stream request cannot claim the full schema revision was applied", async () => {
    await upgradedEdge();
    await pull(cloud().fetchPage, ["stations"]);
    expect(await watermark(revisionKey)).toBeUndefined();
    const remote = cloud();
    await pull(remote.fetchPage);
    expect(
      remote.calls.some(
        (call) => call.stream === "vouchers" && call.since === null,
      ),
    ).toBe(true);
    expect(await watermark(revisionKey)).toBe("1");
  });

  it("AC9 concurrent upgrade ticks initiate only one full catalog rewind", async () => {
    await upgradedEdge();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const remote = cloud({
      stations: async (stream, since) => {
        if (!held) {
          held = true;
          enter();
          await released;
        }
        return {
          protocolVersion: 3,
          stream,
          records: since === null ? [station()] : [],
          nextCursor: since ?? catCursor(100, stationId),
          hasMore: false,
        };
      },
    });
    const first = pull(remote.fetchPage);
    await entered;
    const second = pull(remote.fetchPage);
    release();
    const results = await Promise.all([first, second]);
    for (const result of results)
      for (const stream of CATALOG_SYNC_STREAMS)
        expect(result.streams[stream]?.error).toBeFalsy();
    expect(
      remote.calls.filter(
        (call) => call.stream === "stations" && call.since === null,
      ),
    ).toHaveLength(1);
    expect(await watermark(revisionKey)).toBe("1");
  });
});
