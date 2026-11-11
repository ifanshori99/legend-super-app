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
import { encodeCursor, outletIdSchema } from "@starter/shared/core";
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

async function page(stream: Stream, since?: string): Promise<Rec> {
  return (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: outletId as never,
    query: catalogSyncQuerySchema.parse({
      stream,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      limit: 100,
      ...(since ? { since } : {}),
    }),
  })) as unknown as Rec;
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
    await q("DELETE FROM promotions WHERE id = ANY($1::uuid[])", [
      [openId, quotaId, budgetId],
    ]);
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
    const source = ((await page("promotions")).records as Rec[]).find(
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
