// legend-111j: the `loyalty-earn` outbox consumer (design M6) and the cashier
// phone-lookup cap (brief 290a "Tes gagal-dulu").
//
// Events are synthetic envelopes delivered through
// `withTenant(db, ctx, tx => deliverLoyaltyEarnEvent(ctx, event, tx, now))`
// (pattern of accounting-auto-journal.test.ts). Each test owns a fresh tenant
// (the program, daily cap and anomalies are per tenant).
//
// Assumptions:
// - Gross revenue without service and PBJT: the consumer trusts the payload
//   `grossSalesIdr` (design M6 step 1), so the tests pin that the points follow
//   gross, not total, for a POS sale and a nett-price QR sale. The emitters that
//   build that payload are locked by order-revenue.unit.test.ts (POS
//   `orderRevenueSplit`) and qr-order-paid-event.test.ts (QR `qr-order-paid`).
// - Earn rows use the order ULID as `source_id`; refund rows the refund id.
// - Order QR paid then system refund: a gateway refund of a QR order emits
//   `payment.refunded` (payload: refundId, paymentIntentId, amountIdr, no
//   orderId) and there is no order.refunded / order.voided path for a paid QR
//   order today. So the consumer cannot tie it to an order and must ignore it;
//   the test pins that and records the reason. A later card that adds a QR
//   refund path must emit order.refunded with the orderId.
// - The phone lookup cap test calls PUT /api/pos/orders/:orderId/customer with
//   an outlet-scoped cashier session of the seeded tenant and an unpaid POS
//   order seeded with SQL (no device token). The cap is read from the seeded
//   tenant's program row.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant.ts";
import {
  listLoyaltyAnomalies,
  recordLoyaltyAnomaly,
} from "../services/loyalty-anomaly.service.ts";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { originHeader, verifySessionMfa } from "./helpers";
import {
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers";
import {
  NEXT_DATE,
  NEXT_DAY,
  asTenant,
  anomaliesOf,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  outboxEvents,
  owner,
  paymentRefundedEvent,
  profileOf,
  recordOf,
  seedConsent,
  seedMember,
  seedOrder,
  seedProgram,
  seedProfile,
  visitCount,
  type ProgramOptions,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

async function worldWith(program: ProgramOptions = {}): Promise<World> {
  const world = await createWorld();
  await seedProgram(world.tenantId, program);
  return world;
}

/** Seeds the order and delivers `order.paid` for a member. */
async function pay(
  world: World,
  member: { id: string; userId?: string },
  input: {
    outletId?: string;
    channel?: "pos" | "qr";
    grossSalesIdr?: number;
    discountIdr?: number;
    serviceChargeIdr?: number;
    pbjtIdr?: number;
    paidPointsIdr?: number;
    nett?: boolean;
    cashierId?: string | null;
    attachedBy?: string | null;
    attachedVia?: "member_qr" | "phone_lookup" | "pwa_session";
    paidAt?: string;
    businessDate?: string;
  } = {},
) {
  const outletId = input.outletId ?? world.outletA;
  const orderUlid = await seedOrder(world.tenantId, {
    outletId,
    channel: input.channel,
    profileId: member.id,
    attachedBy: input.attachedBy,
    attachedVia: input.attachedVia,
    grossSalesIdr: input.grossSalesIdr,
    discountIdr: input.discountIdr,
    serviceChargeIdr: input.serviceChargeIdr,
    pbjtIdr: input.pbjtIdr,
    nett: input.nett,
    cashierId: input.cashierId,
    businessDate: input.businessDate,
  });
  const event = orderPaidEvent(world, { orderUlid, outletId, ...input });
  await deliver(world, event);
  return { orderUlid, event };
}

describe("LOY-02 order.paid books points once", () => {
  it("LOY-02 a twin order.paid books one earn row, one record, one visit", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid, event } = await pay(world, member);
    // Same event again, and the same order under a new event id.
    await deliver(world, event);
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
    );

    const rows = await ledgerOf(world.tenantId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "earn",
      points: "10",
      source_type: "order",
      source_id: orderUlid,
    });
    expect(rows[0]!.expires_at?.toISOString().slice(0, 10)).toBe("2027-10-15");
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      booked_points: "10",
      eligible_spend_idr: "100000",
    });
    expect(await visitCount(world.tenantId, member.id)).toBe(1);
    const profile = await profileOf(world.tenantId, member.id);
    expect(profile.visits_count).toBe(1);
    expect(profile.lifetime_spend_idr).toBe("100000");
    expect(profile.first_visit_at?.toISOString()).toBe(
      "2026-10-15T05:00:00.000Z",
    );
    expect(profile.last_visit_at?.toISOString()).toBe(
      "2026-10-15T05:00:00.000Z",
    );
    expect(
      await outboxEvents(world.tenantId, "points.earned", member.id),
    ).toHaveLength(1);
  });

  it("LOY-02 an order without a member writes no record and no points", async () => {
    const world = await worldWith();
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
    );
    expect(await recordOf(world.tenantId, orderUlid)).toBeNull();
  });

  it("LOY-02 an inactive program skips the order: no points, no visit", async () => {
    const world = await worldWith({ isActive: false });
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "skipped",
      outcome_reason: "skipped_program_inactive",
    });
    expect(await ledgerOf(world.tenantId, member.id)).toHaveLength(0);
    expect(await visitCount(world.tenantId, member.id)).toBe(0);
  });

  it("LOY-02 a pending member (not verified or no consent) is blocked_not_member: no points, no visit", async () => {
    const world = await worldWith();
    const pending = await seedProfile(world.tenantId, {
      status: "pending_verification",
    });
    await seedConsent(world.tenantId, pending.id);
    const noConsent = await seedProfile(world.tenantId);
    const first = await pay(world, pending);
    const second = await pay(world, noConsent);
    for (const { orderUlid } of [first, second])
      expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
        state: "blocked",
        outcome_reason: "blocked_not_member",
      });
    expect(await ledgerOf(world.tenantId, pending.id)).toHaveLength(0);
    expect(await ledgerOf(world.tenantId, noConsent.id)).toHaveLength(0);
    expect(await visitCount(world.tenantId, pending.id)).toBe(0);
  });

  it("LOY-02 a loyalty consent withdrawn before paidAt blocks the order", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    await seedConsent(world.tenantId, member.id, {
      decision: "withdrawn",
      recordedAt: "2026-10-01T00:00:00Z",
    });
    const { orderUlid } = await pay(world, member);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "blocked",
      outcome_reason: "blocked_not_member",
    });
  });
});

describe("LOY-02 eligible spend (design M6 risk 5)", () => {
  it("LOY-02 POS: gross excludes service charge and PBJT", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    // total 116.000; points follow gross 100.000 (10), not the total (11).
    const { orderUlid } = await pay(world, member, {
      grossSalesIdr: 100_000,
      serviceChargeIdr: 5_000,
      pbjtIdr: 11_000,
    });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      eligible_spend_idr: "100000",
      booked_points: "10",
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });

  it("LOY-02 QR nett-price order: points follow the gross before service and PBJT", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      channel: "qr",
      grossSalesIdr: 59_000,
      serviceChargeIdr: 4_000,
      pbjtIdr: 5_000,
      nett: true,
    });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      eligible_spend_idr: "59000",
      booked_points: "5",
    });
  });

  it("LOY-02 discount and points tender are subtracted: points never earn points", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      grossSalesIdr: 100_000,
      discountIdr: 10_000,
      paidPointsIdr: 30_000,
    });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      eligible_spend_idr: "60000",
      booked_points: "6",
    });
  });
});

describe("LOY-02 refunds and voids", () => {
  it("LOY-02 a partial refund is reduced by refundPointsIdr", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      grossSalesIdr: 100_000,
      paidPointsIdr: 20_000,
    }); // eligible 80.000 -> 8 points
    expect(await balanceOf(world.tenantId, member.id)).toBe(8);
    const refundId = randomUUID();
    // Refund of 50.000 gross, 10.000 of it was paid with points: eligible 40.000
    // = half of 80.000 -> reverse 4.
    await deliver(
      world,
      orderRefundedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        refundId,
        grossSalesIdr: 50_000,
        refundPointsIdr: 10_000,
      }),
    );
    const reversal = (await ledgerOf(world.tenantId, member.id)).find(
      (row) => row.type === "reverse",
    );
    expect(reversal).toMatchObject({ points: "-4", source_id: refundId });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      refunded_eligible_idr: "40000",
      reversed_points: "4",
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(4);
  });

  it("LOY-02 voiding a paid order reverses all its points; an open-order void does nothing", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member);
    await deliver(
      world,
      orderVoidedEvent(world, {
        orderUlid,
        outletId: world.outletA,
        voidId: null,
        voidedFinalOrder: false,
      }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);

    const voidId = randomUUID();
    const voided = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId,
      voidedFinalOrder: true,
    });
    await deliver(world, voided);
    await deliver(world, voided); // replay
    const reversals = (await ledgerOf(world.tenantId, member.id)).filter(
      (row) => row.type === "reverse",
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      points: "-10",
      source_type: "void",
      source_id: voidId,
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    expect((await recordOf(world.tenantId, orderUlid))?.state).toBe("reversed");
  });

  it("LOY-02 QR order paid, then a system refund: the consumer ignores payment.refunded (no orderId), nothing is left half-done", async () => {
    // Why: a paid QR order has no void or refund path; the gateway refund emits
    // `payment.refunded` without an order id, so the consumer has no way to tie
    // it to the points. Pin that it changes nothing, so a later change cannot
    // silently reverse points of an unrelated order.
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, { channel: "qr" });
    await deliver(world, paymentRefundedEvent(world, world.outletA, 100_000));
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect(
      (await ledgerOf(world.tenantId, member.id)).filter(
        (row) => row.type === "reverse",
      ),
    ).toHaveLength(0);
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      reversed_points: "0",
    });
  });
});

describe("LOY-02 QR member session is not self-serve", () => {
  it("LOY-02 a QR order attached by pwa_session (attached_by NULL) earns", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      channel: "qr",
      attachedVia: "pwa_session",
      attachedBy: null,
      cashierId: null,
    });
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "booked",
      booked_points: "10",
    });
    expect(
      await anomaliesOf(world.tenantId, "self_serve_blocked"),
    ).toHaveLength(0);
  });
});

describe("LOY-02 daily point cap per business date, across outlets", () => {
  it("LOY-02 caps the sum of both outlets on one business date and resets the next day", async () => {
    const world = await worldWith({ dailyCap: 15 });
    const member = await seedMember(world.tenantId);
    const first = await pay(world, member, { outletId: world.outletA }); // 10
    const second = await pay(world, member, { outletId: world.outletB }); // 10 -> 5 booked
    const third = await pay(world, member, { outletId: world.outletA }); // 0 left

    expect(await recordOf(world.tenantId, first.orderUlid)).toMatchObject({
      state: "booked",
      booked_points: "10",
      capped_points: "0",
    });
    expect(await recordOf(world.tenantId, second.orderUlid)).toMatchObject({
      state: "booked",
      computed_points: "10",
      booked_points: "5",
      capped_points: "5",
    });
    expect(await recordOf(world.tenantId, third.orderUlid)).toMatchObject({
      state: "capped",
      booked_points: "0",
      capped_points: "10",
    });
    expect(
      (await ledgerOf(world.tenantId, member.id)).filter(
        (row) => row.type === "earn",
      ),
    ).toHaveLength(2);
    expect(await balanceOf(world.tenantId, member.id)).toBe(15);
    // A capped order is still a visit.
    expect(await visitCount(world.tenantId, member.id)).toBe(3);
    const hits = await anomaliesOf(world.tenantId, "daily_cap_hit");
    expect(hits).toHaveLength(2);
    expect(hits.every((row) => row.customer_profile_id === member.id)).toBe(
      true,
    );

    // The next business date starts a fresh allowance.
    const next = await pay(world, member, {
      paidAt: NEXT_DAY,
      businessDate: NEXT_DATE,
    });
    expect(await recordOf(world.tenantId, next.orderUlid)).toMatchObject({
      state: "booked",
      booked_points: "10",
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(25);
  });

  it("LOY-02 a null cap means no daily limit", async () => {
    const world = await worldWith({ dailyCap: null });
    const member = await seedMember(world.tenantId);
    await pay(world, member, { grossSalesIdr: 5_000_000 });
    expect(await balanceOf(world.tenantId, member.id)).toBe(500);
  });
});

describe("LOY-02 staff cannot earn from their own transactions", () => {
  async function expectBlocked(
    world: World,
    memberId: string,
    orderUlid: string,
  ) {
    expect(await recordOf(world.tenantId, orderUlid)).toMatchObject({
      state: "blocked",
      outcome_reason: "blocked_self_serve",
    });
    expect(await ledgerOf(world.tenantId, memberId)).toHaveLength(0);
    const anomalies = await anomaliesOf(world.tenantId, "self_serve_blocked");
    expect(anomalies.map((row) => row.customer_profile_id)).toContain(memberId);
    // A blocked self-serve order is still a visit.
    expect(await visitCount(world.tenantId, memberId)).toBe(1);
  }

  it("LOY-02 blocked when the cashier is the member's own user", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      cashierId: member.userId,
    });
    await expectBlocked(world, member.id, orderUlid);
  });

  it("LOY-02 blocked when the staff user attached the member to their own order", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      attachedBy: member.userId,
      attachedVia: "phone_lookup",
    });
    await expectBlocked(world, member.id, orderUlid);
  });

  it("LOY-02 blocked when the cashier's verified WhatsApp equals the member's number", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const cashierUser = randomUUID();
    await owner.query(
      `INSERT INTO user_identities (user_id, type, value_hash, verified_at)
       VALUES ($1, 'whatsapp', $2, now())`,
      [cashierUser, member.whatsappHash],
    );
    const { orderUlid } = await pay(world, member, { cashierId: cashierUser });
    await expectBlocked(world, member.id, orderUlid);
  });

  it("LOY-02 a different cashier is not blocked", async () => {
    const world = await worldWith();
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, { cashierId: randomUUID() });
    expect((await recordOf(world.tenantId, orderUlid))?.state).toBe("booked");
  });

  it("LOY-02 with the ban switched off the staff member earns", async () => {
    const world = await worldWith({ selfServeBan: false });
    const member = await seedMember(world.tenantId);
    const { orderUlid } = await pay(world, member, {
      cashierId: member.userId,
    });
    expect((await recordOf(world.tenantId, orderUlid))?.state).toBe("booked");
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });
});

describe("LOY-02 cashier phone lookup cap", () => {
  let app: Express;
  const headers = { Host: seededHostname };

  beforeAll(async () => {
    app = createApp();
    // The seeded tenant's program: two lookups per cashier per business day.
    await seedProgram(seededTenantId, { phoneLookupCap: 2 });
  });

  async function draftOrder(): Promise<string> {
    return seedOrder(seededTenantId, {
      outletId: seededOutletA,
      profileId: null,
      status: "draft",
    });
  }

  async function memberWithNumber(number: string) {
    return seedMember(seededTenantId, {
      whatsappHash: await whatsAppDigest(number),
    });
  }

  const randomNumber = () =>
    `+62812${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  it("LOY-02 the third lookup of a cashier on one business day is refused with 429 and recorded; the order stays unattached", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Cari Nomor",
    });
    await verifySessionMfa(cashier.email);
    const numbers = [randomNumber(), randomNumber(), randomNumber()];
    const members: Awaited<ReturnType<typeof memberWithNumber>>[] = [];
    for (const number of numbers) members.push(await memberWithNumber(number));
    const orders = [await draftOrder(), await draftOrder(), await draftOrder()];
    const attach = (orderUlid: string, number: string) =>
      cashier.client
        .put(`/api/pos/orders/${orderUlid}/customer`)
        .set(headers)
        .set(originHeader)
        .send({ whatsappNumber: number });

    for (const index of [0, 1]) {
      const ok = await attach(orders[index]!, numbers[index]!);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        customerProfileId: members[index]!.id,
        attachedVia: "phone_lookup",
      });
    }
    const refused = await attach(orders[2]!, numbers[2]!);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("PHONE_LOOKUP_CAP_REACHED");
    expect(refused.body.error.message).toContain("QR member");

    const mine = (await anomaliesOf(seededTenantId)).filter(
      (row) => row.actor_user_id === cashier.userId,
    );
    expect(
      mine.filter((row) => row.kind === "phone_lookup_attach"),
    ).toHaveLength(2);
    // The refusal is committed even though the request failed.
    expect(
      mine.filter((row) => row.kind === "phone_lookup_cap_hit"),
    ).toHaveLength(1);

    const attached = await asTenant(seededTenantId, (client) =>
      client.query<{ customer_profile_id: string | null }>(
        "SELECT customer_profile_id FROM orders WHERE tenant_id = $1 AND customer_profile_id = $2",
        [seededTenantId, members[2]!.id],
      ),
    );
    expect(attached.rows).toHaveLength(0);
  });

  it("LOY-02 the cap is per cashier: another cashier still has lookups left", async () => {
    const other = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Lain",
    });
    await verifySessionMfa(other.email);
    const number = randomNumber();
    const member = await memberWithNumber(number);
    const response = await other.client
      .put(`/api/pos/orders/${await draftOrder()}/customer`)
      .set(headers)
      .set(originHeader)
      .send({ whatsappNumber: number });
    expect(response.status).toBe(200);
    expect(response.body.data.customerProfileId).toBe(member.id);
  });
});

describe("loyalty anomaly list paging", () => {
  it("LOY-02 rows sharing one now() are all reached across pages, and a bad cursor is a 422", async () => {
    const world = await worldWith();
    // One transaction: all five rows share one microsecond `created_at`.
    await withTenant(db, world.context, async (tx) => {
      for (let i = 0; i < 5; i += 1)
        await recordLoyaltyAnomaly(tx, {
          tenantId: world.tenantId,
          kind: "phone_lookup_attach",
          outletId: world.outletA,
        });
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await withTenant(db, world.context, (tx) =>
        listLoyaltyAnomalies(tx, world.tenantId, { cursor, limit: 2 }),
      );
      seen.push(...result.items.map((item) => item.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    const bad = Buffer.from("2026-11-08T03:00:00.000Z|not-a-uuid").toString(
      "base64url",
    );
    await expect(
      withTenant(db, world.context, (tx) =>
        listLoyaltyAnomalies(tx, world.tenantId, { cursor: bad, limit: 2 }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
