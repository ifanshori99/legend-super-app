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
  PROMO_CHECKPOINT_STREAMS,
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import {
  promosEnabled,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import { createTrustedClock } from "../edge/trusted-clock.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import type {
  OrderPromoInput,
  OrderPromoPort,
} from "../services/order-promo-port.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const NOW = new Date("2026-11-11T03:00:00.000Z");
const handles: PromoGateHandle[] = [];

async function bootWithFreshLookingCheckpoints(
  proven: boolean,
  checkpointAt: Date = NOW,
) {
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
  const edgeNodeId = registered.edgeNode.id;
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
