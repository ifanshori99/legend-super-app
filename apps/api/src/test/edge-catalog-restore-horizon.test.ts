// Catalog membership after a cloud restore, round 3 (card legend-7r7q6,
// docs/briefs/1199-ronde3.md). Fail-first at ffdf4cd58.
//
// P1: after a logical restore the new cluster's txid counter is low, while the
// restored rows keep their old, higher `sync_txid`. The export hides them
// (`sync_txid < pg_snapshot_xmin`) until the runbook restamps them. CTO
// decision: while any row in the stream's scope is stamped at or above the
// page's horizon, the cloud sends no `visibleBelow` / `horizon` (without the
// fields the edge never deactivates). After the restamp only rows that are
// really gone are deactivated.
//
// P2: a stream that is empty in the cloud gave `nextCursor: null` on a replay,
// so the edge stored no cursor, treated every later pull as a first boot and
// restarted the replay marker forever: nothing was ever deactivated (a
// promotion the restored cloud no longer has kept discounting offline). The
// cloud now gives an edge that sends `protocolVersion` a start cursor for an
// empty first page; an edge without it keeps `null`.
//
// These tests pull from the real cloud export (`listCatalogRecordsSince`), not
// from a scripted cloud. The promotions stream is tenant-wide and other test
// files write promotions, so the promotion case runs against its own tenant
// (cloned from the main one, one outlet, no promotions, its own edge database):
// the cloud's genuinely empty promotions page (legend-bg5wy).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { promotionAvailability } from "@starter/shared/crm";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  listCatalogRecordsSince,
  resetDeactivationWarnings,
  setCatalogSnapshotXmaxProvider,
} from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Rec = Record<string, unknown>;
type FetchPage = (stream: string, since: string | null) => Promise<unknown>;
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();
const STATIONS = "stations";
const PRICE_LISTS = "price_lists";
const PROMOS = "promotions";

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const q = (text: string, params: unknown[] = []) =>
  mainOwner.query(text, params);

let O1 = "";
let O2 = "";
let edge: EdgeDatabase;
let node: { id: string; credential: string };
const cloudStations: string[] = [];

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** One page of the real cloud export, as an edge with `protocolVersion` asks. */
const cloudPage = async (
  stream: string,
  since: string | null,
  options: { outletId?: string; versioned?: boolean; limit?: number } = {},
): Promise<Rec> =>
  (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: (options.outletId ?? O1) as never,
    query: catalogSyncQuerySchema.parse({
      stream,
      limit: options.limit ?? 100,
      ...(since === null ? {} : { since }),
      ...(options.versioned === false
        ? {}
        : { protocolVersion: CATALOG_PROTOCOL_VERSION }),
    }),
  })) as unknown as Rec;

const realCloud: { fetchPage: FetchPage } = {
  fetchPage: (stream, since) => cloudPage(stream, since),
};

async function pull(
  cloud: { fetchPage: FetchPage },
  streams: string[],
): Promise<PullResult> {
  return (await pullCatalog({
    database: edge.database,
    context: scopeOf("device", O1),
    edgeNodeId: node.id,
    fetchPage: cloud.fetchPage,
    streams,
  } as never)) as PullResult;
}

const replayMarker = async (stream: string): Promise<string | null> =>
  ((
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, `catalog:replay:${stream}`],
    )
  )[0]?.watermark ?? null) as string | null;

const rewind = async (stream: string) => {
  const rows = await edge.rows(
    "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2 RETURNING stream",
    [node.id, `catalog:${stream}`],
  );
  expect(rows, `rewind ${stream}: checkpoint row exists`).toHaveLength(1);
};

/**
 * Pulls until the replay marker is gone (the confirmation pull ran) or `max`
 * pulls passed. The cloud is settled before each pull so a horizon pinned by
 * the previous pull is behind the next pull's xmin.
 */
async function pullUntilConfirmed(
  cloud: { fetchPage: FetchPage },
  stream: string,
  max = 8,
): Promise<number> {
  for (let n = 1; n <= max; n += 1) {
    await settleCloud(mainOwner);
    const result = await pull(cloud, [stream]);
    expect(result.streams[stream]?.error, `pull ${n}`).toBeFalsy();
    if ((await replayMarker(stream)) === null) return n;
  }
  return max + 1;
}

/** Writes on the edge as its owner, triggers off (a row the edge already had). */
async function edgeWrite(text: string, params: unknown[] = []) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    // No parameters: simple protocol, so several statements may run at once.
    if (params.length === 0) await client.query(text);
    else await client.query(text, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Writes `sync_txid` on a cloud row with the stamp trigger switched off. */
async function stampCloud(table: string, rowId: string, value: string) {
  const client = await mainOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('legend.skip_sync_txid', 'on', true)",
    );
    await client.query(
      `UPDATE ${table} SET sync_txid = ${value} WHERE id = $1`,
      [rowId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cloudStation(outletId: string, name: string): Promise<string> {
  const stationId = id();
  await q(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1,$2,$3,$4,'hot_kitchen')`,
    [stationId, tenantId, outletId, name],
  );
  cloudStations.push(stationId);
  return stationId;
}

const cloudStamp = async (table: string, rowId: string): Promise<bigint> =>
  BigInt(
    (
      await q(`SELECT sync_txid::text AS t FROM ${table} WHERE id = $1`, [
        rowId,
      ])
    ).rows[0].t as string,
  );

const localStation = async (rowId: string) =>
  (
    await edge.rows(
      `SELECT is_active AS active, deleted_at IS NOT NULL AS deleted,
              sync_txid::text AS txid FROM stations WHERE id = $1`,
      [rowId],
    )
  )[0] as { active: boolean; deleted: boolean; txid: string } | undefined;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji horizon katalog",
  );
  O2 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji horizon katalog kosong",
  );
  const registered = await registerEdgeNode(scopeOf("session", O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji horizon katalog",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: O1 });
  const found = await q(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [node.id],
  );
  await edgeWrite(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
    [JSON.stringify(found.rows[0].row)],
  );
}, 240_000);

beforeEach(async () => {
  setCatalogSnapshotXmaxProvider(null);
  resetDeactivationWarnings();
  await edgeWrite(
    `DELETE FROM stations; DELETE FROM price_list_items; DELETE FROM price_lists;
     DELETE FROM promotion_outlets; DELETE FROM promotions;
     DELETE FROM edge_pull_checkpoints`,
  );
  while (cloudStations.length > 0) {
    const stationId = cloudStations.pop();
    await q("DELETE FROM stations WHERE id = $1", [stationId]);
  }
});

afterAll(async () => {
  setCatalogSnapshotXmaxProvider(null);
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    for (const stationId of cloudStations)
      await q("DELETE FROM stations WHERE id = $1", [stationId]);
    await q("DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM edge_nodes WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM outlets WHERE id = ANY($1::uuid[])", [[O1, O2]]);
  } catch {
    // Best effort: private ids on private outlets.
  }
  await mainOwner.end();
});

describe("7r7q6 ronde 3 P1 cloud: no visibility fields while a row of the stream's scope is stamped at or above the horizon", () => {
  it("a station stamped at the (forced) horizon withholds visibleBelow/horizon; one txid higher they are back", async () => {
    const S = await cloudStation(O1, "Stasiun di atas horizon");
    await settleCloud(mainOwner);
    const stamp = await cloudStamp("stations", S);

    setCatalogSnapshotXmaxProvider(async () => stamp);
    const withheld = await cloudPage(STATIONS, null);
    expect(withheld, "stamp == horizon: from the future").not.toHaveProperty(
      "visibleBelow",
    );
    expect(withheld).not.toHaveProperty("horizon");

    setCatalogSnapshotXmaxProvider(async () => stamp + 1n);
    const sent = await cloudPage(STATIONS, null);
    expect(sent.visibleBelow).toMatch(/^\d+$/);
    expect(sent.horizon).toBe((stamp + 1n).toString());
  });

  it("the check is scoped to the stream's outlet: another outlet's future row does not withhold the fields", async () => {
    const S = await cloudStation(O1, "Stasiun outlet lain");
    await settleCloud(mainOwner);
    setCatalogSnapshotXmaxProvider(async () => cloudStamp("stations", S));
    const page = await cloudPage(STATIONS, null, { outletId: O2 });
    expect(page.visibleBelow).toMatch(/^\d+$/);
    expect(page.horizon).toMatch(/^\d+$/);
  });

  it("legend-bg5wy: a page with more rows after it sends no visibility fields; the last page does", async () => {
    await cloudStation(O1, "Stasiun halaman satu");
    await cloudStation(O1, "Stasiun halaman dua");
    await settleCloud(mainOwner);
    const first = await cloudPage(STATIONS, null, { limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(first, "not a last page").not.toHaveProperty("visibleBelow");
    expect(first).not.toHaveProperty("horizon");
    const whole = await cloudPage(STATIONS, null);
    expect(whole.hasMore).toBe(false);
    expect(whole.visibleBelow).toMatch(/^\d+$/);
    expect(whole.horizon).toMatch(/^\d+$/);
  });

  it("legend-bg5wy: withholding the fields warns once per stream+tenant with no personal data; a clean page does not warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const S = await cloudStation(O1, "Stasiun dari backup (warn)");
      await settleCloud(mainOwner);
      setCatalogSnapshotXmaxProvider(async () => cloudStamp("stations", S));
      await cloudPage(STATIONS, null);
      await cloudPage(STATIONS, null);
      const calls = warn.mock.calls.filter(
        ([fields]) =>
          (fields as { stream?: string } | undefined)?.stream === STATIONS,
      );
      expect(calls, "rate limited: one warning for two pages").toHaveLength(1);
      expect(calls[0]![0]).toEqual({ stream: STATIONS, tenantId });

      resetDeactivationWarnings();
      warn.mockClear();
      setCatalogSnapshotXmaxProvider(
        async () => (await cloudStamp("stations", S)) + 1n,
      );
      await cloudPage(STATIONS, null);
      expect(warn, "visible stream: no warning").not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("7r7q6 ronde 3 P1 edge: a restore before the restamp hides nothing that is still in the cloud", () => {
  it("before the restamp no station is deactivated; after it only the station really gone is", async () => {
    const V = await cloudStation(O1, "Stasiun terlihat");
    const S = await cloudStation(O1, "Stasiun dari backup");
    await settleCloud(mainOwner);
    const seed = await pull(realCloud, [STATIONS]);
    expect(seed.streams[STATIONS]?.error, "seed pull").toBeFalsy();
    expect((await localStation(S))?.active, "seed: S on the edge").toBe(true);
    const Z = id(); // on the edge, gone from the restored cloud
    await edgeWrite(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type, sync_txid)
       VALUES ($1,$2,$3,'Stasiun hilang','hot_kitchen',7)`,
      [Z, tenantId, O1],
    );

    // The restore: S keeps a stamp above the new cluster's counter.
    const xmax = BigInt(
      (await q("SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x"))
        .rows[0].x as string,
    );
    await stampCloud("stations", S, (xmax + 1_000_000_000n).toString());
    await rewind(STATIONS);

    for (let n = 1; n <= 3; n += 1) {
      await settleCloud(mainOwner);
      const result = await pull(realCloud, [STATIONS]);
      expect(result.streams[STATIONS]?.error, `pull ${n}`).toBeFalsy();
    }
    expect(
      await localStation(S),
      "S is still in the cloud (hidden until the restamp): never deactivated",
    ).toMatchObject({ active: true, deleted: false });
    expect(
      await localStation(Z),
      "nothing is deactivated while the cloud cannot show every row",
    ).toMatchObject({ active: true, deleted: false });
    expect((await localStation(V))?.active).toBe(true);

    // The runbook restamp.
    await stampCloud("stations", S, "pg_current_xact_id()::text::bigint");
    const pulls = await pullUntilConfirmed(realCloud, STATIONS);
    expect(pulls, "the replay is confirmed after the restamp").toBeLessThan(9);

    expect(await localStation(S), "S is kept").toMatchObject({
      active: true,
      deleted: false,
    });
    expect(Number((await localStation(S))!.txid)).toBeGreaterThan(0);
    expect((await localStation(V))?.active, "V is kept").toBe(true);
    expect(
      await localStation(Z),
      "Z, really gone, is switched off (row kept)",
    ).toMatchObject({ active: false });
  }, 180_000);
});

describe("7r7q6 ronde 3 P2 cloud: an empty first page gives a versioned edge a start cursor", () => {
  it("with protocolVersion the empty page carries a cat2 cursor that pages again to the same empty end", async () => {
    const first = await cloudPage(PRICE_LISTS, null, { outletId: O2 });
    expect(first.records).toEqual([]);
    expect(first.hasMore).toBe(false);
    expect(typeof first.nextCursor, "a start cursor").toBe("string");

    const again = await cloudPage(PRICE_LISTS, first.nextCursor as string, {
      outletId: O2,
    });
    expect(again.records).toEqual([]);
    expect(again.nextCursor).toBe(first.nextCursor);
  });

  it("without protocolVersion (an older edge) the empty page keeps nextCursor null", async () => {
    const page = await cloudPage(PRICE_LISTS, null, {
      outletId: O2,
      versioned: false,
    });
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("7r7q6 ronde 3 P2 edge: a stream empty in the restored cloud still deactivates after the confirmation pull", () => {
  it("a price list the restored cloud no longer has gets deleted_at (row kept)", async () => {
    const seed = await pull(realCloud, [PRICE_LISTS]);
    expect(seed.streams[PRICE_LISTS]?.error, "seed pull").toBeFalsy();
    const L = id();
    await edgeWrite(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from, sync_txid)
       VALUES ($1,$2,$3,'takeaway','2026-01-01',9)`,
      [L, tenantId, O1],
    );
    await rewind(PRICE_LISTS);

    const pulls = await pullUntilConfirmed(realCloud, PRICE_LISTS);

    expect(pulls, "the replay of an empty stream is confirmed").toBeLessThan(9);
    const [row] = await edge.rows(
      "SELECT deleted_at IS NOT NULL AS deleted FROM price_lists WHERE id = $1",
      [L],
    );
    expect(row, "row kept (never DELETE)").toBeDefined();
    expect(row!.deleted, "L is switched off").toBe(true);
  }, 180_000);
});

describe("7r7q6 ronde 3 P2 edge: a promotions stream genuinely empty in the restored cloud (own tenant)", () => {
  let T2 = "";
  let T2outlet = "";
  let edge2: EdgeDatabase;
  let node2: { id: string; credential: string };

  const scope2 = (source: "session" | "device"): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({ tenantId: T2, brandId: null, source }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(T2outlet)] },
    );

  const emptyCloud: { fetchPage: FetchPage } = {
    fetchPage: async (stream, since) =>
      (await listCatalogRecordsSince(db, {
        tenantId: T2 as never,
        outletId: T2outlet as never,
        query: catalogSyncQuerySchema.parse({
          stream,
          limit: 100,
          ...(since === null ? {} : { since }),
          protocolVersion: CATALOG_PROTOCOL_VERSION,
        }),
      })) as unknown,
  };

  const pull2 = async () =>
    (await pullCatalog({
      database: edge2.database,
      context: scope2("device"),
      edgeNodeId: node2.id,
      fetchPage: emptyCloud.fetchPage,
      streams: [PROMOS],
    } as never)) as PullResult;

  beforeAll(async () => {
    T2 = id();
    T2outlet = id();
    // A tenant of its own: same shape as the main one, its own brand and legal
    // entity, so it owns no promotion.
    await q(
      `INSERT INTO tenants SELECT (json_populate_record(NULL::tenants,
         (to_jsonb(t) || jsonb_build_object('id', $1::text, 'slug', $2::text))::json)).*
         FROM tenants t WHERE t.id = $3`,
      [T2, `horizon-${T2}`, tenantId],
    );
    const T2brand = id();
    await q(
      `INSERT INTO brands SELECT (json_populate_record(NULL::brands,
         (to_jsonb(b) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text))::json)).*
         FROM brands b WHERE b.id = (SELECT brand_id FROM outlets WHERE id = $3)`,
      [T2brand, T2, cafeLegendAccessFixtures.outletIds.bandung],
    );
    const T2legal = id();
    await q(
      `INSERT INTO legal_entities SELECT (json_populate_record(NULL::legal_entities,
         (to_jsonb(l) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text))::json)).*
         FROM legal_entities l WHERE l.id = (SELECT legal_entity_id FROM outlets WHERE id = $3)`,
      [T2legal, T2, cafeLegendAccessFixtures.outletIds.bandung],
    );
    await q(
      `INSERT INTO outlets SELECT (json_populate_record(NULL::outlets,
         (to_jsonb(o) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text,
            'code', $3::text, 'brand_id', $5::text, 'legal_entity_id', $6::text))::json)).*
         FROM outlets o WHERE o.id = $4`,
      [
        T2outlet,
        T2,
        `ED${T2outlet.slice(0, 8)}`.toUpperCase(),
        cafeLegendAccessFixtures.outletIds.bandung,
        T2brand,
        T2legal,
      ],
    );
    const registered = await registerEdgeNode(scope2("session"), actor, {
      outletId: T2outlet,
      role: "standby",
      label: "Mini PC uji promo kosong",
    });
    node2 = { id: registered.edgeNode.id, credential: registered.credential };
    edge2 = await createEdgeDatabase({ tenantId: T2, outletId: T2outlet });
    const found = await q(
      "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
      [node2.id],
    );
    const client = await edge2.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
        [JSON.stringify(found.rows[0].row)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, 240_000);

  afterAll(async () => {
    await edge2?.cleanup();
    try {
      await q("DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1", [
        T2outlet,
      ]);
      await q("DELETE FROM edge_nodes WHERE outlet_id = $1", [T2outlet]);
      await q("DELETE FROM outlets WHERE id = $1", [T2outlet]);
      await q("DELETE FROM brands WHERE tenant_id = $1", [T2]);
      await q("DELETE FROM legal_entities WHERE tenant_id = $1", [T2]);
      await q("DELETE FROM tenants WHERE id = $1", [T2]);
    } catch {
      // Best effort: private ids on a private tenant.
    }
  });

  it("a promotion the restored cloud no longer has stops applying offline after the confirmation pull", async () => {
    const seed = await pull2();
    expect(seed.streams[PROMOS]?.error, "seed pull").toBeFalsy();
    const P = id();
    const client = await edge2.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO promotions
           (id, tenant_id, name, description, status, voucher_required, starts_at,
            ends_at, conditions, benefit, stack_group, stackable, priority, sync_txid)
         VALUES ($1,$2,'Promo sebelum restore','','active',false,'2026-01-01T00:00:00Z',
                 '2099-01-01T00:00:00Z',$3,$4,'horizon',false,0,11)`,
        [
          P,
          T2,
          JSON.stringify([
            { kind: "item_quantity", menuItemIds: [id()], minQuantity: 1 },
          ]),
          JSON.stringify({ kind: "nominal_off", amountIdr: 1000 }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const rewound = await edge2.rows(
      "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2 RETURNING stream",
      [node2.id, `catalog:${PROMOS}`],
    );
    expect(rewound, "rewind: checkpoint row exists").toHaveLength(1);

    let confirmed = 0;
    for (let n = 1; n <= 8 && confirmed === 0; n += 1) {
      await settleCloud(mainOwner);
      const result = await pull2();
      expect(result.streams[PROMOS]?.error, `pull ${n}`).toBeFalsy();
      const marker = await edge2.rows(
        "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
        [node2.id, `catalog:replay:${PROMOS}`],
      );
      if (marker.length === 0) confirmed = n;
    }
    expect(
      confirmed,
      "the replay of an empty stream is confirmed",
    ).toBeGreaterThan(0);

    const [row] = (await edge2.rows(
      "SELECT status, starts_at, ends_at FROM promotions WHERE id = $1",
      [P],
    )) as { status: string; starts_at: Date; ends_at: Date | null }[];
    expect(row, "promotion row kept (never DELETE)").toBeDefined();
    expect(
      promotionAvailability(
        {
          status: row!.status as never,
          startsAt: row!.starts_at.toISOString() as never,
          endsAt: row!.ends_at ? (row!.ends_at.toISOString() as never) : null,
        },
        new Date().toISOString() as never,
      ),
      "P no longer applies offline",
    ).not.toBeNull();
  }, 180_000);
});
