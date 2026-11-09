// Delivery channel state, menu sync and the 86/menu outbox consumer (bead
// legend-5bn3, slice D2; PRD v1.7 §3.23). Real Express app, Better Auth, RBAC
// and PostgreSQL; the platform adapter is a recording double installed through
// the adapter registry. Data is committed through the owner pool (the HTTP
// requests use other connections) and removed in afterAll.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { DeliveryChannel, DeliveryRequest } from "@starter/shared/adapters";
import { itemRestoredEvent, itemSoldOutEvent } from "@starter/shared/menu";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  clearRecordedDeliveryCalls,
  deliveryChannelAdapterFor,
  recordedDeliveryCalls,
  setDeliveryChannelAdapter,
} from "../services/delivery-ports.ts";
import {
  DELIVERY_SOLD_OUT_SYNC_ERROR,
  deliverDeliveryChannelEvent,
  syncStaleDeliveryChannels,
} from "../services/delivery-sync-consumer.ts";
import { DELIVERY_MENU_SYNC_ERROR } from "../services/delivery-channels.service.ts";
import { originHeader } from "./helpers";
import {
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers";

const calls: DeliveryRequest[] = [];
let failNext = false;
const spy: DeliveryChannel = {
  async execute(_context, input) {
    if (failNext) throw new Error("platform down");
    calls.push(input);
    return { reference: input.reference, accepted: true };
  },
};
const actionsOf = (platform: string) =>
  calls
    .filter((call) => call.channel === platform)
    .map((call) => call.action);

const base = `/api/outlets/${seededOutletA}/delivery-channels`;
const tenantContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

const ids = {
  category: randomUUID(),
  item: randomUUID(),
  priceList: randomUUID(),
};
let app: Express;
let manager: Awaited<ReturnType<typeof staffWithRole>>;
let cashier: Awaited<ReturnType<typeof staffWithRole>>;
let outletManager: Awaited<ReturnType<typeof staffWithRole>>;

async function asOwner<T>(
  run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run((sql, params) => client.query(sql, params));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function channelRow(platform: string, outletId = seededOutletA) {
  return asOwner(async (q) => {
    const { rows } = await q(
      "SELECT * FROM delivery_channels WHERE tenant_id = $1 AND outlet_id = $2 AND platform = $3",
      [seededTenantId, outletId, platform],
    );
    return rows[0];
  });
}

async function setChannel(platform: string, set: string) {
  await asOwner((q) =>
    q(
      `UPDATE delivery_channels SET ${set} WHERE tenant_id = $1 AND outlet_id = $2 AND platform = $3`,
      [seededTenantId, seededOutletA, platform],
    ),
  );
}

async function auditCount(action: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
    [seededTenantId, action],
  );
  return Number(rows[0]?.count ?? 0);
}

function menuEvent(
  definition: typeof itemSoldOutEvent | typeof itemRestoredEvent,
  payload: Record<string, unknown>,
) {
  return definition.envelopeSchema.parse({
    id: createUlid(),
    tenantId: seededTenantId,
    outletId: seededOutletA,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: createUlid(),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload,
  });
}

beforeAll(async () => {
  for (const platform of ["gofood", "grabfood"] as const)
    setDeliveryChannelAdapter(platform, spy);
  app = createApp();
  manager = await staffWithRole(app, {
    template: "owner",
    label: "Delivery Manager",
  });
  cashier = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Delivery Cashier",
  });
  outletManager = await staffWithRole(app, {
    template: "owner",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "Delivery Outlet Manager",
  });
  await asOwner(async (q) => {
    const { rows } = await q(
      "SELECT brand_id FROM outlets WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, seededOutletA],
    );
    const brandId = rows[0].brand_id as string;
    await q(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'D2 Kategori')",
      [ids.category, seededTenantId, brandId],
    );
    await q(
      "INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, 'D2 Nasi Goreng')",
      [ids.item, seededTenantId, brandId, ids.category],
    );
    await q(
      "INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1, $2, $3, 'gofood', '2000-01-01')",
      [ids.priceList, seededTenantId, seededOutletA],
    );
    await q(
      "INSERT INTO price_list_items (tenant_id, price_list_id, item_id, price_idr) VALUES ($1, $2, $3, 35000)",
      [seededTenantId, ids.priceList, ids.item],
    );
    await q(
      "INSERT INTO item_availability (tenant_id, outlet_id, menu_item_id, status) VALUES ($1, $2, $3, 'sold_out')",
      [seededTenantId, seededOutletA, ids.item],
    );
    for (const [platform, store] of [
      ["gofood", "d2-gofood-store"],
      ["grabfood", "d2-grabfood-store"],
    ])
      await q(
        "INSERT INTO delivery_channels (tenant_id, outlet_id, platform, store_external_id, is_open) VALUES ($1, $2, $3, $4, $5)",
        [seededTenantId, seededOutletA, platform, store, platform === "gofood"],
      );
  });
});

afterAll(async () => {
  for (const platform of ["gofood", "grabfood"] as const)
    setDeliveryChannelAdapter(platform, null);
  await asOwner(async (q) => {
    await q("DELETE FROM delivery_channels WHERE tenant_id = $1", [
      seededTenantId,
    ]);
    await q("DELETE FROM item_availability WHERE menu_item_id = $1", [ids.item]);
    await q("DELETE FROM price_list_items WHERE price_list_id = $1", [
      ids.priceList,
    ]);
    await q("DELETE FROM price_lists WHERE id = $1", [ids.priceList]);
    await q("DELETE FROM menu_items WHERE id = $1", [ids.item]);
    await q("DELETE FROM menu_categories WHERE id = $1", [ids.category]);
  });
  await owner.end();
});

describe("delivery channels API", () => {
  it("refuses anonymous callers and staff without delivery.channel.manage", async () => {
    const { agent } = await import("./helpers");
    expect((await agent(app).get(base)).status).toBe(401);
    expect((await cashier.client.get(base)).status).toBe(403);
    const patch = await cashier.client
      .patch(`${base}/gofood`)
      .set(originHeader)
      .send({ isOpen: false });
    expect(patch.status).toBe(403);
  });

  it("lists the channels of the outlet only", async () => {
    const list = await manager.client.get(base);
    expect(list.status).toBe(200);
    expect(
      list.body.data.map((row: { platform: string }) => row.platform),
    ).toEqual(["gofood", "grabfood"]);
    const other = await manager.client.get(
      `/api/outlets/${seededOutletB}/delivery-channels`,
    );
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([]);
  });

  it("refuses an outlet-scoped manager on another outlet's channels", async () => {
    expect((await outletManager.client.get(base)).status).toBe(200);
    const other = `/api/outlets/${seededOutletB}/delivery-channels`;
    expect((await outletManager.client.get(other)).status).toBe(403);
    const patch = await outletManager.client
      .patch(`${other}/gofood`)
      .set(originHeader)
      .send({ isOpen: false });
    expect(patch.status).toBe(403);
    const sync = await outletManager.client
      .post(`${other}/gofood/sync`)
      .set(originHeader);
    expect(sync.status).toBe(403);
  });

  it("closes and reopens a store through the adapter and audits both", async () => {
    calls.length = 0;
    const before = await auditCount("delivery_channel.state_changed");
    const closedUntil = new Date(Date.now() + 3600_000).toISOString();
    const closed = await manager.client
      .patch(`${base}/gofood`)
      .set(originHeader)
      .send({ isOpen: false, closedUntil, closedReason: "Dapur penuh" });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({
      platform: "gofood",
      isOpen: false,
      closedReason: "Dapur penuh",
    });
    expect(closed.body.data.closedUntil).toBe(closedUntil);
    expect(actionsOf("gofood")).toEqual(["close"]);
    const reopened = await manager.client
      .patch(`${base}/gofood`)
      .set(originHeader)
      .send({ isOpen: true });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({
      isOpen: true,
      closedUntil: null,
      closedReason: null,
    });
    expect(actionsOf("gofood")).toEqual(["close", "open"]);
    expect(await auditCount("delivery_channel.state_changed")).toBe(before + 2);
  });

  it("rolls the state back when the platform call fails", async () => {
    failNext = true;
    try {
      const response = await manager.client
        .patch(`${base}/gofood`)
        .set(originHeader)
        .send({ isOpen: false });
      expect(response.status).toBe(502);
    } finally {
      failNext = false;
    }
    expect((await channelRow("gofood")).is_open).toBe(true);
  });

  it("answers 404 for a platform that is not connected and 422 for a bad body", async () => {
    const unknown = await manager.client
      .patch(`${base}/shopeefood`)
      .set(originHeader)
      .send({ isOpen: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("DELIVERY_CHANNEL_UNKNOWN");
    const bad = await manager.client
      .patch(`${base}/gofood`)
      .set(originHeader)
      .send({ isOpen: "yes" });
    expect(bad.status).toBe(422);
  });

  it("syncs the platform price list with the 86 flag and records the result", async () => {
    calls.length = 0;
    const response = await manager.client
      .post(`${base}/gofood/sync`)
      .set(originHeader);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      pushedItemCount: 1,
      soldOutItemCount: 1,
    });
    expect(response.body.data.channel).toMatchObject({
      syncStatus: "ok",
      syncError: null,
      menuItemCount: 1,
      soldOutItemCount: 1,
    });
    expect(response.body.data.channel.lastSyncedAt).not.toBeNull();
    const [call] = calls;
    expect(call.action).toBe("sync_menu");
    expect(call.payload).toMatchObject({
      storeExternalId: "d2-gofood-store",
      items: [
        {
          itemId: ids.item,
          soldOut: true,
          prices: [{ variantId: null, priceIdr: 35000 }],
        },
      ],
    });
  });

  it("records a failed sync on the channel and answers 502", async () => {
    failNext = true;
    try {
      const response = await manager.client
        .post(`${base}/grabfood/sync`)
        .set(originHeader);
      expect(response.status).toBe(502);
    } finally {
      failNext = false;
    }
    const row = await channelRow("grabfood");
    expect(row.sync_status).toBe("error");
    expect(row.sync_error).toBe(DELIVERY_MENU_SYNC_ERROR);
    expect(row.sync_error).not.toContain("platform down");
  });
});

describe("delivery sync consumer", () => {
  it("sends 86 and restore only to open channels, idempotently per event", async () => {
    calls.length = 0;
    const soldOut = menuEvent(itemSoldOutEvent, {
      itemId: ids.item,
      availabilityId: randomUUID(),
      outletId: seededOutletA,
      soldOutUntil: null,
    });
    for (let replay = 0; replay < 2; replay += 1)
      await withTenant(db, tenantContext, (tx) =>
        deliverDeliveryChannelEvent(tenantContext, soldOut, tx),
      );
    expect(actionsOf("gofood")).toEqual(["sold_out", "sold_out"]);
    expect(actionsOf("grabfood")).toEqual([]);
    expect(calls[0].reference).toBe(calls[1].reference);
    expect(calls[0].payload).toMatchObject({ itemId: ids.item, soldOut: true });
    const restored = menuEvent(itemRestoredEvent, {
      itemId: ids.item,
      availabilityId: randomUUID(),
      outletId: seededOutletA,
    });
    await withTenant(db, tenantContext, (tx) =>
      deliverDeliveryChannelEvent(tenantContext, restored, tx),
    );
    expect(calls[2].payload).toMatchObject({ soldOut: false });
  });

  it("debounces a price change: stale first, pushed by the sweep after the window", async () => {
    await setChannel("grabfood", "sync_status = 'ok', sync_error = NULL");
    calls.length = 0;
    const priceChanged = {
      ...menuEvent(itemRestoredEvent, {
        itemId: ids.item,
        availabilityId: randomUUID(),
        outletId: seededOutletA,
      }),
      name: "price_list.updated",
      payload: {
        priceListId: ids.priceList,
        outletId: seededOutletA,
        channel: "gofood",
        effectiveFrom: "2000-01-01",
        operation: "updated",
      },
    };
    // gofood was synced seconds ago: inside the window it is only marked stale.
    await withTenant(db, tenantContext, (tx) =>
      deliverDeliveryChannelEvent(tenantContext, priceChanged, tx),
    );
    expect(calls).toEqual([]);
    expect((await channelRow("gofood")).sync_status).toBe("stale");
    // After the window the sweep pushes the stale open channel (grabfood is closed).
    await setChannel("grabfood", "is_open = false");
    const pushed = await syncStaleDeliveryChannels(
      tenantContext,
      new Date(Date.now() + 120_000),
    );
    expect(pushed).toBe(1);
    expect(actionsOf("gofood")).toEqual(["sync_menu"]);
    expect(actionsOf("grabfood")).toEqual([]);
    expect((await channelRow("gofood")).sync_status).toBe("ok");
  });

  it("ignores a price change of a channel that is not a delivery platform", async () => {
    calls.length = 0;
    const dineIn = {
      ...menuEvent(itemRestoredEvent, {
        itemId: ids.item,
        availabilityId: randomUUID(),
        outletId: seededOutletA,
      }),
      name: "price_list.updated",
      payload: {
        priceListId: ids.priceList,
        outletId: seededOutletA,
        channel: "dine_in",
        effectiveFrom: "2000-01-01",
        operation: "updated",
      },
    };
    await withTenant(db, tenantContext, (tx) =>
      deliverDeliveryChannelEvent(tenantContext, dineIn, tx),
    );
    expect(calls).toEqual([]);
  });

  it("never fails the event when the platform refuses an 86: open channel error, closed channel stale", async () => {
    await setChannel("gofood", "is_open = true, sync_status = 'ok', sync_error = NULL");
    await setChannel("grabfood", "is_open = false, sync_status = 'ok', sync_error = NULL");
    const soldOut = menuEvent(itemSoldOutEvent, {
      itemId: ids.item,
      availabilityId: randomUUID(),
      outletId: seededOutletA,
      soldOutUntil: null,
    });
    failNext = true;
    try {
      await expect(
        withTenant(db, tenantContext, (tx) =>
          deliverDeliveryChannelEvent(tenantContext, soldOut, tx),
        ),
      ).resolves.toBeUndefined();
    } finally {
      failNext = false;
    }
    const gofood = await channelRow("gofood");
    expect(gofood.sync_status).toBe("error");
    expect(gofood.sync_error).toBe(DELIVERY_SOLD_OUT_SYNC_ERROR);
    expect(gofood.sync_error).not.toContain("platform down");
    expect((await channelRow("grabfood")).sync_status).toBe("stale");
  });

  it("marks or pushes the channels of every outlet of the brand on a menu change", async () => {
    await setChannel("gofood", "is_open = true, sync_status = 'ok', sync_error = NULL, last_synced_at = now()");
    await asOwner((q) =>
      q(
        "INSERT INTO delivery_channels (tenant_id, outlet_id, platform, store_external_id, is_open) VALUES ($1, $2, 'gofood', 'd2-gofood-store-b', true)",
        [seededTenantId, seededOutletB],
      ),
    );
    try {
      calls.length = 0;
      // A brand-scoped event carries the brand's first outlet or none at all.
      const itemChanged = {
        ...menuEvent(itemRestoredEvent, {
          itemId: ids.item,
          availabilityId: randomUUID(),
          outletId: seededOutletA,
        }),
        outletId: null,
        name: "menu_item.updated",
        payload: {
          itemId: ids.item,
          categoryId: ids.category,
          isActive: true,
          operation: "updated",
        },
      };
      await withTenant(db, tenantContext, (tx) =>
        deliverDeliveryChannelEvent(tenantContext, itemChanged, tx),
      );
      // Outlet A synced seconds ago: stale (debounced). Outlet B never synced:
      // pushed at once.
      expect((await channelRow("gofood")).sync_status).toBe("stale");
      expect((await channelRow("grabfood")).sync_status).toBe("stale");
      expect(calls.map((call) => [call.outletId, call.action])).toEqual([
        [seededOutletB, "sync_menu"],
      ]);
      expect((await channelRow("gofood", seededOutletB)).sync_status).toBe("ok");
    } finally {
      await asOwner((q) =>
        q(
          "DELETE FROM delivery_channels WHERE tenant_id = $1 AND outlet_id = $2",
          [seededTenantId, seededOutletB],
        ),
      );
    }
  });
});

describe("delivery adapter registry", () => {
  it("answers with a recording fake when no adapter is installed", async () => {
    clearRecordedDeliveryCalls();
    await deliveryChannelAdapterFor("shopeefood").execute(tenantContext, {
      tenantId: tenantContext.tenant.tenantId,
      outletId: seededOutletA as never,
      reference: "registry-1",
      channel: "shopeefood",
      action: "close",
      payload: {},
    });
    expect(recordedDeliveryCalls().map((call) => call.reference)).toEqual([
      "registry-1",
    ]);
    clearRecordedDeliveryCalls();
    expect(recordedDeliveryCalls()).toEqual([]);
  });
});
