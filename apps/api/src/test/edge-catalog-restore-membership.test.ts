// Catalog membership after a cloud restore (card legend-7r7q6, second opinion
// 1197 finding R2 / proposed test T2). Written from
// docs/briefs/sub-1199-edge-catalog-so1197.md (CTO decision R2) and the
// second-opinion doc, not from the implementation. Fail-first: at acf1edca3 a
// full replay only applies the records it receives, so an item the restored
// cloud no longer has stays active on the edge.
//
// Contract under test (R2):
//  - After a restore (CTO design: recovery sets the checkpoint watermark of
//    `catalog:<stream>` to the sentinel 'rewind'; the cloud refusing the stored
//    cursor ends in the same rewind), an item that is NOT in the complete multi-page cloud
//    snapshot is DEACTIVATED on the edge (`is_active = false`). It is NOT
//    deleted: an offline sale that already references it stays valid.
//  - Items of another tenant on the same edge database stay untouched.
//  - Absence is never inferred from one incremental page (a pull that starts
//    from a valid cursor), nor from a snapshot that did not finish.
//
// Assumptions (the brief is silent), each easy to change:
//  - The stream is `menu_items`; it has an `isActive` flag in the sync record
//    and `is_active` / `deleted_at` columns on the edge. "Deactivated" means
//    the row is soft-removed: is_active = false or deleted_at set, but the row
//    still exists (never DELETE). A rewound pull that finishes the whole
//    snapshot (last page, !hasMore) does it; one that stops at maxPages does
//    not until a later pull completes. A plain incremental pull or a first
//    boot never does.
//  - The edge needs no extra step beyond the pull: the deactivation happens by
//    the time the pull that completes the snapshot returns.
//  - The restored cloud's rows are restamped above the edge's stored ones
//    (the runbook restamps with pg_current_xact_id), so version guards on the
//    edge never filter the replay; R1 is covered elsewhere.
//  - "Other outlet" is covered by the edge's other tenant row only: this edge
//    database holds one outlet.
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
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { EdgeCloudHttpError } from "../edge/cloud-http.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  catCursor,
  scriptedCatalogCloud,
  settleCloud,
  type ScriptedPage,
} from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Rec = Record<string, unknown>;
type FetchPage = (stream: string, since: string | null) => Promise<unknown>;
type PullResult = {
  streams: Record<string, { error?: { code?: string } } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();
const CATEGORIES = "menu_categories";
const ITEMS = "menu_items";
const ITEMS_CHECKPOINT = `catalog:${ITEMS}`;
const MARKER = "CATALOG_CURSOR_REJECTED";

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const q = (text: string, params: unknown[] = []) =>
  mainOwner.query(text, params);

let O1 = "";
let brandId = "";
let edge: EdgeDatabase;
let node: { id: string; credential: string };
let categoryTemplate: Rec;
const catId = id();

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function pull(
  cloud: { fetchPage: FetchPage },
  maxPages?: number,
): Promise<PullResult> {
  try {
    return (await pullCatalog({
      database: edge.database,
      context: scopeOf("device", O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
      ...(maxPages === undefined ? {} : { maxPages }),
    } as never)) as PullResult;
  } catch (error) {
    // A pull that aborts is a legitimate outcome in the unfinished-snapshot
    // test; the assertions are on the edge data, not on the return value.
    return { streams: { [ITEMS]: { error: { code: String(error) } } } };
  }
}

const itemsCheckpoint = async (): Promise<string | null | undefined> =>
  (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, ITEMS_CHECKPOINT],
    )
  )[0]?.watermark as string | null | undefined;

type Local = {
  name: string;
  active: boolean;
  deleted: boolean;
  txid: string;
};
const localItem = async (rowId: string): Promise<Local | undefined> =>
  (
    await edge.rows(
      `SELECT name, is_active AS active, deleted_at IS NOT NULL AS deleted,
              sync_txid::text AS txid
         FROM menu_items WHERE id = $1`,
      [rowId],
    )
  )[0] as Local | undefined;

/** Soft removal: the row still exists, but it is switched off (is_active false or deleted_at set). */
async function expectSoftRemoved(rowId: string, why: string) {
  const row = await localItem(rowId);
  expect(row, `${why}: the row still exists (never DELETE)`).toBeDefined();
  expect(row!.active === false || row!.deleted, why).toBe(true);
}

const NOW = "2026-11-19T08:00:00.000Z";
const category = (): Rec => ({ ...categoryTemplate, id: catId });
const item = (
  rowId: string,
  name: string,
  txid: number,
  over: Rec = {},
): Rec => ({
  id: rowId,
  tenantId,
  brandId,
  categoryId: catId,
  name,
  description: "",
  type: "single",
  stationId: null,
  stationType: null,
  course: null,
  recipeId: null,
  taxRuleId: null,
  labels: [],
  allergens: [],
  mediaId: null,
  isActive: true,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  syncTxid: String(txid),
  ...over,
});

/** A scripted cloud with one category and the given menu items, in pages of one. */
const cloudWith = (items: Rec[]) =>
  scriptedCatalogCloud({ [CATEGORIES]: [category()], [ITEMS]: items }, 1);

async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM menu_items");
    await client.query("DELETE FROM menu_categories");
    await client.query("DELETE FROM edge_pull_checkpoints");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function copyToEdge(table: string, rowId: string) {
  const found = await mainOwner.query(
    `SELECT row_to_json(t) AS row FROM ${table} t WHERE id = $1`,
    [rowId],
  );
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json) ON CONFLICT DO NOTHING`,
      [JSON.stringify(found.rows[0].row)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Copies a local menu item to another tenant/brand (a neighbour on a shared edge DB). */
async function cloneItemToOtherTenant(sourceId: string): Promise<string> {
  const otherId = id();
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO menu_items
         SELECT (json_populate_record(NULL::menu_items,
                 (to_jsonb(t) || jsonb_build_object(
                    'id', $1::text, 'tenant_id', $2::text, 'brand_id', $3::text)
                 )::json)).*
           FROM menu_items t WHERE t.id = $4`,
      [otherId, id(), id(), sourceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return otherId;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji keanggotaan katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori keanggotaan',0)`,
    [catId, tenantId, brandId],
  );
  await settleCloud(mainOwner);
  let found: Rec | undefined;
  let since: string | undefined;
  for (let n = 0; n < 2000 && !found; n += 1) {
    const page = (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: O1 as never,
      query: catalogSyncQuerySchema.parse({
        stream: CATEGORIES,
        limit: 100,
        ...(since === undefined ? {} : { since }),
      }),
    })) as unknown as ScriptedPage;
    found = page.records.find((r) => r.id === catId);
    if (!page.hasMore || !page.nextCursor) break;
    since = page.nextCursor;
  }
  expect(found, "template category exported by the cloud").toBeTruthy();
  categoryTemplate = found!;

  const registered = await registerEdgeNode(scopeOf("session", O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji keanggotaan katalog",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: O1 });
  await copyToEdge("edge_nodes", node.id);
}, 240_000);

beforeEach(async () => {
  await resetEdge();
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    await q("DELETE FROM menu_categories WHERE id = $1", [catId]);
    await q("DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM edge_nodes WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM outlets WHERE id = $1", [O1]);
  } catch {
    // Best effort: private ids on a private outlet.
  }
  await mainOwner.end();
});

// ------------------------------------------------------------------ scenarios

const X = id(); // created after the backup: gone from the restored cloud
const Y = id(); // exists in the backup too
const W = id(); // exists only in the restored cloud

/** The edge synced X and Y (txids 500, 501) from the cloud before the restore. */
async function seedBeforeRestore() {
  const before = cloudWith([item(X, "Item X", 500), item(Y, "Item Y", 501)]);
  const first = await pull(before);
  expect(first.streams[ITEMS]?.error, "seed pull").toBeFalsy();
  expect((await localItem(X))?.active, "seed: X active").toBe(true);
  expect((await localItem(Y))?.active, "seed: Y active").toBe(true);
  expect(await itemsCheckpoint(), "seed: stored cursor").toBeTruthy();
}

/** The restored cloud: X is gone; Y is back (restamped higher); W is new. */
const restoredItems = () => [
  item(Y, "Item Y setelah restore", 600),
  item(W, "Item W", 601),
];

describe("7r7q6 R2: an item missing from the restored cloud is deactivated on the edge", () => {
  it("restore recovery (watermark set to the 'rewind' sentinel): the full multi-page snapshot deactivates X, keeps the row, and applies Y and W", async () => {
    await seedBeforeRestore();
    await edge.rows(
      "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
      [node.id, ITEMS_CHECKPOINT],
    );
    const restored = cloudWith(restoredItems());

    const result = await pull(restored);

    expect(result.streams[ITEMS]?.error, "restore pull").toBeFalsy();
    expect(
      restored.calls.filter((c) => c.stream === ITEMS && c.since === null),
      "the replay started from the beginning",
    ).toHaveLength(1);
    expect(
      restored.calls.filter((c) => c.stream === ITEMS).length,
      "the snapshot had more than one page",
    ).toBeGreaterThan(1);
    await expectSoftRemoved(X, "X is deactivated, not deleted");
    expect(await localItem(Y)).toMatchObject({
      name: "Item Y setelah restore",
      active: true,
    });
    expect(await localItem(W)).toMatchObject({
      name: "Item W",
      active: true,
    });
  }, 120_000);

  it("cloud refuses the stored cursor (restore detected): the replay deactivates X the same way", async () => {
    await seedBeforeRestore();
    const restored = cloudWith(restoredItems());
    const asked: (string | null)[] = [];
    const fetchPage = async (stream: string, since: string | null) => {
      if (stream === ITEMS) asked.push(since);
      // The restored cloud's counter is below the edge's cursor: it refuses
      // every cursor and serves only the full snapshot.
      if (stream === ITEMS && since !== null)
        throw new EdgeCloudHttpError("HTTP_400", MARKER);
      return restored.fetchPage(stream, since);
    };

    await pull({ fetchPage });
    // Recovery may need a second pull (like edge-catalog-rewind.test.ts).
    if ((await localItem(W)) === undefined) await pull({ fetchPage });

    expect(asked, "a full pull from the start happened").toContain(null);
    await expectSoftRemoved(X, "X is deactivated, not deleted");
    expect(await localItem(Y)).toMatchObject({
      name: "Item Y setelah restore",
      active: true,
    });
  }, 120_000);

  it("another tenant's item on the same edge database stays active while X is deactivated", async () => {
    await seedBeforeRestore();
    const neighbour = await cloneItemToOtherTenant(X);
    expect((await localItem(neighbour))?.active, "neighbour seeded").toBe(true);
    await edge.rows(
      "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
      [node.id, ITEMS_CHECKPOINT],
    );

    await pull(cloudWith(restoredItems()));

    // Guard against a vacuous pass: the restore did reach X.
    await expectSoftRemoved(X, "X deactivated");
    expect(
      await localItem(neighbour),
      "the other tenant's item is untouched",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });
  }, 120_000);
});

describe("7r7q6 R2: absence is not inferred from partial information", () => {
  it("an incremental pull (valid stored cursor, one page without X) does not deactivate X", async () => {
    await seedBeforeRestore();
    // Normal operation: Y changed (higher txid); the page simply does not
    // mention X because X did not change.
    const incremental = cloudWith([
      item(X, "Item X", 500),
      item(Y, "Item Y diubah", 700),
    ]);
    // Serve only the changed row after the stored position.
    const stored = await itemsCheckpoint();
    const fetchPage = async (stream: string, since: string | null) => {
      if (stream !== ITEMS || since === null)
        return incremental.fetchPage(stream, since);
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [item(Y, "Item Y diubah", 700)],
        nextCursor: incremental.cursorAfter(ITEMS, 3),
        hasMore: false,
      } satisfies ScriptedPage;
    };

    const result = await pull({ fetchPage });

    expect(result.streams[ITEMS]?.error, "incremental pull").toBeFalsy();
    expect(stored, "pull started from a stored cursor").toBeTruthy();
    expect(await localItem(Y)).toMatchObject({
      name: "Item Y diubah",
      active: true,
    });
    expect(
      await localItem(X),
      "X was not in the incremental page and stays active",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });
  }, 120_000);

  it("an incremental pull over several pages that omit X still keeps X active", async () => {
    await seedBeforeRestore();
    const stored = await itemsCheckpoint();
    const changed = [item(Y, "Item Y v2", 700), item(W, "Item W", 701)];
    const fetchPage = async (stream: string, since: string | null) => {
      if (stream !== ITEMS) return cloudWith([]).fetchPage(stream, since);
      const index = since === stored ? 0 : 1;
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [changed[index]],
        nextCursor: catCursor(710 + index, ITEMS),
        hasMore: index === 0,
      } satisfies ScriptedPage;
    };

    await pull({ fetchPage });

    expect(await localItem(X)).toMatchObject({ active: true, deleted: false });
  }, 120_000);

  it("a replay that did not finish (network error before the last page) deactivates nothing", async () => {
    await seedBeforeRestore();
    await edge.rows(
      "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
      [node.id, ITEMS_CHECKPOINT],
    );
    const restored = cloudWith(restoredItems());
    // Page 1 (Y) arrives, page 2 (W) never does: X is absent from what the
    // edge has seen so far, but the snapshot is not complete.
    restored.breakAt(ITEMS, 2);

    await pull(restored);

    expect(
      await localItem(X),
      "X stays active until a complete snapshot proves it is gone",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });
  }, 120_000);

  it("a rewound pull that stops at maxPages deactivates nothing until a later pull completes the snapshot", async () => {
    await seedBeforeRestore();
    await edge.rows(
      "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
      [node.id, ITEMS_CHECKPOINT],
    );
    const V = id();
    const restored = cloudWith([...restoredItems(), item(V, "Item V", 602)]);

    // Three pages of one item; the pull is allowed one page per stream.
    await pull(restored, 1);
    expect(
      await localItem(X),
      "backlog: the snapshot is not complete yet, X stays active",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });

    // Later pulls (no page limit) reach the last page.
    await pull(restored);
    if ((await localItem(V)) === undefined) await pull(restored);

    expect(await localItem(V), "snapshot completed").toMatchObject({
      active: true,
    });
    await expectSoftRemoved(X, "X deactivated once the snapshot completes");
  }, 120_000);
});
