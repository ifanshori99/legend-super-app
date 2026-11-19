// Cloud database restore detection for the catalog sync cursor (bead
// legend-y9y8y, hardening 1190 piece A, after the architect addendum: NO
// cat3/epoch cursor, only the txid horizon check). Written from
// docs/briefs/sub-1190-edge-catalog-hardening.md, not from the implementation.
// Fail-first: no txid-ahead check exists before the change.
//
// Contract under test:
//  - A cursor (cat2) whose txid is above the cloud's current transaction
//    horizon (`pg_snapshot_xmax`; the txid went backwards after a restore) is
//    refused: HTTP 400 and header `X-Edge-Error: CATALOG_CURSOR_REJECTED`.
//  - A cursor at or below the horizon is accepted as before; cat1 and other
//    tags stay refused.
//  - The edge then rewinds through the existing path (edge-catalog-rewind.test.ts).
//
// Assumptions (the brief is silent), each easy to change:
//  - Pages still issue `cat2` cursors = [tag, txid, ...keys].
//  - The seam `setCatalogSnapshotXmaxProvider(provider | null)` in
//    services/edge-catalog-sync.ts replaces the horizon; calling it with
//    null restores the real one. A provider returns the horizon as bigint
//    (it receives the transaction; the tests ignore the argument).
//  - Without the seam, a txid 1,000,000,000 above the real one is "ahead".
//  - Key columns are copied from a real cursor, so a refusal can only come
//    from the horizon rule, never from a malformed key.
//  - Recovery after the rejection may happen inside the same pull or on the
//    next one (at most two pulls), like edge-catalog-rewind.test.ts.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createUlid,
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { EdgeCloudHttpError } from "../edge/cloud-http.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  catalogRecordAggregateId,
  registerMasterDataEdgeApplier,
} from "../edge/master-data-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  listCatalogRecordsSince,
  setCatalogSnapshotXmaxProvider,
} from "../services/edge-catalog-sync.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
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
const MARKER_HEADER = "x-edge-error";
const AHEAD = 1_000_000_000n;

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
    "Outlet uji epoch katalog",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori epoch',0)`,
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
    label: "Mini PC uji epoch katalog",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: O1 });
  await copyToEdge("edge_nodes", node.id);
}, 240_000);

beforeEach(async () => {
  await resetEdge();
});

afterEach(() => {
  setCatalogSnapshotXmaxProvider(null);
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

// ------------------------------------------------------------------- helpers

const getPage = (query: Record<string, string | number>) =>
  request(app)
    .get(PATH)
    .set("Authorization", `Bearer ${node.credential}`)
    .query({ stream: STREAM, ...query });

type Real = { txid: string; keys: string[] };

/** Splits a cursor the cloud issued: [tag, txid, ...keys]. */
function split(cursor: string | null): Real {
  expect(cursor, "the page issued a cursor").toBeTruthy();
  const parts = decodeCursor(cursor!);
  expect(parts[1], "txid digits").toMatch(/^\d+$/);
  return {
    txid: String(parts[1]),
    keys: parts.slice(2).map((key) => String(key)),
  };
}

const cursorOf = (r: Real, over: Partial<Real> = {}, tag = "cat2") => {
  const { txid, keys } = { ...r, ...over };
  return encodeCursor([tag, txid, ...keys]);
};
const ahead = (txid: string) => String(BigInt(txid) + AHEAD);

/** One real page of one record, as a real edge would receive it. */
async function realFirst(): Promise<Real> {
  const res = await getPage({ limit: 1 });
  expect(res.status).toBe(200);
  return split((res.body as Page).nextCursor);
}

/** Walks to the last page; the cursor after it is the end of the stream. */
async function realEnd(): Promise<Real> {
  let since: string | undefined;
  let last: string | null = null;
  for (let n = 0; n < 2000; n += 1) {
    const res = await getPage({ limit: 100, ...(since ? { since } : {}) });
    expect(res.status).toBe(200);
    const page = res.body as Page;
    last = page.nextCursor ?? last;
    if (!page.hasMore || !page.nextCursor) break;
    since = page.nextCursor;
  }
  return split(last);
}

// ------------------------------------------------------------ cloud, by HTTP

describe("y9y8y cloud: refuses cursors from the future (restored database)", () => {
  it("a cursor whose txid is ahead of the cloud is refused 400 with the marker", async () => {
    const real = await realFirst();
    const res = await getPage({
      since: cursorOf(real, { txid: ahead(real.txid) }),
      limit: 100,
    });
    expect(res.status).toBe(400);
    expect(res.headers[MARKER_HEADER]).toBe(MARKER);
  });

  it("a real cursor is refused once the cloud's horizon falls below its txid (seam), and accepted again after the reset", async () => {
    const real = await realFirst();
    const since = cursorOf(real);
    expect((await getPage({ since, limit: 100 })).status).toBe(200);

    setCatalogSnapshotXmaxProvider(async () => BigInt(real.txid) - 1n);
    const refused = await getPage({ since, limit: 100 });
    expect(refused.status).toBe(400);
    expect(refused.headers[MARKER_HEADER]).toBe(MARKER);

    setCatalogSnapshotXmaxProvider(null);
    expect((await getPage({ since, limit: 100 })).status).toBe(200);
  });

  it("a cursor exactly at the horizon is accepted (txid equal is not ahead)", async () => {
    const real = await realFirst();
    // xmax is the next id the cluster hands out, so every issued txid is below
    // it; a provider returning the cursor's own txid must not refuse it.
    setCatalogSnapshotXmaxProvider(async () => BigInt(real.txid));
    const res = await getPage({ since: cursorOf(real), limit: 100 });
    expect(res.status).toBe(200);
    expect(res.headers[MARKER_HEADER]).toBeUndefined();
  });

  it("cat1 and other tags stay refused 400 with the marker", async () => {
    const real = await realFirst();
    for (const tag of ["cat1", "cat3", "nope"]) {
      const res = await getPage({
        since: cursorOf(real, {}, tag),
        limit: 100,
      });
      expect(res.status, tag).toBe(400);
      expect(res.headers[MARKER_HEADER], tag).toBe(MARKER);
    }
  });

  it("a valid cursor and a first page carry no marker", async () => {
    const real = await realFirst();
    const res = await getPage({
      since: cursorOf(real, { txid: "1" }),
      limit: 1,
    });
    expect(res.status).toBe(200);
    expect(res.headers[MARKER_HEADER]).toBeUndefined();
    expect((res.body as Page).records.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------- edge rewind

/**
 * A cloud that answers over the real HTTP route when the edge asks with a
 * cursor, and replays a "restored cloud" full pull when it asks from the start:
 * one synthetic record whose txid is lower than the one the edge stored, ending
 * at the real end-of-stream cursor.
 */
function restoredCloud(opts: { endCursor: string; rowId: string }) {
  const statuses: number[] = [];
  const asked: (string | null)[] = [];
  const fetchPage = async (
    stream: string,
    since: string | null,
  ): Promise<Page> => {
    if (stream !== STREAM) return emptyPage(stream, since);
    asked.push(since);
    if (since === null)
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [category(opts.rowId, "Nama setelah restore", 10)],
        nextCursor: opts.endCursor,
        hasMore: false,
      };
    const res = await getPage({
      since,
      limit: 100,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
    });
    statuses.push(res.status);
    if (res.status !== 200) {
      const header = res.headers[MARKER_HEADER];
      throw new EdgeCloudHttpError(
        `HTTP_${res.status}`,
        typeof header === "string" ? header : undefined,
      );
    }
    return res.body as Page;
  };
  return { fetchPage, asked, statuses };
}

/** The edge stored `staleCursor` and a local row with sync_txid 500. */
async function seedStoredCursor(rowId: string, staleCursor: string) {
  const seeded = await pull({
    fetchPage: async (stream, since) =>
      stream === STREAM
        ? ({
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            stream,
            records: [category(rowId, "Nama lama", 500)],
            nextCursor: staleCursor,
            hasMore: false,
          } satisfies Page)
        : emptyPage(stream, since),
  });
  expect(seeded.streams[STREAM]?.error, "seed pull").toBeFalsy();
  expect(await checkpoint(), "seed: stored checkpoint").toBe(staleCursor);
  expect((await localRow(rowId))?.txid, "seed: local sync_txid").toBe("500");
}

describe("y9y8y edge: a restored cloud makes the edge rewind and sync again", () => {
  it("the stored cursor is ahead of the cloud: the cloud refuses it, the edge pulls from the start, rewinds the checkpoint and local sync_txid, and the next pull is accepted", async () => {
    const end = await realEnd();
    const endCursor = cursorOf(end);
    const rowId = id();
    const staleCursor = cursorOf(end, { txid: ahead(end.txid) });
    await seedStoredCursor(rowId, staleCursor);
    const cloud = restoredCloud({ endCursor, rowId });

    await pull(cloud);
    if ((await checkpoint()) === staleCursor) await pull(cloud);

    expect(cloud.statuses[0], "the cloud refused the stored cursor").toBe(400);
    expect(cloud.asked, "a full pull from the start happened").toContain(null);
    expect(await checkpoint(), "checkpoint rewound to the real cursor").toBe(
      endCursor,
    );
    expect(
      await localRow(rowId),
      "the txid-10 cloud row replaced the txid-500 local copy",
    ).toEqual({ name: "Nama setelah restore", txid: "10" });

    // Steady state: the next pull sends the new cursor and gets 200.
    const refused = cloud.statuses.filter((s) => s !== 200).length;
    const next = await pull(cloud);
    expect(cloud.asked.at(-1)).toBe(endCursor);
    expect(
      cloud.statuses.filter((s) => s !== 200).length,
      "no second refusal",
    ).toBe(refused);
    expect(cloud.statuses.at(-1)).toBe(200);
    expect(next.streams[STREAM]?.error?.code).not.toBe("HTTP_400");
  }, 120_000);

  it("the horizon forced below the stored txid (seam) has the same effect", async () => {
    const end = await realEnd();
    const endCursor = cursorOf(end);
    const rowId = id();
    await seedStoredCursor(rowId, endCursor);
    // The cloud was "restored": its horizon is now below the stored txid.
    setCatalogSnapshotXmaxProvider(async () => BigInt(end.txid) - 1n);
    const cloud = restoredCloud({
      endCursor: cursorOf(end, { txid: "1" }),
      rowId,
    });

    await pull(cloud);

    expect(cloud.statuses[0], "the cloud refused the stored cursor").toBe(400);
    expect(cloud.asked, "a full pull from the start happened").toContain(null);
    expect(await localRow(rowId)).toEqual({
      name: "Nama setelah restore",
      txid: "10",
    });
  }, 120_000);

  it("a stored cursor that is still valid is not reset", async () => {
    const end = await realEnd();
    const rowId = id();
    const valid = cursorOf(end);
    await seedStoredCursor(rowId, valid);
    const cloud = restoredCloud({ endCursor: valid, rowId });

    await pull(cloud);

    expect(cloud.statuses[0], "the stored cursor is accepted").toBe(200);
    expect(cloud.asked, "no full pull from the start").not.toContain(null);
    expect(await localRow(rowId), "local row untouched by a reset").toEqual({
      name: "Nama lama",
      txid: "500",
    });
  }, 120_000);
});

// ------------------------------------------------ 1199 R1: receipts vs restore
//
// Second opinion 1197, finding R1 (P1), test T1; CTO decision in
// docs/briefs/sub-1199-edge-catalog-so1197.md. Written from the brief and the
// second opinion, not from the implementation. Fail-first: at acf1edca3 a link
// receipt at the old version (1000) keeps blocking the restored cloud history
// (version 200) while the pull still stores its checkpoint as a success.
//
// Contract under test:
//  - Records that reached the edge as link events (so the edge holds a receipt
//    at version 1000) must NOT keep the edge on the old value after the cloud
//    was restored (horizon 200) and the edge rewound: the cloud's value is
//    applied, and the stream is only reported fresh after that.
//  - Later changes (version 201) coming over HTTP or over the link are applied.
//  - Normal protection stays: an older HTTP replay in the same generation never
//    overwrites a newer event.
//
// Assumptions (the brief is silent), each easy to change:
//  - The restore is simulated like the sibling tests: the edge's stored cursor
//    is above the cloud's horizon, the cloud answers it with HTTP 400 plus the
//    CATALOG_CURSOR_REJECTED marker, and the edge pulls from the start. The
//    cloud is a scripted fetchPage (no HTTP route), so the test only depends on
//    the edge behaviour. Recovery may take two pulls, like the tests above.
//  - Event `sequence` equals the record's `syncTxid` (as in
//    edge-master-data-applier.test.ts); a link event for a record is applied
//    through the real receive transaction (createDbLinkStore.applyInbound).
//  - A link event for a restored-generation version (201) is applied even
//    though the edge once held a receipt at 1000 for the same record.
//  - A printer tombstone delivered as a link event at version 1000 does not
//    keep a printer deleted when the restored cloud history has it live at 200.

// Two ways the edge learns about the restore (CTO design, 1199): the cloud
// refuses the stored cursor (HTTP 400 + marker), or the operator sets the
// catalog checkpoint watermark to the sentinel string 'rewind'. Both must
// rewind the stream including receipt-backed rows.
for (const mode of ["cursor-rejected", "operator-rewind"] as const)
  describe(`1199 R1 (${mode}): an old link receipt must not block a restored catalog`, () => {
    let authed: AuthenticatedEdgeNode;
    const RESTORED = "Nama cloud setelah restore";
    const FROM_EVENT = "Nama dari event lama";

    beforeEach(async () => {
      resetEdgeApplierRegistryForTests();
      registerMasterDataEdgeApplier();
      const found = await authenticateEdgeCredential(node.credential);
      if (!found) throw new Error("Test node did not authenticate");
      authed = found;
    });

    afterEach(() => resetEdgeApplierRegistryForTests());

    const linkStore = () =>
      createDbLinkStore({
        database: edge.database,
        context: authed.context,
        node: authed.scope,
        outboundDirection: "edge_to_cloud",
      });

    function catalogEvent(stream: string, record: Rec): EventEnvelope {
      const eventId = createUlid();
      return eventEnvelopeSchema.parse({
        id: eventId,
        tenantId,
        outletId: O1,
        name: "catalog_record.updated",
        version: 1,
        aggregateType: "catalog_record",
        aggregateId: catalogRecordAggregateId(stream as never, record as never),
        sequence: Number(record.syncTxid),
        occurredAt: "2026-11-19T10:00:00.000Z",
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `epoch-1199:${eventId}`,
        payloadSchemaRef: "catalog_record.updated.v1",
        payload: { stream, record },
      });
    }

    async function deliver(stream: string, record: Rec) {
      const link = linkStore();
      const fromSeq = await link.lastReceivedInbound();
      await link.applyInbound({
        fromSeq,
        toSeq: fromSeq + 1,
        events: [{ linkSeq: fromSeq + 1, event: catalogEvent(stream, record) }],
      });
    }

    const cursorFor = (txid: bigint | number | string, key: string) =>
      encodeCursor(["cat2", String(txid), key]);

    /**
     * A scripted cloud with its own history. It refuses a cursor whose txid is
     * above its `horizon` (HTTP 400 + marker), serves every record from the
     * start when asked without a cursor, and serves only records newer than the
     * cursor otherwise. `publish` adds a change and moves the horizon up.
     */
    function scriptedHistory(stream: string, horizon: bigint, records: Rec[]) {
      const state = { horizon, records: [...records] };
      const asked: (string | null)[] = [];
      const fetchPage = async (
        requested: string,
        since: string | null,
      ): Promise<Page> => {
        if (requested !== stream) return emptyPage(requested, since);
        asked.push(since);
        if (since !== null) {
          // The sentinel 'rewind' must never reach the cloud as a cursor.
          let tag: unknown;
          try {
            tag = decodeCursor(since)[0];
          } catch {
            tag = undefined;
          }
          if (tag !== "cat2")
            throw new Error(
              `The edge sent a non-cursor to the cloud: ${since}`,
            );
        }
        if (
          since !== null &&
          BigInt(String(decodeCursor(since)[1])) > state.horizon
        )
          throw new EdgeCloudHttpError("HTTP_400", MARKER);
        const floor =
          since === null ? -1n : BigInt(String(decodeCursor(since)[1]));
        const served = state.records.filter(
          (r) => BigInt(String(r.syncTxid)) > floor,
        );
        const last = served.at(-1);
        return {
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream,
          records: served,
          nextCursor: last
            ? cursorFor(String(last.syncTxid), String(last.id))
            : since,
          hasMore: false,
        };
      };
      return {
        fetchPage,
        asked,
        publish(record: Rec) {
          state.records.push(record);
          state.horizon = BigInt(String(record.syncTxid));
        },
        /** Pulls once more than needed: recovery may take two pulls. */
        async pullTwice() {
          if (mode === "operator-rewind") {
            const updated = await edge.owner.query(
              "UPDATE edge_pull_checkpoints SET watermark = 'rewind' WHERE edge_node_id = $1 AND stream = $2",
              [node.id, `catalog:${stream}`],
            );
            expect(updated.rowCount, "the checkpoint row was rewound").toBe(1);
          }
          await pullStream(stream, fetchPage);
          await pullStream(stream, fetchPage);
        },
      };
    }

    async function pullStream(stream: string, fetchPage: FetchPage) {
      const result = (await pullCatalog({
        database: edge.database,
        context: scopeOf("device", O1),
        edgeNodeId: node.id,
        streams: [stream],
        fetchPage,
      } as never)) as PullResult;
      return result;
    }

    /** The edge stored a cursor at `txid` for `stream` (a normal pull). */
    async function seedCursor(stream: string, txid: number, key: string) {
      const seeded = await pullStream(stream, async (requested, since) =>
        requested === stream
          ? ({
              protocolVersion: CATALOG_PROTOCOL_VERSION,
              stream,
              records: [],
              nextCursor: cursorFor(txid, key),
              hasMore: false,
            } satisfies Page)
          : emptyPage(requested, since),
      );
      expect(seeded.streams[stream]?.error, "seed pull").toBeFalsy();
    }

    /** A category the edge holds from a link event at version 1000. */
    async function categoryFromOldEvent(rowId: string) {
      await deliver(STREAM, category(rowId, FROM_EVENT, 1000));
      expect(await localRow(rowId), "link event applied").toEqual({
        name: FROM_EVENT,
        txid: "1000",
      });
      await seedCursor(STREAM, 1000, rowId);
    }

    /** The cloud was restored: its history says `RESTORED` at version 200. */
    async function restoreCategory(rowId: string) {
      const cloud = scriptedHistory(STREAM, 200n, [
        category(rowId, RESTORED, 200),
      ]);
      await cloud.pullTwice();
      expect(cloud.asked, "the edge pulled from the start").toContain(null);
      return cloud;
    }

    it("T1a after a restore the cloud's value replaces the value held by a version-1000 link receipt, and the checkpoint only follows", async () => {
      const rowId = id();
      await categoryFromOldEvent(rowId);

      await restoreCategory(rowId);

      expect(
        await localRow(rowId),
        "restored cloud value applied over the old receipt",
      ).toEqual({ name: RESTORED, txid: "200" });
      expect(
        BigInt(String(decodeCursor((await checkpoint())!)[1])),
        "the stream is reported fresh at the restored horizon",
      ).toBe(200n);
    }, 120_000);

    it("T1b a version-201 change over HTTP after the restore is applied, not lost", async () => {
      const rowId = id();
      await categoryFromOldEvent(rowId);
      const cloud = await restoreCategory(rowId);

      cloud.publish(category(rowId, "Nama versi 201 via HTTP", 201));
      await pullStream(STREAM, cloud.fetchPage);

      expect(await localRow(rowId)).toEqual({
        name: "Nama versi 201 via HTTP",
        txid: "201",
      });
    }, 120_000);

    it("T1c a version-201 change over the link after the restore is applied, not lost", async () => {
      const rowId = id();
      await categoryFromOldEvent(rowId);
      await restoreCategory(rowId);
      expect((await localRow(rowId))?.name, "restore applied first").toBe(
        RESTORED,
      );

      await deliver(STREAM, category(rowId, "Nama versi 201 via link", 201));

      expect(await localRow(rowId)).toEqual({
        name: "Nama versi 201 via link",
        txid: "201",
      });
    }, 120_000);

    it("T1d after the restore an older HTTP replay in the same generation still cannot overwrite a newer link event", async () => {
      const rowId = id();
      await categoryFromOldEvent(rowId);
      const cloud = await restoreCategory(rowId);
      expect((await localRow(rowId))?.name, "restore applied first").toBe(
        RESTORED,
      );
      await deliver(STREAM, category(rowId, "Event baru 202", 202));

      // The same generation replays version 201 over HTTP (older than the event).
      cloud.publish(category(rowId, "Replay HTTP lama 201", 201));
      await pullStream(STREAM, cloud.fetchPage);

      expect(await localRow(rowId)).toEqual({
        name: "Event baru 202",
        txid: "202",
      });
    }, 120_000);

    it.skipIf(mode !== "cursor-rejected")(
      "T1e (guard, normal operation) without a restore an older HTTP replay does not overwrite a link event",
      async () => {
        const rowId = id();
        await categoryFromOldEvent(rowId);

        await pullStream(STREAM, async (requested, since) =>
          requested === STREAM
            ? ({
                protocolVersion: CATALOG_PROTOCOL_VERSION,
                stream: STREAM,
                records: [category(rowId, "Replay HTTP lama 900", 900)],
                nextCursor: cursorFor(1000, rowId),
                hasMore: false,
              } satisfies Page)
            : emptyPage(requested, since),
        );

        expect(await localRow(rowId)).toEqual({
          name: FROM_EVENT,
          txid: "1000",
        });
      },
      120_000,
    );

    // ------------------------------------------------------- printer tombstone

    const printerRecord = (
      printerId: string,
      label: string,
      txid: number,
    ): Rec => ({
      id: printerId,
      tenantId,
      outletId: O1,
      label,
      role: "receipt",
      stationId: null,
      transport: "network",
      host: "192.168.1.50",
      port: 9100,
      devicePath: null,
      paperWidth: 48,
      fallbackPrinterId: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
      deletedAt: null,
      syncTxid: String(txid),
    });
    const printerTombstone = (printerId: string, txid: number): Rec => ({
      id: printerId,
      tenantId,
      outletId: O1,
      deletedAt: "2026-11-19T10:00:00.000Z",
      syncTxid: String(txid),
    });
    const printerRows = (printerId: string) =>
      edge.rows(
        "SELECT label, retired_at FROM edge_printers WHERE tenant_id = $1 AND id = $2",
        [tenantId, printerId],
      );

    it("T1f a printer deleted by a version-1000 tombstone event comes back when the restored cloud history has it live at 200, and a 201 change then applies", async () => {
      const printerId = id();
      await deliver("printers", printerRecord(printerId, "Printer lama", 1));
      await deliver("printers", printerTombstone(printerId, 1000));
      expect(await printerRows(printerId), "tombstone applied").toEqual([]);
      await seedCursor("printers", 1000, printerId);

      const cloud = scriptedHistory("printers", 200n, [
        printerRecord(printerId, "Printer setelah restore", 200),
      ]);
      await cloud.pullTwice();

      expect(
        await printerRows(printerId),
        "the restored live printer is not blocked by the old tombstone",
      ).toMatchObject([{ label: "Printer setelah restore", retired_at: null }]);

      cloud.publish(printerRecord(printerId, "Printer versi 201", 201));
      await pullStream("printers", cloud.fetchPage);
      expect(await printerRows(printerId)).toMatchObject([
        { label: "Printer versi 201", retired_at: null },
      ]);
    }, 120_000);
  });
