// legend-09sxa / brief 533 B2 + B3 (architect 531 P2): written from the brief
// and the shared contract, not from the implementation.
//
// B2 (CTO decision after founder Q57/Q66). The promo engine already refuses
// promotions with a shared cap (quota/budget) at an edge, online or not, so the
// behaviour proven here is: uncapped promos stay alive offline until 24 h and
// close on a truncated pull; capped promos never give a discount at an edge:
//  - a promotion WITHOUT quota or budget stays usable while the edge is
//    offline (its catalog pull fails), until the 24 h freshness limit; it is
//    closed when a pull is TRUNCATED (hasMore, not finished) and reopens when
//    the pull completes;
//  - a promotion WITH a quota (quotaTotal) or budget (budgetIdr) is dead as
//    soon as the edge cannot reach the cloud: its counters would be wrong.
// B3: the edge keeps what it already granted. When the cloud lowers quotaTotal
//  or budgetIdr below the local uses_total / spent_idr, the sync must still
//  succeed, the edge stores max(cloud, local), and the promotion cannot be
//  used again (so the outlet never gives more than it was allowed).
//
// How the tests observe "alive": a checkout quote through the freshness guard
// (`withPromoFreshness(orderPromoPort)`) gives the nominal discount (7,777) or
// 0. The gate must therefore decide PER PROMOTION; a single global boolean
// cannot make the unquoted promotion alive and the quota one dead together.
//
// Assumptions (the brief is silent), each easy to change:
//  - "offline" = every catalog fetch fails (fetchPage rejects). The pull then
//    reports a stream error and must NOT erase the last success time of a
//    promotion without quota (the 24 h limit counts from the last success).
//  - The budget counts like the quota: budgetIdr != null makes a promotion
//    "capped" and dead offline.
//  - 24 h: at 23 h of age an offline promotion without quota is alive, at 25 h
//    it is closed (PROMO_STALE_AFTER_MS).
//  - The pull results here are read only through the shared pullCatalog
//    stream result `.error`, as in edge-promo-stream-sync.test.ts.
//
// NOTE for the engineer: with these semantics the existing test
// "an in-flight failed pull closes cached freshness before reading the first
// page" in edge-promo-stream-sync.test.ts (an uncapped promotion, expects
// promosEnabled() false after a failed pull) contradicts B2 and has to be
// updated together with the implementation.
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

const HOUR = 60 * 60_000;
const DISCOUNT = 7_777;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const openId = randomUUID(); // no quota, no budget
const quotaId = randomUUID(); // quotaTotal 100
const budgetId = randomUUID(); // budgetIdr 1_000_000
const openItem = randomUUID();
const quotaItem = randomUUID();
const budgetItem = randomUUID();
// Other suites retain ended headers in the shared tenant. The catalog must
// include those revocations, so our own promotion need not be on page one.
const earlierPromotionIds = Array.from({ length: 100 }, () => randomUUID());
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

async function seedPromotion(
  id: string,
  item: string,
  caps: { quotaTotal?: number; budgetIdr?: number } = {},
) {
  await q(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, voucher_required, starts_at,
        ends_at, conditions, benefit, stack_group, stackable, priority,
        quota_total, budget_idr)
     VALUES ($1,$2,$3,'','active',false,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z',
             $4,$5,$6,false,0,$7,$8)`,
    [
      id,
      tenantId,
      `Offline promo ${id.slice(0, 8)}`,
      JSON.stringify([
        { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
      ]),
      JSON.stringify({ kind: "nominal_off", amountIdr: DISCOUNT }),
      `o${id.slice(0, 8)}`,
      caps.quotaTotal ?? null,
      caps.budgetIdr ?? null,
    ],
  );
}

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

/** Include retained revocations before locating one of this file's fixtures. */
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
  fetchPage: (stream: string, since: string | null) => Promise<unknown> = (
    stream,
    since,
  ) => page(stream as Stream, since ?? undefined),
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

const offlinePull = () =>
  pull(async () => {
    throw new Error("Cloud unreachable");
  });

/** Discount a cashier gets on one item through the freshness guard. */
function guardedDiscount(item: string): Promise<number> {
  return withTenant(edge.database, scope("device"), async (tx) =>
    Number(
      (
        await guarded.quote(tx, scope("device"), {
          outletId: outletIdSchema.parse(outletId),
          channel: "dine_in",
          lines: [
            {
              menuItemId: item as never,
              quantity: 1,
              unitPriceIdr: 10_000 as never,
              lineTotalIdr: 10_000 as never,
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

/** Same quote without the freshness guard: only the quota/budget rules apply. */
function engineDiscount(item: string): Promise<number> {
  return withTenant(edge.database, scope("device"), async (tx) =>
    Number(
      (
        await orderPromoPort.quote(tx, scope("device"), {
          outletId: outletIdSchema.parse(outletId),
          channel: "dine_in",
          lines: [
            {
              menuItemId: item as never,
              quantity: 1,
              unitPriceIdr: 10_000 as never,
              lineTotalIdr: 10_000 as never,
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

/** Pretend the last successful promo/voucher sync was `ageMs` ago. */
async function ageCheckpoints(ageMs: number) {
  await edge.owner.query(
    "UPDATE edge_pull_checkpoints SET last_success_at = $2 WHERE edge_node_id = $1 AND stream IN ('catalog:promotions','catalog:vouchers')",
    [nodeId, new Date(Date.now() - ageMs)],
  );
}

async function edgeCounters(id: string) {
  return edge.rows(
    "SELECT uses_total, spent_idr::integer AS spent_idr, quota_total, budget_idr::integer AS budget_idr FROM promotions WHERE id = $1",
    [id],
  );
}

async function setLocalUse(id: string, uses: number, spent: number) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE promotions SET uses_total = $2, spent_idr = $3, updated_at = now() WHERE id = $1",
      [id, uses, spent],
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
    throw new Error("Requires disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet promosi offline",
  );
  await q(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, voucher_required, starts_at,
        ends_at, conditions, benefit, stack_group, stackable, priority)
     SELECT id, $2, 'Earlier ended promo', '', 'ended', false,
            '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '[]',
            '{"kind":"nominal_off","amountIdr":1}', 'earlier', false, 0
       FROM unnest($1::uuid[]) AS id`,
    [earlierPromotionIds, tenantId],
  );
  await seedPromotion(openId, openItem);
  await seedPromotion(quotaId, quotaItem, { quotaTotal: 100 });
  await seedPromotion(budgetId, budgetItem, { budgetIdr: 1_000_000 });
  const registered = await registerEdgeNode(scope("session"), actor, {
    outletId,
    role: "standby",
    label: "Edge offline promo",
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
  await q(
    "UPDATE promotions SET quota_total = 100, budget_idr = NULL, description = '' WHERE id = $1",
    [quotaId],
  );
  await q("UPDATE promotions SET budget_idr = 1000000 WHERE id = $1", [
    budgetId,
  ]);
  await q(
    "UPDATE promotions SET quota_total = NULL, budget_idr = NULL, description = '' WHERE id = $1",
    [openId],
  );
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
    await q(
      "DELETE FROM promotions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, [openId, quotaId, budgetId, ...earlierPromotionIds]],
    );
  } finally {
    await owner.end();
  }
});

describe("533 B2 offline and truncated pulls: uncapped promos live to 24 h, capped promos die", () => {
  it("control: after a complete pull the uncapped promotion gives its discount, capped ones never do at an edge", async () => {
    const result = await pull();
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeUndefined();
    await openGate();
    expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
    // The promo engine already refuses shared caps (quota/budget) in edge mode.
    expect(await guardedDiscount(quotaItem)).toBe(0);
    expect(await guardedDiscount(budgetItem)).toBe(0);
  });

  it("offline (pull fails) a promotion without quota stays alive, the quota and budget promotions give nothing", async () => {
    await pull();
    await openGate();
    const failed = await offlinePull();
    expect(
      failed.streams["promotions" as keyof typeof failed.streams]?.error,
    ).toBeDefined();
    await gate!.refresh();
    expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
    expect(await guardedDiscount(quotaItem)).toBe(0);
    expect(await guardedDiscount(budgetItem)).toBe(0);
  });

  it("repeated offline pulls keep an uncapped promotion alive and a capped one dead", async () => {
    await pull();
    await openGate();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await offlinePull();
      await gate!.refresh();
      expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
      expect(await guardedDiscount(quotaItem)).toBe(0);
    }
  });

  it("offline, an uncapped promotion is alive at 23 h since the last sync and closed at 25 h", async () => {
    await pull();
    await ageCheckpoints(23 * HOUR);
    await offlinePull();
    await openGate();
    expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
    expect(await guardedDiscount(quotaItem)).toBe(0);
    await ageCheckpoints(25 * HOUR);
    await offlinePull();
    await gate!.refresh();
    expect(await guardedDiscount(openItem)).toBe(0);
    expect(await guardedDiscount(quotaItem)).toBe(0);
    expect(await guardedDiscount(budgetItem)).toBe(0);
  });

  it("a truncated pull closes every promotion immediately, a finished pull reopens them", async () => {
    await pull();
    await openGate();
    expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
    const source = (await all("promotions")).find(
      (record) => record.id === openId,
    )!;
    const nextTxid = String(BigInt(String(source.syncTxid)) + 1n);
    const partial = await pull(
      async () => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: "promotions",
        records: [{ ...source, syncTxid: nextTxid }],
        nextCursor: encodeCursor(["cat2", nextTxid, openId]),
        hasMore: true,
      }),
      ["promotions"],
      1,
    );
    expect(partial.backlog).toBe(true);
    // No gate refresh: the cached state must already be closed.
    expect(await guardedDiscount(openItem)).toBe(0);
    expect(await guardedDiscount(quotaItem)).toBe(0);
    await gate!.refresh();
    expect(await guardedDiscount(openItem)).toBe(0);
    await pull(
      async (stream, since) => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records: [],
        nextCursor: since,
        hasMore: false,
      }),
      ["promotions"],
    );
    await gate!.refresh();
    expect(await guardedDiscount(openItem)).toBe(DISCOUNT);
    expect(await guardedDiscount(quotaItem)).toBe(0);
  });

  it("a promotion that gets a quota in the cloud is dead offline after the next sync", async () => {
    await pull();
    await q(
      "UPDATE promotions SET quota_total = 5, description = 'Now capped' WHERE id = $1",
      [openId],
    );
    await settleCloud(owner);
    await pull();
    await openGate();
    expect(await guardedDiscount(openItem)).toBe(0);
    await offlinePull();
    await gate!.refresh();
    expect(await guardedDiscount(openItem)).toBe(0);
    await q(
      "UPDATE promotions SET quota_total = NULL, description = '' WHERE id = $1",
      [openId],
    );
  });
});

describe("533 B3 quota and budget lowered in the cloud below local use", () => {
  it("50 local uses then cloud quota 30: sync succeeds, quota stored as 50, not usable again", async () => {
    await pull();
    expect(await engineDiscount(quotaItem)).toBe(DISCOUNT);
    await setLocalUse(quotaId, 50, 50 * DISCOUNT);
    await q(
      "UPDATE promotions SET quota_total = 30, description = 'Quota cut' WHERE id = $1",
      [quotaId],
    );
    await settleCloud(owner);
    const result = await pull();
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeUndefined();
    expect(
      (
        await edge.rows(
          "SELECT last_success_at FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = 'catalog:promotions'",
          [nodeId],
        )
      )[0]?.last_success_at,
    ).not.toEqual(new Date(0));
    expect(await edgeCounters(quotaId)).toEqual([
      {
        uses_total: 50,
        spent_idr: 50 * DISCOUNT,
        quota_total: 50,
        budget_idr: null,
      },
    ]);
    // Cloud metadata still arrives, but the outlet never gives a 51st use.
    expect(
      (
        await edge.rows("SELECT description FROM promotions WHERE id = $1", [
          quotaId,
        ])
      )[0]?.description,
    ).toBe("Quota cut");
    expect(await engineDiscount(quotaItem)).toBe(0);
  });

  it("budget lowered below the rupiah already granted locally: sync succeeds, budget stored as the local spend, not usable again", async () => {
    await pull();
    expect(await engineDiscount(budgetItem)).toBe(DISCOUNT);
    await setLocalUse(budgetId, 50, 50 * DISCOUNT);
    await q("UPDATE promotions SET budget_idr = 10000 WHERE id = $1", [
      budgetId,
    ]);
    await settleCloud(owner);
    const result = await pull();
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeUndefined();
    expect(await edgeCounters(budgetId)).toEqual([
      {
        uses_total: 50,
        spent_idr: 50 * DISCOUNT,
        quota_total: null,
        budget_idr: 50 * DISCOUNT,
      },
    ]);
    expect(await engineDiscount(budgetItem)).toBe(0);
  });

  it("a cloud quota above the local use is taken as is and the promotion works again", async () => {
    await pull();
    await setLocalUse(quotaId, 50, 50 * DISCOUNT);
    await q("UPDATE promotions SET quota_total = 50 WHERE id = $1", [quotaId]);
    await settleCloud(owner);
    await pull();
    expect(await engineDiscount(quotaItem)).toBe(0);
    await q("UPDATE promotions SET quota_total = 200 WHERE id = $1", [quotaId]);
    await settleCloud(owner);
    const result = await pull();
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeUndefined();
    expect((await edgeCounters(quotaId))[0]).toMatchObject({
      uses_total: 50,
      quota_total: 200,
    });
    expect(await engineDiscount(quotaItem)).toBe(DISCOUNT);
  });
});

// brief 533c P2 (money, tier K): the money risk is the promo gate opening on an
// UNFINISHED multi-page promo snapshot (some pages applied, others not: e.g. a
// promo being replaced, old one not yet ended, new one already active). A
// retry that gets NO page at all (cloud unreachable) must not "complete" the
// stream: the gate stays closed, no order gets a discount from the unfinished
// snapshot, and the discount never exceeds the promo in force (Rp20,000, A),
// until a full sync reaches the end.
//
// Assumptions (the brief is silent), each easy to change:
//  - The records are built from a real cloud page (shape) and edited. Promo A
//    (Rp20,000 on the quoted item) is in force from the first sync. The second
//    sync has two pages with harmless unrelated changes: new promos C and D on
//    other items. The pull is truncated after page 1 (maxPages 1), so A alone
//    still gives Rp20,000 in the unguarded engine, but the sync is unfinished.
//    (Not about stacking: the test does not depend on A and B combining.)
//  - "Re-read fails" = the gate's own database handle throws on every call
//    while it is broken (the quote path reads the edge database directly).
//  - While the sync is unfinished, the guarded discount must be 0 (closed),
//    and at no moment above Rp20,000.
describe("533c P2 a partial promo sync is never completed by a retry that gets no page", () => {
  const PROMO = 20_000;
  const LINE = 100_000;
  const promoA = randomUUID();
  const promoC = randomUUID();
  const promoD = randomUUID();

  async function cloudHistory(): Promise<Rec[]> {
    const source = (await all("promotions")).find(
      (record) => record.id === openId,
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
      record(promoA, "Promo A", openItem, "grp_a", base + 10n),
      record(promoC, "Promo C", randomUUID(), "grp_c", base + 20n),
      record(promoD, "Promo D", randomUUID(), "grp_d", base + 21n),
    ];
  }

  /** Serves the records newer than the cursor, `size` per page. */
  const serve =
    (records: Rec[], size: number) =>
    async (stream: string, since: string | null) => {
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

  const quoteTotal = (port: typeof orderPromoPort) =>
    withTenant(edge.database, scope("device"), async (tx) =>
      Number(
        (
          await port.quote(tx, scope("device"), {
            outletId: outletIdSchema.parse(outletId),
            channel: "dine_in",
            lines: [
              {
                menuItemId: openItem as never,
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
  const orderDiscount = () => quoteTotal(guarded);
  /** Promotions the edge database holds as active, among A, C and D. */
  const appliedPromos = async () => {
    const rows = await edge.owner.query<{ id: string }>(
      "SELECT id FROM promotions WHERE status = 'active' AND id = ANY($1::uuid[])",
      [[promoA, promoC, promoD]],
    );
    return rows.rows.map((row) => row.id).sort();
  };
  const sortedIds = (...ids: string[]) => [...ids].sort();
  const streamError = (result: Awaited<ReturnType<typeof pull>>) =>
    result.streams["promotions" as keyof typeof result.streams]?.error;

  /** Gate whose own database reads can be made to fail. */
  let readsBroken = false;
  async function openFlakyGate() {
    setPromoGateEdgeModeForTests(() => true);
    gate?.stop();
    const flaky = new Proxy(edge.database, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (readsBroken && typeof value === "function") {
          return () => {
            throw new Error("Edge database read failed");
          };
        }
        return value;
      },
    });
    gate = startPromoGate({
      context: scope("device"),
      edgeNodeId: nodeId,
      database: flaky as typeof db,
      clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
    });
    await gate.refresh();
  }

  /** A is in force and fresh; then a two-page sync (C, D) stops after page 1. */
  async function startWithUnfinishedSync(open: () => Promise<void>) {
    const cloud = await cloudHistory();
    expect(
      streamError(await pull(serve(cloud.slice(0, 1), 10))),
    ).toBeUndefined();
    await open();
    expect(await orderDiscount()).toBe(PROMO);
    const partial = await pull(serve(cloud, 1), ["promotions"], 1);
    expect(partial.backlog).toBe(true);
    // Precondition: the unfinished sync is really stored (A and C applied, D
    // missing; an unguarded quote is not usable here, the engine itself is
    // closed while the stream is pending), so the guarded gate must be closed.
    expect(await appliedPromos()).toEqual(sortedIds(promoA, promoC));
    expect(await orderDiscount()).toBe(0);
    return cloud;
  }

  afterEach(() => {
    readsBroken = false;
  });

  it("after a partial sync, retries with no page keep the gate closed (cached, refreshed and repeated); a full sync reopens it with only the promo in force", async () => {
    const cloud = await startWithUnfinishedSync(openGate);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(streamError(await offlinePull())).toBeDefined();
      // No refresh yet: the cached state must already be closed.
      expect(await orderDiscount()).toBe(0);
      await gate!.refresh();
      expect(await orderDiscount()).toBe(0);
    }
    expect(await appliedPromos()).toEqual(sortedIds(promoA, promoC));
    const done = await pull(serve(cloud, 1));
    expect(streamError(done)).toBeUndefined();
    expect(done.backlog).toBeFalsy();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
    expect(await appliedPromos()).toEqual(sortedIds(promoA, promoC, promoD));
  });

  it("when the gate cannot re-read the checkpoint after the failed retry it stays closed, and reopens only after a full sync", async () => {
    const cloud = await startWithUnfinishedSync(openFlakyGate);
    expect(streamError(await offlinePull())).toBeDefined();
    readsBroken = true;
    await gate!.refresh().catch(() => undefined);
    expect(await orderDiscount()).toBe(0);
    readsBroken = false;
    expect(await orderDiscount()).toBe(0);
    await gate!.refresh();
    expect(await orderDiscount()).toBe(0);
    expect(streamError(await pull(serve(cloud, 1)))).toBeUndefined();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
  });

  it("a gate restarted after the failed retry (new process) still sees the unfinished sync and stays closed", async () => {
    const cloud = await startWithUnfinishedSync(openGate);
    expect(streamError(await offlinePull())).toBeDefined();
    await openGate();
    expect(await orderDiscount()).toBe(0);
    expect(streamError(await pull(serve(cloud, 1)))).toBeUndefined();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
  });

  it("legend-09sxa concurrent retry cannot reopen a partial snapshot from its earlier complete checkpoint", async () => {
    const cloud = await cloudHistory();
    expect(
      streamError(await pull(serve(cloud.slice(0, 1), 10))),
    ).toBeUndefined();
    await openGate();
    expect(await orderDiscount()).toBe(PROMO);

    let releasePartial!: () => void;
    let firstFetch!: () => void;
    let retryFetch!: () => void;
    let failRetry!: () => void;
    let retryReachedFetch = false;
    const partialMayReturn = new Promise<void>((resolve) => {
      releasePartial = resolve;
    });
    const partialArrived = new Promise<void>((resolve) => {
      firstFetch = resolve;
    });
    const retryArrived = new Promise<void>((resolve) => {
      retryFetch = resolve;
    });
    const retryMayFail = new Promise<void>((resolve) => {
      failRetry = resolve;
    });
    const source = serve(cloud, 1);
    const partial = pull(
      async (stream, since) => {
        firstFetch();
        await partialMayReturn;
        return source(stream, since);
      },
      ["promotions"],
      1,
    );
    await partialArrived;
    const retry = pull(async () => {
      retryReachedFetch = true;
      retryFetch();
      await retryMayFail;
      throw new Error("Concurrent cloud transport failure");
    }, ["promotions"]);
    try {
      // Before serialization, retry reaches fetch with the old complete
      // checkpoint. A serialized retry queues instead; the bounded wait lets
      // that implementation proceed without making fetch overlap a contract.
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        retryArrived,
        new Promise<void>((resolve) => {
          wait = setTimeout(resolve, 250);
        }),
      ]);
      if (wait) clearTimeout(wait);
      const retryReadOldCheckpoint = retryReachedFetch;
      releasePartial();
      const unfinished = await partial;
      expect(unfinished.backlog).toBe(true);
      expect(await appliedPromos()).toEqual(sortedIds(promoA, promoC));
      expect(await orderDiscount()).toBe(0);
      await retryArrived;
      failRetry();
      expect(streamError(await retry)).toBeDefined();
      // Check the cached provider before a refresh can repair it from disk.
      expect(
        await orderDiscount(),
        `Retry fetched before partial commit: ${retryReadOldCheckpoint}`,
      ).toBe(0);
      await gate!.refresh();
      expect(await orderDiscount()).toBe(0);
      expect(streamError(await pull(serve(cloud, 1)))).toBeUndefined();
      await gate!.refresh();
      expect(await orderDiscount()).toBe(PROMO);
    } finally {
      releasePartial();
      failRetry();
      await Promise.allSettled([partial, retry]);
    }
  });

  it("legend-09sxa a checkpoint read failure closes cached discounts without touching the catalog", async () => {
    const cloud = await cloudHistory();
    expect(
      streamError(await pull(serve(cloud.slice(0, 1), 10))),
    ).toBeUndefined();
    await openGate();
    expect(await orderDiscount()).toBe(PROMO);
    const before = await appliedPromos();
    let fetches = 0;
    const unreadable = new Proxy(edge.database, {
      get(target, property) {
        if (property === "transaction")
          return () => {
            throw new Error("Checkpoint database unavailable");
          };
        return Reflect.get(target, property, target);
      },
    });
    const result = await pullCatalog({
      database: unreadable as typeof db,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: ["promotions"],
      fetchPage: async () => {
        fetches += 1;
        throw new Error("Must not fetch without a checkpoint");
      },
    });
    expect(streamError(result)).toBeDefined();
    expect(fetches).toBe(0);
    expect(await appliedPromos()).toEqual(before);
    expect(await orderDiscount()).toBe(0);
    expect(
      streamError(await pull(serve(cloud.slice(0, 1), 10))),
    ).toBeUndefined();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
  });

  it("control (533 B2): a pure fetch failure with a complete stored checkpoint keeps the promo alive", async () => {
    const cloud = await cloudHistory();
    expect(
      streamError(await pull(serve(cloud.slice(0, 1), 10))),
    ).toBeUndefined();
    await openGate();
    expect(await orderDiscount()).toBe(PROMO);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(streamError(await offlinePull())).toBeDefined();
      expect(await orderDiscount()).toBe(PROMO);
      await gate!.refresh();
      expect(await orderDiscount()).toBe(PROMO);
    }
    await openGate();
    expect(await orderDiscount()).toBe(PROMO);
  });

  it("control: once a full sync reached the end, a later fetch failure no longer closes the gate", async () => {
    const cloud = await startWithUnfinishedSync(openGate);
    expect(streamError(await offlinePull())).toBeDefined();
    expect(streamError(await pull(serve(cloud, 1)))).toBeUndefined();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
    expect(streamError(await offlinePull())).toBeDefined();
    await gate!.refresh();
    expect(await orderDiscount()).toBe(PROMO);
  });
});
