// 1269 F0 (founder 25 Nov 2026): FACILITY_TICKETS_ENABLED is off by default
// and every server door that creates a ticket, a hold, a quota, a right or a
// claim refuses with 403 FACILITY_TICKETS_DISABLED, writes nothing and takes no
// money. Refund-side paths (cancel, void, refund) keep working. The suite runs
// with the flag on (vitest.config.ts); each test flips it off and restores it.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env.ts";
import { holdFacilitySlot } from "../services/facility-slots.service.ts";
import {
  issuePosTicketCredential,
  assertPosTicketsIssuable,
  issuePosTicketsForPaidOrder,
} from "../services/facility-pos-tickets.ts";
import { sellPosTicket } from "../services/facility-pos-ticket-sale.ts";
import { joinFacilityQueue } from "../services/facility-queue.service.ts";
import {
  createBreakfastOrderForMember,
  payBreakfastOrderForMember,
} from "../services/facility-breakfast.service.ts";
import { issueTierBenefit } from "../services/facility-entitlement.service.ts";
import {
  facilityTicketsEnabled,
  assertFacilityTicketsEnabled,
} from "../services/facility-tickets-gate.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
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

const flag = env as unknown as { FACILITY_TICKETS_ENABLED?: boolean };
const was = flag.FACILITY_TICKETS_ENABLED;
beforeEach(() => {
  flag.FACILITY_TICKETS_ENABLED = false;
});
afterEach(() => {
  flag.FACILITY_TICKETS_ENABLED = was;
});

const DISABLED = "FACILITY_TICKETS_DISABLED";
// The guard is the first statement of each door, so these arguments are never
// touched: a refusal that reached the database would throw a different error.
const never = null as never;

describe("1269 F0 the switch", () => {
  it("is off unless exactly true (fail closed)", () => {
    flag.FACILITY_TICKETS_ENABLED = undefined;
    expect(facilityTicketsEnabled()).toBe(false);
    flag.FACILITY_TICKETS_ENABLED = false;
    expect(() => assertFacilityTicketsEnabled()).toThrowError(
      expect.objectContaining({ code: DISABLED, status: 403 }),
    );
    flag.FACILITY_TICKETS_ENABLED = true;
    expect(() => assertFacilityTicketsEnabled()).not.toThrow();
  });
});

describe("1269 F0 doors refuse before reading or writing anything", () => {
  const ctx = never as ScopedTenantContext;

  it("slot hold, POS ticket sale, credential and queue", async () => {
    expect(
      await rejectionCode(holdFacilitySlot(never, ctx, never as never)),
    ).toBe(DISABLED);
    expect(await rejectionCode(sellPosTicket(ctx, never, never as never))).toBe(
      DISABLED,
    );
    expect(
      await rejectionCode(issuePosTicketCredential(ctx, never, never as never)),
    ).toBe(DISABLED);
    expect(
      await rejectionCode(
        joinFacilityQueue(ctx, "u", "c", { facilityId: "f", areaId: "a" }),
      ),
    ).toBe(DISABLED);
  });

  it("breakfast from a ticket: create and pay", async () => {
    expect(
      await rejectionCode(
        createBreakfastOrderForMember(ctx, never, "t", never as never),
      ),
    ).toBe(DISABLED);
    expect(
      await rejectionCode(
        payBreakfastOrderForMember(ctx, never, "t", "o", {
          idempotencyKey: "k",
        }),
      ),
    ).toBe(DISABLED);
  });
});

describe("1269 F0 entitlement grants and claims", () => {
  async function setup() {
    const world = await createWorld();
    const facilityId = await seedFacility(world);
    return { world, facilityId, customerProfileId: randomUUID() };
  }

  it("issue (staff, purchase, subscription) and redeem are refused and write no row", async () => {
    const { world, facilityId, customerProfileId } = await setup();
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
          svc.issue({ facilityId, customerProfileId, source }),
        ),
      ).toBe(DISABLED);
    expect(
      await rejectionCode(svc.redeem({ facilityId, customerProfileId })),
    ).toBe(DISABLED);
    expect(
      await rejectionCode(
        withTenant(db, world.context, (tx) =>
          issueTierBenefit(tx, world.context, {
            facilityId,
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
  });

  it("a paid order issues no package or minimum-spend grant, and the same event issues once the switch is on", async () => {
    const world = await createWorld();
    const facilityId = await seedFacility(world);
    const member = await seedMember(world.tenantId);
    const [menuA] = (await seedMenuItems(world, 1)) as [string];
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 2,
      validity: { kind: "duration_hours", hours: 24 },
    });
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
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);

    flag.FACILITY_TICKETS_ENABLED = true;
    await deliverEntitlement(world, paid);
    expect(
      (await ledgerRows(world.tenantId)).filter((row) => row.type === "grant"),
    ).toHaveLength(1);
  });

  it("cancelling what an earlier order issued still works while off", async () => {
    const { world, facilityId, customerProfileId } = await setup();
    const svc = entitlementsOf(world);
    flag.FACILITY_TICKETS_ENABLED = true;
    const sourceRef = `ref-${randomUUID().slice(0, 8)}`;
    await svc.issue({ facilityId, customerProfileId, sourceRef });
    flag.FACILITY_TICKETS_ENABLED = false;
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

describe("1269 F0 a bill without a ticket line is untouched", () => {
  it("tender start and completion pass for an order with no ticket line", async () => {
    const world = await createWorld();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
      grossSalesIdr: 10_000,
      businessDate: TODAY,
      status: "draft",
    });
    await withTenant(db, world.context, (tx) =>
      assertPosTicketsIssuable(tx, world.context, orderUlid),
    );
    await withTenant(db, world.context, (tx) =>
      issuePosTicketsForPaidOrder(tx, world.context, {
        orderId: orderUlid,
        now: new Date(),
        actorUserId: randomUUID() as never,
      }),
    );
  });
});
