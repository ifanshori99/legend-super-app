// Delivery channel foundation (bead legend-5bn3, slice D1): the three tables
// exist with tenant + outlet RLS, the unique order key holds, and the store
// mappers round-trip rows through the contract schemas. Rolled back.
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
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
  findByExternalId,
  lockDeliveryOrder,
  toDeliveryChannel,
  toDeliveryChannelOrder,
} from "../services/delivery-store.ts";
import {
  owner,
  seededOutletA as seededOutletAId,
  seededTenantId as seededTenantIdRaw,
} from "./floor-test-helpers.ts";

const seededTenantId = tenantIdSchema.parse(seededTenantIdRaw);
const seededOutletA = outletIdSchema.parse(seededOutletAId);

afterAll(async () => {
  await owner.end();
});

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: seededTenantId,
    brandId: null,
    source: "domain",
  }),
  { kind: "tenant" },
);

class Rollback extends Error {}

describe("delivery tables", () => {
  it("enforce tenant and outlet RLS", async () => {
    const { rows } = await owner.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
        WHERE c.relname IN ('delivery_channels', 'delivery_channel_orders', 'delivery_settlement_lines')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it("round-trip rows through the store mappers and refuse a second order for one external id", async () => {
    const channel = cafeLegendDeliveryFixtures.channels[0];
    const order = cafeLegendDeliveryFixtures.orders[0];
    await expect(
      withTenant(db, context, async (tx) => {
        const [channelRow] = await tx
          .insert(deliveryChannels)
          .values({
            tenantId: seededTenantId,
            outletId: seededOutletA,
            platform: channel.platform,
            storeExternalId: "store-d1-test",
            commissionRateBps: 2000,
            isOpen: false,
          })
          .returning();
        expect(toDeliveryChannel(channelRow).platform).toBe(channel.platform);

        const values = {
          tenantId: seededTenantId,
          outletId: seededOutletA,
          platform: order.platform,
          externalOrderId: "D1-EXT-1",
          orderId: null,
          pickupNumber: null,
          status: "received" as const,
          source: order.source,
          grossIdr: order.grossIdr,
          commissionIdr: order.commissionIdr,
          payloadHash: order.payloadHash,
          customerNote: null,
          lines: order.lines.map((line) => ({ ...line })),
          receivedAt: new Date(order.receivedAt),
        };
        const [row] = await tx
          .insert(deliveryChannelOrders)
          .values(values)
          .returning();
        const dto = toDeliveryChannelOrder(row);
        expect(dto.externalOrderId).toBe("D1-EXT-1");
        expect(dto.lines).toHaveLength(order.lines.length);

        expect((await lockDeliveryOrder(tx, seededTenantId, row.id))?.id).toBe(
          row.id,
        );
        expect(
          (
            await findByExternalId(
              tx,
              seededTenantId,
              order.platform,
              "D1-EXT-1",
            )
          )?.id,
        ).toBe(row.id);

        await tx.execute(sql`SAVEPOINT dup`);
        await expect(
          tx.insert(deliveryChannelOrders).values(values),
        ).rejects.toThrow();
        await tx.execute(sql`ROLLBACK TO SAVEPOINT dup`);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
