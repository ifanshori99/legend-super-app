// 1269 F0 (founder 25 Nov 2026): FACILITY_SHOWER_ENABLED is off by default and
// closes ONLY facilities whose database type is 'shower'. Every server door
// that creates a shower ticket, hold, quota, right or claim refuses with 403
// FACILITY_SHOWER_DISABLED, writes no row and takes no money; a coworking
// (paid WFC) facility keeps working. Refund-side paths (cancel) keep working.
// The suite runs with the flag on (vitest.config.ts); each test flips it off
// and restores it.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { holdFacilitySlot } from "../services/facility-slots.service.ts";
import { joinFacilityQueue } from "../services/facility-queue.service.ts";
import { issueTierBenefit } from "../services/facility-entitlement.service.ts";
import {
  closedShowerFacilityIds,
  facilityShowerEnabled,
} from "../services/facility-shower-gate.ts";
import {
  createWorld,
  orderPaidEvent,
  owner,
  seedMember,
  seedOrder,
} from "./member-loyalty-helpers.ts";
import {
  PAID_AT,
  TODAY,
  deliverEntitlement,
  entitlementsOf,
  ledgerRows,
  rejectionCode,
  seedFacility,
  seedMenuItems,
  seedOrderItems,
  seedRule,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
const was = flag.FACILITY_SHOWER_ENABLED;
beforeEach(() => {
  flag.FACILITY_SHOWER_ENABLED = false;
});
afterEach(() => {
  flag.FACILITY_SHOWER_ENABLED = was;
});

const DISABLED = "FACILITY_SHOWER_DISABLED";

async function setup() {
  const world = await createWorld();
  const shower = await seedFacility(world, world.outletA, "shower");
  const wfc = await seedFacility(world, world.outletA, "coworking");
  return { world, shower, wfc, customerProfileId: randomUUID() };
}

describe("1269 F0 the switch", () => {
  it("is off unless exactly true (fail closed)", () => {
    flag.FACILITY_SHOWER_ENABLED = undefined;
    expect(facilityShowerEnabled()).toBe(false);
    flag.FACILITY_SHOWER_ENABLED = true;
    expect(facilityShowerEnabled()).toBe(true);
  });

  it("closes only the shower, read from the database row", async () => {
    const { world, shower, wfc } = await setup();
    const locker = await seedFacility(world, world.outletA, "locker");
    const room = await seedFacility(world, world.outletA, "meeting_room");
    const closed = await withTenant(db, world.context, (tx) =>
      closedShowerFacilityIds(tx, world.tenantId, [shower, wfc, locker, room]),
    );
    expect([...closed]).toEqual([shower]);
    flag.FACILITY_SHOWER_ENABLED = true;
    const open = await withTenant(db, world.context, (tx) =>
      closedShowerFacilityIds(tx, world.tenantId, [shower]),
    );
    expect(open.size).toBe(0);
  });
});

describe("1269 F0 entitlement issue and claim", () => {
  it("a shower is refused and writes no row, coworking still issues and redeems", async () => {
    const { world, shower, wfc, customerProfileId } = await setup();
    const svc = entitlementsOf(world);
    for (const source of [
      "purchase",
      "package",
      "min_spend",
      "subscription",
      "staff_issue",
    ] as const)
      expect(
        await rejectionCode(
          svc.issue({ facilityId: shower, customerProfileId, source }),
        ),
      ).toBe(DISABLED);
    expect(
      await rejectionCode(
        svc.redeem({ facilityId: shower, customerProfileId }),
      ),
    ).toBe(DISABLED);
    expect(
      await rejectionCode(
        withTenant(db, world.context, (tx) =>
          issueTierBenefit(tx, world.context, {
            facilityId: shower,
            customerProfileId,
            tierKey: "gold",
            period: "2026-11",
            sessions: 1,
            paid: true,
          } as never),
        ),
      ),
    ).toBe(DISABLED);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);

    const issued = await svc.issue({
      facilityId: wfc,
      customerProfileId,
    });
    expect(issued.status).toBe("issued");
    await svc.redeem({ facilityId: wfc, customerProfileId });
    expect(
      (await ledgerRows(world.tenantId)).every(
        (row) => row.facility_id === wfc,
      ),
    ).toBe(true);
  });

  it("cancelling what an earlier order issued at a shower still works while off", async () => {
    const { world, shower, customerProfileId } = await setup();
    const svc = entitlementsOf(world);
    flag.FACILITY_SHOWER_ENABLED = true;
    const sourceRef = `ref-${randomUUID().slice(0, 8)}`;
    await svc.issue({ facilityId: shower, customerProfileId, sourceRef });
    flag.FACILITY_SHOWER_ENABLED = false;
    await svc.cancel({
      sourceRef,
      sourceTypes: ["purchase"],
      reason: "Refund pesanan lama",
      occurredAt: new Date(),
    } as never);
    expect((await ledgerRows(world.tenantId)).map((row) => row.type)).toContain(
      "cancel",
    );
  });
});

describe("1269 F0 a paid order issues rights for coworking only", () => {
  it("the shower package rule issues nothing, the coworking rule still does, and the shower issues once the switch is on", async () => {
    const { world, shower, wfc } = await setup();
    const member = await seedMember(world.tenantId);
    const [menuA] = (await seedMenuItems(world, 1)) as [string];
    const rule = (facilityId: string) =>
      seedRule(world, {
        facilityId,
        outletId: world.outletA,
        type: "package",
        condition: { menuItemId: menuA },
        sessions: 2,
        validity: { kind: "duration_hours", hours: 24 },
      });
    await rule(shower);
    await rule(wfc);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
      grossSalesIdr: 100_000,
      businessDate: TODAY,
      status: "completed",
    });
    await seedOrderItems(world, {
      orderUlid,
      outletId: world.outletA,
      menuItemIds: [menuA],
      businessDate: TODAY,
    });
    const paid = orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: 100_000,
      paidAt: PAID_AT,
      businessDate: TODAY,
    });

    await deliverEntitlement(world, paid);
    const grants = (await ledgerRows(world.tenantId)).filter(
      (row) => row.type === "grant",
    );
    expect(grants.map((row) => row.facility_id)).toEqual([wfc]);

    flag.FACILITY_SHOWER_ENABLED = true;
    await deliverEntitlement(world, paid);
    const after = (await ledgerRows(world.tenantId)).filter(
      (row) => row.type === "grant",
    );
    expect(after.map((row) => row.facility_id).sort()).toEqual(
      [shower, wfc].sort(),
    );
  });
});

describe("1269 F0 hold and queue", () => {
  it("a shower hold and queue join are refused before any write; coworking passes the gate", async () => {
    const { world, shower, wfc, customerProfileId } = await setup();
    const hold = (facilityId: string) =>
      withTenant(db, world.context, (tx) =>
        holdFacilitySlot(tx, world.context, {
          facilityId,
          areaId: randomUUID(),
          timing: { kind: "now" },
          productId: randomUUID(),
          customerProfileId,
          source: "purchase",
          idempotencyKey: randomUUID(),
        } as never),
      );
    expect(await rejectionCode(hold(shower))).toBe(DISABLED);
    // Coworking is past the gate: it fails later (the area does not exist).
    expect(await rejectionCode(hold(wfc))).not.toBe(DISABLED);

    const join = (facilityId: string) =>
      joinFacilityQueue(world.context, randomUUID(), customerProfileId, {
        facilityId,
        areaId: randomUUID(),
      });
    expect(await rejectionCode(join(shower))).toBe(DISABLED);
    expect(await rejectionCode(join(wfc))).not.toBe(DISABLED);
  });
});
