// Explicit catalog protocol version on every response (bead legend-2dlxq, brief
// docs/briefs/ecf-482.md card 2). Written from the brief and the shared contract
// (`packages/shared/src/edge/catalog-sync.ts`), not from the implementation.
// Fail-first: the version stamp does not exist yet.
//
// A private database created before app imports is the CLOUD (it exports one
// real category record as a template and serves
// the cloud-side response), a second database (helpers/edge-database.ts) is the
// EDGE, and the cloud HTTP layer is a scripted `fetchPage`.
//
// API (names chosen by the implementer, see docs/briefs/ecf-482-tests.md):
//  - `CATALOG_PROTOCOL_VERSION` (3) and `CATALOG_PROTOCOL_MIN_VERSION` (3),
//    exported by `@starter/shared/edge`. "Older" = that version minus 1;
//    "newer" = plus 1 (an edge that is too old: CATALOG_EDGE_OUTDATED).
//  - every catalog page carries the top-level field `protocolVersion` (number),
//    also an empty page `{ records: [], nextCursor, hasMore: false }`.
//  - an edge that gets a page with a lower version, or none, refuses it with an
//    error carrying the code CATALOG_CLOUD_OUTDATED BEFORE storing anything or
//    moving the checkpoint (the legend-dciax guard for a missing syncTxid
//    already uses the same code; the version check must also run on empty
//    pages, where there are no records to notice an old cloud by).
//
// Assumptions (the brief is silent), each easy to change:
//  - A refusal may be a thrown error or a stream error result; both are read
//    through `errorText`, which includes `name`, `code` and `message`.
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
  CATALOG_PROTOCOL_MIN_VERSION,
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { db, pool } from "../db/index.ts";
import { pullCatalog } from "./catalog-puller.ts";
import { EdgeCloudHttpError } from "./cloud-http.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  listCatalogRecordsSince,
  negotiateCatalogProtocolVersion,
} from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { catCursor, settleCloud } from "../test/helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "../test/helpers/edge-database.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } =
    await import("../test/helpers/catalog-database.ts");
  return createCatalogCloud();
});

type Rec = Record<string, unknown>;
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();
const STREAM = "menu_categories";
const CHECKPOINT = `catalog:${STREAM}`;

const VERSION = CATALOG_PROTOCOL_VERSION;
const OLD_VERSION = CATALOG_PROTOCOL_MIN_VERSION - 1;
const NEWER_VERSION = CATALOG_PROTOCOL_VERSION + 1;

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
let lastCloudCursor: string | undefined;
const catId = id();

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** A scripted cloud answering every request with one fixed page. */
function cloudAnswering(page: Rec) {
  const calls: Array<{ stream: string; since: string | null }> = [];
  return {
    calls,
    fetchPage: async (stream: string, since: string | null) => {
      calls.push({ stream, since });
      if (stream === STREAM) return { stream, ...page };
      // Every other stream: an empty page from the same cloud (same version).
      return {
        stream,
        records: [],
        nextCursor: null,
        hasMore: false,
        ...("protocolVersion" in page
          ? { protocolVersion: page.protocolVersion }
          : {}),
      };
    },
  };
}

async function pull(cloud: {
  fetchPage: (stream: string, since: string | null) => Promise<unknown>;
}) {
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

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name} ${String(code ?? "")} ${error.message}`;
  }
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}
// Text of every failure the pull reports (any stream), so the test does not
// depend on which stream notices the old cloud first.
const refusal = (result: PullResult | Error): string =>
  result instanceof Error
    ? errorText(result)
    : Object.values(result.streams)
        .filter((s) => s?.error)
        .map((s) => errorText(s?.error))
        .join(" | ");

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

const newCategory = (txid: bigint): Rec => ({
  ...template,
  id: id(),
  name: `Kategori versi ${txid}`,
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

// A new edge asks for the version (`protocolVersion` query parameter); an older
// edge does not and must get pages without the field (its page schema is strict).
const cloudQuery = (
  since?: string,
  edgeAsksVersion: boolean | number = true,
) => ({
  tenantId: tenantId as never,
  outletId: O1 as never,
  query: catalogSyncQuerySchema.parse({
    stream: STREAM,
    limit: 100,
    ...(since === undefined ? {} : { since }),
    ...(edgeAsksVersion
      ? {
          protocolVersion:
            typeof edgeAsksVersion === "number" ? edgeAsksVersion : VERSION,
        }
      : {}),
  }),
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji versi protokol katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori versi protokol',0)`,
    [catId, tenantId, brandId],
  );
  await settleCloud(mainOwner);
  // Walk every page the way an edge would; remember the last cursor so a test
  // can ask the cloud for the (empty) page after the end.
  let found: Rec | undefined;
  let since: string | undefined;
  for (let n = 0; n < 2000; n += 1) {
    const page = (await listCatalogRecordsSince(
      db,
      cloudQuery(since),
    )) as unknown as {
      records: Rec[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    found = found ?? page.records.find((r) => r.id === catId);
    if (page.nextCursor) lastCloudCursor = page.nextCursor;
    if (!page.hasMore || !page.nextCursor) break;
    since = page.nextCursor;
  }
  expect(found, "template category exported by the cloud").toBeTruthy();
  template = found!;

  const registered = await registerEdgeNode(scopeOf("session", O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji versi protokol katalog",
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
  await pool.end();
  await cloud.cleanup();
});

it("owns a separate cloud database for this catalog suite", async () => {
  const result = await mainOwner.query("SELECT current_database() AS name");
  const appResult = await pool.query("SELECT current_database() AS name");
  expect(result.rows[0].name).toBe(cloud.name);
  expect(appResult.rows[0].name).toBe(cloud.name);
  expect(`/${cloud.name}`).not.toBe(cloud.parentDatabaseName);
});

describe("legend-2dlxq the shared contract names the protocol version", () => {
  it("exports the current and the minimum protocol version as positive integers, minimum not above current", () => {
    expect(Number.isInteger(VERSION)).toBe(true);
    expect(VERSION).toBeGreaterThanOrEqual(1);
    expect(CATALOG_PROTOCOL_MIN_VERSION).toBeGreaterThanOrEqual(1);
    expect(CATALOG_PROTOCOL_MIN_VERSION).toBeLessThanOrEqual(VERSION);
  });
});

describe("legend-2dlxq the cloud stamps the version on every response", () => {
  it("a page with records carries protocolVersion", async () => {
    const page = (await listCatalogRecordsSince(
      db,
      cloudQuery(),
    )) as unknown as Rec;
    expect(page.protocolVersion).toBe(VERSION);
  });

  it("an empty page (cursor past the end) carries protocolVersion too", async () => {
    expect(lastCloudCursor).toBeTruthy();
    const page = (await listCatalogRecordsSince(
      db,
      cloudQuery(lastCloudCursor),
    )) as unknown as Rec;
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.protocolVersion).toBe(VERSION);
  });

  it("answers with the lower of the requested and its own version", async () => {
    // A newer edge (asks for v+1) gets this cloud's version, never a higher one.
    const newer = (await listCatalogRecordsSince(
      db,
      cloudQuery(undefined, VERSION + 1),
    )) as unknown as Rec;
    expect(newer.protocolVersion).toBe(VERSION);
    // An edge that only understands an older version is answered with that one
    // (it then refuses or reads it by its own rules).
    const older = (await listCatalogRecordsSince(
      db,
      cloudQuery(undefined, VERSION - 1),
    )) as unknown as Rec;
    expect(older.protocolVersion).toBe(VERSION - 1);
    expect(negotiateCatalogProtocolVersion(VERSION)).toBe(VERSION);
    expect(negotiateCatalogProtocolVersion(VERSION + 5)).toBe(VERSION);
  });

  it("an older edge (no protocolVersion in the request) gets pages without the field", async () => {
    const page = (await listCatalogRecordsSince(
      db,
      cloudQuery(undefined, false),
    )) as unknown as Rec;
    expect(page).not.toHaveProperty("protocolVersion");
    const empty = (await listCatalogRecordsSince(
      db,
      cloudQuery(lastCloudCursor, false),
    )) as unknown as Rec;
    expect(empty.records).toEqual([]);
    expect(empty).not.toHaveProperty("protocolVersion");
  });
});

describe("legend-2dlxq the edge refuses an older cloud before the checkpoint moves", () => {
  it("a page with an OLDER protocolVersion is refused with CATALOG_CLOUD_OUTDATED, nothing stored, checkpoint unchanged", async () => {
    const rec = newCategory(BigInt(String(template.syncTxid)) + 1n);
    const cloud = cloudAnswering({
      records: [rec],
      nextCursor: catCursor(1, STREAM),
      hasMore: false,
      protocolVersion: OLD_VERSION,
    });
    const result = await pull(cloud);
    expect(refusal(result)).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(await edgeCategoryIds([String(rec.id)])).toEqual([]);
    expect(await checkpoint()).toBeUndefined();
  });

  it("a cloud that rejects the protocolVersion parameter (HTTP 400 without a cursor) is reported as CATALOG_CLOUD_OUTDATED", async () => {
    const calls: Array<string | null> = [];
    const result = await pull({
      fetchPage: async (_stream: string, since: string | null) => {
        calls.push(since);
        throw new EdgeCloudHttpError("HTTP_400");
      },
    });
    expect(refusal(result)).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(refusal(result)).not.toMatch(/HTTP_400/);
    expect(await checkpoint()).toBeUndefined();
  });

  it("an EMPTY page without protocolVersion is refused and its cursor is not stored", async () => {
    const cloud = cloudAnswering({
      records: [],
      nextCursor: catCursor(7, STREAM),
      hasMore: false,
    });
    const result = await pull(cloud);
    expect(refusal(result)).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(await checkpoint()).toBeUndefined();
  });

  it("an EMPTY page with an OLDER protocolVersion is refused and its cursor is not stored", async () => {
    const cloud = cloudAnswering({
      records: [],
      nextCursor: catCursor(7, STREAM),
      hasMore: false,
      protocolVersion: OLD_VERSION,
    });
    const result = await pull(cloud);
    expect(refusal(result)).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(await checkpoint()).toBeUndefined();
  });

  it("an existing checkpoint stays exactly where it was when a later page is refused", async () => {
    const first = newCategory(BigInt(String(template.syncTxid)) + 1n);
    const good = cloudAnswering({
      records: [first],
      nextCursor: catCursor(1, STREAM),
      hasMore: false,
      protocolVersion: VERSION,
    });
    const ok = await pull(good);
    expect(ok).not.toBeInstanceOf(Error);
    expect((ok as PullResult).streams[STREAM]?.error).toBeFalsy();
    const before = await checkpoint();
    expect(before).toBeTruthy();

    const oldCloud = cloudAnswering({
      records: [],
      nextCursor: catCursor(99, STREAM),
      hasMore: false,
      protocolVersion: OLD_VERSION,
    });
    const result = await pull(oldCloud);
    expect(refusal(result)).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(await checkpoint()).toBe(before);
  });

  it("a page from a NEWER cloud than the edge understands is refused with CATALOG_EDGE_OUTDATED, nothing stored", async () => {
    const rec = newCategory(BigInt(String(template.syncTxid)) + 1n);
    const cloud = cloudAnswering({
      records: [rec],
      nextCursor: catCursor(1, STREAM),
      hasMore: false,
      protocolVersion: NEWER_VERSION,
    });
    const result = await pull(cloud);
    const text = refusal(result);
    expect(text).toMatch(/CATALOG_EDGE_OUTDATED/);
    expect(text).not.toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(await edgeCategoryIds([String(rec.id)])).toEqual([]);
    expect(await checkpoint()).toBeUndefined();
  });

  it("the refusal is a clear error, not a raw schema failure", async () => {
    const cloud = cloudAnswering({
      records: [],
      nextCursor: null,
      hasMore: false,
    });
    const text = refusal(await pull(cloud));
    expect(text).toMatch(/CATALOG_CLOUD_OUTDATED/);
    expect(text).not.toMatch(/ZodError|invalid_type|Invalid input/);
  });

  it("control: an empty page with the current protocolVersion is accepted", async () => {
    const cloud = cloudAnswering({
      records: [],
      nextCursor: null,
      hasMore: false,
      protocolVersion: VERSION,
    });
    const result = await pull(cloud);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as PullResult).streams[STREAM]?.error).toBeFalsy();
  });

  it("the stream result carries lastSuccessAt, equal to the stored checkpoint's last_success_at", async () => {
    const cloud = cloudAnswering({
      records: [],
      nextCursor: null,
      hasMore: false,
      protocolVersion: VERSION,
    });
    const result = (await pull(cloud)) as PullResult;
    const reported = (result.streams[STREAM] as { lastSuccessAt?: Date })
      .lastSuccessAt;
    const stored = await edge.rows(
      "SELECT last_success_at FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = $2",
      [node.id, CHECKPOINT],
    );
    expect(reported).toBeInstanceOf(Date);
    expect(stored).toHaveLength(1);
    expect((stored[0]!.last_success_at as Date).getTime()).toBe(
      reported!.getTime(),
    );
  });

  it("control: a page with records and the current protocolVersion is stored and the checkpoint moves", async () => {
    const rec = newCategory(BigInt(String(template.syncTxid)) + 1n);
    const cloud = cloudAnswering({
      records: [rec],
      nextCursor: catCursor(1, STREAM),
      hasMore: false,
      protocolVersion: VERSION,
    });
    const result = await pull(cloud);
    expect(result).not.toBeInstanceOf(Error);
    expect(await edgeCategoryIds([String(rec.id)])).toHaveLength(1);
    expect(await checkpoint()).toBe(catCursor(1, STREAM));
  });
});
