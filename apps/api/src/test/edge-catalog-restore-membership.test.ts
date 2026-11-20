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
// Ronde 2 (A4, protocol): the cloud exports only rows below its oldest open
// transaction, so a short last page after a replay can hide an item that still
// exists. Therefore deactivation needs TWO complete pulls:
//  - Cloud pages carry optional `visibleBelow` (pg_snapshot_xmin) and `horizon`
//    (pg_snapshot_xmax), decimal strings from the same snapshot as the page.
//  - Pull 1 (replay, last page): marker `catalog:replay:<stream>` goes from
//    "1" to `h:<horizon>`. Nothing is deactivated.
//  - A later last page with visibleBelow >= that horizon: deactivate what the
//    replay never saw, then remove the marker. visibleBelow < horizon (a
//    transaction held open in the cloud): do nothing, keep the marker.
//  - Pages without the fields (an older cloud): never deactivate, marker stays.
// B (money): a promotion missing from the restored cloud must stop applying
// offline. It is switched off through `status` (any value that makes
// promotionAvailability() non-null), never deleted.
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
import { promotionAvailability } from "@starter/shared/crm";
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  installPromoFreshnessProvider,
  promosEnabled,
  setPromoGateEdgeModeForTests,
} from "../edge/promo-gate.ts";
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
const PROMOS = "promotions";
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
  streams?: string[],
): Promise<PullResult> {
  try {
    return (await pullCatalog({
      database: edge.database,
      context: scopeOf("device", O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(streams === undefined ? {} : { streams }),
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

type Visibility = { visibleBelow: string; horizon: string };
/** A snapshot with nothing in flight: everything below the horizon is visible. */
const SETTLED: Visibility = { visibleBelow: "1000", horizon: "1000" };

/**
 * Adds the optional cloud fields to every page, as the real cloud service
 * does. `current()` is read per page, so a test can change it between pulls;
 * null serves pages without the fields (an older cloud).
 */
const withVisibility =
  (inner: FetchPage, current: () => Visibility | null): FetchPage =>
  async (stream, since) => {
    const page = (await inner(stream, since)) as Rec;
    const view = current();
    return view ? { ...page, ...view } : page;
  };

const replayMarker = async (stream: string): Promise<string | null> =>
  ((
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, `catalog:replay:${stream}`],
    )
  )[0]?.watermark ?? null) as string | null;

const rewind = (stream: string) =>
  edge.rows(
    "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
    [node.id, `catalog:${stream}`],
  );

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

const isSoftRemoved = async (rowId: string) => {
  const row = await localItem(rowId);
  return row !== undefined && (row.active === false || row.deleted);
};

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

const expectXStillActive = async (why: string) =>
  expect(await localItem(X), why).toMatchObject({
    name: "Item X",
    active: true,
    deleted: false,
  });

describe("7r7q6 R2: an item missing from the restored cloud is deactivated on the edge after TWO complete pulls", () => {
  it("restore recovery (watermark set to the 'rewind' sentinel): pull 1 applies Y and W and deactivates nothing; pull 2 deactivates X, keeps the row, and clears the marker", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());
    const view: Visibility | null = SETTLED;
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => view),
    };

    const first = await pull(served);

    expect(first.streams[ITEMS]?.error, "restore pull").toBeFalsy();
    expect(
      restored.calls.filter((c) => c.stream === ITEMS && c.since === null),
      "the replay started from the beginning",
    ).toHaveLength(1);
    expect(
      restored.calls.filter((c) => c.stream === ITEMS).length,
      "the snapshot had more than one page",
    ).toBeGreaterThan(1);
    expect(await localItem(Y)).toMatchObject({
      name: "Item Y setelah restore",
      active: true,
    });
    expect(await localItem(W)).toMatchObject({
      name: "Item W",
      active: true,
    });
    await expectXStillActive(
      "one complete pull is not enough: the last page may hide an item that is still in the cloud",
    );
    expect(
      await replayMarker(ITEMS),
      "the horizon of the replay is remembered",
    ).toBe(`h:${SETTLED.horizon}`);

    const second = await pull(served);

    expect(second.streams[ITEMS]?.error, "second pull").toBeFalsy();
    await expectSoftRemoved(X, "X is deactivated, not deleted");
    expect(await localItem(Y)).toMatchObject({ active: true, deleted: false });
    expect(await localItem(W)).toMatchObject({ active: true, deleted: false });
    expect(await replayMarker(ITEMS), "the marker is cleared").toBeNull();
  }, 120_000);

  it("cloud refuses the stored cursor (restore detected): the replay deactivates X the same way after the next complete pull", async () => {
    await seedBeforeRestore();
    const restored = cloudWith(restoredItems());
    const view = withVisibility(restored.fetchPage, () => SETTLED);
    const asked: (string | null)[] = [];
    const fetchPage = async (stream: string, since: string | null) => {
      if (stream === ITEMS) asked.push(since);
      // The restored cloud's counter is below the edge's old cursor: it
      // refuses that cursor until the edge has asked for the full snapshot.
      // Cursors it issues itself afterwards are valid (a real cloud accepts
      // its own page cursors).
      if (stream === ITEMS && since !== null && !asked.includes(null))
        throw new EdgeCloudHttpError("HTTP_400", MARKER);
      return view(stream, since);
    };

    // Recovery takes a few pulls (rewind, replay, then the confirming pull);
    // the bound only keeps a broken implementation from looping forever.
    for (let n = 0; n < 5 && !(await isSoftRemoved(X)); n += 1)
      await pull({ fetchPage });

    expect(asked, "a full pull from the start happened").toContain(null);
    await expectSoftRemoved(X, "X is deactivated, not deleted");
    expect(await localItem(Y)).toMatchObject({
      name: "Item Y setelah restore",
      active: true,
    });
    expect(await localItem(W)).toMatchObject({ name: "Item W", active: true });
  }, 120_000);

  it("another tenant's item on the same edge database stays active while X is deactivated", async () => {
    await seedBeforeRestore();
    const neighbour = await cloneItemToOtherTenant(X);
    expect((await localItem(neighbour))?.active, "neighbour seeded").toBe(true);
    await rewind(ITEMS);
    const served = {
      fetchPage: withVisibility(
        cloudWith(restoredItems()).fetchPage,
        () => SETTLED,
      ),
    };

    await pull(served);
    await pull(served);

    // Guard against a vacuous pass: the restore did reach X.
    await expectSoftRemoved(X, "X deactivated");
    expect(
      await localItem(neighbour),
      "the other tenant's item is untouched",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });
  }, 120_000);

  it("pages without visibleBelow/horizon (an older cloud) never deactivate anything, however many pulls complete, and the marker stays", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());

    await pull(restored);
    await pull(restored);
    await pull(restored);

    expect(await localItem(Y)).toMatchObject({
      name: "Item Y setelah restore",
      active: true,
    });
    expect(await localItem(W)).toMatchObject({ name: "Item W", active: true });
    await expectXStillActive(
      "without the cloud's proof of visibility absence is never inferred",
    );
    expect(
      await replayMarker(ITEMS),
      "the marker survives until a cloud that sends the fields completes it",
    ).not.toBeNull();
  }, 120_000);

  it("a cloud transaction held open (visibleBelow < horizon) blocks deactivation until it ends", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());
    let view: Visibility | null = { visibleBelow: "1000", horizon: "1000" };
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => view),
    };

    await pull(served); // replay completes; horizon 1000 is remembered
    expect(await replayMarker(ITEMS)).toBe("h:1000");

    // A cloud transaction that began before the horizon is still open: the
    // oldest open one (1000 - 1) keeps rows around the horizon invisible.
    view = { visibleBelow: "999", horizon: "1010" };
    await pull(served);
    await pull(served);
    await expectXStillActive("a hidden row may still be in the cloud");
    expect(
      await replayMarker(ITEMS),
      "the marker keeps its original horizon while the transaction is open",
    ).toBe("h:1000");

    // The transaction ends: everything below the remembered horizon is visible.
    view = { visibleBelow: "1000", horizon: "1010" };
    await pull(served);

    await expectSoftRemoved(X, "X deactivated once the cloud proves absence");
    expect(await localItem(Y)).toMatchObject({ active: true, deleted: false });
    expect(await localItem(W)).toMatchObject({ active: true, deleted: false });
    expect(await replayMarker(ITEMS)).toBeNull();
  }, 120_000);
});

describe("7r7q6 R2: a second rewind restarts the confirmation", () => {
  it("marker h:H, then another rewind: the new replay replaces the old horizon, so a later page with H <= visibleBelow < new horizon deactivates nothing", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());
    let view: Visibility | null = SETTLED;
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => view),
    };

    await pull(served);
    expect(await replayMarker(ITEMS), "first replay remembers H").toBe(
      `h:${SETTLED.horizon}`,
    );

    // A second rewind (e.g. the cloud refused the cursor again); the cloud
    // moved on (horizon 1010) and a row committed above its oldest open
    // transaction (visibleBelow 1005) may still be hidden.
    await rewind(ITEMS);
    view = { visibleBelow: "1005", horizon: "1010" };
    const second = await pull(served);

    expect(second.streams[ITEMS]?.error, "second replay").toBeFalsy();
    await expectXStillActive("a replay pull never deactivates");
    // ASSUMPTION: per the header contract the last page of a replay moves the
    // marker "1" -> h:<its horizon>; the old h:1000 must be gone either way.
    expect(
      await replayMarker(ITEMS),
      "the old horizon h:1000 no longer counts",
    ).not.toBe(`h:${SETTLED.horizon}`);

    // Under the stale h:1000, visibleBelow 1005 would prove absence.
    await pull(served);
    await expectXStillActive(
      "visibleBelow 1005 is below the new replay's horizon 1010: absence is not proven",
    );

    // Recovery still works once the cloud shows everything below 1010.
    view = { visibleBelow: "1010", horizon: "1010" };
    await pull(served);
    await expectSoftRemoved(X, "X deactivated after a fresh confirmation");
    expect(await replayMarker(ITEMS)).toBeNull();
  }, 120_000);

  it("marker h:H, then another rewind with a settled last page: the pull itself still deactivates nothing", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());
    const view: Visibility = { visibleBelow: "1010", horizon: "1010" };
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => view),
    };

    await pull(served);
    await rewind(ITEMS);
    await pull(served);

    await expectXStillActive("every rewound pull is a first pull of a replay");
  }, 120_000);
});

describe("7r7q6 R2: the cloud sends visibleBelow/horizon only to clients that ask with protocolVersion", () => {
  const ask = async (withProtocol: boolean) =>
    (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: O1 as never,
      query: catalogSyncQuerySchema.parse({
        stream: CATEGORIES,
        limit: 100,
        ...(withProtocol ? { protocolVersion: CATALOG_PROTOCOL_VERSION } : {}),
      }),
    })) as unknown as Rec;

  it("a page requested without protocolVersion has no visibleBelow and no horizon", async () => {
    const page = await ask(false);
    expect(page).not.toHaveProperty("visibleBelow");
    expect(page).not.toHaveProperty("horizon");
  });

  it("a page requested with protocolVersion carries both as decimal strings", async () => {
    const page = await ask(true);
    expect(page.visibleBelow).toMatch(/^\d+$/);
    expect(page.horizon).toMatch(/^\d+$/);
  });
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
        ...SETTLED,
      } satisfies ScriptedPage & Visibility;
    };

    const result = await pull({ fetchPage });
    await pull({ fetchPage });

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
    expect(
      await replayMarker(ITEMS),
      "no replay was running, so no marker exists",
    ).toBeNull();
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
        ...SETTLED,
      } satisfies ScriptedPage & Visibility;
    };

    await pull({ fetchPage });

    expect(await localItem(X)).toMatchObject({ active: true, deleted: false });
  }, 120_000);

  it("a replay that did not finish (network error before the last page) deactivates nothing, even after more pulls", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const restored = cloudWith(restoredItems());
    // Page 1 (Y) arrives, page 2 (W) never does: X is absent from what the
    // edge has seen so far, but the snapshot is not complete.
    restored.breakAt(ITEMS, 2);
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => SETTLED),
    };

    await pull(served);
    await pull(served);

    expect(
      await localItem(X),
      "X stays active until a complete snapshot proves it is gone",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });
  }, 120_000);

  it("a rewound pull that stops at maxPages deactivates nothing until later pulls complete the snapshot and confirm it", async () => {
    await seedBeforeRestore();
    await rewind(ITEMS);
    const V = id();
    const restored = cloudWith([...restoredItems(), item(V, "Item V", 602)]);
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => SETTLED),
    };

    // Three pages of one item; the pull is allowed one page per stream.
    await pull(served, 1);
    expect(
      await localItem(X),
      "backlog: the snapshot is not complete yet, X stays active",
    ).toMatchObject({ name: "Item X", active: true, deleted: false });

    // Later pulls (no page limit) reach the last page; then one more confirms.
    for (let n = 0; n < 5 && !(await isSoftRemoved(X)); n += 1)
      await pull(served);

    expect(await localItem(V), "snapshot completed").toMatchObject({
      active: true,
    });
    await expectSoftRemoved(X, "X deactivated once the snapshot is confirmed");
  }, 120_000);
});

describe("7r7q6 B: a promotion missing from the restored cloud stops applying offline", () => {
  const SRC = id();
  const P = id(); // promotion deleted in the cloud after the backup
  const Q = id(); // promotion that survives the restore
  let template: Rec;

  const promoRecord = (rowId: string, name: string, txid: bigint): Rec => ({
    ...template,
    id: rowId,
    name,
    status: "active",
    syncTxid: String(txid),
  });
  const localPromo = async (rowId: string) =>
    (
      await edge.rows(
        `SELECT name, status, starts_at, ends_at FROM promotions WHERE id = $1`,
        [rowId],
      )
    )[0] as
      | { name: string; status: string; starts_at: Date; ends_at: Date | null }
      | undefined;
  /** Why the promotion does not apply now (null = it applies). */
  const availability = async (rowId: string) => {
    const row = await localPromo(rowId);
    expect(row, "promotion row exists (never DELETE)").toBeDefined();
    return promotionAvailability(
      {
        status: row!.status as never,
        startsAt: row!.starts_at.toISOString() as never,
        endsAt: row!.ends_at ? (row!.ends_at.toISOString() as never) : null,
      },
      new Date().toISOString() as never,
    );
  };

  beforeAll(async () => {
    await q(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, voucher_required, starts_at,
          ends_at, conditions, benefit, stack_group, stackable, priority)
       VALUES ($1,$2,'Sumber promo keanggotaan','','active',false,'2026-01-01T00:00:00Z',
               '2099-01-01T00:00:00Z',$3,$4,'membershipsrc',false,0)`,
      [
        SRC,
        tenantId,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [id()], minQuantity: 1 },
        ]),
        JSON.stringify({ kind: "nominal_off", amountIdr: 1000 }),
      ],
    );
    await settleCloud(mainOwner);
    let found: Rec | undefined;
    let since: string | undefined;
    for (let n = 0; n < 2000 && !found; n += 1) {
      const page = (await listCatalogRecordsSince(db, {
        tenantId: tenantId as never,
        outletId: O1 as never,
        query: catalogSyncQuerySchema.parse({
          stream: PROMOS,
          limit: 100,
          ...(since === undefined ? {} : { since }),
        }),
      })) as unknown as ScriptedPage;
      found = page.records.find((r) => r.id === SRC);
      if (!page.hasMore || !page.nextCursor) break;
      since = page.nextCursor;
    }
    expect(found, "template promotion exported by the cloud").toBeTruthy();
    template = found!;
  }, 120_000);

  beforeEach(async () => {
    const client = await edge.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM promotion_outlets");
      await client.query("DELETE FROM promotions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await q("DELETE FROM promotions WHERE id = $1", [SRC]).catch(
      () => undefined,
    );
  });

  it("after the restore pulls, P is no longer applicable but still exists; Q keeps applying", async () => {
    const base = BigInt(String(template.syncTxid));
    const before = scriptedCatalogCloud(
      {
        [PROMOS]: [
          promoRecord(P, "Promo P", base + 10n),
          promoRecord(Q, "Promo Q", base + 11n),
        ],
      },
      1,
    );
    const seeded = await pull(before, undefined, [PROMOS]);
    expect(seeded.streams[PROMOS]?.error, "seed pull").toBeFalsy();
    expect(await availability(P), "seed: P applies").toBeNull();
    expect(await availability(Q), "seed: Q applies").toBeNull();

    await rewind(PROMOS);
    // Restored cloud: P is gone, Q is back restamped higher.
    const restored = scriptedCatalogCloud(
      { [PROMOS]: [promoRecord(Q, "Promo Q setelah restore", base + 500n)] },
      1,
    );
    const served = {
      fetchPage: withVisibility(restored.fetchPage, () => SETTLED),
    };

    await pull(served, undefined, [PROMOS]);
    expect(
      await availability(P),
      "pull 1 alone deactivates nothing",
    ).toBeNull();
    await pull(served, undefined, [PROMOS]);

    expect(
      await availability(P),
      "P must not give discounts offline any more",
    ).not.toBeNull();
    expect(await localPromo(P), "P is kept, not deleted").toBeDefined();
    expect(await localPromo(Q)).toMatchObject({
      name: "Promo Q setelah restore",
      status: "active",
    });
    expect(await availability(Q), "Q still applies").toBeNull();
  }, 120_000);

  describe("1199 P2-B: automatic promos stay off while the replay marker exists", () => {
    const checkpointAge = async () =>
      (
        await edge.rows(
          "SELECT last_success_at AS at FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
          [node.id, `catalog:${PROMOS}`],
        )
      )[0]?.at as Date | undefined;

    beforeEach(() => {
      // Edge process whose 24 h freshness provider says fresh: only the
      // catalog stream state can close the gate here.
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
    });
    afterAll(() => {
      installPromoFreshnessProvider(null);
      setPromoGateEdgeModeForTests(null);
    });

    it("off from the restore replay until the deactivation commits, then Q applies again", async () => {
      const base = BigInt(String(template.syncTxid));
      const seeded = await pull(
        scriptedCatalogCloud(
          {
            [PROMOS]: [
              promoRecord(P, "Promo P", base + 10n),
              promoRecord(Q, "Promo Q", base + 11n),
            ],
          },
          1,
        ),
        undefined,
        [PROMOS],
      );
      expect(seeded.streams[PROMOS]?.error, "seed pull").toBeFalsy();
      expect(promosEnabled(), "seed: promos on").toBe(true);

      await rewind(PROMOS);
      const served = {
        fetchPage: withVisibility(
          scriptedCatalogCloud(
            {
              [PROMOS]: [promoRecord(Q, "Promo Q na restore", base + 500n)],
            },
            1,
          ).fetchPage,
          () => SETTLED,
        ),
      };

      await pull(served, undefined, [PROMOS]);
      expect(await replayMarker(PROMOS), "replay pinned").toBe("h:1000");
      expect(
        promosEnabled(),
        "replay marker exists: P may still be on this edge, promos stay off",
      ).toBe(false);
      expect(
        (await checkpointAge())?.getTime(),
        "freshness of the stream is closed durably (survives a restart)",
      ).toBe(0);

      await pull(served, undefined, [PROMOS]);
      expect(await replayMarker(PROMOS), "deactivation committed").toBeNull();
      expect(await availability(P), "P is off").not.toBeNull();
      expect(promosEnabled(), "marker gone: promos on again").toBe(true);
      expect(
        (await checkpointAge())?.getTime(),
        "freshness reopened",
      ).toBeGreaterThan(0);
      expect(await availability(Q), "Q applies again").toBeNull();
    }, 120_000);

    it("an older cloud without visibility fields never ends the replay: promos stay off", async () => {
      const base = BigInt(String(template.syncTxid));
      await pull(
        scriptedCatalogCloud(
          { [PROMOS]: [promoRecord(P, "Promo P", base + 10n)] },
          1,
        ),
        undefined,
        [PROMOS],
      );
      await rewind(PROMOS);
      const old = scriptedCatalogCloud(
        { [PROMOS]: [promoRecord(Q, "Promo Q", base + 500n)] },
        1,
      );
      for (let n = 0; n < 3; n += 1) await pull(old, undefined, [PROMOS]);

      expect(await replayMarker(PROMOS)).not.toBeNull();
      expect(promosEnabled(), "fail closed until a deactivation commits").toBe(
        false,
      );
    }, 120_000);
  });

  it("without the cloud's visibility fields P keeps applying (never inferred from an older cloud)", async () => {
    const base = BigInt(String(template.syncTxid));
    const before = scriptedCatalogCloud(
      { [PROMOS]: [promoRecord(P, "Promo P", base + 10n)] },
      1,
    );
    await pull(before, undefined, [PROMOS]);
    await rewind(PROMOS);
    const restored = scriptedCatalogCloud(
      { [PROMOS]: [promoRecord(Q, "Promo Q", base + 500n)] },
      1,
    );

    await pull(restored, undefined, [PROMOS]);
    await pull(restored, undefined, [PROMOS]);
    await pull(restored, undefined, [PROMOS]);

    expect(await availability(P)).toBeNull();
  }, 120_000);
});
