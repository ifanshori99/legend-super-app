// Q81 economic returns include both tender cash and original-payer DP liability.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import {
  asTenant,
  createWorld,
  orderPaidEvent,
  orderRefundedEvent,
  owner,
  seedMember,
  seedOrder,
} from "./member-loyalty-helpers.ts";
import {
  NOW,
  PAID_AT,
  TODAY,
  deliverEntitlement,
  ledgerRows,
  seedFacility,
  seedRule,
} from "./facility-entitlement-helpers.ts";
import { seedEconomicDepositRefund } from "./dp-economic-refund-fixture.ts";

afterAll(async () => {
  await owner.end();
});

async function scenario() {
  const world = await createWorld();
  const member = await seedMember(world.tenantId);
  const facilityId = await seedFacility(world);
  await seedRule(world, {
    facilityId,
    outletId: world.outletA,
    type: "min_spend",
    condition: { minSpendIdr: 170_000 },
    sessions: 2,
    validity: { kind: "operating_day" },
  });
  const first = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: member.id,
    grossSalesIdr: 100_000,
    businessDate: TODAY,
  });
  const second = await seedOrder(world.tenantId, {
    outletId: world.outletA,
    profileId: member.id,
    grossSalesIdr: 100_000,
    businessDate: TODAY,
  });
  const paid = orderPaidEvent(world, {
    orderUlid: second,
    outletId: world.outletA,
    grossSalesIdr: 100_000,
    businessDate: TODAY,
    paidAt: PAID_AT,
  });
  return { world, first, second, paid };
}

async function durableReturn(s: Awaited<ReturnType<typeof scenario>>) {
  return asTenant(s.world.tenantId, (client) =>
    seedEconomicDepositRefund(client, {
      tenantId: s.world.tenantId,
      outletId: s.world.outletA,
      orderId: ulidToUuid(s.first),
      tenderIdr: 15_000,
      depositIdr: 25_000,
      requestedBy: randomUUID(),
      approvedBy: randomUUID(),
      refundedAt: NOW.toISOString(),
    }),
  );
}

describe("legend-77r0 Q81 facility spend counts the whole economic return", () => {
  it("Q81-ECON-FAC-01: DP25k+tender15k reduces daily spend200k to160k and cannot issue a170k benefit", async () => {
    const s = await scenario();
    await durableReturn(s);
    await deliverEntitlement(s.world, s.paid);
    expect(
      (await ledgerRows(s.world.tenantId)).filter(
        (row) => row.type === "grant",
      ),
    ).toHaveLength(0);
  });

  it("Q81-ECON-FAC-02: the DP component removes an unredeemed benefit when net spend falls below its threshold", async () => {
    const s = await scenario();
    await deliverEntitlement(s.world, s.paid);
    expect(
      (await ledgerRows(s.world.tenantId)).filter(
        (row) => row.type === "grant",
      ),
    ).toHaveLength(1);
    const { refundId } = await durableReturn(s);
    const returned = orderRefundedEvent(s.world, {
      orderUlid: s.first,
      outletId: s.world.outletA,
      refundId,
      grossSalesIdr: 40_000,
      refundedAt: NOW.toISOString(),
    });
    await deliverEntitlement(s.world, returned);
    const cancelled = (await ledgerRows(s.world.tenantId)).filter(
      (row) => row.type === "cancel",
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.sessions).toBe(2);
    await deliverEntitlement(s.world, returned);
    expect(
      (await ledgerRows(s.world.tenantId)).filter(
        (row) => row.type === "cancel",
      ),
    ).toHaveLength(1);
  });
});
