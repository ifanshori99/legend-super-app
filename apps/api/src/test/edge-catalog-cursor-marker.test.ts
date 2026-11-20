// Catalog cursor rejection marker (bead legend-75kly, hardening 1190). Written
// from docs/briefs/sub-1190-edge-catalog-hardening.md (pieces A and B), the
// shared contract and the way sibling tests simulate a cloud HTTP 400
// (`EdgeCloudHttpError`), not from the implementation. Fail-first: the marker
// and the "400 without marker never resets" rules are missing today.
//
// Contract under test:
//  - Cloud route: a refused sync cursor answers HTTP 400 AND the response header
//    `X-Edge-Error: CATALOG_CURSOR_REJECTED`. Other errors carry no marker.
//  - Edge fetch: `EdgeCloudHttpError.code` stays `HTTP_<status>`; the optional
//    `reason` is the header value, only when it is `[A-Z_]{1,64}`.
//  - Edge puller: a stored cursor is reset only on the cursor error or on
//    HTTP_400 + marker. A 400 WITHOUT marker and a stored cursor is ambiguous:
//    one probe `fetchPage(stream, null)` whose result is discarded; probe 400
//    -> CATALOG_CLOUD_OUTDATED; probe ok -> the original HTTP_400 is reported,
//    checkpoint and local rows untouched; other probe error -> that error.
//    Without a stored cursor (`since === null`) a 400 stays
//    CATALOG_CLOUD_OUTDATED, no probe.
//
// Assumptions (the brief is silent), each easy to change:
//  - The marker is exported as `EDGE_ERROR_HEADER` / `CATALOG_CURSOR_REJECTED_MARKER`
//    from `../edge/catalog-cursor-marker.ts` (name taken from the brief's
//    suggested module); the edge constructor shape is
//    `new EdgeCloudHttpError("HTTP_400", reason?)`.
//  - A stream failure is reported on `result.streams[stream].error.code`
//    (like catalog-puller.test.ts), not thrown.
//  - Recovery after a marked 400 may happen inside the same pull or on the
//    next one (same assumption as edge-catalog-rewind.test.ts): at most two.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
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
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import {
  CATALOG_CURSOR_REJECTED_MARKER,
  EDGE_ERROR_HEADER,
} from "../edge/catalog-cursor-marker.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { EdgeCloudHttpError, cloudGetJson } from "../edge/cloud-http.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
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
  streams: Record<string, { error?: { code?: string } } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();
const STREAM = "menu_categories";
const CHECKPOINT = `catalog:${STREAM}`;
const PATH = "/api/edge-sync/catalog";
const MARKER = "CATALOG_CURSOR_REJECTED";

const app = createApp();
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

async function pull(cloud: { fetchPage: FetchPage }): Promise<PullResult> {
  return (await pullCatalog({
    database: edge.database,
    context: scopeOf("device", O1),
    edgeNodeId: node.id,
    fetchPage: cloud.fetchPage,
  } as never)) as PullResult;
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

const category = (rowId: string, name: string, txid: number): Rec => ({
  ...template,
  id: rowId,
  name,
  parentId: null,
  syncTxid: String(txid),
});

const emptyPage = (stream: string, since: string | null): Page => ({
  protocolVersion: CATALOG_PROTOCOL_VERSION,
  stream,
  records: [],
  nextCursor: since,
  hasMore: false,
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji marker kursor katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori marker',0)`,
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
    label: "Mini PC uji marker kursor katalog",
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

// ---------------------------------------------------------------- cloud route

const getPage = (query: Record<string, string | number>) =>
  request(app)
    .get(PATH)
    .set("Authorization", `Bearer ${node.credential}`)
    .query({ stream: STREAM, ...query });

/** `[tag, txid, ...rest]` of a real cursor the cloud just issued. */
async function realCursorParts(): Promise<string[]> {
  const first = await getPage({ limit: 1 });
  expect(first.status).toBe(200);
  const cursor = (first.body as Page).nextCursor;
  expect(cursor, "the cloud issued a cursor").toBeTruthy();
  return decodeCursor(cursor!).map((part) => String(part));
}

describe("75kly cloud: a refused sync cursor is marked in a response header", () => {
  it("a cat1 cursor is refused with HTTP 400 and X-Edge-Error: CATALOG_CURSOR_REJECTED", async () => {
    const parts = await realCursorParts();
    // Key columns of a real cursor (cat2: tag, txid, keys).
    const keys = parts.slice(2);
    const res = await getPage({
      since: encodeCursor(["cat1", "5", ...keys]),
      limit: 10,
    });
    expect(res.status).toBe(400);
    expect(res.headers[EDGE_ERROR_HEADER.toLowerCase()]).toBe(MARKER);
  });

  it("a cursor whose txid is ahead of the cloud (restored database) is refused with the marker", async () => {
    const parts = await realCursorParts();
    const keys = parts.slice(2);
    const ahead = String(BigInt(parts[1]!) + 1_000_000_000n);
    const res = await getPage({
      since: encodeCursor([parts[0]!, ahead, ...keys]),
      limit: 10,
    });
    expect(res.status).toBe(400);
    expect(res.headers[EDGE_ERROR_HEADER.toLowerCase()]).toBe(MARKER);
  });

  it("the exported marker constants carry the agreed literals", () => {
    expect(EDGE_ERROR_HEADER).toBe("X-Edge-Error");
    expect(CATALOG_CURSOR_REJECTED_MARKER).toBe(MARKER);
  });

  it("a successful page and an unrelated validation error carry no marker", async () => {
    const ok = await getPage({ limit: 1 });
    expect(ok.status).toBe(200);
    expect(ok.headers[EDGE_ERROR_HEADER.toLowerCase()]).toBeUndefined();

    const invalid = await getPage({ limit: 0 });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);
    expect(invalid.headers[EDGE_ERROR_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("a request without a credential is refused 401 without a marker", async () => {
    const res = await request(app).get(PATH).query({ stream: STREAM });
    expect(res.status).toBe(401);
    expect(res.headers[EDGE_ERROR_HEADER.toLowerCase()]).toBeUndefined();
  });
});

// ------------------------------------------------------------- edge http error

describe("75kly edge fetch: EdgeCloudHttpError.reason from the marker header", () => {
  const options = (headers: Record<string, string>, status = 400) => ({
    cloudUrl: "wss://cloud.example.com/api/edge-link",
    credential: "edg1.tenant.outlet.node.s3cr3t-value",
    path: "/api/edge-sync/catalog?stream=menu_categories",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ secret: "never read" }), {
        status,
        headers: { "content-type": "application/json", ...headers },
      })) as typeof fetch,
  });
  const failure = async (
    headers: Record<string, string>,
    status = 400,
  ): Promise<EdgeCloudHttpError> => {
    try {
      await cloudGetJson(options(headers, status));
    } catch (error) {
      expect(error).toBeInstanceOf(EdgeCloudHttpError);
      return error as EdgeCloudHttpError;
    }
    throw new Error("Expected cloudGetJson to fail");
  };

  it("keeps the code HTTP_400 and exposes the marker as reason", async () => {
    const error = await failure({ [EDGE_ERROR_HEADER]: MARKER });
    expect(error.code).toBe("HTTP_400");
    expect(error.reason).toBe(MARKER);
  });

  it("has no reason without the header", async () => {
    const error = await failure({});
    expect(error.code).toBe("HTTP_400");
    expect(error.reason).toBeUndefined();
  });

  it.each([
    ["lowercase", "catalog_cursor_rejected"],
    ["digits", "CURSOR_2"],
    ["spaces", "CATALOG CURSOR"],
    ["more than 64 characters", "A".repeat(65)],
  ])("ignores a malformed value (%s)", async (_label, value) => {
    const error = await failure({ [EDGE_ERROR_HEADER]: value });
    expect(error.code).toBe("HTTP_400");
    expect(error.reason).toBeUndefined();
  });

  it("accepts a 64 character token and keeps the code of other statuses", async () => {
    const long = "A".repeat(64);
    const error = await failure({ [EDGE_ERROR_HEADER]: long }, 503);
    expect(error.code).toBe("HTTP_503");
    expect(error.reason).toBe(long);
  });

  it("never puts the response body into the error", async () => {
    const error = await failure({ [EDGE_ERROR_HEADER]: MARKER });
    expect(JSON.stringify(error)).not.toContain("never read");
    expect(error.message).not.toContain("never read");
  });
});

// ------------------------------------------------------------- edge puller

/** Stores checkpoint cat2:500 and one local row with sync_txid 500. */
async function seedHighCheckpoint(rowId: string) {
  const oldCursor = catCursor(500, STREAM, rowId);
  const seeded = await pull({
    fetchPage: async (stream, since) =>
      stream === STREAM
        ? ({
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            stream,
            records: [category(rowId, "Nama lama", 500)],
            nextCursor: oldCursor,
            hasMore: false,
          } satisfies Page)
        : emptyPage(stream, since),
  });
  expect(seeded.streams[STREAM]?.error, "seed pull").toBeFalsy();
  expect(await checkpoint(), "seed: stored checkpoint").toBe(oldCursor);
  expect((await localRow(rowId))?.txid, "seed: local sync_txid").toBe("500");
  return oldCursor;
}

/**
 * A cloud that answers the stored cursor with `onStored`, a pull from the
 * start (`null`) with `onStart`, and records every request for the stream.
 */
function cloudWith(opts: {
  oldCursor: string;
  onStored: () => never;
  onStart: () => Page;
}) {
  const asked: (string | null)[] = [];
  const fetchPage = async (
    stream: string,
    since: string | null,
  ): Promise<Page> => {
    if (stream !== STREAM) return emptyPage(stream, since);
    asked.push(since);
    if (since === opts.oldCursor) return opts.onStored();
    if (since === null) return opts.onStart();
    throw new Error(`unexpected cursor ${since}`);
  };
  return { fetchPage, asked };
}

const probePage = (rowId: string): Page => ({
  protocolVersion: CATALOG_PROTOCOL_VERSION,
  stream: STREAM,
  records: [category(rowId, "Dari probe", 10)],
  nextCursor: catCursor(10, STREAM, rowId),
  hasMore: false,
});

describe("75kly edge puller: only a marked 400 resets the stored cursor", () => {
  it("HTTP_400 WITH the marker resets: full pull from the start, checkpoint and local sync_txid rewind", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const newCursor = catCursor(10, STREAM, rowId);
    const cloud = cloudWith({
      oldCursor,
      onStored: () => {
        throw new EdgeCloudHttpError("HTTP_400", MARKER);
      },
      onStart: () => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: STREAM,
        records: [category(rowId, "Nama setelah restore", 10)],
        nextCursor: newCursor,
        hasMore: false,
      }),
    });

    await pull(cloud);
    if ((await checkpoint()) === oldCursor) await pull(cloud);

    expect(cloud.asked, "a full pull from the start happened").toContain(null);
    expect(await checkpoint()).toBe(newCursor);
    expect(await localRow(rowId)).toEqual({
      name: "Nama setelah restore",
      txid: "10",
    });
  }, 60_000);

  it("HTTP_400 WITHOUT the marker and a probe that succeeds: the original HTTP_400 is reported, nothing is reset, the probe page is discarded", async () => {
    const rowId = id();
    const probeRow = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const cloud = cloudWith({
      oldCursor,
      onStored: () => {
        throw new EdgeCloudHttpError("HTTP_400");
      },
      onStart: () => probePage(probeRow),
    });

    const result = await pull(cloud);

    expect(result.streams[STREAM]?.error?.code).toBe("HTTP_400");
    expect(cloud.asked, "stored cursor once, then exactly one probe").toEqual([
      oldCursor,
      null,
    ]);
    expect(await checkpoint(), "checkpoint intact").toBe(oldCursor);
    expect(await localRow(rowId), "local row intact").toEqual({
      name: "Nama lama",
      txid: "500",
    });
    expect(await localRow(probeRow), "probe page not applied").toBeUndefined();
  }, 60_000);

  it("HTTP_400 WITHOUT the marker and a probe that is also HTTP_400: CATALOG_CLOUD_OUTDATED, nothing is reset", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const cloud = cloudWith({
      oldCursor,
      onStored: () => {
        throw new EdgeCloudHttpError("HTTP_400");
      },
      onStart: () => {
        throw new EdgeCloudHttpError("HTTP_400");
      },
    });

    const result = await pull(cloud);

    expect(result.streams[STREAM]?.error?.code).toBe("CATALOG_CLOUD_OUTDATED");
    expect(cloud.asked).toEqual([oldCursor, null]);
    expect(await checkpoint()).toBe(oldCursor);
    expect(await localRow(rowId)).toEqual({ name: "Nama lama", txid: "500" });
  }, 60_000);

  it("HTTP_400 WITHOUT the marker and a probe that fails otherwise: the probe error is reported, nothing is reset", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const cloud = cloudWith({
      oldCursor,
      onStored: () => {
        throw new EdgeCloudHttpError("HTTP_400");
      },
      onStart: () => {
        throw new EdgeCloudHttpError("HTTP_503");
      },
    });

    const result = await pull(cloud);

    expect(result.streams[STREAM]?.error?.code).toBe("HTTP_503");
    expect(cloud.asked).toEqual([oldCursor, null]);
    expect(await checkpoint()).toBe(oldCursor);
    expect(await localRow(rowId)).toEqual({ name: "Nama lama", txid: "500" });
  }, 60_000);

  it("a different marker value does not count as the cursor marker", async () => {
    const rowId = id();
    const oldCursor = await seedHighCheckpoint(rowId);
    const cloud = cloudWith({
      oldCursor,
      onStored: () => {
        throw new EdgeCloudHttpError("HTTP_400", "SOMETHING_ELSE");
      },
      onStart: () => probePage(id()),
    });

    const result = await pull(cloud);

    expect(result.streams[STREAM]?.error?.code).toBe("HTTP_400");
    expect(await checkpoint()).toBe(oldCursor);
    expect(await localRow(rowId)).toEqual({ name: "Nama lama", txid: "500" });
  }, 60_000);

  it("without a stored cursor a 400 stays CATALOG_CLOUD_OUTDATED and is not probed", async () => {
    const asked: (string | null)[] = [];
    const result = await pull({
      fetchPage: async (stream, since) => {
        if (stream === STREAM) {
          asked.push(since);
          throw new EdgeCloudHttpError("HTTP_400");
        }
        return emptyPage(stream, since);
      },
    });

    expect(result.streams[STREAM]?.error?.code).toBe("CATALOG_CLOUD_OUTDATED");
    expect(asked, "one request, no probe").toEqual([null]);
    expect(await checkpoint()).toBeUndefined();
  }, 60_000);
});
