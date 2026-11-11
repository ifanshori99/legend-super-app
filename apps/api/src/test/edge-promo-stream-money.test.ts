import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  PROMO_CHECKPOINT_STREAMS,
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import {
  installPromoFreshnessProvider,
  installPromoClockProvider,
  markPromoCatalogStreamPending,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import { createTrustedClock } from "../edge/trusted-clock.ts";
import {
  quotePromotions,
  redeemPromotions,
  resolveCode,
} from "../services/crm-promo-engine.ts";
import { orderPromoPort } from "../services/order-promo.ts";
import type { OrderPromoInput } from "../services/order-promo-port.ts";
import { applyCatalogRecords } from "../services/edge-catalog-apply.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { createEdgeDatabase } from "./helpers/edge-database.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const promotionIds: string[] = [];
const handles: PromoGateHandle[] = [];
const guarded = withPromoFreshness(orderPromoPort);

function context(source: "session" | "device" = "device", outlet = outletId) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outlet] },
  );
}

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedPromotion(
  item: string,
  caps: {
    quotaTotal?: number;
    quotaPerCustomer?: number;
    budgetIdr?: number;
    benefit?: unknown;
  } = {},
) {
  const id = randomUUID();
  promotionIds.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, voucher_required, starts_at,
          conditions, benefit, stack_group, stackable, priority,
          quota_total, quota_per_customer, budget_idr)
       VALUES ($1, $2, 'Edge stream money proof', '', 'active', false,
               now() - interval '1 hour', $3, $4, $5, true, 0, $6, $7, $8)`,
      [
        id,
        tenantId,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
        ]),
        JSON.stringify(
          caps.benefit ?? { kind: "nominal_off", amountIdr: 20_000 },
        ),
        `edge${id.slice(0, 8)}`,
        caps.quotaTotal ?? null,
        caps.quotaPerCustomer ?? null,
        caps.budgetIdr ?? null,
      ],
    ),
  );
  return id;
}

async function seedVoucher() {
  const id = randomUUID();
  const code = `E${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  await asOwner((client) =>
    client.query(
      `INSERT INTO vouchers (id, tenant_id, code_hash, source, value_idr, valid_from)
       VALUES ($1, $2, $3, 'manual', 20000, now() - interval '1 hour')`,
      [id, tenantId, createHash("sha256").update(code).digest("hex")],
    ),
  );
  return { id, code };
}

function input(
  item: string,
  total = 12_000,
  code: string | null = null,
): OrderPromoInput {
  return {
    outletId,
    channel: "takeaway",
    lines: [
      {
        menuItemId: item,
        quantity: 1,
        unitPriceIdr: idr(total),
        lineTotalIdr: idr(total),
      },
    ],
    customer: null,
    voucherCode: code,
    at: new Date(),
  };
}

function quote(value: OrderPromoInput, ctx = context()) {
  return withTenant(db, ctx, (tx) => guarded.quote(tx, ctx, value));
}

function redeem(
  value: OrderPromoInput,
  orderId = createUlid(),
  ctx = context(),
) {
  return withTenant(db, ctx, (tx) =>
    guarded.redeem(tx, ctx, { ...value, orderId, actorUserId: null }),
  );
}

/** Changes catalog state only after this checkout is demonstrably waiting on its candidate lock. */
async function changeCatalogWhileRedemptionWaits(options: {
  promotionIds: string[];
  input: OrderPromoInput;
  orderId: string;
  expected?: Awaited<ReturnType<typeof quotePromotions>>;
  change: (holder: PoolClient) => Promise<unknown>;
  database?: typeof db;
  ownerPool?: Pool;
}) {
  const database = options.database ?? db;
  const ownerPool = options.ownerPool ?? owner;
  const holder = await ownerPool.connect();
  let result:
    | Promise<
        | { ok: true; value: Awaited<ReturnType<typeof guarded.redeem>> }
        | { ok: false; error: unknown }
      >
    | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await holder.query(
      "SELECT id FROM promotions WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [tenantId, options.promotionIds],
    );
    const label = `edge-promo-race-${randomUUID()}`;
    const ctx = context();
    result = withTenant(database, ctx, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('application_name', ${label}, true)`,
      );
      return guarded.redeem(tx, ctx, {
        ...options.input,
        orderId: options.orderId,
        actorUserId: null,
        ...(options.expected === undefined
          ? {}
          : { expected: options.expected }),
      });
    }).then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    await vi.waitFor(
      async () => {
        const waiting = await ownerPool.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1",
          [label],
        );
        expect(waiting.rows.some((row) => row.wait_event_type === "Lock")).toBe(
          true,
        );
      },
      { timeout: 10_000, interval: 25 },
    );
    await options.change(holder);
    await holder.query("COMMIT");
    return await result;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (result) await result;
  }
}

async function financialState(
  promotionId: string | null,
  orders: string[],
  voucherId?: string,
) {
  return asOwner(async (client) => {
    const counters =
      promotionId === null
        ? []
        : (
            await client.query(
              "SELECT uses_total, spent_idr FROM promotions WHERE id = $1 AND tenant_id = $2",
              [promotionId, tenantId],
            )
          ).rows;
    const applications = (
      await client.query(
        "SELECT order_id, status, total_discount_idr FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id",
        [tenantId, orders.map((id) => ulidToUuid(id as never))],
      )
    ).rows;
    const redemptions = (
      await client.query(
        "SELECT order_id, status, discount_idr FROM promotion_redemptions WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id",
        [tenantId, orders.map((id) => ulidToUuid(id as never))],
      )
    ).rows;
    const voucher =
      voucherId === undefined
        ? []
        : (
            await client.query(
              "SELECT status, redeemed_order_id, redeemed_at FROM vouchers WHERE tenant_id = $1 AND id = $2",
              [tenantId, voucherId],
            )
          ).rows;
    return { counters, applications, redemptions, voucher };
  });
}

async function startUnsafeAgeGate(kind: "stale" | "unproven" | "fresh") {
  const testOutlet = outletIdSchema.parse(randomUUID());
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Promo stream age proof', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [testOutlet, `EM${testOutlet.slice(0, 8)}`.toUpperCase(), outletId],
  );
  const ctx = context("device", testOutlet);
  const edgeNodeId = randomUUID();
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
     VALUES ($1, $2, $3, 'standby', 'Promo stream age proof', $4)`,
    [edgeNodeId, tenantId, testOutlet, "a".repeat(64)],
  );
  const now = new Date();
  for (const stream of PROMO_CHECKPOINT_STREAMS)
    await owner.query(
      `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [
        tenantId,
        testOutlet,
        edgeNodeId,
        stream,
        new Date(now.getTime() - (kind === "stale" ? 25 * 60 * 60_000 : 0)),
      ],
    );
  const clock = createTrustedClock({
    wall: () => now,
    mono: () => 0,
    persistedHighWater: new Date(
      now.getTime() - (kind === "unproven" ? 0 : 10 * 60_000),
    ),
  });
  setPromoGateEdgeModeForTests(() => true);
  const handle = startPromoGate({
    context: ctx,
    edgeNodeId,
    clock,
  });
  handles.push(handle);
  await handle.refresh();
  return { ctx, testOutlet, now };
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(() => {
  while (handles.length) handles.pop()!.stop();
  installPromoFreshnessProvider(null);
  installPromoClockProvider(null);
  setPromoGateEdgeModeForTests(null);
});

afterAll(async () => {
  if (promotionIds.length)
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, promotionIds],
      ),
    );
  await owner.end();
});

describe("legend-09sxa shared redemption authority keeps the outlet's money safe", () => {
  it("an outlet switch synced while checkout waits on the promotion lock revokes the promised discount without financial writes", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    const orderId = createUlid();
    const value = input(item);
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    const expected = (await quote(value)).result;
    expect(Number(expected.totalDiscountIdr)).toBe(12_000);
    const before = await financialState(promotion, [orderId]);
    const result = await changeCatalogWhileRedemptionWaits({
      promotionIds: [promotion],
      input: value,
      orderId,
      expected,
      change: (holder) =>
        holder.query(
          `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (tenant_id, promotion_id, outlet_id) DO UPDATE SET enabled = false`,
          [tenantId, promotion, outletId],
        ),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { status: 409, code: "PROMO_CHANGED" },
    });
    expect(await financialState(promotion, [orderId])).toEqual(before);
  });

  it.each([false, true])(
    "a pending catalog stream closes an already waiting checkout before any financial writes (expected quote: %s)",
    async (hasExpected) => {
      const item = randomUUID();
      const promotion = await seedPromotion(item);
      const orderId = createUlid();
      const value = input(item);
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
      const expected = (await quote(value)).result;
      const before = await financialState(promotion, [orderId]);
      const result = await changeCatalogWhileRedemptionWaits({
        promotionIds: [promotion],
        input: value,
        orderId,
        ...(hasExpected ? { expected } : {}),
        change: async () => {
          markPromoCatalogStreamPending("catalog:promotions");
        },
      });
      if (hasExpected) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "CONFLICT" },
        });
      } else {
        expect(result).toMatchObject({
          ok: true,
          value: { totalDiscountIdr: 0 },
        });
      }
      expect(await financialState(promotion, [orderId])).toEqual(before);
    },
  );

  it("trusted time passing the expiry while checkout waits cannot redeem the previously promised discount", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    const orderId = createUlid();
    let now = new Date();
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET ends_at = $1 WHERE tenant_id = $2 AND id = $3",
        [new Date(now.getTime() + 60_000), tenantId, promotion],
      ),
    );
    const value = input(item);
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    installPromoClockProvider(() => now);
    const expected = (await quote(value)).result;
    expect(Number(expected.totalDiscountIdr)).toBe(12_000);
    const before = await financialState(promotion, [orderId]);
    const result = await changeCatalogWhileRedemptionWaits({
      promotionIds: [promotion],
      input: value,
      orderId,
      expected,
      change: async () => {
        now = new Date(now.getTime() + 2 * 60_000);
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { status: 409, code: "PROMO_CHANGED" },
    });
    expect(await financialState(promotion, [orderId])).toEqual(before);
  });

  it("a restrictive stacking policy synced during candidate lock wait prevents the old combined discount", async () => {
    const item = randomUUID();
    const ids = await Promise.all([
      seedPromotion(item, {
        benefit: { kind: "nominal_off", amountIdr: 2_000 },
      }),
      seedPromotion(item, {
        benefit: { kind: "nominal_off", amountIdr: 2_000 },
      }),
    ]);
    const edge = await createEdgeDatabase({ tenantId, outletId });
    try {
      const copied = await asOwner((client) =>
        client.query(
          "SELECT row_to_json(p) AS row FROM promotions p WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [tenantId, ids],
        ),
      );
      for (const row of copied.rows)
        await edge.owner.query(
          "INSERT INTO promotions SELECT * FROM json_populate_record(NULL::promotions, $1::json)",
          [JSON.stringify(row.row)],
        );
      await edge.owner.query(
        `INSERT INTO promo_settings (tenant_id, stacking_policy)
         VALUES ($1, '{"mode":"stackable","maxStacked":5,"allowSameGroup":true}')`,
        [tenantId],
      );
      const ctx = context();
      const value = input(item);
      const orderId = createUlid();
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
      const expected = (
        await withTenant(edge.database, ctx, (tx) =>
          guarded.quote(tx, ctx, value),
        )
      ).result;
      expect(Number(expected.totalDiscountIdr)).toBe(4_000);
      const result = await changeCatalogWhileRedemptionWaits({
        promotionIds: ids,
        input: value,
        orderId,
        expected,
        database: edge.database as typeof db,
        ownerPool: edge.owner,
        change: (holder) =>
          holder.query(
            `UPDATE promo_settings SET stacking_policy = '{"mode":"exclusive","maxStacked":1,"allowSameGroup":false}' WHERE tenant_id = $1`,
            [tenantId],
          ),
      });
      expect(result).toMatchObject({
        ok: false,
        error: { status: 409, code: "PROMO_CHANGED" },
      });
      const counters = await edge.rows(
        "SELECT uses_total, spent_idr FROM promotions WHERE id = ANY($1::uuid[])",
        [ids],
      );
      expect(
        counters.every(
          (row) => Number(row.uses_total) === 0 && Number(row.spent_idr) === 0,
        ),
      ).toBe(true);
      expect(
        await edge.rows(
          "SELECT order_id FROM promotion_order_applications WHERE order_id = $1",
          [ulidToUuid(orderId)],
        ),
      ).toHaveLength(0);
      expect(
        await edge.rows(
          "SELECT order_id FROM promotion_redemptions WHERE order_id = $1",
          [ulidToUuid(orderId)],
        ),
      ).toHaveLength(0);
    } finally {
      await edge.cleanup();
    }
  }, 240_000);

  it("the direct CRM voucher preview refuses edge redemption authority even while fresh", async () => {
    const voucher = await seedVoucher();
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    const ctx = context();
    const before = await financialState(null, [], voucher.id);
    await expect(
      withTenant(db, ctx, (tx) => resolveCode(tx, ctx, voucher.code, false)),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await financialState(null, [], voucher.id)).toEqual(before);
  });

  it("the direct CRM quote cannot bypass a stale edge freshness gate", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    const ctx = context();
    const before = await financialState(promotion, []);
    const quoted = await withTenant(db, ctx, (tx) =>
      quotePromotions(tx, ctx, input(item)),
    );
    expect(Number(quoted.totalDiscountIdr)).toBe(0);
    expect(await financialState(promotion, [])).toEqual(before);
  });

  it("the direct CRM redemption cannot write financial rows while edge streams are stale", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    const orderId = createUlid();
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    const ctx = context();
    const before = await financialState(promotion, [orderId]);
    const redeemed = await withTenant(db, ctx, (tx) =>
      redeemPromotions(tx, ctx, {
        ...input(item),
        orderId,
        actorUserId: null,
      }),
    );
    expect(Number(redeemed.totalDiscountIdr)).toBe(0);
    expect(await financialState(promotion, [orderId])).toEqual(before);
  });

  it("a direct CRM redemption with a previously promised discount conflicts after edge streams go stale", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    const orderId = createUlid();
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    const ctx = context();
    const before = await financialState(promotion, [orderId]);
    await expect(
      withTenant(db, ctx, (tx) =>
        redeemPromotions(tx, ctx, {
          ...input(item),
          orderId,
          actorUserId: null,
          expected: { evaluations: [], totalDiscountIdr: idr(12_000) },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await financialState(promotion, [orderId])).toEqual(before);
  });

  it("refuses a voucher quote on a fresh edge until cloud redemption is verified", async () => {
    const voucher = await seedVoucher();
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    await expect(
      quote(input(randomUUID(), 12_000, voucher.code)),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      (await financialState(null, [], voucher.id)).voucher[0],
    ).toMatchObject({ status: "issued", redeemed_order_id: null });
  });

  it("two offline edge cashiers consume nothing and cloud can grant the single-use voucher exactly once", async () => {
    const voucher = await seedVoucher();
    const value = input(randomUUID(), 12_000, voucher.code);
    const edgeOrders = [createUlid(), createUlid()];
    const cloudOrders = [createUlid(), createUlid()];
    const orders = [...edgeOrders, ...cloudOrders];
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    const before = await financialState(null, orders, voucher.id);
    const attempts = await Promise.allSettled(
      edgeOrders.map((order) => redeem(value, order, context("device"))),
    );
    expect(attempts.every((result) => result.status === "rejected")).toBe(true);
    for (const attempt of attempts)
      if (attempt.status === "rejected")
        expect(attempt.reason).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await financialState(null, orders, voucher.id)).toEqual(before);

    setPromoGateEdgeModeForTests(() => false);
    const cloud = await Promise.allSettled(
      cloudOrders.map((order) => redeem(value, order, context("session"))),
    );
    const granted = cloud.filter((result) => result.status === "fulfilled");
    expect(granted).toHaveLength(1);
    expect(
      granted.reduce(
        (sum, result) =>
          sum +
          (result.status === "fulfilled"
            ? Number(result.value.totalDiscountIdr)
            : 0),
        0,
      ),
    ).toBe(12_000);
    const consumed = await financialState(null, orders, voucher.id);
    expect(consumed.voucher[0]).toMatchObject({ status: "redeemed" });
    expect(consumed.applications).toHaveLength(1);
    expect(consumed.redemptions).toHaveLength(1);
    expect(Number(consumed.redemptions[0]?.discount_idr)).toBe(12_000);

    setPromoGateEdgeModeForTests(() => true);
    await expect(
      redeem(value, createUlid(), context("device")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await financialState(null, orders, voucher.id)).toEqual(consumed);
  });

  it.each(["stale", "unproven"] as const)(
    "%s stream age produces zero discount and leaves financial rows unchanged",
    async (kind) => {
      const rig = await startUnsafeAgeGate(kind);
      const item = randomUUID();
      const promotion = await seedPromotion(item);
      const voucher = await seedVoucher();
      const order = createUlid();
      const value = { ...input(item), outletId: rig.testOutlet };
      const before = await financialState(promotion, [order], voucher.id);
      expect(Number((await quote(value, rig.ctx)).totalDiscountIdr)).toBe(0);
      expect(
        Number((await redeem(value, order, rig.ctx)).totalDiscountIdr),
      ).toBe(0);
      await expect(
        redeem({ ...value, voucherCode: voucher.code }, order, rig.ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await financialState(promotion, [order], voucher.id)).toEqual(
        before,
      );
    },
  );

  it.each([{ quotaTotal: 1 }, { quotaPerCustomer: 1 }, { budgetIdr: 20_000 }])(
    "a fresh edge never spends globally capped promo capacity %j",
    async (caps) => {
      const item = randomUUID();
      const promotion = await seedPromotion(item, caps);
      const order = createUlid();
      const customerId = randomUUID();
      await asOwner((client) =>
        client.query(
          `INSERT INTO customer_profiles (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
         VALUES ($1, $2, $3, $4, 'Edge capped promo member', 'active', now())`,
          [
            customerId,
            tenantId,
            randomUUID(),
            createHash("sha256").update(customerId).digest("hex"),
          ],
        ),
      );
      const value: OrderPromoInput = {
        ...input(item),
        customer: {
          customerProfileId: customerId,
          tierId: null,
          isMember: true,
        },
      };
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
      const before = await financialState(promotion, [order]);
      expect(Number((await quote(value)).totalDiscountIdr)).toBe(0);
      expect(Number((await redeem(value, order)).totalDiscountIdr)).toBe(0);
      const after = await financialState(promotion, [order]);
      expect(after.counters).toEqual(before.counters);
      expect(after.redemptions).toHaveLength(0);
      expect(
        after.applications.every((row) => Number(row.total_discount_idr) === 0),
      ).toBe(true);
    },
  );

  it("a caller's rolled-back wall clock cannot revive a promotion expired by trusted edge time", async () => {
    const rig = await startUnsafeAgeGate("fresh");
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET ends_at = $1 WHERE tenant_id = $2 AND id = $3",
        [new Date(rig.now.getTime() - 60_000), tenantId, promotion],
      ),
    );
    const order = createUlid();
    const value: OrderPromoInput = {
      ...input(item),
      outletId: rig.testOutlet,
      at: new Date(rig.now.getTime() - 2 * 60_000),
    };
    expect(Number((await quote(value, rig.ctx)).totalDiscountIdr)).toBe(0);
    expect(Number((await redeem(value, order, rig.ctx)).totalDiscountIdr)).toBe(
      0,
    );
    const state = await financialState(promotion, [order]);
    expect(Number(state.counters[0]?.spent_idr)).toBe(0);
    expect(state.redemptions).toHaveLength(0);
  });

  it("a fresh edge never grants a facility reward that another edge or cloud could grant again", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item, {
      benefit: {
        kind: "facility_entitlement",
        facilityProductId: randomUUID(),
        quantity: 1,
      },
    });
    const customerId = randomUUID();
    await asOwner((client) =>
      client.query(
        `INSERT INTO customer_profiles (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
         VALUES ($1, $2, $3, $4, 'Edge facility promo member', 'active', now())`,
        [
          customerId,
          tenantId,
          randomUUID(),
          createHash("sha256").update(customerId).digest("hex"),
        ],
      ),
    );
    const value: OrderPromoInput = {
      ...input(item),
      customer: { customerProfileId: customerId, tierId: null, isMember: true },
    };
    const order = createUlid();
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    const quoted = await quote(value);
    expect(
      quoted.result.evaluations.some(
        (evaluation) =>
          evaluation.applied && evaluation.facilityEntitlement !== null,
      ),
    ).toBe(false);
    const redeemed = await redeem(value, order);
    expect(
      redeemed.result.evaluations.some(
        (evaluation) =>
          evaluation.applied && evaluation.facilityEntitlement !== null,
      ),
    ).toBe(false);
    const state = await financialState(promotion, [order]);
    expect(state.counters[0]).toEqual({ uses_total: 0, spent_idr: "0" });
    expect(state.redemptions).toHaveLength(0);
    const rewards = await asOwner((client) =>
      client.query(
        "SELECT id FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
        [tenantId, promotion],
      ),
    );
    expect(rewards.rows).toHaveLength(0);
  });

  it("an actual edge redemption survives cloud metadata resync and releases its own discount exactly once", async () => {
    const item = randomUUID();
    const promotion = await seedPromotion(item);
    const ctx = context();
    const exportedRecord = async () => {
      await settleCloud(owner);
      let since: string | undefined;
      for (let pages = 0; pages < 100; pages += 1) {
        const page = await listCatalogRecordsSince(db, {
          tenantId: ctx.tenant.tenantId,
          outletId,
          query: catalogSyncQuerySchema.parse({
            stream: "promotions",
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            ...(since === undefined ? {} : { since }),
          }),
        });
        const record = (
          page.records as unknown as Record<string, unknown>[]
        ).find((candidate) => candidate.id === promotion);
        if (record) return record;
        if (!page.hasMore || page.nextCursor === null) break;
        since = page.nextCursor;
      }
      throw new Error("Seeded promotion was not exported by the cloud");
    };
    const edge = await createEdgeDatabase({ tenantId, outletId });
    try {
      const apply = (record: Record<string, unknown>) =>
        withTenant(edge.database, ctx, (tx) =>
          applyCatalogRecords(tx, {
            tenantId: ctx.tenant.tenantId,
            stream: "promotions",
            records: [record],
          }),
        );
      const localCounters = async () => {
        const [row] = await edge.rows(
          "SELECT uses_total, spent_idr, description FROM promotions WHERE id = $1",
          [promotion],
        );
        return {
          uses: Number(row?.uses_total),
          spent: Number(row?.spent_idr),
          description: row?.description,
        };
      };
      const localCatalogStamp = async () => {
        const [row] = await edge.rows(
          "SELECT sync_txid::text AS stamp FROM promotions WHERE id = $1",
          [promotion],
        );
        return String(row?.stamp);
      };
      await apply(await exportedRecord());
      const importedCatalogStamp = await localCatalogStamp();
      expect(importedCatalogStamp).toMatch(/^\d+$/);
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
      const orderId = createUlid();
      const redeemed = await withTenant(edge.database, ctx, (tx) =>
        guarded.redeem(tx, ctx, {
          ...input(item),
          orderId,
          actorUserId: null,
        }),
      );
      expect(Number(redeemed.totalDiscountIdr)).toBe(12_000);
      expect(await localCounters()).toMatchObject({ uses: 1, spent: 12_000 });
      expect(await localCatalogStamp()).toBe(importedCatalogStamp);

      await asOwner((client) =>
        client.query(
          "UPDATE promotions SET description = 'Cloud revised metadata', uses_total = 7, spent_idr = 140000 WHERE tenant_id = $1 AND id = $2",
          [tenantId, promotion],
        ),
      );
      await apply(await exportedRecord());
      const refreshedCatalogStamp = await localCatalogStamp();
      expect(BigInt(refreshedCatalogStamp)).toBeGreaterThan(
        BigInt(importedCatalogStamp),
      );
      expect(await localCounters()).toEqual({
        uses: 1,
        spent: 12_000,
        description: "Cloud revised metadata",
      });
      const release = () =>
        withTenant(edge.database, ctx, (tx) =>
          guarded.release(tx, ctx, {
            orderId,
            actorUserId: null,
            at: new Date(),
            reason: "Void edge order after catalog refresh",
          }),
        );
      expect(await release()).toEqual({
        released: true,
        releasedDiscountIdr: idr(12_000),
      });
      expect(await localCounters()).toMatchObject({ uses: 0, spent: 0 });
      expect(await localCatalogStamp()).toBe(refreshedCatalogStamp);
      expect(await release()).toEqual({
        released: false,
        releasedDiscountIdr: idr(0),
      });
      expect(await localCounters()).toMatchObject({ uses: 0, spent: 0 });
      expect(await localCatalogStamp()).toBe(refreshedCatalogStamp);
      const cloud = await financialState(promotion, []);
      expect(Number(cloud.counters[0]?.uses_total)).toBe(7);
      expect(Number(cloud.counters[0]?.spent_idr)).toBe(140_000);
    } finally {
      await edge.cleanup();
    }
  }, 240_000);

  it.each([0, 1, 12_000])(
    "fresh uncapped automatic discount stays between zero and bill Rp%i",
    async (total) => {
      const item = randomUUID();
      const promotion = await seedPromotion(item);
      const order = createUlid();
      setPromoGateEdgeModeForTests(() => true);
      installPromoFreshnessProvider(() => true);
      const result = await redeem(input(item, total), order);
      expect(Number(result.totalDiscountIdr)).toBe(total);
      expect(Number(result.totalDiscountIdr)).toBeGreaterThanOrEqual(0);
      expect(Number(result.totalDiscountIdr)).toBeLessThanOrEqual(total);
      const state = await financialState(promotion, [order]);
      expect(
        state.redemptions.every(
          (row) =>
            Number(row.discount_idr) >= 0 && Number(row.discount_idr) <= total,
        ),
      ).toBe(true);
      expect(Number(state.counters[0]?.spent_idr)).toBe(total);
    },
  );
});
