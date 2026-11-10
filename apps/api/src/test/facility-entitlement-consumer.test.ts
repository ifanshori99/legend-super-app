// legend-fjk5 (WS-09, F25): outbox consumer of the facility entitlement ledger.
// `order.paid` issues grants for `package` and `min_spend` rules (FAC-04: only
// after the order is paid and the condition is met); `order.refunded` cancels
// the unredeemed rest of the grants of that order (FAC-04) and a replay of
// either event changes nothing.
//
// Assumptions (the brief leaves them open):
// - The grant's `sourceRef` is the paying order's ULID (for min_spend: the
//   order whose payment crossed the threshold).
// - Expiry of a `duration_hours` rule is measured from the event time or the
//   delivery time (both are within one hour of NOW here); `operating_day` rules
//   expire in the future but within 36 hours of NOW.
// - An order that is not completed (draft) does not count toward min_spend.
// - Spend of a day = sum of (subtotal - discount) of completed, non-training
//   orders of the same customer, outlet and business day, minus their rows in
//   `pos_order_refunds` (decided in the fix brief, F3). The refund row exists
//   before the `order.refunded` event is delivered (the real flow), so the net
//   spend is read from the table, not from the event amount.
// - At most one min_spend grant per customer, outlet, rule and business day (F4).
// - `order.voided` cancels the rest of the package and min_spend grants of the
//   order only for a final void with a voidId (F1); non-final voids are ignored.
// - Whether a further paid order on the same day issues a second min_spend grant
//   once the threshold was crossed is not specified, so it is not tested.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverFacilityEntitlementEvent } from "../services/facility-entitlement-consumer.ts";
import {
  asTenant,
  createWorld,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  owner,
  seedMember,
  seedOrder,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  HOUR,
  NOW,
  PAID_AT,
  TODAY,
  deliverEntitlement,
  entitlementsOf,
  ledgerRows,
  seedFacility,
  seedMenuItems,
  seedOrderItems,
  seedRule,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

type PaidOrder = {
  profileId: string | null;
  outletId?: string;
  grossSalesIdr?: number;
  menuItemIds?: string[];
  businessDate?: string;
  status?: "draft" | "completed";
  discountIdr?: number;
  paidAt?: string;
  training?: boolean;
};

/**
 * Marks a POS order as a training order (`pos_orders.is_training`). POS-04
 * freezes `pos_orders` of a final order with a trigger, so the stamp is written
 * with session_replication_role = replica (same pattern as the training tests
 * of the GL), modelling an order stamped at insert.
 */
async function markTraining(world: World, orderUlid: string) {
  await asTenant(world.tenantId, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
        [world.tenantId, ulidToUuid(orderUlid)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** One POS refund row of `amountIdr` for the order (as the refund flow writes it). */
async function seedRefund(
  world: World,
  orderUlid: string,
  amountIdr: number,
  outletId: string = world.outletA,
) {
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
          lines, requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, $4, 'customer_cancelled', 'Uji', $5::jsonb,
               'kasir-uji', 'supervisor-uji', $6, $7)`,
      [
        world.tenantId,
        outletId,
        ulidToUuid(orderUlid),
        amountIdr,
        JSON.stringify([{ method: "cash", amountIdr, reference: null }]),
        randomUUID(),
        NOW.toISOString(),
      ],
    ),
  );
}

/** Seeds an order and returns its ULID plus the matching `order.paid` event. */
async function order(world: World, input: PaidOrder) {
  const outletId = input.outletId ?? world.outletA;
  const businessDate = input.businessDate ?? TODAY;
  const grossSalesIdr = input.grossSalesIdr ?? 100_000;
  const orderUlid = await seedOrder(world.tenantId, {
    outletId,
    profileId: input.profileId,
    grossSalesIdr,
    businessDate,
    status: input.status ?? "completed",
    discountIdr: input.discountIdr,
  });
  if (input.training) await markTraining(world, orderUlid);
  if (input.menuItemIds?.length)
    await seedOrderItems(world, {
      orderUlid,
      outletId,
      menuItemIds: input.menuItemIds,
      businessDate,
    });
  const paid = orderPaidEvent(world, {
    orderUlid,
    outletId,
    grossSalesIdr,
    discountIdr: input.discountIdr,
    paidAt: input.paidAt ?? PAID_AT,
    businessDate,
  });
  return { orderUlid, paid };
}

async function setup() {
  const world = await createWorld();
  const facilityId = await seedFacility(world);
  const member = await seedMember(world.tenantId);
  const [menuA, menuB] = (await seedMenuItems(world, 2)) as [string, string];
  return { world, facilityId, member, menuA, menuB };
}

const grants = async (tenantId: string, customerProfileId?: string) =>
  (await ledgerRows(tenantId, { customerProfileId })).filter(
    (row) => row.type === "grant",
  );

describe("FAC-04 order.paid issues a package entitlement", () => {
  it("FAC-04 a paid order with the package menu item issues the rule's sessions", async () => {
    const { world, facilityId, member, menuA } = await setup();
    const ruleId = await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 3,
      validity: { kind: "duration_hours", hours: 24 },
    });
    const { orderUlid, paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);

    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "grant",
      sessions: 3,
      source_type: "package",
      source_ref: orderUlid,
      rule_id: ruleId,
      facility_id: facilityId,
      outlet_id: world.outletA,
      customer_profile_id: member.id,
    });
    const expiresAt = rows[0]!.expires_at!.getTime();
    expect(expiresAt).toBeGreaterThan(NOW.getTime() + 22 * HOUR);
    expect(expiresAt).toBeLessThan(NOW.getTime() + 25 * HOUR);

    const current = await entitlementsOf(world).current({
      facilityId,
      customerProfileId: member.id,
    });
    expect(current.balance.availableSessions).toBe(3);
  });

  it("FAC-04 an operating_day rule expires later the same day or night", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      validity: { kind: "operating_day" },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    const [row] = await grants(world.tenantId);
    expect(row!.expires_at!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(row!.expires_at!.getTime()).toBeLessThan(NOW.getTime() + 36 * HOUR);
  });

  it("FAC-04 a billing_period rule issues a grant without an own expiry", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      validity: { kind: "billing_period" },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    const [row] = await grants(world.tenantId);
    expect(row!.expires_at).toBeNull();
  });

  it("FAC-04 replaying the same order.paid event writes one grant", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    await deliverEntitlement(world, paid);
    expect(await grants(world.tenantId)).toHaveLength(1);
  });

  it("FAC-04 an order without the package menu item issues nothing", async () => {
    const { world, facilityId, member, menuA, menuB } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuB],
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 a disabled rule issues nothing", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      isEnabled: false,
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 an order without a customer profile issues nothing", async () => {
    const { world, facilityId, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
    });
    const { paid } = await order(world, {
      profileId: null,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 an event for an order that does not exist issues nothing and does not fail", async () => {
    const { world, facilityId, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
    });
    const paid = orderPaidEvent(world, {
      orderUlid: createUlid(),
      outletId: world.outletA,
      paidAt: PAID_AT,
      businessDate: TODAY,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 two rules for the same item issue one grant each", async () => {
    const { world, facilityId, member, menuA } = await setup();
    const ruleOne = await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 1,
    });
    const ruleTwo = await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 2,
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, paid);
    const rows = await grants(world.tenantId);
    expect(rows.map((row) => row.rule_id).sort()).toEqual(
      [ruleOne, ruleTwo].sort(),
    );
  });
});

describe("FAC-04 order.paid issues a min_spend entitlement", () => {
  const seedMinSpend = async (
    world: World,
    facilityId: string,
    minSpendIdr = 150_000,
  ) =>
    seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "min_spend",
      condition: { minSpendIdr },
      sessions: 1,
      validity: { kind: "operating_day" },
    });

  it("FAC-04 a single order at or above the threshold issues a grant", async () => {
    const { world, facilityId, member } = await setup();
    const ruleId = await seedMinSpend(world, facilityId);
    const { orderUlid, paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
    });
    await deliverEntitlement(world, paid);
    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessions: 1,
      source_type: "min_spend",
      source_ref: orderUlid,
      rule_id: ruleId,
      customer_profile_id: member.id,
    });
  });

  it("FAC-04 a spend below the threshold issues nothing", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpend(world, facilityId);
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 149_000,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 paid orders of the same business day add up to the threshold", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpend(world, facilityId);
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, first.paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);

    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, second.paid);
    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe(second.orderUlid);

    await deliverEntitlement(world, second.paid);
    expect(await grants(world.tenantId)).toHaveLength(1);
  });

  it("FAC-04 spend of another business day, customer or outlet does not count", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpend(world, facilityId);
    const stranger = await seedMember(world.tenantId);
    await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
      businessDate: "2026-11-07",
    });
    await order(world, { profileId: stranger.id, grossSalesIdr: 100_000 });
    await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
      outletId: world.outletB,
    });
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 an unpaid order does not count toward the threshold", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpend(world, facilityId);
    await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
      status: "draft",
    });
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 a disabled min_spend rule issues nothing", async () => {
    const { world, facilityId, member } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "min_spend",
      condition: { minSpendIdr: 50_000 },
      isEnabled: false,
    });
    const { paid } = await order(world, { profileId: member.id });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });
});

describe("FAC-04 order.refunded cancels the unredeemed rest", () => {
  async function paidPackage(sessions: number) {
    const ctx = await setup();
    const { world, facilityId, member, menuA } = ctx;
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions,
    });
    const placed = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, placed.paid);
    const refund = (refundId?: string) =>
      orderRefundedEvent(world, {
        orderUlid: placed.orderUlid,
        outletId: world.outletA,
        refundId,
        grossSalesIdr: 100_000,
        refundedAt: NOW.toISOString(),
      });
    return {
      ...ctx,
      ...placed,
      refund,
      svc: entitlementsOf(world),
      key: { facilityId, customerProfileId: member.id },
    };
  }

  it("FAC-04 a refund cancels all unused sessions of the order's grant", async () => {
    const { world, refund, svc, key } = await paidPackage(3);
    await deliverEntitlement(world, refund());
    const rows = await ledgerRows(world.tenantId);
    const cancels = rows.filter((row) => row.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      sessions: 3,
      grant_entry_id: rows.find((row) => row.type === "grant")!.id,
    });
    expect((await svc.current(key)).balance).toMatchObject({
      availableSessions: 0,
      cancelledSessions: 3,
    });
  });

  it("FAC-04 a refund after one session was used cancels only the rest", async () => {
    const { world, refund, svc, key } = await paidPackage(3);
    await svc.redeem(key);
    await deliverEntitlement(world, refund());
    const cancels = (await ledgerRows(world.tenantId)).filter(
      (row) => row.type === "cancel",
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sessions).toBe(2);
    expect((await svc.current(key)).balance).toMatchObject({
      availableSessions: 0,
      redeemedSessions: 1,
      cancelledSessions: 2,
    });
  });

  it("FAC-04 replaying the refund event, or a second refund, writes nothing more", async () => {
    const { world, refund } = await paidPackage(2);
    const event = refund();
    await deliverEntitlement(world, event);
    const afterFirst = await ledgerRows(world.tenantId);
    await deliverEntitlement(world, event);
    await deliverEntitlement(world, refund(randomUUID()));
    expect(await ledgerRows(world.tenantId)).toHaveLength(afterFirst.length);
  });

  it("FAC-04 a refund of an order whose grant is fully redeemed writes nothing", async () => {
    const { world, refund, svc, key } = await paidPackage(1);
    await svc.redeem(key);
    const before = await ledgerRows(world.tenantId);
    await deliverEntitlement(world, refund());
    expect(await ledgerRows(world.tenantId)).toHaveLength(before.length);
  });

  it("FAC-04 a refund of an order that issued nothing writes nothing", async () => {
    const { world, member } = await setup();
    const { orderUlid } = await order(world, { profileId: member.id });
    await deliverEntitlement(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
        refundedAt: NOW.toISOString(),
      }),
    );
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 a refund of one order leaves the grants of another order", async () => {
    const { world, member, refund, svc, key, menuA } = await paidPackage(2);
    const second = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, second.paid);
    await deliverEntitlement(world, refund());
    expect((await svc.current(key)).balance.availableSessions).toBe(2);
  });

  it("FAC-04 a refunded min_spend grant is cancelled too", async () => {
    const { world, facilityId, member } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "min_spend",
      condition: { minSpendIdr: 100_000 },
      sessions: 2,
    });
    const placed = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, placed.paid);
    expect(await grants(world.tenantId)).toHaveLength(1);
    // F3: the net spend comes from the refund rows, so the full refund is seeded.
    await seedRefund(world, placed.orderUlid, 100_000);
    await deliverEntitlement(
      world,
      orderRefundedEvent(world, {
        orderUlid: placed.orderUlid,
        outletId: world.outletA,
        grossSalesIdr: 100_000,
        refundedAt: NOW.toISOString(),
      }),
    );
    const cancels = (await ledgerRows(world.tenantId)).filter(
      (row) => row.type === "cancel",
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sessions).toBe(2);
  });
});

const cancelsOf = async (tenantId: string) =>
  (await ledgerRows(tenantId)).filter((row) => row.type === "cancel");

const seedMinSpendRule = (
  world: World,
  facilityId: string,
  minSpendIdr = 150_000,
  sessions = 1,
) =>
  seedRule(world, {
    facilityId,
    outletId: world.outletA,
    type: "min_spend",
    condition: { minSpendIdr },
    sessions,
    validity: { kind: "operating_day" },
  });

describe("F1 order.voided cancels the rest of the order's grants", () => {
  async function withGrants() {
    const ctx = await setup();
    const { world, facilityId, member, menuA } = ctx;
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 3,
    });
    await seedMinSpendRule(world, facilityId, 100_000, 2);
    const placed = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, placed.paid);
    expect(await grants(world.tenantId)).toHaveLength(2);
    return { ...ctx, ...placed };
  }

  it("F1 a final void cancels the unused sessions of the package and min_spend grants", async () => {
    const { world, orderUlid } = await withGrants();
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    const rows = await ledgerRows(world.tenantId);
    const cancels = rows.filter((row) => row.type === "cancel");
    expect(cancels.map((row) => row.sessions).sort()).toEqual([2, 3]);
    expect(cancels.map((row) => row.grant_entry_id).sort()).toEqual(
      rows
        .filter((row) => row.type === "grant")
        .map((row) => row.id)
        .sort(),
    );
  });

  it("F1 a final void after one session was used cancels only the rest", async () => {
    const { world, facilityId, member, orderUlid } = await withGrants();
    await entitlementsOf(world).redeem({
      facilityId,
      customerProfileId: member.id,
    });
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    const total = (await cancelsOf(world.tenantId)).reduce(
      (sum, row) => sum + row.sessions,
      0,
    );
    // 3 + 2 granted, 1 redeemed: 4 sessions are left to cancel.
    expect(total).toBe(4);
  });

  it("F1 replaying the void event or a second void writes nothing more", async () => {
    const { world, orderUlid } = await withGrants();
    const event = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId: randomUUID(),
      voidedFinalOrder: true,
    });
    await deliverEntitlement(world, event);
    const afterFirst = await cancelsOf(world.tenantId);
    expect(afterFirst).toHaveLength(2);
    await deliverEntitlement(world, event);
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await cancelsOf(world.tenantId)).toHaveLength(2);
  });

  it("F1 a non-final void changes nothing", async () => {
    const { world, orderUlid } = await withGrants();
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: false,
      }),
    );
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });

  it("F1 a final void without a voidId changes nothing", async () => {
    const { world, orderUlid } = await withGrants();
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: null,
        voidedFinalOrder: true,
      }),
    );
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });

  it("F1 a void of another order leaves the grants of this order", async () => {
    const { world, member } = await withGrants();
    const other = await order(world, {
      profileId: member.id,
      grossSalesIdr: 10_000,
    });
    await deliverEntitlement(
      world,
      orderVoidedEvent(world, {
        orderUlid: other.orderUlid,
        outletId: world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });
});

describe("F2 training orders issue and count for nothing", () => {
  it("F2 a training order with the package item issues no grant", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
      training: true,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("F2 a training order above the threshold issues no min_spend grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 200_000,
      training: true,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("F2 a training order does not count toward the daily spend of a real order", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
      training: true,
    });
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });
});

describe("F3 daily spend is net of refunds and discounts", () => {
  it("F3 a refund of an earlier order lowers the spend before the threshold is checked", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await seedRefund(world, first.orderUlid, 60_000);
    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    // Gross 200,000 but net 140,000 < 150,000.
    await deliverEntitlement(world, second.paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("F3 a net spend exactly at the threshold issues the grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await seedRefund(world, first.orderUlid, 50_000);
    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, second.paid);
    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe(second.orderUlid);
  });

  it("F3 spend is subtotal minus discount", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const { paid } = await order(world, {
      profileId: member.id,
      grossSalesIdr: 200_000,
      discountIdr: 60_000,
    });
    // Net 140,000 < 150,000.
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  async function twoOrdersWithGrant() {
    const ctx = await setup();
    const { world, facilityId, member } = ctx;
    await seedMinSpendRule(world, facilityId, 150_000, 2);
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, first.paid);
    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliverEntitlement(world, second.paid);
    const [grant] = await grants(world.tenantId);
    expect(grant!.source_ref).toBe(second.orderUlid);
    return { ...ctx, first, second, grant: grant! };
  }

  const refundEvent = (world: World, orderUlid: string, amountIdr: number) =>
    orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      grossSalesIdr: amountIdr,
      refundedAt: NOW.toISOString(),
    });

  it("F3 refund 1: a refund of another order of the day cancels the grant when the net spend falls below the threshold", async () => {
    const { world, first, grant } = await twoOrdersWithGrant();
    await seedRefund(world, first.orderUlid, 60_000);
    await deliverEntitlement(
      world,
      refundEvent(world, first.orderUlid, 60_000),
    );
    const cancels = await cancelsOf(world.tenantId);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      sessions: 2,
      grant_entry_id: grant.id,
    });
  });

  it("F3 refund 2: a refund that leaves the net spend at or above the threshold cancels nothing", async () => {
    const { world, first } = await twoOrdersWithGrant();
    await seedRefund(world, first.orderUlid, 40_000);
    await deliverEntitlement(
      world,
      refundEvent(world, first.orderUlid, 40_000),
    );
    // Net 160,000 >= 150,000.
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });

  it("F3 refund 2: a partial refund of the order that crossed the threshold keeps the grant while the net spend is enough", async () => {
    const { world, second } = await twoOrdersWithGrant();
    await seedRefund(world, second.orderUlid, 30_000);
    await deliverEntitlement(
      world,
      refundEvent(world, second.orderUlid, 30_000),
    );
    // Net 170,000 >= 150,000.
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });

  it("F3 a refund of another customer's order does not cancel the grant", async () => {
    const { world } = await twoOrdersWithGrant();
    const stranger = await seedMember(world.tenantId);
    const other = await order(world, {
      profileId: stranger.id,
      grossSalesIdr: 10_000,
    });
    await seedRefund(world, other.orderUlid, 10_000);
    await deliverEntitlement(
      world,
      refundEvent(world, other.orderUlid, 10_000),
    );
    expect(await cancelsOf(world.tenantId)).toHaveLength(0);
  });

  it("F3 a refund cancels the package grant of that order even when it is small", async () => {
    const { world, facilityId, member, menuA } = await setup();
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      sessions: 3,
    });
    const placed = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
    });
    await deliverEntitlement(world, placed.paid);
    await seedRefund(world, placed.orderUlid, 1_000);
    await deliverEntitlement(
      world,
      refundEvent(world, placed.orderUlid, 1_000),
    );
    const cancels = await cancelsOf(world.tenantId);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sessions).toBe(3);
  });
});

describe("F4 one min_spend grant per day and rule", () => {
  it("F4 an event that waits for a concurrent open transaction sees its grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    // Transaction A delivers the first event and stays open until released.
    // The second event is delivered meanwhile: if its "grant of the day" check
    // ran before it waited for the customer lock, it would not see A's grant.
    // A late second delivery only makes this test pass, never fail.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered!: () => void;
    const deliveredFirst = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const open = withTenant(db, world.context, async (tx) => {
      await deliverFacilityEntitlementEvent(world.context, first.paid, tx, NOW);
      delivered();
      await gate;
    });
    await Promise.race([deliveredFirst, open]);
    const concurrent = deliverEntitlement(world, second.paid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await Promise.all([open, concurrent]);
    expect(await grants(world.tenantId)).toHaveLength(1);
  });

  it("F4 a further order after the threshold was crossed issues no second grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    for (let index = 0; index < 3; index += 1) {
      const placed = await order(world, {
        profileId: member.id,
        grossSalesIdr: 100_000,
      });
      await deliverEntitlement(world, placed.paid);
    }
    expect(await grants(world.tenantId)).toHaveLength(1);
  });

  it("F4 two orders after midnight of the same business day issue one grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    // Business day 2026-11-08 ends at 04:00 Jakarta on 11-09: 01:00 and 02:00
    // Jakarta time on 11-09 are still business day 11-08, though on another
    // calendar day than 00:00-24:00 of 11-08.
    const first = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
      paidAt: "2026-11-08T18:00:00.000Z",
    });
    const second = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
      paidAt: "2026-11-08T19:00:00.000Z",
    });
    await deliverEntitlement(world, first.paid);
    await deliverEntitlement(world, second.paid);
    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe(first.orderUlid);
  });

  it("F4 two business days that share a calendar day each issue a grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    // Paid 03:00 Jakarta on 11-08 still belongs to business day 11-07.
    const lateNight = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
      businessDate: "2026-11-07",
      paidAt: "2026-11-07T20:00:00.000Z",
    });
    const morning = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
      businessDate: "2026-11-08",
      paidAt: "2026-11-08T03:00:00.000Z",
    });
    await deliverEntitlement(world, lateNight.paid);
    await deliverEntitlement(world, morning.paid);
    const rows = await grants(world.tenantId);
    expect(rows.map((row) => row.source_ref).sort()).toEqual(
      [lateNight.orderUlid, morning.orderUlid].sort(),
    );
  });

  it("F4 the same business day for another customer issues its own grant", async () => {
    const { world, facilityId, member } = await setup();
    await seedMinSpendRule(world, facilityId);
    const stranger = await seedMember(world.tenantId);
    const mine = await order(world, {
      profileId: member.id,
      grossSalesIdr: 150_000,
    });
    const theirs = await order(world, {
      profileId: stranger.id,
      grossSalesIdr: 150_000,
    });
    await deliverEntitlement(world, mine.paid);
    await deliverEntitlement(world, theirs.paid);
    expect(await grants(world.tenantId)).toHaveLength(2);
  });
});

describe("TEN-01..03 consumer isolation", () => {
  it("TEN-01 an order of tenant A never issues a grant in tenant B", async () => {
    const a = await setup();
    const b = await setup();
    // Same thresholds in both tenants; only A's customer paid.
    for (const t of [a, b])
      await seedRule(t.world, {
        facilityId: t.facilityId,
        outletId: t.world.outletA,
        type: "min_spend",
        condition: { minSpendIdr: 50_000 },
      });
    const { paid } = await order(a.world, { profileId: a.member.id });
    await deliverEntitlement(a.world, paid);
    expect(await grants(a.world.tenantId)).toHaveLength(1);
    expect(await ledgerRows(b.world.tenantId)).toHaveLength(0);
  });

  it("TEN-02 a rule of another outlet does not issue for an order at this outlet", async () => {
    const { world, member } = await setup();
    const facilityB = await seedFacility(world, world.outletB);
    await seedRule(world, {
      facilityId: facilityB,
      outletId: world.outletB,
      type: "min_spend",
      condition: { minSpendIdr: 50_000 },
    });
    const { paid } = await order(world, { profileId: member.id });
    await deliverEntitlement(world, paid);
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("TEN-02 an order at outlet B issues only the grant of outlet B's rule", async () => {
    const { world, facilityId, member } = await setup();
    const facilityB = await seedFacility(world, world.outletB);
    for (const [fid, outletId] of [
      [facilityId, world.outletA],
      [facilityB, world.outletB],
    ] as const)
      await seedRule(world, {
        facilityId: fid,
        outletId,
        type: "min_spend",
        condition: { minSpendIdr: 50_000 },
      });
    const { paid } = await order(world, {
      profileId: member.id,
      outletId: world.outletB,
    });
    await deliverEntitlement(world, paid);
    const rows = await grants(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      facility_id: facilityB,
      outlet_id: world.outletB,
    });
  });
});

// Q78 (founder decision): a `package` grant with `operating_day` validity paid
// AFTER the facility closed on the order's business day lasts until the close of
// the NEXT operating day that has opening hours (it is not void at once). Paid
// BEFORE closing: it still ends at that day's closing. A facility without any
// operating hours keeps the old behavior (end of the business day).
//
// Assumptions: facility hours are Mon-Sat 10:00-22:00 outlet time (Asia/Jakarta,
// UTC+7; the outlet's business-day cutoff is 04:00); `daysOfWeek` 0 = Sunday;
// "closes" means the `closesAt` instant of that day, so `expires_at` equals it.
// Dates: Mon 2026-11-09, Tue 2026-11-10, Sat 2026-11-14, Sun 2026-11-15,
// Mon 2026-11-16.
describe("Q78 package operating_day paid after closing", () => {
  const jakarta = (date: string, time: string) =>
    new Date(`${date}T${time}:00+07:00`);

  async function setOperatingHours(
    world: World,
    facilityId: string,
    hours: { daysOfWeek: number[]; opensAt: string; closesAt: string }[],
  ) {
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE facilities SET operating_hours = $3::jsonb WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, facilityId, JSON.stringify(hours)],
      ),
    );
  }

  /** Seeds hours and rule, pays the package order at `paidAt`, delivers the event at that time. */
  async function payPackage(input: {
    businessDate: string;
    paidAt: Date;
    hours?: { daysOfWeek: number[]; opensAt: string; closesAt: string }[];
  }) {
    const { world, facilityId, member, menuA } = await setup();
    await setOperatingHours(
      world,
      facilityId,
      input.hours ?? [
        { daysOfWeek: [1, 2, 3, 4, 5, 6], opensAt: "10:00", closesAt: "22:00" },
      ],
    );
    await seedRule(world, {
      facilityId,
      outletId: world.outletA,
      type: "package",
      condition: { menuItemId: menuA },
      validity: { kind: "operating_day" },
    });
    const { paid } = await order(world, {
      profileId: member.id,
      menuItemIds: [menuA],
      businessDate: input.businessDate,
      paidAt: input.paidAt.toISOString(),
    });
    await withTenant(db, world.context, (tx) =>
      deliverFacilityEntitlementEvent(world.context, paid, tx, input.paidAt),
    );
    const [row] = await grants(world.tenantId);
    return { world, facilityId, member, row: row! };
  }

  it("Q78 paid after closing on Monday, open Mon-Sat: expires at Tuesday's closing", async () => {
    const { row } = await payPackage({
      businessDate: "2026-11-09",
      paidAt: jakarta("2026-11-09", "23:00"),
    });
    expect(row.expires_at!.toISOString()).toBe(
      jakarta("2026-11-10", "22:00").toISOString(),
    );
  });

  it("Q78 paid Saturday night after closing, closed Sunday: expires at Monday's closing", async () => {
    const { row } = await payPackage({
      businessDate: "2026-11-14",
      paidAt: jakarta("2026-11-14", "23:00"),
    });
    expect(row.expires_at!.toISOString()).toBe(
      jakarta("2026-11-16", "22:00").toISOString(),
    );
  });

  it("Q78 paid before closing: expires at the same day's closing", async () => {
    const { row } = await payPackage({
      businessDate: "2026-11-09",
      paidAt: jakarta("2026-11-09", "20:00"),
    });
    expect(row.expires_at!.toISOString()).toBe(
      jakarta("2026-11-09", "22:00").toISOString(),
    );
  });

  it("Q78 a facility without operating hours keeps the old end-of-business-day expiry", async () => {
    const { row } = await payPackage({
      businessDate: "2026-11-09",
      paidAt: jakarta("2026-11-09", "23:00"),
      hours: [],
    });
    const expiresAt = row.expires_at!.getTime();
    expect(expiresAt).toBeGreaterThan(jakarta("2026-11-09", "23:00").getTime());
    // Not extended to the next day's closing (or even its opening).
    expect(expiresAt).toBeLessThanOrEqual(
      jakarta("2026-11-10", "04:00").getTime(),
    );
  });

  it("Q78 the grant paid after closing can be redeemed on Tuesday morning", async () => {
    const { world, facilityId, member, row } = await payPackage({
      businessDate: "2026-11-09",
      paidAt: jakarta("2026-11-09", "23:00"),
    });
    const at = jakarta("2026-11-10", "11:00");
    const result = await entitlementsOf(world).redeem({
      facilityId,
      customerProfileId: member.id,
      at,
    });
    expect(result.grantEntryId).toBe(row.id);
    const current = await entitlementsOf(world).current({
      facilityId,
      customerProfileId: member.id,
      at,
    });
    expect(current.balance.availableSessions).toBe(0);
  });
});
