// Delivery commission reconciliation (bead legend-5bn3, slice D5): a platform
// statement line is matched against gross - commission of the internal order,
// variance and unknown orders are flagged, replays are idempotent and the
// period read returns lines with their totals. Every case rolls back.
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendDeliveryFixtures } from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import {
  deliveryChannelOrders,
  deliveryChannels,
} from "../db/schema/delivery.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getDeliveryReconciliation,
  importDeliveryStatement,
  readDeliveryReconciliation,
  recomputeOrderSettlement,
} from "../services/delivery-reconciliation.service.ts";
import { originHeader } from "./helpers";
import {
  owner,
  seededOutletA as seededOutletAId,
  seededOutletB as seededOutletBId,
  seededTenantId as seededTenantIdRaw,
  staffWithRole,
} from "./floor-test-helpers.ts";

const tenantId = tenantIdSchema.parse(seededTenantIdRaw);
const outletA = outletIdSchema.parse(seededOutletAId);
const outletB = outletIdSchema.parse(seededOutletBId);

const httpStore = "store-d5-http";
let app: Express;

beforeAll(async () => {
  app = createApp();
  await owner.query(
    "DELETE FROM delivery_channels WHERE tenant_id = $1 AND store_external_id = $2",
    [tenantId, httpStore],
  );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM delivery_channels WHERE tenant_id = $1 AND store_external_id = $2",
    [tenantId, httpStore],
  );
  await owner.end();
});

const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "domain" }),
  { kind: "tenant" },
);

class Rollback extends Error {}

const sample = cafeLegendDeliveryFixtures.orders[0];
const now = new Date("2026-11-09T10:00:00.000Z");

/** Run `body` in a tenant transaction that always rolls back. */
async function rolledBack(
  body: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<void>,
) {
  await expect(
    withTenant(db, context, async (tx) => {
      await body(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function seedChannel(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  outletId = outletA,
) {
  await tx.insert(deliveryChannels).values({
    tenantId,
    outletId,
    platform: "gofood",
    storeExternalId: `store-d5-${outletId}`,
    commissionRateBps: 2000,
    isOpen: true,
  });
}

async function seedOrder(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  externalOrderId: string,
  outletId = outletA,
) {
  const [row] = await tx
    .insert(deliveryChannelOrders)
    .values({
      tenantId,
      outletId,
      platform: "gofood",
      externalOrderId,
      orderId: null,
      pickupNumber: null,
      status: "received",
      source: sample.source,
      grossIdr: idr(100_000),
      commissionIdr: idr(20_000),
      payloadHash: sample.payloadHash,
      customerNote: null,
      lines: sample.lines.map((line) => ({ ...line })),
      receivedAt: new Date(sample.receivedAt),
    })
    .returning();
  return row;
}

const statement = (
  externalOrderId: string,
  settledNetIdr: number,
  settledOn = "2026-11-08",
) => ({
  externalOrderId,
  grossIdr: 100_000,
  commissionIdr: 20_000,
  settledNetIdr,
  settledOn,
});

const importInput = (
  lines: ReturnType<typeof statement>[],
  outletId = outletA,
) => ({
  outletId,
  platform: "gofood" as const,
  lines,
  actorUserId: null,
  now,
});

describe("delivery commission reconciliation", () => {
  it("matches gross - commission, flags variance and unknown orders", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx);
      const ok = await seedOrder(tx, "D5-OK");
      await seedOrder(tx, "D5-VAR");
      const result = await importDeliveryStatement(
        tx,
        context,
        importInput([
          statement("D5-OK", 80_000),
          statement("D5-VAR", 75_000),
          statement("D5-GHOST", 50_000),
        ]),
      );
      const byId = Object.fromEntries(
        result.lines.map((line) => [line.externalOrderId, line]),
      );
      expect(byId["D5-OK"]).toMatchObject({
        status: "matched",
        varianceIdr: 0,
        deliveryChannelOrderId: ok.id,
      });
      expect(byId["D5-VAR"]).toMatchObject({
        status: "variance",
        varianceIdr: -5_000,
      });
      expect(byId["D5-GHOST"]).toMatchObject({
        status: "unknown_order",
        deliveryChannelOrderId: null,
        varianceIdr: 50_000,
      });
      expect(result.appliedCount).toBe(3);

      const [settled] = await tx
        .select()
        .from(deliveryChannelOrders)
        .where(
          and(
            eq(deliveryChannelOrders.tenantId, tenantId),
            eq(deliveryChannelOrders.id, ok.id),
          ),
        );
      expect(settled.settledNetIdr).toBe(80_000);
      expect(settled.settledAt).toEqual(now);
    });
  });

  it("treats an order of another outlet as unknown", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx);
      await seedOrder(tx, "D5-OTHER", outletB);
      const result = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-OTHER", 80_000)]),
      );
      expect(result.lines[0]).toMatchObject({
        status: "unknown_order",
        deliveryChannelOrderId: null,
      });
    });
  });

  it("is idempotent on a replay and updates a corrected line in place", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx);
      await seedOrder(tx, "D5-REPLAY");
      const first = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-REPLAY", 70_000)]),
      );
      expect(first.lines[0].status).toBe("variance");

      const replay = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-REPLAY", 70_000)]),
      );
      expect(replay.appliedCount).toBe(0);
      expect(replay.lines[0].id).toBe(first.lines[0].id);

      const corrected = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-REPLAY", 80_000)]),
      );
      expect(corrected.appliedCount).toBe(1);
      expect(corrected.lines[0]).toMatchObject({
        id: first.lines[0].id,
        status: "matched",
        varianceIdr: 0,
      });
    });
  });

  it("rejects a line whose stored copy belongs to another outlet", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx, outletA);
      await seedChannel(tx, outletB);
      await seedOrder(tx, "D5-XOUT", outletA);
      const first = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-XOUT", 80_000)], outletA),
      );
      expect(first.appliedCount).toBe(1);

      const second = await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-XOUT", 10_000)], outletB),
      );
      expect(second.lines).toHaveLength(0);
      expect(second.appliedCount).toBe(0);
      expect(second.rejected).toEqual([
        {
          externalOrderId: "D5-XOUT",
          settledOn: "2026-11-08",
          code: "OUTLET_MISMATCH",
        },
      ]);

      const read = await readDeliveryReconciliation(tx, tenantId, outletA, {
        platform: "gofood",
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      });
      expect(read.lines).toHaveLength(1);
      expect(read.lines[0]).toMatchObject({
        id: first.lines[0].id,
        outletId: outletA,
        settledNetIdr: 80_000,
      });
    });
  });

  it("sums the lines of one order and clears settlement when none remain", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx);
      const order = await seedOrder(tx, "D5-SUM");
      const orderRow = () =>
        tx
          .select()
          .from(deliveryChannelOrders)
          .where(
            and(
              eq(deliveryChannelOrders.tenantId, tenantId),
              eq(deliveryChannelOrders.id, order.id),
            ),
          )
          .then((rows) => rows[0]);

      await importDeliveryStatement(
        tx,
        context,
        importInput([
          statement("D5-SUM", 50_000, "2026-11-05"),
          statement("D5-SUM", 30_000, "2026-11-06"),
        ]),
      );
      const summed = await orderRow();
      expect(summed.settledNetIdr).toBe(80_000);
      expect(summed.settledAt).toEqual(now);

      // Correcting one line re-sums instead of overwriting with the last line.
      await importDeliveryStatement(
        tx,
        context,
        importInput([statement("D5-SUM", 20_000, "2026-11-05")]),
      );
      expect((await orderRow()).settledNetIdr).toBe(50_000);

      // No matched line remains (settlement lines are append-only, so use an
      // order that never had one): a stale settlement is cleared.
      const bare = await seedOrder(tx, "D5-BARE");
      await tx
        .update(deliveryChannelOrders)
        .set({ settledAt: now, settledNetIdr: idr(1) })
        .where(eq(deliveryChannelOrders.id, bare.id));
      await recomputeOrderSettlement(tx, tenantId, bare.id, now);
      const [cleared] = await tx
        .select()
        .from(deliveryChannelOrders)
        .where(eq(deliveryChannelOrders.id, bare.id));
      expect(cleared.settledNetIdr).toBeNull();
      expect(cleared.settledAt).toBeNull();
    });
  });

  it("reads one period with totals", async () => {
    await rolledBack(async (tx) => {
      await seedChannel(tx);
      await seedOrder(tx, "D5-P1");
      await seedOrder(tx, "D5-P2");
      await importDeliveryStatement(
        tx,
        context,
        importInput([
          statement("D5-P1", 80_000, "2026-11-02"),
          statement("D5-P2", 70_000, "2026-11-03"),
          statement("D5-OUT", 80_000, "2026-12-01"),
        ]),
      );
      const result = await readDeliveryReconciliation(tx, tenantId, outletA, {
        platform: "gofood",
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      });
      expect(result.lines.map((line) => line.externalOrderId)).toEqual([
        "D5-P1",
        "D5-P2",
      ]);
      expect(result.summary).toMatchObject({
        lineCount: 2,
        matchedCount: 1,
        varianceCount: 1,
        unknownOrderCount: 0,
        grossIdr: 200_000,
        commissionIdr: 40_000,
        settledNetIdr: 150_000,
        varianceIdr: -10_000,
      });
    });
  });

  it("refuses a platform that is not connected for the outlet", async () => {
    await expect(
      getDeliveryReconciliation(context, outletA, {
        platform: "grabfood",
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_CHANNEL_UNKNOWN" });
  });

  describe("HTTP", () => {
    const url = (outletId: string) =>
      `/api/outlets/${outletId}/delivery-reconciliation?platform=gofood&periodStart=2026-11-01&periodEnd=2026-11-30`;
    const get = (
      staff: Awaited<ReturnType<typeof staffWithRole>>,
      outletId: string,
    ) => staff.client.get(url(outletId)).set(originHeader);

    it("requires accounting.reconcile and the outlet scope", async () => {
      await owner.query(
        `INSERT INTO delivery_channels (tenant_id, outlet_id, platform, store_external_id, is_open)
         VALUES ($1, $2, 'gofood', $3, true)`,
        [tenantId, outletA, httpStore],
      );
      const scopedOwner = await staffWithRole(app, {
        template: "owner",
        scopeType: "outlet",
        scopeId: outletA,
        label: "D5 Outlet Owner",
      });
      const cashier = await staffWithRole(app, {
        template: "cashier",
        scopeType: "outlet",
        scopeId: outletA,
        label: "D5 Cashier",
      });

      const allowed = await get(scopedOwner, outletA);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      // Same outlet, but the role lacks accounting.reconcile.
      expect((await get(cashier, outletA)).status).toBe(403);
      // Outlet-scoped user reading another outlet's reconciliation.
      expect((await get(scopedOwner, outletB)).status).toBe(403);
    });
  });
});
