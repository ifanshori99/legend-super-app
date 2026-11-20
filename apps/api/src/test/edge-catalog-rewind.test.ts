// Catalog pull: a REWIND after a rejected cursor (bead legend-24318 follow-up;
// design docs/briefs/24318-design.md "Desain sync_txid"; companion to
// edge-catalog-followups.test.ts "thhg9"). Written from the design, the shared
// contract and the way sibling tests simulate a cloud HTTP 400
// (`EdgeCloudHttpError("HTTP_400")`), not from the puller implementation.
// Fail-first: this behavior is missing today.
//
// Scenario: the edge stored checkpoint `cat2` txid 500 (and rows with local
// sync_txid 500). The cloud then refuses that cursor with HTTP 400 (for
// example the cloud database was restored, so its txids are LOWER now). The
// edge pulls again from the beginning and ends at `cat2` txid 10.
//   - The checkpoint must become the `cat2:10` cursor. The "cursor only rises"
//     guard (thhg9) must not block a rewind that follows a rejection.
//   - The next pull must not hit a 400 again (it uses the new cursor).
//   - The local `sync_txid` of the rows is reset too: a cloud row with txid 10
//     must replace the local copy whose txid is 500 (otherwise "replace only
//     when incoming is strictly greater" silently skips every row).
//
// Assumptions (the design is silent), each easy to change:
//  - Recovery may happen inside the same pull call or on the very next pull;
//    the tests run at most two pulls before asserting.
//  - A rewind keeps local rows it does not receive again (no hard delete); the
//    empty-cloud case therefore only asserts the checkpoint and the absence of
//    a second 400, not the fate of local rows.
//  - After a rejection plus an empty full pull the stale cursor must not
//    survive. Whether the checkpoint row is deleted or set to null is not
//    asserted.
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
import { CATALOG_CURSOR_REJECTED_MARKER } from "../edge/catalog-cursor-marker.ts";
import { EdgeCloudHttpError } from "../edge/cloud-http.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { catCursor, settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Rec = Record<string, unknown>;
type Page = {
  protocolVersion: number;
  stream: string;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};
type FetchPage = (stream: string, since: string | null) => Promise<unknown>;
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();
const STREAM = "menu_categories";
const CHECKPOINT = `catalog:${STREAM}`;

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
let template: Rec;
const catId = id();

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function pull(cloud: { fetchPage: FetchPage }) {
  try {
    return (await pullCatalog({
      database: edge.database,
      context: scopeOf("device", O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
    } as never)) as PullResult;
  } catch (error) {
    return error as Error;
  }
}
async function pullOk(cloud: { fetchPage: FetchPage }): Promise<PullResult> {
  const result = await pull(cloud);
  expect(result).not.toBeInstanceOf(Error);
  return result as PullResult;
}

const checkpoint = async (): Promise<string | null | undefined> =>
  (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, CHECKPOINT],
    )
  )[0]?.watermark as string | null | undefined;

const localRow = async (rowId: string) =>
  (
    await edge.rows(
      "SELECT name, sync_txid::text AS txid FROM menu_categories WHERE id = $1",
      [rowId],
    )
  )[0] as { name: string; txid: string } | undefined;

/** A category shaped like the cloud's, with the given id, name and txid. */
const category = (rowId: string, name: string, txid: number): Rec => ({
  ...template,
  id: rowId,
  name,
  parentId: null,
  syncTxid: String(txid),
});

async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
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

/**
 * A cloud with a "before" state (txid 500, what the edge stored) and an
 * "after" state (a restored cloud, lower txids). It refuses the old cursor
 * with HTTP 400 and counts every refusal and every request.
 */
function restoredCloud(opts: {
  oldCursor: string;
  after: Rec[];
  newCursor: string | null;
}) {
  const asked: (string | null)[] = [];
  let rejections = 0;
  const fetchPage = async (
    stream: string,
    since: string | null,
  ): Promise<Page> => {
    if (stream !== STREAM)
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [],
        nextCursor: since,
        hasMore: false,
      };
    asked.push(since);
    if (since === opts.oldCursor) {
      rejections += 1;
      // legend-75kly: the cloud marks a rejected cursor; an unmarked 400 no longer resets the checkpoint.
      throw new EdgeCloudHttpError("HTTP_400", CATALOG_CURSOR_REJECTED_MARKER);
    }
    if (since === null)
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: opts.after,
        nextCursor: opts.newCursor,
        hasMore: false,
      };
    if (since === opts.newCursor)
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [],
        nextCursor: since,
        hasMore: false,
      };
    throw new Error(`unexpected cursor ${since}`);
  };
  return { fetchPage, asked, rejections: () => rejections };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji rewind katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori rewind',0)`,
    [catId, tenantId, brandId],
  );
  await settleCloud(mainOwner);
  // Walk every page the way an edge would: other tests leave categories under
  // this brand, so ours is not necessarily on the first page.
  let found: Rec | undefined;
  let since: string | undefined;
  for (let n = 0; n < 2000 && !found; n += 1) {
    const page = (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: O1 as never,
      query: catalogSyncQuerySchema.parse({
        stream: STREAM,
        limit: 100,
        ...(since === undefined ? {} : { since }),
      }),
    })) as unknown as Page;
    found = page.records.find((r) => r.id === catId);
    if (!page.hasMore || !page.nextCursor) break;
    since = page.nextCursor;
  }
  expect(found, "template category exported by the cloud").toBeTruthy();
  template = found!;

  const registered = await registerEdgeNode(scopeOf("session", O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji rewind katalog",
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

/** Stores checkpoint cat2:500 and one local row with sync_txid 500. */
async function seedHighCheckpoint(rowId: string) {
  const oldCursor = catCursor(500, STREAM, rowId);
  await pullOk({
    fetchPage: async (stream, since) =>
      stream === STREAM
        ? ({
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            stream,
            records: [category(rowId, "Nama lama", 500)],
            nextCursor: oldCursor,
            hasMore: false,
          } satisfies Page)
        : ({
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            stream,
            records: [],
            nextCursor: since,
            hasMore: false,
          } satisfies Page),
  });
  expect(await checkpoint(), "seed: stored checkpoint").toBe(oldCursor);
  expect((await localRow(rowId))?.txid, "seed: local sync_txid").toBe("500");
  return oldCursor;
}

describe("24318-rewind a rejected cursor lets a full pull lower the checkpoint", () => {
  it("rewind: the checkpoint becomes cat2:10, the next pull does not hit a 400 again, and the local sync_txid is reset so the txid-10 row replaces the txid-500 copy", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const newCursor = catCursor(10, STREAM, rowId);
    const cloud = restoredCloud({
      oldCursor,
      after: [category(rowId, "Nama setelah restore", 10)],
      newCursor,
    });

    // Recovery may need a second pull (assumption above): at most two.
    await pull(cloud);
    if ((await checkpoint()) === oldCursor) await pull(cloud);

    expect(await checkpoint(), "the rewind overwrote the monotonic guard").toBe(
      newCursor,
    );
    expect(cloud.rejections(), "the old cursor was refused once").toBe(1);
    expect(cloud.asked, "a full pull from the start happened").toContain(null);

    expect(
      await localRow(rowId),
      "the txid-10 cloud row was applied over the txid-500 local copy",
    ).toEqual({ name: "Nama setelah restore", txid: "10" });

    // Steady state: the next pull uses the new cursor and is not refused.
    const before = cloud.rejections();
    const next = await pullOk(cloud);
    expect(next.streams[STREAM]?.error).toBeFalsy();
    expect(cloud.rejections(), "no second 400").toBe(before);
    expect(cloud.asked.at(-1)).toBe(newCursor);
    expect(await checkpoint()).toBe(newCursor);
  }, 60_000);

  it("rewind: a row first seen only after the rewind (txid 10) and the row already stored (txid 500) both end up with the cloud's values", async () => {
    const keep = id();
    const fresh = id();
    const oldCursor = await seedHighCheckpoint(keep);
    // Keys sort by id: the cursor after the page is the last record's key.
    const last = [keep, fresh].sort().at(-1)!;
    const cloud = restoredCloud({
      oldCursor,
      after: [
        category(keep, "Tetap setelah restore", 10),
        category(fresh, "Baru setelah restore", 10),
      ],
      newCursor: catCursor(10, STREAM, last),
    });

    await pull(cloud);
    if ((await checkpoint()) === oldCursor) await pull(cloud);

    expect(await localRow(keep)).toEqual({
      name: "Tetap setelah restore",
      txid: "10",
    });
    expect(await localRow(fresh)).toEqual({
      name: "Baru setelah restore",
      txid: "10",
    });
    expect(await checkpoint()).toBe(catCursor(10, STREAM, last));
  }, 60_000);

  it("empty cloud after the rejection: the stale cat2:500 checkpoint does not survive and the next pull is not refused again", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    // The restored cloud has no rows for this stream: an empty full pull.
    const cloud = restoredCloud({ oldCursor, after: [], newCursor: null });

    await pull(cloud);
    if ((await checkpoint()) === oldCursor) await pull(cloud);

    expect(await checkpoint(), "the refused cursor must not be kept").not.toBe(
      oldCursor,
    );
    expect(cloud.rejections(), "the old cursor was refused once").toBe(1);

    const before = cloud.rejections();
    const next = await pullOk(cloud);
    expect(next.streams[STREAM]?.error).toBeFalsy();
    expect(cloud.rejections(), "no second 400").toBe(before);
    expect(cloud.asked.at(-1), "the next pull starts from the beginning").toBe(
      null,
    );
  }, 60_000);
});
