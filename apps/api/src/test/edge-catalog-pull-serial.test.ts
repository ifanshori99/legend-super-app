// legend-l1wux / brief 978 (money, tier K): written from the brief and the
// pattern of edge-promo-stream-offline.test.ts (533c P2), NOT from the
// implementation of catalog-puller.ts or promo-gate*.ts.
//
// Rule under test: two catalog pulls that overlap in time (one partial or on a
// subset of streams, one complete) never open the promo gate on top of a
// partial promotion snapshot. The gate (a discount) opens only after a pull has
// reached the end of the snapshot. Concretely, with a gate that is open and
// fresh on a complete snapshot (promo A, discount Rp20,000):
//  1. while a full pull is in flight in the middle of its pages, a second
//     partial pull on a subset of the streams (promotions only, one page) must
//     not reopen the gate, at any moment, before the full pull ends;
//  2. while a partial pull is stuck in the middle of a page, a second full pull
//     that starts must not reopen the gate over the partial snapshot the
//     first one stores; only the end of a full snapshot opens it.
// Finally, when both pulls are done and the snapshot is complete, the gate is
// open again and no stream reported an error (no pull is lost).
//
// Assumptions (the brief is silent), each easy to change:
//  - "gate open" = the freshness-guarded quote on the promo A item gives the
//    nominal discount (20,000); closed = 0. Like the 533c P2 tests, the
//    guarded quote is read WITHOUT gate.refresh() first (cached provider), and
//    then after a refresh.
//  - A pull that is in flight (a page fetched, the next not yet) already
//    closes the gate (existing behaviour in edge-promo-stream-sync.test.ts);
//    so "mid-snapshot" samples must be 0 whatever the serialization strategy.
//  - The test does not pin HOW the fix serializes (queue per stream, a lock,
//    one global queue): it only checks the invariant at fixed sample points,
//    with a bounded wait of 250 ms so a queued pull is not treated as hung.
//    The bounded wait is only to let an UNSERIALIZED implementation reach its
//    bad state; a serialized one passes either way.
//  - The cloud history has four promotions (A, C, D, E), one record per page,
//    so a one-page pull is always unfinished (hasMore) and a full pull needs
//    at least three pages.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  decodeCursor,
  encodeCursor,
  outletIdSchema,
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  installPromoFreshnessProvider,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import {
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { orderPromoPort } from "../services/order-promo.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Stream = "promotions" | "vouchers";
type Rec = Record<string, unknown>;
type Page = {
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};
type Fetch = (stream: string, since: string | null) => Promise<unknown>;

const PROMO = 20_000;
const LINE = 100_000;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const sourceId = randomUUID();
const sourceItem = randomUUID();
const promoA = randomUUID();
const promoC = randomUUID();
const promoD = randomUUID();
const promoE = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const q = (text: string, params: unknown[] = []) => owner.query(text, params);
const guarded = withPromoFreshness(orderPromoPort);
let outletId = "";
let edge: EdgeDatabase;
let nodeId = "";
let gate: PromoGateHandle | undefined;

const scope = (source: "session" | "device") =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function page(stream: Stream, since?: string): Promise<Page> {
  return (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: outletId as never,
    query: catalogSyncQuerySchema.parse({
      stream,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      limit: 100,
      ...(since ? { since } : {}),
    }),
  })) as unknown as Page;
}

/** Walk the real cloud pages, retained revocations of other suites included. */
async function all(stream: Stream) {
  const records: Rec[] = [];
  let since: string | undefined;
  for (let count = 0; count < 1000; count += 1) {
    const next = await page(stream, since);
    records.push(...next.records);
    if (!next.hasMore) return records;
    expect(next.nextCursor).not.toBeNull();
    since = next.nextCursor!;
  }
  throw new Error("Catalog did not finish paging");
}

function pull(
  fetchPage: Fetch,
  streams: Stream[] = ["promotions", "vouchers"],
  maxPages?: number,
) {
  return pullCatalog({
    database: edge.database as typeof db,
    context: scope("device"),
    edgeNodeId: nodeId,
    streams: streams as never,
    fetchPage,
    ...(maxPages === undefined ? {} : { maxPages }),
  });
}

const streamError = (result: Awaited<ReturnType<typeof pull>>) =>
  result.streams["promotions" as keyof typeof result.streams]?.error;

/** Discount a cashier gets on the promo A item through the freshness guard. */
function orderDiscount(): Promise<number> {
  return withTenant(edge.database, scope("device"), async (tx) =>
    Number(
      (
        await guarded.quote(tx, scope("device"), {
          outletId: outletIdSchema.parse(outletId),
          channel: "dine_in",
          lines: [
            {
              menuItemId: sourceItem as never,
              quantity: 1,
              unitPriceIdr: LINE as never,
              lineTotalIdr: LINE as never,
            },
          ],
          customer: null,
          voucherCode: null,
          at: new Date(),
        })
      ).totalDiscountIdr,
    ),
  );
}

async function openGate() {
  setPromoGateEdgeModeForTests(() => true);
  gate?.stop();
  gate = startPromoGate({
    context: scope("device"),
    edgeNodeId: nodeId,
    database: edge.database as typeof db,
    clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
  });
  await gate.refresh();
}

/** Promotions the edge database holds as active, among A, C, D and E. */
async function appliedPromos() {
  const rows = await edge.owner.query<{ id: string }>(
    "SELECT id FROM promotions WHERE status = 'active' AND id = ANY($1::uuid[])",
    [[promoA, promoC, promoD, promoE]],
  );
  return rows.rows.map((row) => row.id).sort();
}
const sortedIds = (...ids: string[]) => [...ids].sort();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wait for `promise`, but give up after `ms`: a queued pull is not a hang. */
async function within(ms: number, promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Cloud history: A, C, D, E in txid order, built from a real cloud record. */
async function cloudHistory(): Promise<Rec[]> {
  const source = (await all("promotions")).find(
    (record) => record.id === sourceId,
  )!;
  const base = BigInt(String(source.syncTxid));
  const record = (
    id: string,
    name: string,
    item: string,
    group: string,
    txid: bigint,
  ): Rec => ({
    ...source,
    id,
    name,
    status: "active",
    stackGroup: group,
    conditions: [
      { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
    ],
    benefit: { kind: "nominal_off", amountIdr: PROMO },
    syncTxid: String(txid),
  });
  return [
    record(promoA, "Promo A", sourceItem, "grp_a", base + 10n),
    record(promoC, "Promo C", randomUUID(), "grp_c", base + 20n),
    record(promoD, "Promo D", randomUUID(), "grp_d", base + 21n),
    record(promoE, "Promo E", randomUUID(), "grp_e", base + 22n),
  ];
}

/** Serves the records newer than the cursor, `size` per page. */
const serve =
  (records: Rec[], size: number): Fetch =>
  async (stream, since) => {
    // The promo gate needs a fresh checkpoint on BOTH streams, so every full
    // sync pulls promotions and vouchers; vouchers come from the real cloud.
    if (stream === "vouchers") return page("vouchers", since ?? undefined);
    const floor = since ? BigInt(String(decodeCursor(since)[1])) : -1n;
    const rest = records.filter(
      (record) => BigInt(String(record.syncTxid)) > floor,
    );
    const chunk = rest.slice(0, size);
    const last = chunk[chunk.length - 1];
    return {
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      stream,
      records: chunk,
      nextCursor: last
        ? encodeCursor(["cat2", String(last.syncTxid), String(last.id)])
        : since,
      hasMore: rest.length > chunk.length,
    };
  };

/** A is in force and fresh (complete first sync), the gate is open. */
async function startWithOpenGate() {
  const cloud = await cloudHistory();
  expect(streamError(await pull(serve(cloud.slice(0, 1), 10)))).toBeUndefined();
  await openGate();
  expect(await orderDiscount()).toBe(PROMO);
  return cloud;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet pull serial",
  );
  await q(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, voucher_required, starts_at,
        ends_at, conditions, benefit, stack_group, stackable, priority)
     VALUES ($1,$2,'Serial pull source','','active',false,'2026-01-01T00:00:00Z',
             '2099-01-01T00:00:00Z',$3,$4,'serialsrc',false,0)`,
    [
      sourceId,
      tenantId,
      JSON.stringify([
        { kind: "item_quantity", menuItemIds: [sourceItem], minQuantity: 1 },
      ]),
      JSON.stringify({ kind: "nominal_off", amountIdr: PROMO }),
    ],
  );
  const registered = await registerEdgeNode(scope("session"), actor, {
    outletId,
    role: "standby",
    label: "Edge pull serial",
  });
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({ tenantId, outletId });
  const node = await q(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [nodeId],
  );
  await edge.owner.query(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
    [JSON.stringify(node.rows[0].row)],
  );
}, 240_000);

beforeEach(async () => {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM promotion_outlets");
    await client.query("DELETE FROM vouchers");
    await client.query("DELETE FROM edge_voucher_catalog");
    await client.query("DELETE FROM promotions");
    await client.query("DELETE FROM promo_settings");
    await client.query("DELETE FROM edge_pull_checkpoints");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await settleCloud(owner);
});

afterEach(() => {
  gate?.stop();
  gate = undefined;
  installPromoFreshnessProvider(null);
  setPromoGateEdgeModeForTests(null);
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    await q("DELETE FROM promotions WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      sourceId,
    ]);
  } finally {
    await owner.end();
  }
});

describe("legend-l1wux concurrent catalog pulls never open the promo gate on a partial snapshot", () => {
  it("control: a one-page pull leaves the snapshot unfinished and the gate closed; a full pull reopens it", async () => {
    const cloud = await startWithOpenGate();
    const partial = await pull(serve(cloud, 1), ["promotions"], 1);
    expect(streamError(partial)).toBeUndefined();
    expect(partial.backlog).toBe(true);
    expect(await appliedPromos()).toEqual(sortedIds(promoA, promoC));
    expect(await orderDiscount()).toBe(0);
    await gate!.refresh();
    expect(await orderDiscount()).toBe(0);
    const done = await pull(serve(cloud, 1));
    expect(streamError(done)).toBeUndefined();
    expect(done.backlog).toBeFalsy();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
    expect(await appliedPromos()).toEqual(
      sortedIds(promoA, promoC, promoD, promoE),
    );
  });

  it("a partial pull on a subset of streams that overlaps a full pull in the middle of its pages cannot reopen the gate before the full pull ends", async () => {
    const cloud = await startWithOpenGate();
    const source = serve(cloud, 1);
    const secondPageReached = deferred();
    const releaseFull = deferred();
    let promotionFetches = 0;
    // Full pull: page 1 (C) comes back at once, page 2 (D) is held, so this
    // pull stays in the middle of its snapshot.
    const full = pull(async (stream, since) => {
      if (stream === "promotions") {
        promotionFetches += 1;
        if (promotionFetches === 2) {
          secondPageReached.resolve();
          await releaseFull.promise;
        }
      }
      return source(stream, since);
    });
    let partial: ReturnType<typeof pull> | undefined;
    try {
      await secondPageReached.promise;
      // Precondition: a snapshot is in flight, the gate is closed.
      expect(await orderDiscount()).toBe(0);
      // Second pull, promotions only, one page: it leaves the snapshot unfinished.
      partial = pull(source, ["promotions"], 1);
      // Unserialized, it commits its page now; serialized, it queues behind
      // the full pull. Either way nothing may open the gate yet.
      await within(250, partial);
      expect(await orderDiscount()).toBe(0);
      await gate!.refresh();
      expect(await orderDiscount()).toBe(0);
      releaseFull.resolve();
      expect(streamError(await full)).toBeUndefined();
      expect(streamError(await partial)).toBeUndefined();
      // Only now that a full snapshot is complete does the gate open.
      await gate!.refresh();
      expect(await orderDiscount()).toBe(PROMO);
      expect(await appliedPromos()).toEqual(
        sortedIds(promoA, promoC, promoD, promoE),
      );
    } finally {
      releaseFull.resolve();
      await Promise.allSettled([full, partial]);
    }
  });

  it("a full pull started while a partial pull is stuck in the middle of a page cannot reopen the gate over the partial snapshot", async () => {
    const cloud = await startWithOpenGate();
    const source = serve(cloud, 1);
    const partialArrived = deferred();
    const releasePartial = deferred();
    const fullSecondPage = deferred();
    const releaseFull = deferred();
    let fullPromotionFetches = 0;
    // Partial pull: stuck inside its first page request.
    const partial = pull(
      async (stream, since) => {
        partialArrived.resolve();
        await releasePartial.promise;
        return source(stream, since);
      },
      ["promotions"],
      1,
    );
    let full: ReturnType<typeof pull> | undefined;
    try {
      await partialArrived.promise;
      // Full pull: its second promotions page is held, so it can never finish
      // before the samples below, whatever the order the pulls run in.
      full = pull(async (stream, since) => {
        if (stream === "promotions") {
          fullPromotionFetches += 1;
          if (fullPromotionFetches === 2) {
            fullSecondPage.resolve();
            await releaseFull.promise;
          }
        }
        return source(stream, since);
      });
      // Unserialized, the full pull runs now beside the stuck one; serialized,
      // it waits. The wait only lets the bad state appear.
      await within(250, fullSecondPage.promise);
      releasePartial.resolve();
      const unfinished = await partial;
      expect(streamError(unfinished)).toBeUndefined();
      expect(unfinished.backlog).toBe(true);
      // The partial snapshot is stored, the full pull is not finished.
      await within(250, fullSecondPage.promise);
      expect(await orderDiscount()).toBe(0);
      await gate!.refresh();
      expect(await orderDiscount()).toBe(0);
      releaseFull.resolve();
      const result = await full;
      expect(streamError(result)).toBeUndefined();
      expect(result.backlog).toBeFalsy();
      await gate!.refresh();
      expect(await orderDiscount()).toBe(PROMO);
      expect(await appliedPromos()).toEqual(
        sortedIds(promoA, promoC, promoD, promoE),
      );
    } finally {
      releasePartial.resolve();
      releaseFull.resolve();
      await Promise.allSettled([partial, full]);
    }
  });
});
