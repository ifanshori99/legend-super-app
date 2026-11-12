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

// 533b P1 (money rule, architect round 2; replaces the 533 A3 exception).
// While the trusted clock cannot prove elapsed time (clock.elapsedTimeUnproven()),
// promos and vouchers stay OFF, full stop: no pull checkpoint, however recent
// compared with the boot high water, can switch them on. Scenario: host off for
// three days, NTP blocked, device date set three days back; the only evidence is
// checkpoints, and promo expiry later uses a `new Date()` that went backwards.
// Promos return only after clock.proveWithServerTime(...) succeeds, and then the
// normal 24h checkpoint freshness rules apply (assumption: handle.refresh() is
// the way the gate re-reads the clock in these tests; the running gate also
// re-evaluates on its own interval).
// The old PROMO_CHECKPOINT_PERSIST_MARGIN_MS export is removed (its P3 note,
// "checkpoint value recorded at boot must change", is moot without A3).
describe("533b promo gate stays disabled while the clock is unproven", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  function unprovenClock(runningMs: number) {
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
    return { clock, setWall: (date: Date) => (wall = date.getTime()) };
  }

  async function seedAndStart(
    clock: ReturnType<typeof createTrustedClock>,
    checkpointsAt:
      Date | Record<(typeof PROMO_CHECKPOINT_STREAMS)[number], Date>,
  ) {
    const { context, outletId, edgeNodeId } = await createOutletAndNode();
    for (const stream of PROMO_CHECKPOINT_STREAMS)
      await owner.query(
        `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [
          seededTenantId,
          outletId,
          edgeNodeId,
          stream,
          checkpointsAt instanceof Date ? checkpointsAt : checkpointsAt[stream],
        ],
      );
    setPromoGateEdgeModeForTests(() => true);
    const handle = startPromoGate({ context, edgeNodeId, clock });
    handles.push(handle);
    await handle.refresh();
    return handle;
  }

  it("stays off for fresh checkpoints written well after the boot high water", async () => {
    const { clock } = unprovenClock(15 * MIN);
    await seedAndStart(clock, new Date(NOW.getTime() + 10 * MIN));
    expect(promosEnabled()).toBe(false);
  });

  it("stays off for a checkpoint one second after the boot high water, and exactly at it", async () => {
    const first = unprovenClock(15 * MIN);
    await seedAndStart(first.clock, new Date(NOW.getTime() + 1_000));
    expect(promosEnabled()).toBe(false);
    const second = unprovenClock(15 * MIN);
    await seedAndStart(second.clock, NOW);
    expect(promosEnabled()).toBe(false);
  });

  it("stays off when only one stream synced after the boot high water", async () => {
    const { clock } = unprovenClock(15 * MIN);
    await seedAndStart(clock, {
      "catalog:promotions": new Date(NOW.getTime() + 10 * MIN),
      "catalog:vouchers": new Date(NOW.getTime() - 60 * MIN),
    });
    expect(promosEnabled()).toBe(false);
  });

  it("stays off after the date was set three days back with fresh-looking checkpoints", async () => {
    // Money scenario from the review: persisted stamp is NOW, the device date was
    // set back 3 days (regressed). Checkpoints newer than the high water must not
    // switch promos on.
    let wall = NOW.getTime() - 72 * HOUR;
    let mono = 0;
    const clock = createTrustedClock({
      wall: () => new Date(wall),
      mono: () => mono,
      persistedHighWater: NOW,
    });
    wall += 15 * MIN;
    mono += 15 * MIN;
    await seedAndStart(clock, new Date(NOW.getTime() + 10 * MIN));
    expect(promosEnabled()).toBe(false);
  });

  it("stays off after an attempted proof that disagrees with boot wall plus elapsed time (clock step)", async () => {
    const { clock, setWall } = unprovenClock(15 * MIN);
    const handle = await seedAndStart(
      clock,
      new Date(NOW.getTime() + 10 * MIN),
    );
    const stepped = new Date(NOW.getTime() + 3 * 24 * HOUR);
    setWall(stepped);
    clock.proveWithServerTime(stepped);
    await handle.refresh();
    expect(clock.elapsedTimeUnproven()).toBe(true);
    expect(promosEnabled()).toBe(false);
  });

  it("returns once the cloud's time proves the clock, with fresh checkpoints", async () => {
    const { clock } = unprovenClock(15 * MIN);
    const handle = await seedAndStart(
      clock,
      new Date(NOW.getTime() + 10 * MIN),
    );
    expect(promosEnabled()).toBe(false);
    clock.proveWithServerTime(new Date(NOW.getTime() + 15 * MIN));
    expect(clock.elapsedTimeUnproven()).toBe(false);
    await handle.refresh();
    expect(promosEnabled()).toBe(true);
  });

  it("after proof, still refuses checkpoints older than 24 hours", async () => {
    const { clock } = unprovenClock(15 * MIN);
    const handle = await seedAndStart(
      clock,
      new Date(NOW.getTime() - 25 * HOUR),
    );
    clock.proveWithServerTime(new Date(NOW.getTime() + 15 * MIN));
    await handle.refresh();
    expect(promosEnabled()).toBe(false);
  });
});
