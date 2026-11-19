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
// files write promotions, so the promotion case serves the real export of an
// empty outlet stream (price_lists of a private outlet) relabelled as
// promotions: it is exactly the cloud's empty-stream page.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  listCatalogRecordsSince,
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
  options: { outletId?: string; versioned?: boolean } = {},
): Promise<Rec> =>
  (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: (options.outletId ?? O1) as never,
    query: catalogSyncQuerySchema.parse({
      stream,
      limit: 100,
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

  it("a promotion the restored cloud no longer has stops applying offline after the confirmation pull", async () => {
    // The cloud's empty-stream page, relabelled (see the header).
    const emptyPromos: { fetchPage: FetchPage } = {
      fetchPage: async (stream, since) =>
        stream === PROMOS
          ? {
              ...(await cloudPage(PRICE_LISTS, since, { outletId: O2 })),
              stream: PROMOS,
            }
          : cloudPage(stream, since),
    };
    const seed = await pull(emptyPromos, [PROMOS]);
    expect(seed.streams[PROMOS]?.error, "seed pull").toBeFalsy();
    const P = id();
    await edgeWrite(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, voucher_required, starts_at,
          ends_at, conditions, benefit, stack_group, stackable, priority, sync_txid)
       VALUES ($1,$2,'Promo sebelum restore','','active',false,'2026-01-01T00:00:00Z',
               '2099-01-01T00:00:00Z',$3,$4,'horizon',false,0,11)`,
      [
        P,
        tenantId,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [id()], minQuantity: 1 },
        ]),
        JSON.stringify({ kind: "nominal_off", amountIdr: 1000 }),
      ],
    );
    await rewind(PROMOS);

    const pulls = await pullUntilConfirmed(emptyPromos, PROMOS);

    expect(pulls, "the replay of an empty stream is confirmed").toBeLessThan(9);
    const [row] = (await edge.rows(
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
