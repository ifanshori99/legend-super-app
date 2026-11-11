import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  PROMO_CHECKPOINT_PERSIST_MARGIN_MS,
  PROMO_CHECKPOINT_STREAMS,
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import {
  promosEnabled,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import { CATALOG_GATE_PERSIST_MS } from "../edge/catalog-gate.ts";
import { createTrustedClock } from "../edge/trusted-clock.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import type {
  OrderPromoInput,
  OrderPromoPort,
} from "../services/order-promo-port.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const NOW = new Date("2026-11-11T03:00:00.000Z");
const handles: PromoGateHandle[] = [];

async function createOutletAndNode() {
  const outletId = outletIdSchema.parse(randomUUID());
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji Q62', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `Q62${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletId] },
  );
  const registered = await registerEdgeNode(context, randomUUID(), {
    outletId,
    role: "standby",
    label: "Mini PC uji Q62",
  });
  return { context, outletId, edgeNodeId: registered.edgeNode.id };
}

async function bootWithFreshLookingCheckpoints(
  proven: boolean,
  checkpointAt: Date = NOW,
) {
  const { context, outletId, edgeNodeId } = await createOutletAndNode();
  for (const stream of PROMO_CHECKPOINT_STREAMS)
    await owner.query(
      `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [seededTenantId, outletId, edgeNodeId, stream, checkpointAt],
    );
  const clock = createTrustedClock({
    wall: () => NOW,
    mono: () => 0,
    persistedHighWater: new Date(NOW.getTime() - (proven ? 10 * 60_000 : 0)),
  });
  setPromoGateEdgeModeForTests(() => true);
  const handle = startPromoGate({ context, edgeNodeId, clock });
  handles.push(handle);
  await handle.refresh();
  return { context, outletId };
}

afterEach(() => {
  while (handles.length) handles.pop()!.stop();
  setPromoGateEdgeModeForTests(null);
});

afterAll(async () => {
  await owner.end();
});

describe("Q62 promo and voucher safety when boot elapsed time cannot be proven", () => {
  it("keeps both disabled despite checkpoints that appear freshly synced", async () => {
    await bootWithFreshLookingCheckpoints(false);
    expect(promosEnabled()).toBe(false);
  });

  it("quotes and redeems zero financial value, and refuses a voucher before any engine redemption", async () => {
    const rig = await bootWithFreshLookingCheckpoints(false);
    const engine: OrderPromoPort = {
      async quote() {
        return {
          result: { evaluations: [], totalDiscountIdr: idr(10_000) },
          totalDiscountIdr: idr(10_000),
        };
      },
      async redeem() {
        return {
          result: { evaluations: [], totalDiscountIdr: idr(10_000) },
          totalDiscountIdr: idr(10_000),
        };
      },
      async release() {
        return { released: true, releasedDiscountIdr: idr(0) };
      },
    };
    const guarded = withPromoFreshness(engine);
    const input: OrderPromoInput = {
      outletId: rig.outletId,
      channel: "takeaway",
      lines: [],
      customer: null,
      voucherCode: null,
      at: NOW,
    };
    const redeemInput = {
      ...input,
      orderId: randomUUID(),
      actorUserId: null,
    };
    const quote = await withTenant(db, rig.context, (tx) =>
      guarded.quote(tx, rig.context, input),
    );
    expect(Number(quote.totalDiscountIdr)).toBe(0);
    expect(Number(quote.result.totalDiscountIdr)).toBe(0);
    const redeemed = await withTenant(db, rig.context, (tx) =>
      guarded.redeem(tx, rig.context, redeemInput),
    );
    expect(Number(redeemed.totalDiscountIdr)).toBe(0);
    expect(Number(redeemed.result.totalDiscountIdr)).toBe(0);
    await expect(
      withTenant(db, rig.context, (tx) =>
        guarded.redeem(tx, rig.context, {
          ...redeemInput,
          voucherCode: "VOUCHER10",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("retains the fresh-checkpoint behavior when boot elapsed time is proven", async () => {
    await bootWithFreshLookingCheckpoints(true);
    expect(promosEnabled()).toBe(true);
  });

  it("refuses future checkpoints whose freshness cannot be established", async () => {
    await bootWithFreshLookingCheckpoints(
      true,
      new Date(NOW.getTime() + 60 * 60_000),
    );
    expect(promosEnabled()).toBe(false);
  });
});

// 533 A3 (money rule: promos stay off unless the evidence is provably newer
// than the shutdown). After an offline restart with unproven elapsed time, a
// pull checkpoint written AFTER the boot high water proves the edge synced since
// it booted, so promos and vouchers may come back. The high water is only saved
// every CATALOG_GATE_PERSIST_MS (and a write can lag one more tick), so a
// checkpoint shortly after it may still predate the shutdown (review R1). Rule:
// accept only lastSuccessAt > bootHighWater + PROMO_CHECKPOINT_PERSIST_MARGIN_MS,
// exported from edge/promo-gate-runtime.ts, = 2 * CATALOG_GATE_PERSIST_MS + 5_000
// (125 s). Older, equal, or inside-the-margin checkpoints do not.
describe("533 A3 promo gate accepts checkpoints written after an unproven boot", () => {
  const MIN = 60_000;

  async function bootUnproven(
    checkpointsAt: Record<(typeof PROMO_CHECKPOINT_STREAMS)[number], Date>,
    runningMs = 5 * MIN,
  ) {
    const { context, outletId, edgeNodeId } = await createOutletAndNode();
    for (const stream of PROMO_CHECKPOINT_STREAMS)
      await owner.query(
        `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [seededTenantId, outletId, edgeNodeId, stream, checkpointsAt[stream]],
      );
    // Booted offline with the device date at the persisted stamp: unproven.
    let wall = NOW.getTime();
    let mono = 0;
    const clock = createTrustedClock({
      wall: () => new Date(wall),
      mono: () => mono,
      persistedHighWater: NOW,
    });
    expect(clock.elapsedTimeUnproven()).toBe(true);
    wall += runningMs;
    mono += runningMs;
    setPromoGateEdgeModeForTests(() => true);
    const handle = startPromoGate({ context, edgeNodeId, clock });
    handles.push(handle);
    await handle.refresh();
  }

  const both = (at: Date) => ({
    "catalog:promotions": at,
    "catalog:vouchers": at,
  });

  it("enables promos when both streams synced after the boot high water", async () => {
    await bootUnproven(both(new Date(NOW.getTime() + 3 * MIN)));
    expect(promosEnabled()).toBe(true);
  });

  it("keeps promos off when only one stream synced after the boot high water", async () => {
    await bootUnproven({
      "catalog:promotions": new Date(NOW.getTime() + 3 * MIN),
      "catalog:vouchers": new Date(NOW.getTime() - 60 * MIN),
    });
    expect(promosEnabled()).toBe(false);
  });

  it("keeps promos off when the checkpoints predate the boot high water", async () => {
    await bootUnproven(both(new Date(NOW.getTime() - MIN)));
    expect(promosEnabled()).toBe(false);
  });

  it("derives the persist margin from the catalog gate persist interval", () => {
    expect(PROMO_CHECKPOINT_PERSIST_MARGIN_MS).toBe(
      2 * CATALOG_GATE_PERSIST_MS + 5_000,
    );
  });

  it("keeps promos off for a checkpoint 30 seconds after the boot high water (may predate the shutdown)", async () => {
    await bootUnproven(both(new Date(NOW.getTime() + 30_000)));
    expect(promosEnabled()).toBe(false);
  });

  it("keeps promos off for a checkpoint exactly one margin after the high water", async () => {
    await bootUnproven(
      both(new Date(NOW.getTime() + PROMO_CHECKPOINT_PERSIST_MARGIN_MS)),
    );
    expect(promosEnabled()).toBe(false);
  });

  it("keeps promos off for a checkpoint 61 seconds after the boot high water (inside the 125 s margin)", async () => {
    await bootUnproven(both(new Date(NOW.getTime() + 61_000)));
    expect(promosEnabled()).toBe(false);
  });

  it("enables promos for a checkpoint one second past the margin", async () => {
    await bootUnproven(
      both(
        new Date(NOW.getTime() + PROMO_CHECKPOINT_PERSIST_MARGIN_MS + 1_000),
      ),
    );
    expect(promosEnabled()).toBe(true);
  });

  it("keeps promos off when one stream is past the margin and the other inside it", async () => {
    await bootUnproven({
      "catalog:promotions": new Date(NOW.getTime() + 3 * MIN),
      "catalog:vouchers": new Date(
        NOW.getTime() + PROMO_CHECKPOINT_PERSIST_MARGIN_MS,
      ),
    });
    expect(promosEnabled()).toBe(false);
  });

  it("keeps promos off for a checkpoint exactly at the boot high water", async () => {
    await bootUnproven(both(NOW));
    expect(promosEnabled()).toBe(false);
  });

  it("keeps promos off for a checkpoint in the future of the trusted clock", async () => {
    await bootUnproven(both(new Date(NOW.getTime() + 60 * MIN)));
    expect(promosEnabled()).toBe(false);
  });
});
