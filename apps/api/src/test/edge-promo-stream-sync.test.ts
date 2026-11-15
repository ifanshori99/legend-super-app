// legend-09sxa / brief 528: authoritative promotions and voucher metadata
// travel through the existing catalog pipeline. Cloud and edge are separate
// databases; real SQL and order-engine quotes exercise imported metadata.
import { createHash, randomUUID } from "node:crypto";
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
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  promosEnabled,
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
import { loadStackingPolicy } from "../services/crm-promo-engine.ts";
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
  protocolVersion: number;
  stream: string;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const otherTenant = randomUUID();
const actor = randomUUID();
const promoId = randomUUID();
const voucherId = randomUUID();
const foreignPromoId = randomUUID();
const foreignVoucherId = randomUUID();
const itemId = randomUUID();
const before = "2026-11-01T00:00:00.000Z";
const after = "2026-12-01T00:00:00.000Z";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const q = (text: string, params: unknown[] = []) => owner.query(text, params);
let outletId = "";
let edge: EdgeDatabase;
let nodeId = "";
let gate: PromoGateHandle | undefined;

const scope = (source: "session" | "device") =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function seedPromotion(id: string, tenant: string) {
  await q(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, voucher_required, starts_at,
        ends_at, conditions, benefit, stack_group, stackable, priority)
     VALUES ($1,$2,$3,'','active',false,$4,$5,$6,$7,$8,false,0)`,
    [
      id,
      tenant,
      `Stream promo ${id.slice(0, 8)}`,
      before,
      after,
      JSON.stringify([
        { kind: "item_quantity", menuItemIds: [itemId], minQuantity: 1 },
      ]),
      JSON.stringify({ kind: "nominal_off", amountIdr: 7_777 }),
      `s${id.slice(0, 8)}`,
    ],
  );
}

async function seedVoucher(id: string, tenant: string, promotionId: string) {
  await q(
    `INSERT INTO vouchers
       (id, tenant_id, promotion_id, code_hash, source, value_idr, valid_from, valid_until)
     VALUES ($1,$2,$3,$4,'manual',7777,$5,$6)`,
    [
      id,
      tenant,
      promotionId,
      createHash("sha256").update(id).digest("hex"),
      before,
      after,
    ],
  );
}

async function page(
  stream: Stream,
  since?: string,
  limit = 100,
): Promise<Page> {
  // This assertion makes the original missing-stream bug fail explicitly,
  // before a schema error can obscure the actual missing capability.
  expect(CATALOG_SYNC_STREAMS).toContain(stream);
  return (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: outletId as never,
    query: catalogSyncQuerySchema.parse({
      stream,
      protocolVersion: CATALOG_PROTOCOL_VERSION,
      limit,
      ...(since ? { since } : {}),
    }),
  })) as unknown as Page;
}

async function all(stream: Stream) {
  const records: Rec[] = [];
  let since: string | undefined;
  for (let count = 0; count < 1000; count += 1) {
    const next = await page(stream, since, 100);
    records.push(...next.records);
    if (!next.hasMore) return records;
    expect(next.nextCursor).not.toBeNull();
    since = next.nextCursor!;
  }
  throw new Error("Catalog did not finish paging");
}

const checkpoint = (stream: Stream) =>
  edge.rows(
    `SELECT watermark, last_success_at FROM edge_pull_checkpoints
       WHERE edge_node_id = $1 AND stream = $2`,
    [nodeId, `catalog:${stream}`],
  );

const edgeQuote = () =>
  withTenant(edge.database, scope("device"), (tx) =>
    orderPromoPort.quote(tx, scope("device"), {
      outletId: outletIdSchema.parse(outletId),
      channel: "dine_in",
      lines: [
        {
          menuItemId: itemId as never,
          quantity: 1,
          unitPriceIdr: 10_000 as never,
          lineTotalIdr: 10_000 as never,
        },
      ],
      customer: null,
      voucherCode: null,
      at: new Date("2026-11-11T03:00:00.000Z"),
    }),
  );

async function pull(
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet stream promosi",
  );
  await q(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1,$2,'Tenant stream lain','lengkap','active','shared',
       '{"modules":[],"integrationProviders":[]}',
       '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}',$3)`,
    [otherTenant, `stream-${otherTenant}`, actor],
  );
  await seedPromotion(promoId, tenantId);
  await seedPromotion(foreignPromoId, otherTenant);
  await seedVoucher(voucherId, tenantId, promoId);
  await seedVoucher(foreignVoucherId, otherTenant, foreignPromoId);
  const registered = await registerEdgeNode(scope("session"), actor, {
    outletId,
    role: "standby",
    label: "Edge stream promo",
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
  await q("DELETE FROM promotion_outlets WHERE promotion_id = $1", [promoId]);
  await q(
    "UPDATE promotions SET status = 'active', starts_at = $2, ends_at = $3, outlet_scope = 'all_except' WHERE id = $1",
    [promoId, before, after],
  );
  await q(
    "UPDATE vouchers SET status = 'issued', cancelled_reason = NULL WHERE id = $1",
    [voucherId],
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
  setPromoGateEdgeModeForTests(null);
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    await q("DELETE FROM promotion_outlets WHERE promotion_id = $1", [promoId]);
    await q("DELETE FROM vouchers WHERE id = ANY($1::uuid[])", [
      [voucherId, foreignVoucherId],
    ]);
    await q("DELETE FROM promotions WHERE id = ANY($1::uuid[])", [
      [promoId, foreignPromoId],
    ]);
    // Protected nodes are retained in the disposable cloud database; its
    // teardown drops the private node/outlet together.
    await q("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  } finally {
    await owner.end();
  }
});

describe("528 promotions and voucher catalog streams", () => {
  it("registers both streams with the versioned page contract", () => {
    for (const stream of ["promotions", "vouchers"] as const) {
      expect(CATALOG_SYNC_STREAMS).toContain(stream);
      expect(
        catalogSyncPageSchema.safeParse({
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream,
          records: [],
          nextCursor: null,
          hasMore: false,
        }).success,
      ).toBe(true);
    }
    expect(CATALOG_SYNC_STREAMS.indexOf("promotions" as never)).toBeLessThan(
      CATALOG_SYNC_STREAMS.indexOf("vouchers" as never),
    );
  });

  it("rejects unknown discount restrictions instead of applying a truncated rule", async () => {
    const promotion = (await all("promotions")).find(
      (row) => row.id === promoId,
    )!;
    const voucher = (await all("vouchers")).find(
      (row) => row.id === voucherId,
    )!;
    const pageFor = (stream: string, record: Rec) => ({
      stream,
      records: [record],
      nextCursor: null,
      hasMore: false,
    });
    expect(
      catalogSyncPageSchema.safeParse(pageFor("promotions", promotion)).success,
    ).toBe(true);
    expect(
      catalogSyncPageSchema.safeParse(pageFor("vouchers", voucher)).success,
    ).toBe(true);
    const conditions = promotion.conditions as Rec[];
    const benefit = promotion.benefit as Rec;
    const settings = {
      stackingPolicy: {
        mode: "exclusive",
        maxStacked: 1,
        allowSameGroup: false,
      },
      updatedBy: null,
      updatedAt: before,
      syncTxid: "1",
    };
    for (const changed of [
      { ...promotion, minimumNewRestriction: 1 },
      {
        ...promotion,
        conditions: [{ ...conditions[0], minimumNewRestriction: 1 }],
      },
      { ...promotion, benefit: { ...benefit, minimumNewRestriction: 1 } },
      {
        ...promotion,
        outletOverrides: [
          {
            outletId,
            enabled: true,
            updatedBy: null,
            updatedAt: before,
            minimumNewRestriction: 1,
          },
        ],
      },
      {
        ...promotion,
        stackingSettings: { ...settings, minimumNewRestriction: 1 },
      },
      {
        ...promotion,
        stackingSettings: {
          ...settings,
          stackingPolicy: {
            ...settings.stackingPolicy,
            minimumNewRestriction: 1,
          },
        },
      },
    ]) {
      expect(
        catalogSyncPageSchema.safeParse(pageFor("promotions", changed)).success,
      ).toBe(false);
    }
    expect(
      catalogSyncPageSchema.safeParse(
        pageFor("vouchers", { ...voucher, minimumNewRestriction: 1 }),
      ).success,
    ).toBe(false);
  });

  it("exports only the credential tenant, with exact money and commit-safe versions", async () => {
    for (const [stream, mine, foreign] of [
      ["promotions", promoId, foreignPromoId],
      ["vouchers", voucherId, foreignVoucherId],
    ] as const) {
      const records = await all(stream);
      expect(records.some((record) => record.id === mine)).toBe(true);
      expect(records.some((record) => record.id === foreign)).toBe(false);
      for (const record of records) {
        expect(record.tenantId).toBe(tenantId);
        expect(record.syncTxid).toMatch(/^\d+$/);
      }
      const our = records.find((record) => record.id === mine)!;
      if (stream === "promotions")
        expect(our.benefit).toEqual({ kind: "nominal_off", amountIdr: 7_777 });
      else expect(our.valueIdr).toBe(7_777);
      const first = await page(stream, undefined, 1);
      expect(first.protocolVersion).toBe(CATALOG_PROTOCOL_VERSION);
      expect(decodeCursor(first.nextCursor!)[0]).toBe("cat2");
      const next = await page(stream, first.nextCursor!, 1);
      expect(
        next.records.every((record) => record.id !== first.records[0]?.id),
      ).toBe(true);
    }
  });

  it("pulls real documents into edge and resumes each checkpoint independently", async () => {
    const first = await pull();
    for (const stream of ["promotions", "vouchers"] as const) {
      expect(
        first.streams[stream as keyof typeof first.streams]?.error,
      ).toBeUndefined();
      const saved = await checkpoint(stream);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.last_success_at).toBeInstanceOf(Date);
      const calls: (string | null)[] = [];
      await pull(
        async (requested, since) => {
          calls.push(since);
          return page(requested as Stream, since ?? undefined);
        },
        [stream],
      );
      expect(calls[0]).toBe(saved[0]?.watermark);
    }
    expect(
      await edge.rows("SELECT status, benefit FROM promotions WHERE id = $1", [
        promoId,
      ]),
    ).toEqual([
      { status: "active", benefit: { kind: "nominal_off", amountIdr: 7_777 } },
    ]);
    expect(
      await edge.rows(
        "SELECT payload->>'status' AS status, (payload->>'valueIdr')::integer AS value_idr FROM edge_voucher_catalog WHERE id = $1",
        [voucherId],
      ),
    ).toEqual([{ status: "issued", value_idr: 7_777 }]);
    expect(await edge.rows("SELECT id FROM vouchers")).toEqual([]);
  });

  it("syncs a cloud deactivation and expiry without an old page reviving them", async () => {
    const oldPromos = await all("promotions");
    await pull();
    expect((await edgeQuote()).totalDiscountIdr).toBe(7_777);
    await q(
      "UPDATE promotions SET status = 'paused', ends_at = '2026-11-10T00:00:00Z' WHERE id = $1",
      [promoId],
    );
    await q(
      "UPDATE vouchers SET status = 'cancelled', cancelled_reason = 'Cloud void' WHERE id = $1",
      [voucherId],
    );
    await settleCloud(owner);
    await pull();
    const updated = await edge.rows(
      "SELECT status, ends_at FROM promotions WHERE id = $1",
      [promoId],
    );
    expect(updated[0]?.status).toBe("paused");
    expect(updated[0]?.ends_at).toEqual(new Date("2026-11-10T00:00:00.000Z"));
    expect((await edgeQuote()).totalDiscountIdr).toBe(0);
    expect(
      (
        await edge.rows(
          "SELECT payload->>'status' AS status FROM edge_voucher_catalog WHERE id = $1",
          [voucherId],
        )
      )[0]?.status,
    ).toBe("cancelled");
    const saved = await checkpoint("promotions");
    await pull(
      async () => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: "promotions",
        records: oldPromos,
        nextCursor: saved[0]?.watermark,
        hasMore: false,
      }),
      ["promotions"],
    );
    expect(
      (
        await edge.rows("SELECT status FROM promotions WHERE id = $1", [
          promoId,
        ])
      )[0]?.status,
    ).toBe("paused");
    expect((await edgeQuote()).totalDiscountIdr).toBe(0);
  });

  it("an active promotion expired in the cloud gives no edge discount after sync", async () => {
    await pull();
    expect((await edgeQuote()).totalDiscountIdr).toBe(7_777);
    await q(
      "UPDATE promotions SET ends_at = '2026-11-10T00:00:00Z' WHERE id = $1",
      [promoId],
    );
    await settleCloud(owner);
    await pull();
    expect((await edgeQuote()).totalDiscountIdr).toBe(0);
  });

  it("cloud metadata resync retains locally consumed uses and rupiah", async () => {
    await pull();
    const version = await edge.rows(
      "SELECT sync_txid FROM promotions WHERE id = $1",
      [promoId],
    );
    const client = await edge.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE promotions SET uses_total = 2, spent_idr = 15554, updated_at = now() WHERE id = $1",
        [promoId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(
      await edge.rows("SELECT sync_txid FROM promotions WHERE id = $1", [
        promoId,
      ]),
    ).toEqual(version);
    await q(
      "UPDATE promotions SET description = 'Cloud metadata revision' WHERE id = $1",
      [promoId],
    );
    await settleCloud(owner);
    await pull();
    expect(
      await edge.rows(
        "SELECT description, uses_total, spent_idr::integer AS spent_idr FROM promotions WHERE id = $1",
        [promoId],
      ),
    ).toEqual([
      {
        description: "Cloud metadata revision",
        uses_total: 2,
        spent_idr: 15_554,
      },
    ]);
  });

  it("syncs a customer-bound voucher without its holder locally and never makes it redeemable", async () => {
    const holderId = randomUUID();
    const boundVoucherId = randomUUID();
    const code = `BOUND${randomUUID().replaceAll("-", "").toUpperCase()}`;
    await q(
      `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status)
       VALUES ($1,$2,$3,'Cloud-only voucher holder','pending_verification')`,
      [holderId, tenantId, randomUUID()],
    );
    await q(
      `INSERT INTO vouchers
         (id,tenant_id,customer_profile_id,code_hash,source,value_idr,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,'manual',7777,$5,$6)`,
      [
        boundVoucherId,
        tenantId,
        holderId,
        createHash("sha256").update(code).digest("hex"),
        before,
        after,
      ],
    );
    try {
      await settleCloud(owner);
      expect(
        await edge.rows("SELECT id FROM customer_profiles WHERE id = $1", [
          holderId,
        ]),
      ).toEqual([]);
      const result = await pull();
      // Before the shadow catalog exists, canonical vouchers.customer_profile_id
      // rejects this otherwise valid cloud document and freshness stays closed.
      expect(
        result.streams["vouchers" as keyof typeof result.streams]?.error,
      ).toBeUndefined();
      const saved = await edge.rows(
        "SELECT payload FROM edge_voucher_catalog WHERE id = $1",
        [boundVoucherId],
      );
      expect(saved[0]?.payload).toMatchObject({
        id: boundVoucherId,
        customerProfileId: holderId,
        status: "issued",
        valueIdr: 7_777,
      });
      expect(
        await edge.rows("SELECT id FROM vouchers WHERE id = $1", [
          boundVoucherId,
        ]),
      ).toEqual([]);
      expect((await checkpoint("vouchers"))[0]?.last_success_at).not.toEqual(
        new Date(0),
      );
      setPromoGateEdgeModeForTests(() => true);
      gate = startPromoGate({
        context: scope("device"),
        edgeNodeId: nodeId,
        database: edge.database as typeof db,
        clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
      });
      await gate.refresh();
      expect(promosEnabled()).toBe(true);
      await expect(
        withTenant(edge.database, scope("device"), (tx) =>
          orderPromoPort.quote(tx, scope("device"), {
            outletId: outletIdSchema.parse(outletId),
            channel: "dine_in",
            lines: [
              {
                menuItemId: itemId as never,
                quantity: 1,
                unitPriceIdr: 10_000 as never,
                lineTotalIdr: 10_000 as never,
              },
            ],
            customer: null,
            voucherCode: code,
            at: new Date("2026-11-11T03:00:00.000Z"),
          }),
        ),
      ).rejects.toThrow(/online|cloud/i);
      expect(
        await edge.rows(
          "SELECT payload FROM edge_voucher_catalog WHERE id = $1",
          [boundVoucherId],
        ),
      ).toEqual(saved);
      expect(
        await edge.rows("SELECT id FROM vouchers WHERE id = $1", [
          boundVoucherId,
        ]),
      ).toEqual([]);
      const redeemedOrderId = createUlid();
      await q(
        "UPDATE vouchers SET status = 'redeemed', redeemed_at = now(), redeemed_order_id = $2 WHERE id = $1",
        [boundVoucherId, ulidToUuid(redeemedOrderId)],
      );
      await settleCloud(owner);
      const redeemedPull = await pull();
      expect(
        redeemedPull.streams["vouchers" as keyof typeof redeemedPull.streams]
          ?.error,
      ).toBeUndefined();
      expect(
        (
          await edge.rows(
            "SELECT payload FROM edge_voucher_catalog WHERE id = $1",
            [boundVoucherId],
          )
        )[0]?.payload,
      ).toMatchObject({
        id: boundVoucherId,
        customerProfileId: holderId,
        status: "redeemed",
        redeemedOrderId,
      });
      expect(
        await edge.rows("SELECT id FROM orders WHERE id = $1", [
          ulidToUuid(redeemedOrderId),
        ]),
      ).toEqual([]);
      expect(
        await edge.rows("SELECT id FROM vouchers WHERE id = $1", [
          boundVoucherId,
        ]),
      ).toEqual([]);
    } finally {
      await q("DELETE FROM vouchers WHERE id = $1", [boundVoucherId]);
      await q("DELETE FROM customer_profiles WHERE id = $1", [holderId]);
    }
  });

  it("an older distinct promotion cannot reopen a newer restrictive stacking policy", async () => {
    const source = (await all("promotions")).find(
      (record) => record.id === promoId,
    )!;
    const baseVersion = BigInt(String(source.syncTxid));
    const exclusive = {
      mode: "exclusive",
      maxStacked: 1,
      allowSameGroup: false,
    };
    const permissive = {
      mode: "stackable",
      maxStacked: 2,
      allowSameGroup: true,
    };
    const apply = async (record: Rec) =>
      pull(
        async () => ({
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream: "promotions",
          records: [record],
          nextCursor: encodeCursor([
            "cat2",
            String(record.syncTxid),
            String(record.id),
          ]),
          hasMore: false,
        }),
        ["promotions"],
      );
    const settings = (stackingPolicy: unknown, version: bigint) => ({
      stackingPolicy,
      updatedBy: null,
      updatedAt: new Date().toISOString(),
      syncTxid: String(version),
    });
    await apply({
      ...source,
      stackable: true,
      stackGroup: "newer",
      syncTxid: String(baseVersion + 100n),
      stackingSettings: settings(exclusive, baseVersion + 100n),
    });
    await apply({
      ...source,
      id: randomUUID(),
      name: "Older unseen promotion",
      stackable: true,
      stackGroup: "older",
      syncTxid: String(baseVersion + 50n),
      stackingSettings: settings(permissive, baseVersion + 50n),
    });
    expect(
      await withTenant(edge.database, scope("device"), (tx) =>
        loadStackingPolicy(tx, scope("device")),
      ),
    ).toEqual(exclusive);
    expect((await edgeQuote()).totalDiscountIdr).toBe(7_777);

    // A later permissive setting is legitimate; deleting that setting must
    // restore the exclusive default with a versioned tombstone.
    await apply({
      ...source,
      stackable: true,
      stackGroup: "newer",
      syncTxid: String(baseVersion + 200n),
      stackingSettings: settings(permissive, baseVersion + 200n),
    });
    expect((await edgeQuote()).totalDiscountIdr).toBe(10_000);
    await apply({
      ...source,
      stackable: true,
      stackGroup: "newer",
      syncTxid: String(baseVersion + 300n),
      stackingSettings: null,
    });
    await apply({
      ...source,
      id: randomUUID(),
      name: "Stale policy after deletion",
      stackable: true,
      stackGroup: "stale",
      syncTxid: String(baseVersion + 250n),
      stackingSettings: settings(permissive, baseVersion + 250n),
    });
    expect(
      await withTenant(edge.database, scope("device"), (tx) =>
        loadStackingPolicy(tx, scope("device")),
      ),
    ).toEqual(exclusive);
    expect((await edgeQuote()).totalDiscountIdr).toBe(7_777);
  });

  it("carries outlet disablement and later removal as a new parent document", async () => {
    await pull();
    await q(
      "INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled) VALUES ($1,$2,$3,false)",
      [tenantId, promoId, outletId],
    );
    await settleCloud(owner);
    await pull();
    expect(
      await edge.rows(
        "SELECT enabled FROM promotion_outlets WHERE promotion_id = $1 AND outlet_id = $2",
        [promoId, outletId],
      ),
    ).toEqual([{ enabled: false }]);
    await q(
      "DELETE FROM promotion_outlets WHERE promotion_id = $1 AND outlet_id = $2",
      [promoId, outletId],
    );
    await settleCloud(owner);
    await pull();
    expect(
      await edge.rows(
        "SELECT enabled FROM promotion_outlets WHERE promotion_id = $1",
        [promoId],
      ),
    ).toEqual([]);
  });

  it("a rejected voucher page does not advance its freshness or alter metadata", async () => {
    await pull();
    const saved = await checkpoint("vouchers");
    const stored = await edge.rows(
      "SELECT row_to_json(t) AS row FROM edge_voucher_catalog t WHERE id = $1",
      [voucherId],
    );
    const result = await pull(async (stream, since) => {
      if (stream === "vouchers") throw new Error("Cloud unreachable");
      return page(stream as Stream, since ?? undefined);
    });
    expect(
      result.streams["vouchers" as keyof typeof result.streams]?.error,
    ).toBeDefined();
    // 533 B2: an unreachable cloud (no page arrived) leaves the checkpoint as
    // it was; it neither advances nor is closed. The 24 h limit still applies.
    expect((await checkpoint("vouchers"))[0]).toEqual(saved[0]);
    expect(
      await edge.rows(
        "SELECT row_to_json(t) AS row FROM edge_voucher_catalog t WHERE id = $1",
        [voucherId],
      ),
    ).toEqual(stored);
  });

  it("rejects a foreign-tenant document atomically and keeps its checkpoint", async () => {
    await pull();
    const saved = await checkpoint("promotions");
    const records = (await all("promotions")).filter(
      (record) => record.id === promoId,
    );
    const result = await pull(
      async () => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: "promotions",
        records: [{ ...records[0], tenantId: otherTenant, id: foreignPromoId }],
        nextCursor: saved[0]?.watermark,
        hasMore: false,
      }),
      ["promotions"],
    );
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeDefined();
    expect((await checkpoint("promotions"))[0]).toEqual({
      watermark: saved[0]?.watermark,
      last_success_at: new Date(0),
    });
    expect(
      await edge.rows("SELECT id FROM promotions WHERE id = $1", [
        foreignPromoId,
      ]),
    ).toEqual([]);
    expect(
      (
        await edge.rows("SELECT status FROM promotions WHERE id = $1", [
          promoId,
        ])
      )[0]?.status,
    ).toBe("active");
  });

  it("a partial pull immediately closes a cached fresh gate until all pages finish", async () => {
    await pull();
    setPromoGateEdgeModeForTests(() => true);
    gate = startPromoGate({
      context: scope("device"),
      edgeNodeId: nodeId,
      database: edge.database as typeof db,
      clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
    });
    await gate.refresh();
    expect(promosEnabled()).toBe(true);
    const old = (await all("promotions")).find(
      (record) => record.id === promoId,
    )!;
    const nextTxid = String(BigInt(String(old.syncTxid)) + 1n);
    const partial = await pull(
      async () => ({
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream: "promotions",
        records: [{ ...old, syncTxid: nextTxid }],
        nextCursor: encodeCursor(["cat2", nextTxid, promoId]),
        hasMore: true,
      }),
      ["promotions"],
      1,
    );
    expect(partial.backlog).toBe(true);
    // No gate refresh: the old successful checkpoint is cached in memory.
    expect(promosEnabled()).toBe(false);
    await gate.refresh();
    expect(promosEnabled()).toBe(false);
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
    await gate.refresh();
    expect(promosEnabled()).toBe(true);
  });

  it("an offline failed pull keeps a promotion without quota alive (until the 24 h limit); only a truncated pull closes it (brief 533 B2)", async () => {
    await pull();
    setPromoGateEdgeModeForTests(() => true);
    gate = startPromoGate({
      context: scope("device"),
      edgeNodeId: nodeId,
      database: edge.database as typeof db,
      clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
    });
    await gate.refresh();
    expect(promosEnabled()).toBe(true);
    const guardedQuote = () =>
      withTenant(edge.database, scope("device"), (tx) =>
        withPromoFreshness(orderPromoPort).quote(tx, scope("device"), {
          outletId: outletIdSchema.parse(outletId),
          channel: "dine_in",
          lines: [
            {
              menuItemId: itemId as never,
              quantity: 1,
              unitPriceIdr: 10_000 as never,
              lineTotalIdr: 10_000 as never,
            },
          ],
          customer: null,
          voucherCode: null,
          at: new Date("2026-11-11T03:00:00.000Z"),
        }),
      );
    expect((await guardedQuote()).totalDiscountIdr).toBe(7_777);
    let fetched = false;
    const result = await pull(async () => {
      fetched = true;
      throw new Error("Cloud reply was interrupted");
    }, ["promotions"]);
    expect(fetched).toBe(true);
    expect(
      result.streams["promotions" as keyof typeof result.streams]?.error,
    ).toBeDefined();
    // Offline: this promotion has no quota, so it stays alive until 24 h.
    expect(promosEnabled()).toBe(true);
    await gate.refresh();
    expect(promosEnabled()).toBe(true);
    expect((await guardedQuote()).totalDiscountIdr).toBe(7_777);
  });
});
