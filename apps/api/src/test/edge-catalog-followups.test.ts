// Catalog pull follow-ups (beads legend-thhg9 and legend-dciax; design
// docs/briefs/24318-design.md "Desain sync_txid"; brief card 3 and card 2).
// Written from the design and the shared contract (`packages/shared/src/edge/
// catalog-sync.ts`), not from the implementation. Fail-first: both groups
// describe behavior that is missing today.
//
// Setup mirrors edge-catalog-txid.test.ts: the main test database is the CLOUD
// (only used to export one real category record as a template), a second one
// (helpers/edge-database.ts) is the EDGE. The cloud HTTP layer is a scripted
// `fetchPage`.
//
// thhg9: a late (slower) pull must never move a stored checkpoint BACKWARDS.
//   The checkpoint cursor only rises (compared by the numeric `syncTxid`, not
//   as text: "20" sorts after "100" as a string).
// dciax: an edge talking to an older cloud that does not send `syncTxid` must
//   refuse the page with a clear message, not fail on a parse.
//
// Assumptions (the design is silent), each easy to change:
//  - "Refuses cleanly" means: the stream reports an error (or the pull rejects)
//    whose text names `syncTxid` and the cloud, is not a raw schema/parse error,
//    nothing of the page is stored and the stream's checkpoint does not move.
//    Whether the error is a stream result or a thrown error is not asserted.
//  - Two pulls may run at the same time (the design's "dua pull paralel" in
//    finding 2 says they can). If the implementation serialises them, the late
//    save cannot happen and the thhg9 race test passes for that reason; the
//    sequential monotonic test below still guards the SQL rule.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
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
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  catCursor,
  scriptedCatalogCloud,
  settleCloud,
} from "./helpers/catalog-cloud.ts";
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

const checkpoint = async (): Promise<string | undefined> =>
  (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, CHECKPOINT],
    )
  )[0]?.watermark as string | undefined;

const edgeCategoryIds = async (ids: string[]) =>
  (
    await edge.rows(
      "SELECT id FROM menu_categories WHERE id = ANY($1::uuid[]) ORDER BY id",
      [ids],
    )
  )
    .map((r) => String(r.id))
    .sort();

/** New category records shaped like the cloud's, with the given txids. */
const records = (txids: bigint[]): Rec[] =>
  txids.map((txid, n) => ({
    ...template,
    id: id(),
    name: `Kategori ${txid} ${n}`,
    parentId: null,
    syncTxid: String(txid),
  }));

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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji follow-up katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori follow-up',0)`,
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
    label: "Mini PC uji follow-up katalog",
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

// ------------------------------------------------------------------- thhg9

describe("thhg9 a late checkpoint never lowers the cursor (it only rises)", () => {
  it("a slow pull that finishes after a faster one does not overwrite the newer checkpoint with its older page cursor", async () => {
    const base = BigInt(String(template.syncTxid)) + 100n;
    const recs = records([base, base + 1n, base + 2n]);
    const cloud = scriptedCatalogCloud({ [STREAM]: recs }, 1);

    // A first pull stops after page 1: the checkpoint is page 1 (position 1).
    cloud.breakAt(STREAM, 2);
    await pullOk(cloud);
    expect(await checkpoint()).toBe(cloud.cursorAfter(STREAM, 1));
    cloud.heal();

    // Pull A resumes from page 1 but is held back while it waits for page 2;
    // it is cut after that page, so its only checkpoint save is "position 2".
    let aWaiting = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aCalls = 0;
    const slow = {
      fetchPage: async (stream: string, since: string | null) => {
        if (stream !== STREAM) return cloud.fetchPage(stream, since);
        aCalls += 1;
        if (aCalls === 1) {
          aWaiting = true;
          await gate;
          return cloud.fetchPage(stream, since);
        }
        throw new Error("jaringan putus (tarikan A)");
      },
    };
    // Safety net, only used if pulls are serialised by the implementation.
    const fallback = setTimeout(() => release(), 8_000);
    const a = pull(slow);
    while (!aWaiting) await new Promise((r) => setTimeout(r, 10));

    // Pull B runs to the end meanwhile: checkpoint = position 3.
    await pullOk(cloud);
    release();
    await a;
    clearTimeout(fallback);

    expect(await checkpoint()).toBe(cloud.cursorAfter(STREAM, 3));
    expect(
      await edgeCategoryIds(recs.map((r) => String(r.id))),
      "all three categories are on the edge",
    ).toHaveLength(3);
  }, 60_000);

  it("a pull that reports a cursor older than the stored one keeps the stored checkpoint; a newer one still moves it up (numeric order: 20 is below 100)", async () => {
    const key = id();
    const base = BigInt(String(template.syncTxid)) + 1_000n;
    // Pull n answers with exactly one page: one new category and a cursor.
    const answers = [100n, 20n, 300n].map((txid, n) => {
      const [rec] = records([base + txid]);
      return {
        rec: rec!,
        cursor: catCursor(txid, STREAM, key, String(n)),
      };
    });
    let n = 0;
    const cloud = {
      fetchPage: async (
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
        const answer = answers[n]!;
        n += 1;
        return {
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream,
          records: [answer.rec],
          nextCursor: answer.cursor,
          hasMore: false,
        };
      },
    };

    await pullOk(cloud);
    expect(await checkpoint()).toBe(answers[0]!.cursor);
    expect(decodeCursor(String(await checkpoint()))[1]).toBe("100");

    await pullOk(cloud);
    // The older cursor (txid 20) must not replace txid 100.
    expect(await checkpoint()).toBe(answers[0]!.cursor);

    await pullOk(cloud);
    expect(await checkpoint()).toBe(answers[2]!.cursor);
  });
});

// ------------------------------------------------------------------- dciax

/** Readable text of whatever a pull reports as a failure. */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}

describe("dciax an edge refuses a cloud that does not send syncTxid", () => {
  it("records without syncTxid are refused with a message that names syncTxid and the cloud, nothing is stored and the checkpoint stays", async () => {
    const withTxid = records([BigInt(String(template.syncTxid)) + 1n]);
    const old = withTxid.map((rec) => {
      const { syncTxid: _syncTxid, ...rest } = rec;
      void _syncTxid;
      return rest;
    });
    const cloud = scriptedCatalogCloud({ [STREAM]: old }, 100);

    const result = await pull(cloud);
    const text =
      result instanceof Error
        ? errorText(result)
        : errorText(result.streams[STREAM]?.error);
    expect(text, "the refusal is reported").not.toBe("undefined");
    expect(text).toMatch(/syncTxid/);
    expect(text).toMatch(/cloud/i);
    // A clear message, not a raw schema failure.
    expect(text).not.toMatch(/ZodError|invalid_type|Invalid input|undefined/);

    expect(await edgeCategoryIds(old.map((r) => String(r.id)))).toEqual([]);
    expect(await checkpoint()).toBeUndefined();
  });

  it("a page where only one record lacks syncTxid is refused as a whole (no half-applied page)", async () => {
    const [good, bad] = records([
      BigInt(String(template.syncTxid)) + 1n,
      BigInt(String(template.syncTxid)) + 2n,
    ]);
    const { syncTxid: _drop, ...noTxid } = bad!;
    void _drop;
    const cloud = scriptedCatalogCloud({ [STREAM]: [good!, noTxid] }, 100);

    const result = await pull(cloud);
    const text =
      result instanceof Error
        ? errorText(result)
        : errorText(result.streams[STREAM]?.error);
    expect(text).toMatch(/syncTxid/);
    expect(
      await edgeCategoryIds([String(good!.id), String(noTxid.id)]),
    ).toEqual([]);
    expect(await checkpoint()).toBeUndefined();
  });

  it("a cloud that does send syncTxid is still accepted (control)", async () => {
    const recs = records([BigInt(String(template.syncTxid)) + 1n]);
    const cloud = scriptedCatalogCloud({ [STREAM]: recs }, 100);
    const result = await pullOk(cloud);
    expect(result.streams[STREAM]?.error).toBeFalsy();
    expect(await edgeCategoryIds([String(recs[0]!.id)])).toHaveLength(1);
    expect(await checkpoint()).toBeTruthy();
  });
});
